import { authServerMetadataUrls, sameResource } from "../check/auth.ts";
import { clip, getJson, isObject, type JsonObject } from "../check/rpc.ts";
import { SOURCES } from "../check/sources.ts";
import { isLoopbackHost } from "../proxy/upstream.ts";
import { LinkError } from "./oauth.ts";

/**
 * Discovery as Amazon's account linking guide describes Alexa+ doing it: the
 * protected resource metadata at the MCP server's root, which names the
 * authorization server, then that server's metadata, which must offer PKCE
 * with S256. Where a server keeps a document somewhere Alexa+ doesn't look,
 * linking still goes ahead for testing, with a note saying so.
 */

export interface Discovery {
  /** Where the protected resource metadata was found. */
  resourceMetadataUrl: string;
  /** The protected resource metadata's scopes_supported, which the authorization request asks for. */
  scopes: string[];
  issuer: string;
  /** Where the authorization server's metadata was found. */
  metadataUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** token_endpoint_auth_methods_supported, when the metadata lists it. */
  authMethods?: string[];
  /** Worth knowing, but not a reason to stop: a document found where Alexa+ won't look, say. */
  notes: string[];
}

const LOOKUP_TIMEOUT_MS = 10_000;

/** Reads like Amazon quoting itself, so a refusal says exactly what the requirement is and where it's written. */
export function quoted(source: { title: string; url: string; quote: string }): string {
  return `"${source.quote}" (${source.title}, ${source.url})`;
}

/**
 * Refuses an address that isn't https://, except plain http:// on this
 * machine for local development: over plain http to another machine, the
 * client secret, the code and the tokens would all cross the network readable.
 */
export function requireHttps(what: string, value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LinkError(`The ${what}, ${clip(value, 100)}, isn't a URL.`);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) return url;
  throw new LinkError(
    `Refusing the ${what}, ${url.href}: it must use https:// (plain http:// only on this machine, for local development), or the client secret and tokens would cross the network readable.`,
  );
}

/** OpenID Connect's discovery addresses for an issuer: appended to its path, and inserted before it as RFC 8414 does. */
function openIdUrls(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, "");
  return [`${issuer.origin}${path}/.well-known/openid-configuration`, `${issuer.origin}/.well-known/openid-configuration${path}`];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

export async function discover(mcpUrl: string, fetchFn: typeof fetch): Promise<Discovery> {
  const transport = { fetch: fetchFn, timeoutMs: LOOKUP_TIMEOUT_MS };
  const notes: string[] = [];
  const mcp = new URL(mcpUrl);

  const rootUrl = `${mcp.origin}/.well-known/oauth-protected-resource`;
  const root = await getJson(transport, rootUrl);
  let resourceMetadataUrl = rootUrl;
  let prm = root.json;
  if (!prm) {
    // RFC 9728 puts a path-specific document under the well-known prefix; Amazon's guide names the root alone.
    const path = mcp.pathname.replace(/\/+$/, "");
    const pathUrl = path ? `${rootUrl}${path}` : undefined;
    const specific = pathUrl ? await getJson(transport, pathUrl) : undefined;
    if (!pathUrl || !specific?.json) {
      const tried = `${rootUrl} (${root.problem})${pathUrl ? ` or ${pathUrl} (${specific?.problem})` : ""}`;
      throw new LinkError(`No protected resource metadata at ${tried}. Alexa+ reads ${rootUrl} to find your authorization server, so linking can't start without it.`);
    }
    prm = specific.json;
    resourceMetadataUrl = pathUrl;
    notes.push(
      `Note: the protected resource metadata is only at ${pathUrl}, RFC 9728's path-specific address. Alexa+ reads ${rootUrl}, as Amazon's guide puts it: ${quoted(SOURCES.protectedResourceMetadata)}. Host it there too; the check's AU-03 fails until you do.`,
    );
  }

  const servers = strings(prm.authorization_servers);
  if (!servers.length) {
    throw new LinkError(`The protected resource metadata at ${resourceMetadataUrl} names no authorization_servers, so there's no authorization server to sign in with.`);
  }
  const issuer = servers[0]!;
  if (servers.length > 1) notes.push(`Note: ${resourceMetadataUrl} names ${servers.length} authorization servers; linking uses the first, ${issuer}.`);
  if (typeof prm.resource === "string" && prm.resource && !sameResource(prm.resource, mcpUrl)) {
    notes.push(
      `Note: ${resourceMetadataUrl} names resource ${clip(prm.resource, 100)}, not ${mcpUrl}. Linking sends ${mcpUrl} as the resource parameter; make the two agree (the check's AU-03 warns about this).`,
    );
  }

  const issuerUrl = requireHttps("authorization server", issuer);
  const candidates = [...new Set([...authServerMetadataUrls(issuerUrl), ...openIdUrls(issuerUrl)])];
  const tried: string[] = [];
  let found: { url: string; json: JsonObject } | undefined;
  for (const url of candidates) {
    const fetched = await getJson(transport, url);
    if (fetched.json) {
      found = { url, json: fetched.json };
      break;
    }
    tried.push(`${url} (${fetched.problem})`);
  }
  if (!found) throw new LinkError(`No authorization server metadata for ${issuer}; tried ${tried.join(", ")}.`);
  const { url: metadataUrl, json: metadata } = found;
  if (metadataUrl.includes("/.well-known/openid-configuration")) {
    notes.push(
      `Note: the authorization server's metadata is only at ${metadataUrl}, as OpenID configuration. Amazon's checklist says ${quoted(SOURCES.authServerMetadata)} and lists OpenID Connect as not supported yet, so the check's AU-04 fails until it's there too.`,
    );
  }
  if (typeof metadata.issuer === "string" && !sameResource(metadata.issuer, issuer)) {
    notes.push(`Note: the metadata at ${metadataUrl} names issuer ${clip(metadata.issuer, 100)}, not ${issuer}; RFC 8414 asks clients to use metadata only when the two match.`);
  }

  const methods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes("S256")) {
    const has = Array.isArray(methods) ? `lists code_challenge_methods_supported ${clip(JSON.stringify(methods), 80)}, without S256` : "has no code_challenge_methods_supported";
    throw new LinkError(`Can't link: the authorization server's metadata (${metadataUrl}) ${has}. Amazon's checklist: ${quoted(SOURCES.s256)}`);
  }

  const endpoint = (key: string): string => {
    const value = metadata[key];
    if (typeof value !== "string" || !value) throw new LinkError(`The authorization server's metadata (${metadataUrl}) has no ${key}, so there's nowhere to sign in.`);
    return requireHttps(key, value).href;
  };
  const registration = metadata.registration_endpoint;
  // An empty list says nothing, like a missing one.
  const authMethods = strings(metadata.token_endpoint_auth_methods_supported);
  return {
    resourceMetadataUrl,
    scopes: strings(prm.scopes_supported),
    issuer,
    metadataUrl,
    authorizationEndpoint: endpoint("authorization_endpoint"),
    tokenEndpoint: endpoint("token_endpoint"),
    ...(typeof registration === "string" && registration ? { registrationEndpoint: requireHttps("registration_endpoint", registration).href } : {}),
    ...(authMethods.length ? { authMethods } : {}),
    notes,
  };
}

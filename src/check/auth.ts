import type { RuleResult } from "../shared/contract.ts";
import { challengeOf, isRefusal, missingToolName, type ProbeCall, type SignIn } from "./data-layer.ts";
import { McpSession, clip, getJson, isObject, type JsonObject, type RefreshOutcome, type Transport } from "./rpc.ts";
import { RULES, judge, listOf } from "./rules.ts";

/**
 * The authentication rules (AU-xx), for servers that refuse a request sent
 * without a token: the refusal itself, then the discovery documents Alexa+
 * reads when account linking is set up, then what they promise, then (with a
 * token file from link) whether a refresh actually works.
 */

export const AUTH_RULES = [
  RULES.refusal,
  RULES.noChallengeHeader,
  RULES.protectedResource,
  RULES.authServer,
  RULES.pkce,
  RULES.endpoints,
  RULES.refreshTokens,
  RULES.https,
  RULES.tokenRefresh,
];

/**
 * With a token, the data layer runs signed in, so this asks again without
 * one: initialize, then tools/list, then a tool call, since Amazon's account
 * linking guide expects a refusal "when a tool is called without a valid
 * token" and some servers only guard the calls. The call is a read-only one
 * the data layer made, so making it again unsigned can't change anything.
 * The developer's other headers still go, since the server may need them to
 * be reached at all, but never an Authorization of theirs.
 */
export async function probeSignIn(transport: Transport, probe: ProbeCall | undefined): Promise<SignIn> {
  const headers = Object.fromEntries(Object.entries(transport.headers ?? {}).filter(([name]) => name.toLowerCase() !== "authorization"));
  const session = new McpSession({ ...transport, headers });
  try {
    const init = await session.initialize();
    if (isRefusal(init)) return { challenge: challengeOf(init) };
    if (init.outcome.kind !== "result") return { unknown: "Without a token, the initialize request didn't succeed, so sign-in wasn't checked." };
    await session.notify("notifications/initialized");
    const list = await session.request("tools/list");
    if (isRefusal(list)) return { challenge: challengeOf(list) };
    // A tool that doesn't exist when there's no read-only one: either way nothing can change.
    const missing = missingToolName(new Set());
    const { name, arguments: args, label } = probe ?? { name: missing, arguments: {}, label: missing };
    const call = await session.request("tools/call", { name, arguments: args }, `tools/call ${label}`);
    return isRefusal(call) ? { challenge: challengeOf(call) } : {};
  } finally {
    await session.close();
  }
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname === "[::1]"
  );
}

function parseUrl(value: unknown): URL | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Two URLs naming the same resource, ignoring a trailing slash, letter case in the host and a default port. */
export function sameResource(a: string, b: string): boolean {
  const key = (value: string) => {
    const url = parseUrl(value);
    if (!url) return value;
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    return `${url.protocol}//${url.host}${path}${url.search}`;
  };
  return key(a) === key(b);
}

/**
 * Where an authorization server's metadata may be: RFC 8414 inserts the
 * well-known part before the issuer's path, many servers append it instead,
 * and Amazon's quickstart names the root path.
 */
export function authServerMetadataUrls(issuer: URL): string[] {
  const root = `${issuer.origin}/.well-known/oauth-authorization-server`;
  const path = issuer.pathname.replace(/\/+$/, "");
  if (!path) return [root];
  return [`${root}${path}`, `${issuer.origin}${path}/.well-known/oauth-authorization-server`, root];
}

/**
 * `refresh` is how refreshing a token file's sign-in went, when the check
 * had one; it's judged even when the server doesn't refuse unsigned requests,
 * since a server can guard tools the probe didn't try.
 */
export async function checkAuth(transport: Transport, serverUrl: string, signIn: SignIn, refresh?: RefreshOutcome): Promise<RuleResult[]> {
  const challenge = signIn.challenge;
  if (!challenge) {
    const note = signIn.unknown ?? "The server doesn't require sign-in (account linking is optional).";
    return [...AUTH_RULES.slice(0, -1).map((rule) => judge(rule, "SKIP", note)), tokenRefresh(refresh, note)];
  }
  const rules: RuleResult[] = [];

  rules.push(judge(RULES.refusal, "PASS", `An unauthenticated ${challenge.label} was refused with HTTP ${challenge.status}.`));

  const header = challenge.headers.get("www-authenticate");
  rules.push(
    header
      ? judge(
          RULES.noChallengeHeader,
          "FAIL",
          `The ${challenge.status} answer carries WWW-Authenticate: ${clip(header, 100)}. Amazon lists that header under Not Supported Yet.`,
        )
      : judge(RULES.noChallengeHeader, "PASS", `The ${challenge.status} answer has no WWW-Authenticate header.`),
  );

  const mcpUrl = new URL(serverUrl);
  const { rule: prmRule, document: prm } = await protectedResource(transport, mcpUrl, serverUrl);
  rules.push(prmRule);

  const named = isObject(prm) && Array.isArray(prm.authorization_servers) ? prm.authorization_servers.find((s) => parseUrl(s)) : undefined;
  const issuer = parseUrl(named);
  const { rule: asRule, metadata } = await authServer(transport, issuer, mcpUrl);
  rules.push(asRule);

  if (!metadata) {
    const note = "There's no authorization server metadata to judge (see AU-04).";
    rules.push(judge(RULES.pkce, "SKIP", note), judge(RULES.endpoints, "SKIP", note), judge(RULES.refreshTokens, "SKIP", note));
  } else {
    rules.push(pkce(metadata), endpoints(metadata), refreshTokens(metadata));
  }

  rules.push(https(serverUrl, issuer, metadata));
  rules.push(
    tokenRefresh(
      refresh,
      "No token file was used, so no refresh was tried; sign in with alexa-plus-simulator link and check with --token-file to confirm refreshing works.",
    ),
  );
  return rules;
}

/** AU-09: a refresh with the refresh token link saved, the way Alexa+ keeps a customer signed in. */
function tokenRefresh(outcome: RefreshOutcome | undefined, skipNote: string): RuleResult {
  const rule = RULES.tokenRefresh;
  switch (outcome?.status) {
    case undefined:
      return judge(rule, "SKIP", skipNote);
    case "untried":
      return judge(rule, "SKIP", `No refresh was tried: ${outcome.reason}.`);
    case "missing":
      return judge(
        rule,
        "FAIL",
        "The token file has no refresh token: the token endpoint didn't return one when you linked, so customers would have to re-link whenever an access token expires.",
      );
    case "failed":
      return judge(
        rule,
        "FAIL",
        `A refresh with the saved refresh token failed: ${outcome.problem}. If that refresh token was revoked or has expired, link again and rerun the check; otherwise customers would have to re-link whenever an access token expires.`,
      );
    case "refreshed": {
      if (outcome.sameAccessToken) return judge(rule, "PASS", "A refresh with the saved refresh token worked, though it returned the access token it already had.");
      const rotated = outcome.newRefreshToken ? " and a new refresh token, both saved back to the token file" : ", saved back to the token file (the refresh token stays the same)";
      return judge(rule, "PASS", `A refresh with the saved refresh token returned a new access token${rotated}.`);
    }
  }
}

async function protectedResource(
  transport: Transport,
  mcpUrl: URL,
  serverUrl: string,
): Promise<{ rule: RuleResult; document?: JsonObject }> {
  const rule = RULES.protectedResource;
  const rootUrl = `${mcpUrl.origin}/.well-known/oauth-protected-resource`;
  const root = await getJson(transport, rootUrl);
  if (root.json) {
    const doc = root.json;
    const problems: string[] = [];
    if (typeof doc.resource !== "string" || !doc.resource) problems.push("no resource");
    const servers = Array.isArray(doc.authorization_servers) ? doc.authorization_servers.filter((s) => typeof s === "string" && s) : [];
    if (!servers.length) problems.push("no authorization_servers");
    if (problems.length) return { rule: judge(rule, "FAIL", `The document at ${rootUrl} has ${problems.join(" and ")}.`), document: doc };
    if (!sameResource(doc.resource as string, serverUrl)) {
      return {
        rule: judge(
          rule,
          "WARN",
          `The document at ${rootUrl} names resource ${clip(String(doc.resource), 100)}, not the MCP URL ${serverUrl}; Alexa+ passes it on as the resource parameter, which should be the MCP server's canonical URI.`,
        ),
        document: doc,
      };
    }
    return {
      rule: judge(rule, "PASS", `Found at ${rootUrl}, naming resource ${clip(String(doc.resource), 100)} and authorization server ${clip(String(servers[0]), 100)}.`),
      document: doc,
    };
  }
  // RFC 9728 puts a path-specific document under the well-known prefix; Amazon reads only the root one.
  const path = mcpUrl.pathname.replace(/\/+$/, "");
  if (!path) return { rule: judge(rule, "FAIL", `No protected resource metadata at ${rootUrl} (${root.problem}).`) };
  const pathUrl = `${rootUrl}${path}`;
  const specific = await getJson(transport, pathUrl);
  if (specific.json) {
    return {
      rule: judge(
        rule,
        "FAIL",
        `Nothing at ${rootUrl} (${root.problem}), but the path-specific RFC 9728 document is at ${pathUrl}. Amazon's account linking guide asks for it at the root path exactly.`,
      ),
      document: specific.json,
    };
  }
  return {
    rule: judge(rule, "FAIL", `No protected resource metadata at ${rootUrl} (${root.problem}) or ${pathUrl} (${specific.problem}).`),
  };
}

/**
 * AU-04. The metadata counts only when its issuer is the authorization server
 * it was fetched for (the one the protected resource metadata names, or else
 * the MCP server's origin): RFC 8414 section 3.3 says metadata whose issuer
 * differs "MUST NOT be used", and the root address tried last may well hold
 * another server's, which AU-05 to AU-07 would then judge instead.
 */
async function authServer(
  transport: Transport,
  issuer: URL | undefined,
  mcpUrl: URL,
): Promise<{ rule: RuleResult; metadata?: JsonObject }> {
  const rule = RULES.authServer;
  const expected = issuer?.href ?? mcpUrl.origin;
  const tried: string[] = [];
  const others: string[] = [];
  for (const url of authServerMetadataUrls(issuer ?? new URL(mcpUrl.origin))) {
    const fetched = await getJson(transport, url);
    if (!fetched.json) {
      tried.push(`${url} (${fetched.problem})`);
      continue;
    }
    const named = fetched.json.issuer;
    if (typeof named === "string" && sameResource(named, expected)) {
      const where = issuer ? "" : ", at the MCP server's origin since no protected resource metadata named an authorization server";
      return { rule: judge(rule, "PASS", `Found at ${url}, for issuer ${clip(named, 100)}${where}.`), metadata: fetched.json };
    }
    others.push(`${url} names ${typeof named === "string" && named ? `issuer ${clip(named, 100)}` : "no issuer"}`);
  }
  const whose = issuer ? `for ${issuer.href}` : "at the MCP server's origin (no protected resource metadata named an authorization server)";
  if (others.length) {
    return {
      rule: judge(
        rule,
        "FAIL",
        `No authorization server metadata ${whose} names it as the issuer: ${listOf(others)}. RFC 8414 says metadata whose issuer isn't the authorization server's own must not be used, so AU-05 to AU-07 aren't judged from it.`,
      ),
    };
  }
  return { rule: judge(rule, "FAIL", `No authorization server metadata ${whose}; tried ${listOf(tried)}.`) };
}

function pkce(metadata: JsonObject): RuleResult {
  const rule = RULES.pkce;
  const methods = metadata.code_challenge_methods_supported;
  if (!Array.isArray(methods)) return judge(rule, "FAIL", "The metadata has no code_challenge_methods_supported, so account linking won't proceed.");
  if (!methods.includes("S256")) {
    return judge(rule, "FAIL", `The metadata's code_challenge_methods_supported is ${clip(JSON.stringify(methods), 80)}, without S256.`);
  }
  return judge(rule, "PASS", "The metadata's code_challenge_methods_supported includes S256.");
}

function endpoints(metadata: JsonObject): RuleResult {
  const rule = RULES.endpoints;
  const problems: string[] = [];
  for (const key of ["authorization_endpoint", "token_endpoint"]) {
    if (metadata[key] === undefined) problems.push(`no ${key}`);
    else if (!parseUrl(metadata[key])) problems.push(`a ${key} that isn't a URL`);
  }
  if (problems.length) return judge(rule, "FAIL", `The metadata has ${problems.join(" and ")}.`);
  return judge(rule, "PASS", `The metadata names authorization_endpoint ${clip(String(metadata.authorization_endpoint), 100)} and token_endpoint ${clip(String(metadata.token_endpoint), 100)}.`);
}

function refreshTokens(metadata: JsonObject): RuleResult {
  const rule = RULES.refreshTokens;
  const grants = metadata.grant_types_supported;
  if (grants === undefined) {
    return judge(rule, "WARN", "The metadata has no grant_types_supported, so refresh token support can't be confirmed.");
  }
  if (!Array.isArray(grants)) return judge(rule, "FAIL", "The metadata's grant_types_supported isn't a list.");
  if (grants.includes("refresh_token")) return judge(rule, "PASS", "The metadata's grant_types_supported includes refresh_token.");
  return judge(
    rule,
    "FAIL",
    `The metadata's grant_types_supported is ${clip(JSON.stringify(grants), 80)}, without refresh_token, so customers would re-link whenever an access token expires.`,
  );
}

function https(serverUrl: string, issuer: URL | undefined, metadata: JsonObject | undefined): RuleResult {
  const rule = RULES.https;
  const urls: [string, unknown][] = [["MCP server", serverUrl]];
  if (issuer) urls.push(["authorization server", issuer.href]);
  if (metadata) urls.push(["authorization_endpoint", metadata.authorization_endpoint], ["token_endpoint", metadata.token_endpoint]);
  const insecure: string[] = [];
  const loopback: string[] = [];
  for (const [label, value] of urls) {
    // AU-06 covers an endpoint that's missing or isn't a URL.
    const url = parseUrl(value);
    if (!url || url.protocol === "https:") continue;
    if (url.protocol === "http:" && isLoopback(url.hostname)) loopback.push(`${label} ${url.href}`);
    else insecure.push(`${label} ${url.href}`);
  }
  if (insecure.length) return judge(rule, "FAIL", `Not HTTPS: ${listOf(insecure)}.`);
  if (loopback.length) return judge(rule, "WARN", `Loopback http:// only works for local development: ${listOf(loopback)}.`);
  return judge(rule, "PASS", "The MCP server and the authorization server's endpoints use HTTPS.");
}

import { dirname } from "node:path";
import { describeError } from "../check/rpc.ts";
import { SOURCES } from "../check/sources.ts";
import { duration, startCallback } from "./callback.ts";
import { discover, quoted, requireHttps, type Discovery } from "./discover.ts";
import { LinkError, pkce, randomState, registerClient, tokenRequest, type Client, type ClientAuth, type TokenAnswer } from "./oauth.ts";
import { DEFAULT_TOKEN_FILE, saveTokens, withAnswer, type SavedTokens } from "./tokens.ts";

/**
 * `alexa-plus-simulator link`: Alexa+'s account linking, run on this machine
 * so a developer gets tokens for a server that needs sign-in instead of
 * bringing one. It discovers the authorization server the way Alexa+ does,
 * signs in with the authorization code flow, PKCE (S256) and the resource
 * parameter in a real browser, and saves the tokens for --token-file.
 */

export { LinkError } from "./oauth.ts";
export { DEFAULT_TOKEN_FILE, REFRESH_MARGIN_MS, REFRESH_RETRY_MS, RENEWAL_GRACE_MS, TokenFile, loadTokens, type SavedTokens } from "./tokens.ts";

/** Next to the proxy's 6277 and the page's 6274. */
export const DEFAULT_CALLBACK_PORT = 6278;
/** Long enough to sign in by hand, short enough that a forgotten tab doesn't keep the port. */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
/** Where a client's secret comes from: never a flag, which would land in shell history. */
export const CLIENT_SECRET_ENV = "ALEXA_SIM_CLIENT_SECRET";

export interface LinkOptions {
  mcpUrl: string;
  /** A client you made, with http://127.0.0.1:<callback port>/callback among its redirect URIs; without one, link registers one if it can. */
  clientId?: string;
  /** That client's secret, from ALEXA_SIM_CLIENT_SECRET; none for a public client. */
  clientSecret?: string;
  /** Where the browser comes back; 0 takes any free port (tests). */
  callbackPort?: number;
  /** Where to save the tokens; DEFAULT_TOKEN_FILE by default. */
  tokenFile?: string;
  /** Opens the sign-in page in a browser; tests follow the redirect themselves. */
  open: (url: string) => unknown;
  out: (line: string) => void;
  fetch?: typeof fetch;
  /** How long to wait for the sign-in to come back. */
  timeoutMs?: number;
  /** Milliseconds since the epoch, for the saved expiry. */
  now?: () => number;
}

export interface Linked {
  file: string;
  tokens: SavedTokens;
}

export async function link(options: LinkOptions): Promise<Linked> {
  const { out } = options;
  const fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  const now = options.now ?? Date.now;
  const mcpUrl = requireHttps("MCP server's URL", options.mcpUrl).href;
  const file = options.tokenFile ?? DEFAULT_TOKEN_FILE;

  out(`Linking ${mcpUrl} the way Alexa+ account linking does.`);
  const found = await discover(mcpUrl, fetchFn);
  out(`  Protected resource metadata: ${found.resourceMetadataUrl}`);
  out(`  Authorization server: ${found.issuer} (metadata at ${found.metadataUrl})`);
  for (const note of found.notes) out(note);

  const state = randomState();
  const callback = await startCallback(options.callbackPort ?? DEFAULT_CALLBACK_PORT, state);
  try {
    const redirectUri = callback.redirectUri;
    const { client, registered } = await chooseClient(options, found, redirectUri, fetchFn);
    const { verifier, challenge } = pkce();
    const authorize = new URL(found.authorizationEndpoint);
    const params: Record<string, string> = {
      response_type: "code",
      client_id: client.id,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      // RFC 8707: the token is for this MCP server, as Amazon's checklist asks ("Set the resource parameter to your MCP server's canonical URI.").
      resource: mcpUrl,
      // "Include scopes from scopes_supported in the PRM document. Omit scope if scopes_supported is undefined."
      ...(found.scopes.length ? { scope: found.scopes.join(" ") } : {}),
    };
    for (const [name, value] of Object.entries(params)) authorize.searchParams.set(name, value);

    out(`  Redirect: ${redirectUri}${registered ? "" : `, which must be one of ${client.id}'s redirect URIs`}`);
    out("Opening your browser to sign in. If it doesn't open, go to:");
    out(`  ${authorize.href}`);
    Promise.resolve()
      .then(() => options.open(authorize.href))
      .catch(() => out("Couldn't open a browser; open the address above yourself."));
    const timeoutMs = options.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
    out(`Waiting up to ${duration(timeoutMs)} for the sign-in to finish...`);
    const code = await callback.wait(timeoutMs);

    let answer: TokenAnswer;
    try {
      // "Include the resource parameter." "Include the PKCE code_verifier."
      answer = await tokenRequest(fetchFn, found.tokenEndpoint, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier, resource: mcpUrl }, client);
    } catch (error) {
      throw new LinkError(`Signed in, but the code wasn't exchanged for tokens: ${describeError(error)}. Nothing was saved.`);
    }
    const tokens = withAnswer(
      {
        version: 1,
        mcpUrl,
        tokenEndpoint: found.tokenEndpoint,
        clientId: client.id,
        clientAuth: client.auth,
        // A registered client's secret exists nowhere else; one you made stays in your environment.
        ...(registered && client.secret ? { clientSecret: client.secret } : {}),
      },
      answer,
      now(),
    );
    const { createdFolder } = await saveTokens(file, tokens);
    summarize(out, file, tokens, answer, createdFolder, registered);
    return { file, tokens };
  } finally {
    await callback.close();
  }
}

/** A client you made, or one registered for testing when the authorization server allows it. */
async function chooseClient(options: LinkOptions, found: Discovery, redirectUri: string, fetchFn: typeof fetch): Promise<{ client: Client; registered: boolean }> {
  const { out } = options;
  const methods = found.authMethods;
  if (options.clientId) {
    const secret = options.clientSecret || undefined;
    const auth = staticAuth(methods, Boolean(secret));
    out(`  Client: ${options.clientId}, ${auth === "none" ? "a public client (no secret)" : `with its secret from ${CLIENT_SECRET_ENV}, sent as ${auth}`}`);
    return { client: { id: options.clientId, ...(auth !== "none" && secret ? { secret } : {}), auth }, registered: false };
  }
  if (options.clientSecret) out(`Note: ${CLIENT_SECRET_ENV} is set, but there's no --client-id for it to go with, so it isn't used.`);
  if (!found.registrationEndpoint) {
    throw new LinkError(
      `Give a client you made for testing with --client-id (and its secret in ${CLIENT_SECRET_ENV}, if it has one), with ${redirectUri} among its redirect URIs: the authorization server has no registration_endpoint, so link can't register one itself. Alexa+ uses a client made the same way, with Alexa's own redirect URIs.`,
    );
  }
  let client: Client;
  try {
    client = await registerClient(fetchFn, found.registrationEndpoint, {
      client_name: "alexa-plus-simulator (development)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: registeredAuth(methods),
      ...(found.scopes.length ? { scope: found.scopes.join(" ") } : {}),
    });
  } catch (error) {
    throw new LinkError(`Couldn't register a client for testing: ${describeError(error)}. Make one yourself and give it with --client-id.`);
  }
  out(`  Client: registered ${client.id} at ${found.registrationEndpoint} (dynamic client registration), ${client.auth === "none" ? "a public client" : `sent as ${client.auth}`}`);
  out(
    `Note: registering is only a shortcut for testing. Alexa+ itself doesn't register ("Dynamic Client Registration (DCR) isn't supported", says Amazon's account linking guide): for Alexa+ you make a client id and secret yourself, with all of Alexa's redirect URIs.`,
  );
  return { client, registered: true };
}

/** How a client you made authenticates: with its secret the way the token endpoint takes one, or as a public client. */
function staticAuth(methods: string[] | undefined, hasSecret: boolean): ClientAuth {
  if (!hasSecret) {
    if (methods && !methods.includes("none")) {
      throw new LinkError(`The token endpoint takes only ${methods.join(", ")}, so set ${CLIENT_SECRET_ENV} to the client's secret (an environment variable, not a flag, to keep it out of shell history).`);
    }
    return "none";
  }
  // RFC 8414: metadata that doesn't list its methods takes client_secret_basic.
  if (!methods || methods.includes("client_secret_basic")) return "client_secret_basic";
  if (methods.includes("client_secret_post")) return "client_secret_post";
  if (methods.includes("none")) return "none";
  throw new LinkError(`The token endpoint takes only ${methods.join(", ")}; link can authenticate a client with client_secret_basic, client_secret_post or none.`);
}

/** What to register: a client with a secret, like the one Alexa+ uses, when the token endpoint takes one. */
function registeredAuth(methods: string[] | undefined): ClientAuth {
  if (!methods) return "client_secret_basic";
  const usable = (["client_secret_basic", "client_secret_post", "none"] as const).find((method) => methods.includes(method));
  if (!usable) throw new LinkError(`The token endpoint takes only ${methods.join(", ")}; link can register a client with client_secret_basic, client_secret_post or none.`);
  return usable;
}

/** What was saved, never the tokens themselves, and what to run next. */
function summarize(out: (line: string) => void, file: string, tokens: SavedTokens, answer: TokenAnswer, createdFolder: boolean, registered: boolean): void {
  const mode = process.platform === "win32" ? "" : "mode 0600, ";
  const git = createdFolder ? `the .gitignore in ${dirname(file)} keeps it out of git` : "keep it out of git: it holds your sign-in";
  out(`Signed in. Saved to ${file} (${mode}${git}):`);
  const lasts = answer.expiresIn === undefined ? "" : answer.expiresIn >= 120 ? `${Math.round(answer.expiresIn / 60)} minutes` : `${answer.expiresIn} seconds`;
  out(`  access token: ${tokens.expiresAt ? `expires ${tokens.expiresAt}, in ${lasts}` : "the server didn't say when it expires"}`);
  out(`  refresh token: ${tokens.refreshToken ? "yes, to get new access tokens as they expire" : "none"}`);
  if (tokens.scope) out(`  scope: ${tokens.scope}`);
  out(`  for refreshing: the token endpoint ${tokens.tokenEndpoint} and client ${tokens.clientId}${registered && tokens.clientSecret ? ", with the registered client's secret" : ""}`);
  if (!tokens.refreshToken) {
    out(`Warning: the token endpoint returned no refresh token, so this sign-in ends when the access token does. Amazon's account linking guide: ${quoted(SOURCES.refreshTokens)}`);
  }
  // Quoted only when a shell needs it: a ~ inside a path (Windows' short names, like RUNNER~1) is fine, one at the start isn't.
  const arg = /^[\w./:@\\-][\w./:@\\~-]*$/.test(file) ? file : `"${file}"`;
  out("Next:");
  out(`  alexa-plus-simulator check ${tokens.mcpUrl} --token-file ${arg}`);
  out(`  alexa-plus-simulator ${tokens.mcpUrl} --token-file ${arg}`);
  if (!registered && tokens.clientAuth !== "none") out(`Refreshing sends the client's secret, so keep ${CLIENT_SECRET_ENV} set when you run those.`);
}

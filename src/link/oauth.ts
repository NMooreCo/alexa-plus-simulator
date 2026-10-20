import { createHash, randomBytes } from "node:crypto";
import { clip, describeError, isObject, type JsonObject } from "../check/rpc.ts";

/**
 * The OAuth requests account linking makes, written out with fetch: PKCE,
 * the client's authentication at the token endpoint, the token and refresh
 * grants, and dynamic client registration for development.
 */

/** Something that stops linking, said plainly; the CLI prints it and exits with 1. */
export class LinkError extends Error {}

/** How the client proves itself at the token endpoint, by the names RFC 7591 and RFC 8414 use. */
export type ClientAuth = "client_secret_basic" | "client_secret_post" | "none";
export const CLIENT_AUTHS: readonly ClientAuth[] = ["client_secret_basic", "client_secret_post", "none"];

export interface Client {
  id: string;
  secret?: string;
  auth: ClientAuth;
}

/** A PKCE pair (RFC 7636): the verifier stays here, and its S256 challenge goes in the authorization request. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The state that ties the browser's return to this sign-in, so a stray or forged callback is refused. */
export function randomState(): string {
  return randomBytes(16).toString("base64url");
}

/** RFC 6749 form-encodes the client id and secret before HTTP Basic joins them, so a colon in either stays unambiguous. */
function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

export function basicAuth(id: string, secret: string): string {
  return `Basic ${Buffer.from(`${formEncode(id)}:${formEncode(secret)}`).toString("base64")}`;
}

/** Long enough for a slow authorization server, short enough that a hung one says so. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * POSTs to an authorization server endpoint and returns its JSON answer.
 * Redirects aren't followed: one would carry the client's credentials to
 * wherever it points. Throws an Error saying what came back.
 */
async function post(fetchFn: typeof fetch, url: string, init: RequestInit, what: string): Promise<JsonObject> {
  let response: Response;
  try {
    response = await fetchFn(url, { ...init, method: "POST", redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    throw new Error(`the ${what} at ${url} ${timedOut ? `didn't answer within ${REQUEST_TIMEOUT_MS / 1000} seconds` : `couldn't be reached: ${describeError(error)}`}`);
  }
  const text = await response.text();
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    throw new Error(`the ${what} answered with a redirect (HTTP ${response.status}${location ? ` to ${location}` : ""}); name its final address in the metadata`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const said = isObject(json) && typeof json.error === "string" ? `${json.error}${typeof json.error_description === "string" && json.error_description ? ` (${clip(json.error_description, 160)})` : ""}` : clip(text, 120);
    throw new Error(`the ${what} answered HTTP ${response.status}${said ? `: ${said}` : ""}`);
  }
  if (!isObject(json)) throw new Error(`the ${what} answered HTTP ${response.status} with something that isn't a JSON object: ${clip(text, 80) || "an empty body"}`);
  return json;
}

export interface TokenAnswer {
  accessToken: string;
  refreshToken?: string;
  /** Seconds the access token lasts, when the server said. */
  expiresIn?: number;
  scope?: string;
}

/** Sends a grant to the token endpoint, authenticating the client the way it was registered. */
export async function tokenRequest(fetchFn: typeof fetch, endpoint: string, grant: Record<string, string>, client: Client): Promise<TokenAnswer> {
  const body = new URLSearchParams(grant);
  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  if (client.auth === "client_secret_basic") headers.Authorization = basicAuth(client.id, client.secret ?? "");
  else {
    body.set("client_id", client.id);
    if (client.auth === "client_secret_post") body.set("client_secret", client.secret ?? "");
  }
  const json = await post(fetchFn, endpoint, { headers, body }, "token endpoint");
  if (typeof json.access_token !== "string" || !json.access_token) throw new Error("the token endpoint's answer has no access_token");
  // Some servers send expires_in as a string; anything else unreadable means the expiry is unknown.
  const expiresIn = Number(json.expires_in);
  return {
    accessToken: json.access_token,
    ...(typeof json.refresh_token === "string" && json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(json.expires_in !== undefined && Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresIn } : {}),
    ...(typeof json.scope === "string" && json.scope ? { scope: json.scope } : {}),
  };
}

/** RFC 7591 dynamic client registration: what the server registered, including the auth method it settled on. */
export async function registerClient(fetchFn: typeof fetch, endpoint: string, metadata: JsonObject): Promise<Client> {
  const json = await post(
    fetchFn,
    endpoint,
    { headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(metadata) },
    "registration endpoint",
  );
  if (typeof json.client_id !== "string" || !json.client_id) throw new Error("the registration endpoint's answer has no client_id");
  const secret = typeof json.client_secret === "string" && json.client_secret ? json.client_secret : undefined;
  const method = json.token_endpoint_auth_method;
  const named = CLIENT_AUTHS.find((auth) => auth === method);
  if (method !== undefined && !named) throw new Error(`the registration endpoint registered a client that authenticates with ${clip(String(method), 40)}, which link can't use`);
  // RFC 7591 defaults to client_secret_basic, which only means something when a secret came back.
  const auth: ClientAuth = named ?? (secret ? "client_secret_basic" : "none");
  if (auth !== "none" && !secret) throw new Error(`the registration endpoint registered a client that authenticates with ${auth} but sent no client_secret`);
  return { id: json.client_id, ...(secret ? { secret } : {}), auth };
}

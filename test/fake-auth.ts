import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for an add-on that needs sign-in, for link's tests: an OAuth
 * authorization server (metadata, authorize, token, registration) and a small
 * MCP server that takes only the access tokens it issued, on 127.0.0.1. It's
 * strict where a real one is (PKCE, redirect URIs, client authentication), so
 * a test passes only when link does what an authorization server expects.
 */

export type ClientAuth = "client_secret_basic" | "client_secret_post" | "none";

export interface FakeClient {
  id: string;
  secret?: string;
  auth: ClientAuth;
  /** A loopback redirect matches whatever its port, as RFC 8252 asks of an authorization server. */
  redirectUris: string[];
}

export interface FakeAuthOptions {
  /** Where the protected resource metadata is: the root, as Amazon asks; only RFC 9728's path-specific address; or nowhere. */
  prm?: "root" | "path" | "none";
  /** The issuer's path, like "/tenant-1", so its metadata is at RFC 8414's inserted address. */
  issuerPath?: string;
  /** Serve the authorization server's metadata only as OpenID configuration. */
  openIdOnly?: boolean;
  /** code_challenge_methods_supported; null leaves it out. */
  challengeMethods?: string[] | null;
  /** token_endpoint_auth_methods_supported, left out when undefined. */
  authMethods?: string[];
  /** Offer dynamic client registration. */
  registration?: boolean;
  scopes?: string[];
  /** Seconds an access token lasts. */
  expiresIn?: number;
  /** Issue refresh tokens (the default). */
  refreshTokens?: boolean;
  /** A new refresh token with every refresh (the default). */
  rotate?: boolean;
  /** How the person at the authorization page answers. */
  consent?: "approve" | "deny" | "wrong-state";
}

export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: string;
}

const FORECAST = {
  name: "get_forecast",
  description: "Today's forecast.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

function sameRedirect(registered: string, given: string): boolean {
  const a = new URL(registered);
  const b = new URL(given);
  if (isLoopback(a) && isLoopback(b)) return a.protocol === b.protocol && a.hostname === b.hostname && a.pathname === b.pathname;
  return a.href === b.href;
}

/** Form decoding, as RFC 6749 has a client's id and secret encoded inside HTTP Basic. */
const formDecode = (text: string) => decodeURIComponent(text.replace(/\+/g, " "));

export class FakeAuth {
  origin = "";
  mcpUrl = "";
  issuer = "";
  readonly seen: Seen[] = [];
  readonly clients = new Map<string, FakeClient>();
  /** The access tokens /mcp takes. */
  readonly accessTokens = new Set<string>();
  /** Live refresh tokens, and the client each was issued to. */
  readonly refreshTokens = new Map<string, string>();
  /** Every token request, parsed, in order. */
  readonly grants: URLSearchParams[] = [];
  private readonly codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string | null }>();
  private issued = 0;
  private readonly server: Server;

  private constructor(readonly options: FakeAuthOptions) {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
  }

  static async start(options: FakeAuthOptions = {}): Promise<FakeAuth> {
    const fake = new FakeAuth(options);
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    fake.origin = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
    fake.mcpUrl = `${fake.origin}/mcp`;
    fake.issuer = `${fake.origin}${options.issuerPath ?? ""}`;
    return fake;
  }

  addClient(client: FakeClient): void {
    this.clients.set(client.id, client);
  }

  /** Plays the browser: opens the authorization page, then follows its redirect back to link's callback. */
  async browse(url: string): Promise<void> {
    const page = await fetch(url, { redirect: "manual" });
    const location = page.headers.get("location");
    if (page.status !== 302 || !location) throw new Error(`The authorization page answered ${page.status}: ${await page.text()}`);
    await (await fetch(location)).text();
  }

  /** The /mcp endpoint stops taking this token, as a server does once one expires or is revoked. */
  revoke(token: string): void {
    this.accessTokens.delete(token);
  }

  /** The requests to a path, like "/authorize". */
  requests(path: string): Seen[] {
    return this.seen.filter((seen) => seen.path === path);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  get metadata(): Record<string, unknown> {
    const o = this.options;
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.origin}/authorize`,
      token_endpoint: `${this.origin}/token`,
      ...(o.challengeMethods === null ? {} : { code_challenge_methods_supported: o.challengeMethods ?? ["S256"] }),
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      ...(o.authMethods ? { token_endpoint_auth_methods_supported: o.authMethods } : {}),
      ...(o.registration ? { registration_endpoint: `${this.origin}/register` } : {}),
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", this.origin);
    this.seen.push({ method: request.method ?? "", path: url.pathname, query: url.searchParams, headers: request.headers, body });
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    const o = this.options;
    const prm = { resource: this.mcpUrl, authorization_servers: [this.issuer], scopes_supported: o.scopes ?? ["forecast:read"] };
    const path = o.issuerPath ?? "";

    if (url.pathname === "/.well-known/oauth-protected-resource" && (o.prm ?? "root") === "root") return json(200, prm);
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" && o.prm === "path") return json(200, prm);
    if (!o.openIdOnly && url.pathname === `/.well-known/oauth-authorization-server${path}`) return json(200, this.metadata);
    if (o.openIdOnly && url.pathname === `${path}/.well-known/openid-configuration`) return json(200, this.metadata);
    if (url.pathname === "/authorize") return this.authorize(url.searchParams, response);
    if (url.pathname === "/token" && request.method === "POST") return this.token(request.headers, new URLSearchParams(body), json);
    if (url.pathname === "/register" && request.method === "POST" && o.registration) return this.register(JSON.parse(body) as Record<string, unknown>, json);
    if (url.pathname === "/mcp") return this.mcp(request, body, response, json);
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found");
  }

  private authorize(query: URLSearchParams, response: ServerResponse): void {
    const fail = (why: string): void => {
      response.writeHead(400, { "content-type": "text/plain" }).end(why);
    };
    const client = this.clients.get(query.get("client_id") ?? "");
    if (!client) return fail("unknown client_id");
    const redirect = query.get("redirect_uri") ?? "";
    if (!client.redirectUris.some((uri) => sameRedirect(uri, redirect))) return fail(`redirect_uri ${redirect} isn't registered`);
    if (query.get("response_type") !== "code") return fail("response_type must be code");
    if (query.get("code_challenge_method") !== "S256" || !query.get("code_challenge")) return fail("PKCE with S256 is required");
    const back = new URL(redirect);
    const state = query.get("state") ?? "";
    const consent = this.options.consent ?? "approve";
    if (consent === "deny") {
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("error_description", "The person said no");
      back.searchParams.set("state", state);
    } else {
      const code = `code-${++this.issued}`;
      this.codes.set(code, { clientId: client.id, redirectUri: redirect, challenge: query.get("code_challenge")!, resource: query.get("resource") });
      back.searchParams.set("code", code);
      back.searchParams.set("state", consent === "wrong-state" ? "someone-elses-state" : state);
    }
    response.writeHead(302, { location: back.href }).end();
  }

  /** The client the request authenticates as, held to the method it registered with; undefined when it doesn't. */
  private authenticate(headers: IncomingHttpHeaders, form: URLSearchParams): FakeClient | undefined {
    const basic = headers.authorization?.startsWith("Basic ") ? Buffer.from(headers.authorization.slice(6), "base64").toString("utf8") : undefined;
    if (basic !== undefined) {
      const [id = "", secret = ""] = basic.split(":").map(formDecode);
      const client = this.clients.get(id);
      return client?.auth === "client_secret_basic" && client.secret === secret && !form.has("client_secret") ? client : undefined;
    }
    const client = this.clients.get(form.get("client_id") ?? "");
    if (client?.auth === "client_secret_post") return form.get("client_secret") === client.secret ? client : undefined;
    return client?.auth === "none" && !form.has("client_secret") ? client : undefined;
  }

  private token(headers: IncomingHttpHeaders, form: URLSearchParams, json: (status: number, value: unknown) => void): void {
    this.grants.push(form);
    const client = this.authenticate(headers, form);
    if (!client) return json(401, { error: "invalid_client", error_description: "Client authentication failed" });
    const o = this.options;
    const issue = (scope: string | undefined, refresh?: string) => {
      const accessToken = `access-${++this.issued}`;
      this.accessTokens.add(accessToken);
      let refreshToken = refresh;
      if (o.refreshTokens !== false && (!refreshToken || o.rotate !== false)) {
        if (refreshToken) this.refreshTokens.delete(refreshToken);
        refreshToken = `refresh-${++this.issued}`;
        this.refreshTokens.set(refreshToken, client.id);
      }
      json(200, {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: o.expiresIn ?? 3600,
        ...(o.refreshTokens === false || (refresh && o.rotate === false) ? {} : { refresh_token: refreshToken }),
        ...(scope ? { scope } : {}),
      });
    };

    if (form.get("grant_type") === "authorization_code") {
      const code = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      if (!code || code.clientId !== client.id || code.redirectUri !== form.get("redirect_uri")) return json(400, { error: "invalid_grant", error_description: "Unknown code" });
      const verifier = form.get("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== code.challenge) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
      if (form.get("resource") !== code.resource) return json(400, { error: "invalid_target", error_description: "The resource changed" });
      return issue((o.scopes ?? ["forecast:read"]).join(" "));
    }
    if (form.get("grant_type") === "refresh_token") {
      const refresh = form.get("refresh_token") ?? "";
      if (this.refreshTokens.get(refresh) !== client.id) return json(400, { error: "invalid_grant", error_description: "Refresh token is invalid" });
      return issue(undefined, refresh);
    }
    json(400, { error: "unsupported_grant_type" });
  }

  private register(metadata: Record<string, unknown>, json: (status: number, value: unknown) => void): void {
    const auth = (metadata.token_endpoint_auth_method as ClientAuth | undefined) ?? "client_secret_basic";
    const id = `registered-${++this.issued}`;
    const client: FakeClient = { id, auth, redirectUris: metadata.redirect_uris as string[], ...(auth === "none" ? {} : { secret: `secret-${this.issued}` }) };
    this.addClient(client);
    json(201, { client_id: id, ...(client.secret ? { client_secret: client.secret } : {}), token_endpoint_auth_method: auth, redirect_uris: client.redirectUris });
  }

  private mcp(request: IncomingMessage, body: string, response: ServerResponse, json: (status: number, value: unknown) => void): void {
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined;
    // 401 without WWW-Authenticate, as Amazon's checklist asks.
    if (!bearer || !this.accessTokens.has(bearer)) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const message = JSON.parse(body) as { id?: string | number; method: string; params?: { name?: string } };
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const reply = (payload: Record<string, unknown>) => json(200, { jsonrpc: "2.0", id: message.id, ...payload });
    switch (message.method) {
      case "initialize":
        return reply({ result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fake-auth", version: "1.0.0" } } });
      case "tools/list":
        return reply({ result: { tools: [FORECAST] } });
      case "tools/call":
        if (message.params?.name !== FORECAST.name) return reply({ error: { code: -32602, message: `Unknown tool: ${message.params?.name}` } });
        return reply({ result: { content: [{ type: "text", text: "Sunny." }], structuredContent: { summary: "Sunny" } } });
      default:
        return reply({ error: { code: -32601, message: "Method not found" } });
    }
  }
}

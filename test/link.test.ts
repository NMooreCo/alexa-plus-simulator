import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runChecks } from "../src/check/index.ts";
import { LinkError, REFRESH_MARGIN_MS, RENEWAL_GRACE_MS, TokenFile, link, loadTokens, type LinkOptions, type SavedTokens } from "../src/link/index.ts";
import { startProxy, type RunningProxy } from "../src/proxy/index.ts";
import type { ReadinessReport } from "../src/shared/contract.ts";
import { FakeAuth, type FakeAuthOptions } from "./fake-auth.ts";

const running: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((thing) => thing.close()));
});

async function fake(options: FakeAuthOptions = {}): Promise<FakeAuth> {
  const auth = await FakeAuth.start(options);
  running.push(auth);
  return auth;
}

/** A fake with a client made the way Alexa+'s is: an id and a secret, with a loopback redirect. */
async function withClient(options: FakeAuthOptions = {}, auth: "client_secret_basic" | "client_secret_post" | "none" = "client_secret_basic") {
  const server = await fake(options);
  server.addClient({ id: "my-client", auth, redirectUris: ["http://127.0.0.1/callback"], ...(auth === "none" ? {} : { secret: "s3cret:with/odd chars" }) });
  return server;
}

async function freshFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "alexa-sim-link-")), ".alexa-plus-simulator", "tokens.json");
}

/** Runs link against the fake, which plays the browser, so no real browser opens. */
async function linkTo(auth: FakeAuth, options: Partial<LinkOptions> = {}) {
  const lines: string[] = [];
  const file = options.tokenFile ?? (await freshFile());
  const linked = link({
    mcpUrl: auth.mcpUrl,
    callbackPort: 0,
    tokenFile: file,
    open: (url) => auth.browse(url),
    out: (line) => lines.push(line),
    timeoutMs: 5000,
    ...options,
  });
  return { linked, lines, file };
}

async function linked(auth: FakeAuth, options: Partial<LinkOptions> = {}) {
  const run = await linkTo(auth, options);
  const result = await run.linked;
  return { ...run, ...result };
}

const ruleOf = (report: ReadinessReport, id: string) => report.rules.find((r) => r.id === id)!;
const refreshGrants = (auth: FakeAuth) => auth.grants.filter((grant) => grant.get("grant_type") === "refresh_token");

describe("link's discovery", () => {
  it("finds the authorization server from the protected resource metadata at the root, as Alexa+ does", async () => {
    const auth = await fake({ registration: true });
    const { lines } = await linked(auth);
    expect(lines).toContain(`  Protected resource metadata: ${auth.origin}/.well-known/oauth-protected-resource`);
    expect(lines).toContain(`  Authorization server: ${auth.issuer} (metadata at ${auth.origin}/.well-known/oauth-authorization-server)`);
    expect(lines.filter((line) => line.startsWith("Note: the protected"))).toEqual([]);
  });

  it("falls back to RFC 9728's path-specific document, saying Alexa+ reads the root", async () => {
    const auth = await fake({ registration: true, prm: "path" });
    const { lines } = await linked(auth);
    const note = lines.find((line) => line.startsWith("Note: the protected resource metadata is only at"))!;
    expect(note).toContain(`${auth.origin}/.well-known/oauth-protected-resource/mcp`);
    expect(note).toContain(`Alexa+ reads ${auth.origin}/.well-known/oauth-protected-resource`);
  });

  it("refuses when there's no protected resource metadata at all", async () => {
    const auth = await fake({ registration: true, prm: "none" });
    const { linked: run } = await linkTo(auth);
    await expect(run).rejects.toThrow(LinkError);
    await expect(run).rejects.toThrow(`Alexa+ reads ${auth.origin}/.well-known/oauth-protected-resource to find your authorization server`);
  });

  it("finds an issuer's metadata at RFC 8414's inserted address", async () => {
    const auth = await fake({ registration: true, issuerPath: "/tenant-1" });
    const { lines } = await linked(auth);
    expect(lines).toContain(`  Authorization server: ${auth.origin}/tenant-1 (metadata at ${auth.origin}/.well-known/oauth-authorization-server/tenant-1)`);
  });

  it("falls back to OpenID configuration, saying Amazon asks for the OAuth one", async () => {
    const auth = await fake({ registration: true, openIdOnly: true });
    const { lines } = await linked(auth);
    const note = lines.find((line) => line.includes("as OpenID configuration"))!;
    expect(note).toContain(`${auth.origin}/.well-known/openid-configuration`);
    expect(note).toContain("Your auth server metadata is available at /.well-known/oauth-authorization-server.");
  });

  it.each([
    ["lists only plain", ["plain"], `lists code_challenge_methods_supported ["plain"], without S256`],
    ["lists no methods", null, "has no code_challenge_methods_supported"],
  ])("refuses an authorization server that %s, quoting why", async (_, challengeMethods, why) => {
    const auth = await fake({ registration: true, challengeMethods });
    const { linked: run, lines } = await linkTo(auth);
    await expect(run).rejects.toThrow(why);
    await expect(run).rejects.toThrow(`"code_challenge_methods_supported must be present and must include S256. Account linking won't proceed without it."`);
    expect(lines.some((line) => line.startsWith("Opening your browser"))).toBe(false);
    expect(auth.requests("/register")).toEqual([]);
  });
});

describe("link's client", () => {
  it("registers a client for testing when given none, and says Alexa+ uses one you make", async () => {
    const auth = await fake({ registration: true });
    const { lines, tokens } = await linked(auth);
    const [registration] = auth.requests("/register");
    expect(JSON.parse(registration!.body)).toMatchObject({
      redirect_uris: [expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(lines.join("\n")).toContain(`"Dynamic Client Registration (DCR) isn't supported"`);
    // The registered client's secret lives nowhere else, so it's saved with the tokens.
    expect(tokens).toMatchObject({ clientId: expect.stringMatching(/^registered-/), clientAuth: "client_secret_basic", clientSecret: expect.any(String) });
  });

  it("uses a client you made, sending its secret with HTTP Basic, and never saves that secret", async () => {
    const auth = await withClient();
    const { tokens } = await linked(auth, { clientId: "my-client", clientSecret: "s3cret:with/odd chars" });
    const exchange = auth.requests("/token")[0]!;
    expect(exchange.headers.authorization).toMatch(/^Basic /);
    expect(new URLSearchParams(exchange.body).has("client_secret")).toBe(false);
    expect(tokens).toMatchObject({ clientId: "my-client", clientAuth: "client_secret_basic" });
    expect(tokens.clientSecret).toBeUndefined();
  });

  it("sends the secret in the body when the token endpoint takes only client_secret_post", async () => {
    const auth = await withClient({ authMethods: ["client_secret_post"] }, "client_secret_post");
    const { tokens } = await linked(auth, { clientId: "my-client", clientSecret: "s3cret:with/odd chars" });
    const exchange = auth.requests("/token")[0]!;
    expect(exchange.headers.authorization).toBeUndefined();
    expect(new URLSearchParams(exchange.body).get("client_secret")).toBe("s3cret:with/odd chars");
    expect(tokens.clientAuth).toBe("client_secret_post");
  });

  it("signs in as a public client when there's no secret", async () => {
    const auth = await withClient({ authMethods: ["none", "client_secret_basic"] }, "none");
    const { tokens, lines } = await linked(auth, { clientId: "my-client" });
    const form = new URLSearchParams(auth.requests("/token")[0]!.body);
    expect(form.get("client_id")).toBe("my-client");
    expect(form.has("client_secret")).toBe(false);
    expect(tokens.clientAuth).toBe("none");
    expect(lines).toContain("  Client: my-client, a public client (no secret)");
  });

  it("asks for the secret when the token endpoint only takes clients that have one", async () => {
    const auth = await withClient({ authMethods: ["client_secret_basic"] });
    const { linked: run, lines } = await linkTo(auth, { clientId: "my-client" });
    await expect(run).rejects.toThrow("set ALEXA_SIM_CLIENT_SECRET to the client's secret");
    expect(lines.some((line) => line.startsWith("Opening your browser"))).toBe(false);
  });

  it("says how to give a client when it can't register one", async () => {
    const auth = await fake();
    const { linked: run } = await linkTo(auth);
    await expect(run).rejects.toThrow(/Give a client you made for testing with --client-id .* with http:\/\/127\.0\.0\.1:\d+\/callback among its redirect URIs/);
  });
});

describe("link's sign-in", () => {
  it("signs in with PKCE (S256), the resource and the scopes, and saves the tokens privately", async () => {
    const auth = await withClient({ scopes: ["forecast:read", "tasks:write"] });
    const before = Date.now();
    const { tokens, lines, file } = await linked(auth, { clientId: "my-client", clientSecret: "s3cret:with/odd chars" });

    const authorize = auth.requests("/authorize")[0]!.query;
    expect(Object.fromEntries(authorize)).toMatchObject({
      response_type: "code",
      client_id: "my-client",
      code_challenge_method: "S256",
      resource: auth.mcpUrl,
      scope: "forecast:read tasks:write",
      redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/callback$/),
    });
    expect(authorize.get("state")!.length).toBeGreaterThanOrEqual(16);
    const exchange = new URLSearchParams(auth.requests("/token")[0]!.body);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("resource")).toBe(auth.mcpUrl);
    expect(exchange.get("redirect_uri")).toBe(authorize.get("redirect_uri"));
    expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(authorize.get("code_challenge"));

    const saved = JSON.parse(await readFile(file, "utf8")) as SavedTokens;
    expect(saved).toEqual(tokens);
    expect(saved).toMatchObject({
      version: 1,
      mcpUrl: auth.mcpUrl,
      tokenEndpoint: `${auth.origin}/token`,
      clientId: "my-client",
      clientAuth: "client_secret_basic",
      accessToken: [...auth.accessTokens][0],
      refreshToken: [...auth.refreshTokens.keys()][0],
      scope: "forecast:read tasks:write",
    });
    const expires = Date.parse(saved.expiresAt!);
    expect(expires).toBeGreaterThanOrEqual(before + 3600_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 3600_000);
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700);
    }
    expect(await readFile(join(dirname(file), ".gitignore"), "utf8")).toMatch(/^\*$/m);

    const printed = lines.join("\n");
    expect(printed).not.toContain(saved.accessToken);
    expect(printed).not.toContain(saved.refreshToken);
    expect(printed).not.toContain("s3cret");
    expect(lines).toContain(`  alexa-plus-simulator check ${auth.mcpUrl} --token-file ${file}`);
    expect(lines).toContain(`  alexa-plus-simulator ${auth.mcpUrl} --token-file ${file}`);
    expect(printed).toContain("keep ALEXA_SIM_CLIENT_SECRET set");
  });

  it("refuses a sign-in that comes back with another state, saving nothing", async () => {
    const auth = await withClient({ consent: "wrong-state" });
    const { linked: run, file } = await linkTo(auth, { clientId: "my-client", clientSecret: "s3cret:with/odd chars" });
    await expect(run).rejects.toThrow("came back with a state that isn't this sign-in's");
    expect(auth.requests("/token")).toEqual([]);
    await expect(stat(file)).rejects.toThrow();
  });

  it("says so when the person doesn't consent, saving nothing", async () => {
    const auth = await withClient({ consent: "deny" });
    const { linked: run, file } = await linkTo(auth, { clientId: "my-client", clientSecret: "s3cret:with/odd chars" });
    await expect(run).rejects.toThrow("The authorization server answered access_denied (The person said no), so nothing was saved.");
    await expect(stat(file)).rejects.toThrow();
  });

  it("gives up when no sign-in comes back in time", async () => {
    const auth = await withClient();
    const { linked: run } = await linkTo(auth, { clientId: "my-client", clientSecret: "s3cret:with/odd chars", open: () => undefined, timeoutMs: 100 });
    await expect(run).rejects.toThrow("No sign-in came back within 100 ms, so nothing was saved.");
  });

  it("warns, quoting Amazon, when the token endpoint returns no refresh token", async () => {
    const auth = await fake({ registration: true, refreshTokens: false });
    const { lines, tokens } = await linked(auth);
    expect(tokens.refreshToken).toBeUndefined();
    expect(lines.join("\n")).toContain(
      `Warning: the token endpoint returned no refresh token, so this sign-in ends when the access token does. Amazon's account linking guide: "Your token endpoint must return a refresh token alongside every access token.`,
    );
  });

  it("keeps a token file in a folder of yours as it is, without adding a .gitignore", async () => {
    const auth = await fake({ registration: true });
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-link-"));
    const { lines } = await linked(auth, { tokenFile: join(dir, "tokens.json") });
    await expect(stat(join(dir, ".gitignore"))).rejects.toThrow();
    expect(lines.find((line) => line.startsWith("Signed in."))).toContain("keep it out of git");
  });
});

describe("a token file in use", () => {
  it("refreshes a token within a minute of expiring, without the resource parameter, and saves the rotated tokens", async () => {
    const auth = await fake({ registration: true });
    const { file, tokens } = await linked(auth);
    const almost = Date.parse(tokens.expiresAt!) - REFRESH_MARGIN_MS + 1;
    const tokenFile = await TokenFile.load(file, { env: {}, now: () => almost });
    const fresh = await tokenFile.token();
    expect(fresh).not.toBe(tokens.accessToken);
    expect(auth.accessTokens.has(fresh)).toBe(true);
    const [grant] = refreshGrants(auth);
    expect(grant!.get("refresh_token")).toBe(tokens.refreshToken);
    // Alexa+ leaves the resource out of a refresh, and so does this.
    expect(grant!.has("resource")).toBe(false);
    const saved = await loadTokens(file);
    expect(saved.accessToken).toBe(fresh);
    expect(saved.refreshToken).not.toBe(tokens.refreshToken);
    expect(auth.refreshTokens.has(saved.refreshToken!)).toBe(true);
    expect(Date.parse(saved.expiresAt!)).toBe(almost + 3600_000);
  });

  it("leaves a token with more than a minute to go alone", async () => {
    const auth = await fake({ registration: true });
    const { file, tokens } = await linked(auth);
    const tokenFile = await TokenFile.load(file, { env: {}, now: () => Date.parse(tokens.expiresAt!) - REFRESH_MARGIN_MS - 1000 });
    expect(await tokenFile.token()).toBe(tokens.accessToken);
    expect(refreshGrants(auth)).toEqual([]);
  });

  it("refreshes once after a 401 and sends the request again, in the check", async () => {
    const auth = await fake({ registration: true });
    const { file, tokens } = await linked(auth);
    auth.revoke(tokens.accessToken);
    const report = await runChecks({ serverUrl: auth.mcpUrl, token: await TokenFile.load(file, { env: {} }), now: () => 0 });
    expect(ruleOf(report, "DL-01").status).toBe("PASS");
    expect(ruleOf(report, "DL-05").status).toBe("PASS");
    // The one refresh the 401 brought on is what AU-09 reports; the check didn't refresh again.
    expect(refreshGrants(auth)).toHaveLength(1);
    expect(ruleOf(report, "AU-09")).toMatchObject({
      status: "PASS",
      notes: "A refresh with the saved refresh token returned a new access token and a new refresh token, both saved back to the token file.",
    });
    const mcp = auth.requests("/mcp").map((seen) => seen.headers.authorization);
    expect(mcp[0]).toBe(`Bearer ${tokens.accessToken}`);
    expect(mcp[1]).toBe(`Bearer ${(await loadTokens(file)).accessToken}`);
  });

  it("confirms refreshing works in the check when nothing else needed a refresh", async () => {
    const auth = await fake({ registration: true, rotate: false });
    const { file, tokens } = await linked(auth);
    const report = await runChecks({ serverUrl: auth.mcpUrl, token: await TokenFile.load(file, { env: {} }), now: () => 0 });
    expect(refreshGrants(auth)).toHaveLength(1);
    expect(ruleOf(report, "AU-09")).toMatchObject({
      status: "PASS",
      notes: "A refresh with the saved refresh token returned a new access token, saved back to the token file (the refresh token stays the same).",
    });
    const saved = await loadTokens(file);
    expect(saved.refreshToken).toBe(tokens.refreshToken);
    expect(saved.accessToken).not.toBe(tokens.accessToken);
    // Everything else about sign-in passes against this server, but for plain http on loopback.
    const auth8 = report.rules.filter((r) => r.category === "auth" && r.id !== "AU-09").map((r) => r.status);
    expect(auth8).toEqual(["PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "PASS", "WARN"]);
  });

  it("fails AU-09 when the refresh token is refused, and says to link again", async () => {
    const auth = await fake({ registration: true });
    const { file } = await linked(auth);
    auth.refreshTokens.clear();
    const report = await runChecks({ serverUrl: auth.mcpUrl, token: await TokenFile.load(file, { env: {} }), now: () => 0 });
    expect(ruleOf(report, "DL-01").status).toBe("PASS");
    const rule = ruleOf(report, "AU-09");
    expect(rule.status).toBe("FAIL");
    expect(rule.notes).toContain("invalid_grant (Refresh token is invalid)");
    expect(rule.notes).toContain("link again");
    expect(rule.source.quote).toContain("Your token endpoint must return a refresh token alongside every access token.");
  });

  it("fails AU-09 when link got no refresh token", async () => {
    const auth = await fake({ registration: true, refreshTokens: false });
    const { file } = await linked(auth);
    const report = await runChecks({ serverUrl: auth.mcpUrl, token: await TokenFile.load(file, { env: {} }), now: () => 0 });
    expect(ruleOf(report, "AU-09")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("The token file has no refresh token") });
  });

  it("skips AU-09 when refreshing needs a client secret that isn't set", async () => {
    const auth = await withClient();
    const { file } = await linked(auth, { clientId: "my-client", clientSecret: "s3cret:with/odd chars" });
    const report = await runChecks({ serverUrl: auth.mcpUrl, token: await TokenFile.load(file, { env: {} }), now: () => 0 });
    expect(ruleOf(report, "AU-09")).toMatchObject({ status: "SKIP", notes: expect.stringContaining("set ALEXA_SIM_CLIENT_SECRET") });
    expect(refreshGrants(auth)).toEqual([]);

    // With the secret set, the refresh authenticates the way the client was made.
    const withSecret = await runChecks({ serverUrl: auth.mcpUrl, token: await TokenFile.load(file, { env: { ALEXA_SIM_CLIENT_SECRET: "s3cret:with/odd chars" } }), now: () => 0 });
    expect(ruleOf(withSecret, "AU-09").status).toBe("PASS");
    expect(auth.requests("/token").at(-1)!.headers.authorization).toMatch(/^Basic /);
  });

  it("stops the check and says to link again when an expired sign-in can't be refreshed", async () => {
    const auth = await fake({ registration: true });
    const { file, tokens } = await linked(auth);
    auth.refreshTokens.clear();
    const later = () => Date.parse(tokens.expiresAt!) + 1000;
    const tokenFile = await TokenFile.load(file, { env: {}, now: later });
    const expected = `The sign-in saved in ${file} has expired and couldn't be refreshed: the token endpoint answered HTTP 400: invalid_grant (Refresh token is invalid). Run alexa-plus-simulator link ${auth.mcpUrl} to sign in again.`;
    await expect(tokenFile.token()).rejects.toThrow(expected);
    await expect(runChecks({ serverUrl: auth.mcpUrl, token: tokenFile, now: () => 0 })).rejects.toThrow(expected);
    // It tried once, and doesn't keep knocking.
    expect(refreshGrants(auth)).toHaveLength(1);
  });

  it("doesn't refresh again when the server refuses a token refreshed moments ago", async () => {
    const auth = await fake({ registration: true });
    const { file, tokens } = await linked(auth);
    const warnings: string[] = [];
    let clock = Date.now();
    const tokenFile = await TokenFile.load(file, { env: {}, now: () => clock, warn: (line) => warnings.push(line) });
    auth.revoke(tokens.accessToken);
    const fresh = await tokenFile.renew(tokens.accessToken);
    expect(fresh).toBe((await loadTokens(file)).accessToken);
    // A server refusing every token would otherwise set off a refresh for each request.
    expect(await tokenFile.renew(fresh!)).toBeUndefined();
    expect(refreshGrants(auth)).toHaveLength(1);
    expect(warnings).toEqual([
      `The MCP server refused an access token refreshed moments ago, so refreshing again won't help; check that it accepts tokens from ${auth.origin}/token for ${auth.mcpUrl}.`,
    ]);
    // Later on, a refusal is worth one more refresh: a server can drop its tokens when it restarts.
    clock += RENEWAL_GRACE_MS;
    expect(await tokenFile.renew(fresh!)).not.toBe(fresh);
    expect(refreshGrants(auth)).toHaveLength(2);
  });

  it("refreshes through the simulator's proxy after a 401, and passes the 401 on once refreshing can't help", async () => {
    const auth = await fake({ registration: true });
    const { file, tokens } = await linked(auth);
    const warnings: string[] = [];
    let clock = Date.now();
    const tokenFile = await TokenFile.load(file, { env: {}, now: () => clock, warn: (line) => warnings.push(line) });
    const proxy: RunningProxy = await startProxy({
      upstream: auth.mcpUrl,
      port: 0,
      clientPort: 0,
      token: (refused) => (refused ? tokenFile.renew(refused) : tokenFile.token()),
    });
    running.push(proxy);
    const initialize = () =>
      fetch(`${proxy.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      });

    auth.revoke(tokens.accessToken);
    const first = await initialize();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("fake-auth");
    const fresh = (await loadTokens(file)).accessToken;
    expect(auth.requests("/mcp").map((seen) => seen.headers.authorization)).toEqual([`Bearer ${tokens.accessToken}`, `Bearer ${fresh}`]);

    // A while later nothing can be refreshed: the 401 comes back as the server sent it, and the terminal hears why once.
    clock += RENEWAL_GRACE_MS;
    auth.revoke(fresh);
    auth.refreshTokens.clear();
    expect((await initialize()).status).toBe(401);
    expect((await initialize()).status).toBe(401);
    expect(refreshGrants(auth)).toHaveLength(2);
    expect(warnings).toEqual([
      `The MCP server refused the saved access token. Couldn't refresh the sign-in saved in ${file}: the token endpoint answered HTTP 400: invalid_grant (Refresh token is invalid). Run alexa-plus-simulator link ${auth.mcpUrl} to sign in again.`,
    ]);
  });

  it("says plainly what's wrong with a file that isn't link's", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-link-"));
    const notJson = join(dir, "a.json");
    await writeFile(notJson, "not json");
    await expect(loadTokens(notJson)).rejects.toThrow(`${notJson} isn't JSON`);
    const wrong = join(dir, "b.json");
    await writeFile(wrong, JSON.stringify({ version: 1, mcpUrl: "https://addon.example.com/mcp", tokenEndpoint: "https://auth.example.com/token", clientId: "c", clientAuth: "private_key_jwt", accessToken: "a" }));
    await expect(loadTokens(wrong)).rejects.toThrow(`${wrong} isn't a token file from link: its clientAuth isn't one of client_secret_basic, client_secret_post, none.`);
  });
});

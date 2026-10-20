import { describe, expect, it } from "vitest";
import { runChecks, type CheckOptions } from "../src/check/index.ts";
import { authServerMetadataUrls, sameResource } from "../src/check/auth.ts";
import { fakeServer, type FakeOptions } from "./fakes.ts";

const SERVER_URL = "https://addon.example.com/mcp";
const TOKEN = "test-token-123";

const PRM = {
  resource: SERVER_URL,
  authorization_servers: ["https://auth.example.com"],
  scopes_supported: ["forecast:read"],
};
const AS_METADATA = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
  code_challenge_methods_supported: ["S256"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  response_types_supported: ["code"],
};
const ROOT_PRM = "/.well-known/oauth-protected-resource";
const ROOT_AS = "/.well-known/oauth-authorization-server";

/** A server that signs in the way Amazon asks, with any part swapped out. */
function signedIn(overrides: Partial<FakeOptions> = {}, documents: Record<string, unknown> = {}) {
  return fakeServer({
    auth: { token: TOKEN },
    documents: { [ROOT_PRM]: PRM, [ROOT_AS]: AS_METADATA, ...documents },
    ...overrides,
  });
}

async function check(server: { fetch: CheckOptions["fetch"]; now?: () => number }, options: Partial<CheckOptions> = {}) {
  const report = await runChecks({ serverUrl: SERVER_URL, fetch: server.fetch, now: server.now ?? (() => 0), timeoutMs: 2000, ...options });
  const rule = (id: string) => report.rules.find((r) => r.id === id)!;
  const auth = Object.fromEntries(report.rules.filter((r) => r.category === "auth").map((r) => [r.id, r.status]));
  return { report, rule, auth };
}

const ALL_AUTH_PASS = {
  "AU-01": "PASS",
  "AU-02": "PASS",
  "AU-03": "PASS",
  "AU-04": "PASS",
  "AU-05": "PASS",
  "AU-06": "PASS",
  "AU-07": "PASS",
  "AU-08": "PASS",
  // Refreshing is only tried with a token file from link (test/link.test.ts).
  "AU-09": "SKIP",
};

describe("a server that needs sign-in", () => {
  it("passes every auth rule, and skips the data layer without a token", async () => {
    const { report, rule, auth } = await check(signedIn());
    expect(auth).toEqual(ALL_AUTH_PASS);
    expect(rule("AU-01").notes).toBe("An unauthenticated initialize was refused with HTTP 401.");
    expect(rule("AU-03").notes).toContain(`naming resource ${SERVER_URL}`);
    expect(report.rules.filter((r) => r.category === "mcp-data").every((r) => r.status === "SKIP")).toBe(true);
    expect(rule("DL-01").notes).toContain("run again with a token");
    expect(report.verdict).toBe("READY");
  });

  it("with a token, runs the data layer signed in and still asks once without it", async () => {
    const server = signedIn();
    const { report, rule, auth } = await check(server, { token: TOKEN });
    expect(auth).toEqual(ALL_AUTH_PASS);
    expect(report.rules.filter((r) => r.category === "mcp-data").every((r) => r.status === "PASS")).toBe(true);
    const inits = server.sent.filter((s) => s.body?.method === "initialize");
    expect(inits.map((s) => s.headers.get("authorization"))).toEqual([`Bearer ${TOKEN}`, null]);
    // Every MCP request but the probe carries the token in the Authorization header, never in the URL.
    const mcp = server.sent.filter((s) => new URL(s.url).pathname === "/mcp");
    expect(mcp.filter((s) => !s.headers.get("authorization"))).toHaveLength(1);
    expect(server.sent.every((s) => !s.url.includes(TOKEN))).toBe(true);
    // Metadata is public, so it's fetched without the token.
    expect(server.sent.filter((s) => s.url.includes("/.well-known/")).every((s) => !s.headers.get("authorization"))).toBe(true);
    expect(rule("AU-01").notes).toContain("initialize");
  });

  it("fails the data layer when the token itself is refused", async () => {
    const { rule, auth } = await check(signedIn(), { token: "wrong-token" });
    expect(rule("DL-01")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("was refused with HTTP 401 even with the token") });
    expect(rule("DL-02").status).toBe("SKIP");
    expect(auth["AU-01"]).toBe("PASS");
  });

  it("accepts 403, which the account linking guide allows", async () => {
    const { rule } = await check(signedIn({ auth: { token: TOKEN, status: 403 } }));
    expect(rule("AU-01")).toMatchObject({ status: "PASS", notes: expect.stringContaining("HTTP 403") });
  });

  it("finds a server that only guards tool calls, with and without a token", async () => {
    const guarded = () => signedIn({ auth: { token: TOKEN, guard: "tools/call" } });
    const without = await check(guarded());
    expect(without.rule("AU-01").notes).toContain("tools/call get_forecast was refused with HTTP 401");
    expect(without.rule("DL-03").status).toBe("PASS");
    for (const id of ["DL-05", "DL-06", "DL-07"]) {
      expect(without.rule(id)).toMatchObject({ status: "SKIP", notes: expect.stringContaining("sign-in") });
    }
    expect(without.auth).toEqual(ALL_AUTH_PASS);

    const withToken = await check(guarded(), { token: TOKEN });
    expect(withToken.rule("AU-01").notes).toContain("tools/call get_forecast was refused");
    expect(withToken.report.verdict).toBe("READY");
  });
});

describe("a server that doesn't need sign-in", () => {
  it("skips the auth rules, even when given a token, after asking without one", async () => {
    const server = fakeServer();
    const { rule, auth } = await check(server, { token: TOKEN });
    expect(Object.values(auth).every((status) => status === "SKIP")).toBe(true);
    expect(rule("AU-01").notes).toBe("The server doesn't require sign-in (account linking is optional).");
    const probe = server.requests().filter((_, i, all) => i >= all.findLastIndex((r) => r.method === "initialize"));
    expect(probe.map((r) => r.method)).toEqual(["initialize", "tools/list", "tools/call"]);
    expect((probe[2]!.params as { name: string }).name).toBe("get_forecast");
  });
});

describe("AU-02 WWW-Authenticate", () => {
  it("fails a refusal that carries the header", async () => {
    const header = `Bearer resource_metadata="${SERVER_URL.replace("/mcp", "")}/.well-known/oauth-protected-resource"`;
    const { report, rule } = await check(signedIn({ auth: { token: TOKEN, wwwAuthenticate: header } }));
    expect(rule("AU-02")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("resource_metadata") });
    expect(rule("AU-02").notes).toContain("Not Supported Yet");
    expect(report.verdict).toBe("NOT_READY");
  });
});

describe("AU-03 protected resource metadata", () => {
  it("fails when only the path-specific RFC 9728 document exists, and still finds the authorization server from it", async () => {
    const server = fakeServer({
      auth: { token: TOKEN },
      documents: { [`${ROOT_PRM}/mcp`]: PRM, [ROOT_AS]: AS_METADATA },
    });
    const { rule } = await check(server);
    expect(rule("AU-03").status).toBe("FAIL");
    expect(rule("AU-03").notes).toContain("path-specific");
    expect(rule("AU-03").notes).toContain("https://addon.example.com/.well-known/oauth-protected-resource/mcp");
    expect(rule("AU-04").status).toBe("PASS");
  });

  it("warns when resource isn't the MCP URL", async () => {
    const { rule } = await check(signedIn({}, { [ROOT_PRM]: { ...PRM, resource: "https://addon.example.com/" } }));
    expect(rule("AU-03")).toMatchObject({ status: "WARN", notes: expect.stringContaining("not the MCP URL") });
  });

  it("fails a document without authorization_servers", async () => {
    const { rule } = await check(signedIn({}, { [ROOT_PRM]: { resource: SERVER_URL, authorization_servers: [] } }));
    expect(rule("AU-03")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("no authorization_servers") });
  });

  it("fails when there's none, and looks for the authorization server at the MCP server's origin", async () => {
    const server = fakeServer({ auth: { token: TOKEN }, documents: { [ROOT_AS]: AS_METADATA } });
    const { rule } = await check(server);
    expect(rule("AU-03")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("No protected resource metadata") });
    expect(rule("AU-04")).toMatchObject({ status: "PASS", notes: expect.stringContaining("MCP server's origin") });
  });
});

describe("AU-04 authorization server metadata", () => {
  it("fails when there's none, and skips what depends on it", async () => {
    const server = fakeServer({ auth: { token: TOKEN }, documents: { [ROOT_PRM]: PRM } });
    const { rule } = await check(server);
    expect(rule("AU-04")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("HTTP 404") });
    for (const id of ["AU-05", "AU-06", "AU-07"]) expect(rule(id).status).toBe("SKIP");
  });

  it.each([
    ["inserted before the path, as RFC 8414 has it", "/.well-known/oauth-authorization-server/tenant-1"],
    ["appended to the path", "/tenant-1/.well-known/oauth-authorization-server"],
  ])("finds an issuer with a path when the metadata is %s", async (_, path) => {
    const prm = { ...PRM, authorization_servers: ["https://auth.example.com/tenant-1"] };
    const server = fakeServer({ auth: { token: TOKEN }, documents: { [ROOT_PRM]: prm, [path]: AS_METADATA } });
    const { rule } = await check(server);
    expect(rule("AU-04")).toMatchObject({ status: "PASS", notes: `Found at https://auth.example.com${path}.` });
  });

  it("tries RFC 8414's path insertion first", () => {
    expect(authServerMetadataUrls(new URL("https://auth.example.com/tenant-1/"))).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server/tenant-1",
      "https://auth.example.com/tenant-1/.well-known/oauth-authorization-server",
      "https://auth.example.com/.well-known/oauth-authorization-server",
    ]);
    expect(authServerMetadataUrls(new URL("https://auth.example.com"))).toEqual([
      "https://auth.example.com/.well-known/oauth-authorization-server",
    ]);
  });
});

describe("AU-05 to AU-07 what the metadata promises", () => {
  const withMetadata = (metadata: Record<string, unknown>) => check(signedIn({}, { [ROOT_AS]: metadata }));
  const without = (key: string) => Object.fromEntries(Object.entries(AS_METADATA).filter(([k]) => k !== key));

  it("fails without S256", async () => {
    const { rule } = await withMetadata({ ...AS_METADATA, code_challenge_methods_supported: ["plain"] });
    expect(rule("AU-05")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("without S256") });
  });

  it("fails without code_challenge_methods_supported at all", async () => {
    const { rule } = await withMetadata(without("code_challenge_methods_supported"));
    expect(rule("AU-05").status).toBe("FAIL");
  });

  it("fails without a token endpoint", async () => {
    const { rule } = await withMetadata(without("token_endpoint"));
    expect(rule("AU-06")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("no token_endpoint") });
  });

  it.each([
    ["listing refresh_token", ["authorization_code", "refresh_token"], "PASS"],
    ["listing only authorization_code", ["authorization_code"], "FAIL"],
    ["without grant_types_supported", undefined, "WARN"],
  ] as const)("judges refresh tokens %s", async (_, grants, status) => {
    const metadata = grants ? { ...AS_METADATA, grant_types_supported: grants } : without("grant_types_supported");
    const { rule } = await withMetadata(metadata);
    expect(rule("AU-07").status).toBe(status);
  });
});

describe("AU-08 HTTPS", () => {
  it("fails an authorization server reached over plain http", async () => {
    const metadata = { ...AS_METADATA, token_endpoint: "http://auth.example.com/token" };
    const { rule } = await check(signedIn({}, { [ROOT_AS]: metadata }));
    expect(rule("AU-08")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("token_endpoint http://auth.example.com/token") });
  });

  it("only warns about loopback http, for local development", async () => {
    const local = "http://localhost:8787/mcp";
    const server = signedIn({}, { [ROOT_PRM]: { ...PRM, resource: local } });
    const report = await runChecks({ serverUrl: local, fetch: server.fetch, now: () => 0 });
    const rule = (id: string) => report.rules.find((r) => r.id === id)!;
    expect(rule("AU-03").status).toBe("PASS");
    expect(rule("AU-08")).toMatchObject({ status: "WARN", notes: expect.stringContaining(`MCP server ${local}`) });
  });
});

describe("sameResource", () => {
  it("ignores a trailing slash, host case and a default port, but not the path", () => {
    expect(sameResource("https://Example.com:443/mcp/", "https://example.com/mcp")).toBe(true);
    expect(sameResource("https://example.com/", "https://example.com/mcp")).toBe(false);
    expect(sameResource("http://example.com/mcp", "https://example.com/mcp")).toBe(false);
  });
});

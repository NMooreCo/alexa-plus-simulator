import { describe, expect, it } from "vitest";
import { DISCLAIMER, type ReadinessReport } from "../src/shared/contract.ts";
import { runChecks, type CheckOptions } from "../src/check/index.ts";
import { BOOKING_TOOL, FORECAST_TOOL, fakeServer, legacySseServer, sdkServer, type FakeTool } from "./fakes.ts";

const SERVER_URL = "https://addon.example.com/mcp";
const MISSING = "alexa_plus_simulator_no_such_tool_";

async function check(server: { fetch: CheckOptions["fetch"]; now?: () => number }, options: Partial<CheckOptions> = {}) {
  const report = await runChecks({
    serverUrl: SERVER_URL,
    fetch: server.fetch,
    // A frozen clock unless the fake keeps one, so real timing can't make a test flaky.
    now: server.now ?? (() => 0),
    timeoutMs: 2000,
    ...options,
  });
  const rule = (id: string) => {
    const found = report.rules.find((r) => r.id === id);
    if (!found) throw new Error(`No ${id} in the report`);
    return found;
  };
  return { report, rule };
}

const statuses = (report: ReadinessReport, category: string) =>
  Object.fromEntries(report.rules.filter((r) => r.category === category).map((r) => [r.id, r.status]));

const ALL_DATA_PASS = {
  "DL-01": "PASS",
  "DL-02": "PASS",
  "DL-03": "PASS",
  "DL-04": "PASS",
  "DL-05": "PASS",
  "DL-06": "PASS",
  "DL-07": "PASS",
  "DL-08": "PASS",
};

describe("runChecks against the MCP SDK's own server", () => {
  it.each(["json", "sse", "stateless"] as const)("passes every data-layer rule (%s)", async (mode) => {
    const server = sdkServer(mode);
    const { report, rule } = await check(server);
    expect(statuses(report, "mcp-data")).toEqual(ALL_DATA_PASS);
    expect(rule("DL-01").notes).toContain(mode === "json" ? "JSON, with a session id" : mode === "sse" ? "SSE, with a session id" : "stateless");
    expect(rule("DL-01").notes).toContain("sdk-server 2.0.0");
    expect(rule("DL-08").notes).toContain("ui://status (text/html;profile=mcp-app)");
    expect(report.rules.filter((r) => r.category === "auth").every((r) => r.status === "SKIP")).toBe(true);
    expect(report.verdict).toBe("READY");
    // Only the read-only tool, twice, and the made-up one: never feed_animals.
    expect(server.toolCalls.filter((name) => !name.startsWith(MISSING))).toEqual(["get_status", "get_status"]);
    // The check ends its session rather than leaving it on the server.
    expect(server.sessions.size).toBe(0);
  });
});

describe("what the check sends", () => {
  it("opens with Alexa+'s documented initialize and carries the session after it", async () => {
    const server = fakeServer();
    await check(server);
    const [init] = server.requests();
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: { roots: { listChanged: true } },
        clientInfo: { name: "Alexa+ MCP Client", version: "1.0.0" },
      },
    });
    expect(typeof init!.id).toBe("string");

    const posts = server.sent.filter((s) => s.httpMethod === "POST");
    for (const post of posts) {
      expect(post.headers.get("accept")).toBe("application/json, text/event-stream");
      expect(post.headers.get("content-type")).toBe("application/json");
      expect(post.headers.get("authorization")).toBeNull();
    }
    expect(posts[0]!.headers.get("mcp-session-id")).toBeNull();
    expect(posts[1]!.body).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    for (const post of posts.slice(1)) {
      expect(post.headers.get("mcp-session-id")).toBe("fake-session-1");
      expect(post.headers.get("mcp-protocol-version")).toBe("2025-03-26");
    }
    const last = server.sent.at(-1)!;
    expect(last.httpMethod).toBe("DELETE");
    expect(last.headers.get("mcp-session-id")).toBe("fake-session-1");
  });

  it("times tools/list three times and follows nextCursor", async () => {
    const server = fakeServer({ pageSize: 1 });
    const { rule } = await check(server);
    const lists = server.requests().filter((r) => r.method === "tools/list");
    expect(lists.map((r) => r.params)).toEqual([undefined, { cursor: "1" }, undefined, undefined]);
    expect(rule("DL-03")).toMatchObject({ status: "PASS", notes: expect.stringContaining("2 tools") });
  });

  it("sends no session id to a stateless server and has no session to end", async () => {
    const server = fakeServer({ sessionId: null });
    const { report, rule } = await check(server);
    expect(report.verdict).toBe("READY");
    expect(rule("DL-01").notes).toContain("stateless");
    expect(server.sent.every((s) => !s.headers.get("mcp-session-id"))).toBe(true);
    expect(server.sent.some((s) => s.httpMethod === "DELETE")).toBe(false);
  });

  it("sends the developer's headers on every request to the server's origin, under its own, and never to another origin", async () => {
    const server = fakeServer({
      auth: { token: "t0ken" },
      documents: {
        "/.well-known/oauth-protected-resource": { resource: SERVER_URL, authorization_servers: ["https://auth.example.com"] },
        "/.well-known/oauth-authorization-server": { issuer: "https://auth.example.com" },
      },
    });
    const headers = { "X-Gateway-Key": "open-sesame", Accept: "text/html", Authorization: "Bearer theirs" };
    await check(server, { token: "t0ken", headers });
    const ours = server.sent.filter((s) => new URL(s.url).origin === "https://addon.example.com");
    // Every MCP request (the token-less probe's included), the session's end and the metadata on the server's origin.
    expect(ours.map((s) => s.httpMethod)).toContain("DELETE");
    expect(ours.some((s) => s.url.endsWith("/.well-known/oauth-protected-resource"))).toBe(true);
    for (const sent of ours) expect(sent.headers.get("x-gateway-key"), `${sent.httpMethod} ${sent.url}`).toBe("open-sesame");
    // The check's own headers win: the Accept it means to send, and the token rather than an Authorization of the developer's.
    for (const post of ours.filter((s) => s.httpMethod === "POST")) expect(post.headers.get("accept")).toBe("application/json, text/event-stream");
    const mcp = ours.filter((s) => new URL(s.url).pathname === "/mcp" && s.httpMethod === "POST");
    expect(new Set(mcp.map((s) => s.headers.get("authorization")))).toEqual(new Set(["Bearer t0ken", null]));
    // The authorization server is another origin's, and hears none of them.
    const theirs = server.sent.filter((s) => new URL(s.url).origin === "https://auth.example.com");
    expect(theirs.length).toBeGreaterThan(0);
    for (const sent of theirs) expect(sent.headers.get("x-gateway-key")).toBeNull();
  });

  it("never calls a tool that isn't marked read-only, or one that needs arguments", async () => {
    const tools: FakeTool[] = [
      { ...FORECAST_TOOL, annotations: { readOnlyHint: false } },
      { ...FORECAST_TOOL, name: "get_city", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
      { ...FORECAST_TOOL, name: "no_annotations", annotations: undefined },
      BOOKING_TOOL,
    ];
    const server = fakeServer({ tools });
    const { rule } = await check(server);
    expect(server.calledTools().every((name) => name.startsWith(MISSING))).toBe(true);
    expect(rule("DL-05")).toMatchObject({ status: "SKIP", notes: expect.stringContaining("readOnlyHint") });
    expect(rule("DL-07").status).toBe("SKIP");
  });
});

describe("DL-01 Streamable HTTP", () => {
  it("fails a server that speaks only the legacy HTTP+SSE transport, and lets go of its stream", async () => {
    const server = legacySseServer();
    const { report, rule } = await check(server);
    expect(rule("DL-01")).toMatchObject({ status: "FAIL" });
    expect(rule("DL-01").notes).toContain("legacy HTTP+SSE");
    expect(rule("DL-01").notes).toContain("/messages?sessionId=abc123");
    expect(report.rules.filter((r) => r.id !== "DL-01" && r.category === "mcp-data").every((r) => r.status === "SKIP")).toBe(true);
    expect(rule("AU-01")).toMatchObject({ status: "SKIP", notes: expect.stringContaining("sign-in wasn't checked") });
    expect(report.verdict).toBe("NOT_READY");
    expect(server.canceled()).toBe(true);
  });

  it("fails a URL with nothing behind it without calling it the legacy transport", async () => {
    const server = fakeServer();
    const { rule } = await check(server, { serverUrl: "https://addon.example.com/wrong" });
    expect(rule("DL-01")).toMatchObject({ status: "FAIL", notes: "The initialize request failed: HTTP 404: Not Found." });
    expect(server.sent.map((s) => s.httpMethod)).toEqual(["POST", "GET"]);
  });

  it("works over SSE framing throughout", async () => {
    const { report, rule } = await check(fakeServer({ framing: "sse" }));
    expect(statuses(report, "mcp-data")).toEqual(ALL_DATA_PASS);
    expect(rule("DL-01").notes).toContain("SSE");
  });

  it("fails a server it can't reach, and leaves sign-in unjudged", async () => {
    const refused: CheckOptions["fetch"] = async () => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
    };
    const { report, rule } = await check({ fetch: refused });
    expect(rule("DL-01")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("ECONNREFUSED") });
    expect(rule("AU-01")).toMatchObject({ status: "SKIP", notes: expect.stringContaining("sign-in wasn't checked") });
    expect(report.verdict).toBe("NOT_READY");
  });

  it("fails a server that never answers initialize, without hanging", async () => {
    const { rule } = await check(fakeServer({ hangOnInitialize: true }), { timeoutMs: 50 });
    expect(rule("DL-01")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("no answer within 50 ms") });
  });

  it("fails an answer whose id isn't the request's", async () => {
    const { rule } = await check(fakeServer({ answerId: 7 }));
    expect(rule("DL-01")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("id is 7") });
  });

  it("warns when notifications/initialized is refused", async () => {
    const { rule } = await check(fakeServer({ initializedStatus: 500 }));
    expect(rule("DL-01")).toMatchObject({ status: "WARN", notes: expect.stringContaining("HTTP 500") });
  });
});

describe("DL-02 protocol version", () => {
  it("warns about a version other than the one Alexa+ asks for", async () => {
    const { report, rule } = await check(fakeServer({ protocolVersion: "2025-06-18" }));
    expect(rule("DL-02")).toMatchObject({ status: "WARN", notes: expect.stringContaining("2025-06-18") });
    expect(report.verdict).toBe("CONDITIONAL");
  });

  it("fails an initialize result with no protocolVersion", async () => {
    const { rule } = await check(fakeServer({ protocolVersion: "" }));
    expect(rule("DL-02").status).toBe("FAIL");
  });
});

describe("DL-03 tool definitions", () => {
  it("warns about a tool with no description", async () => {
    const { rule } = await check(fakeServer({ tools: [{ ...FORECAST_TOOL, description: undefined }, BOOKING_TOOL] }));
    expect(rule("DL-03")).toMatchObject({ status: "WARN", notes: expect.stringContaining("get_forecast has no description") });
  });

  it("fails tools with no name or no object inputSchema", async () => {
    const tools: FakeTool[] = [
      { ...BOOKING_TOOL, name: undefined },
      { ...BOOKING_TOOL, name: "untyped", inputSchema: { properties: {} } },
      { ...BOOKING_TOOL, name: "stringly", inputSchema: "object" },
    ];
    const { rule } = await check(fakeServer({ tools }));
    expect(rule("DL-03").status).toBe("FAIL");
    expect(rule("DL-03").notes).toContain("Tool 1 has no name");
    expect(rule("DL-03").notes).toContain(`untyped's inputSchema has no type, not "object"`);
    expect(rule("DL-03").notes).toContain("stringly has no inputSchema object");
  });

  it("fails a server with no tools", async () => {
    const { rule } = await check(fakeServer({ tools: [] }));
    expect(rule("DL-03")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("no tools") });
    expect(rule("DL-05").status).toBe("SKIP");
  });
});

describe("DL-04 latency", () => {
  it("fails when the median round trip is over 500 ms", async () => {
    const server = fakeServer({ latency: () => 650 });
    const { rule } = await check(server);
    expect(rule("DL-04")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("Median 650 ms") });
  });

  it("fails at exactly 500 ms, since the budget is less than 500 ms", async () => {
    expect((await check(fakeServer({ latency: () => 500 }))).rule("DL-04").status).toBe("FAIL");
    expect((await check(fakeServer({ latency: () => 499 }))).rule("DL-04").status).toBe("PASS");
  });

  it("warns when only some round trips are slow, naming the slowest", async () => {
    const server = fakeServer({ latency: (method) => (method === "tools/call" ? 900 : 40) });
    const { rule } = await check(server);
    // initialize, three listings, two calls and one screen: the two calls are over.
    expect(rule("DL-04")).toMatchObject({ status: "WARN" });
    expect(rule("DL-04").notes).toContain("Median 40 ms");
    expect(rule("DL-04").notes).toContain("2 of 7 round trips");
    expect(rule("DL-04").notes).toContain("900 ms (tools/call get_forecast)");
  });

  it("times every other read-only tool once, naming a slow one, and never calls a tool that isn't read-only", async () => {
    const refresh: FakeTool = { name: "refresh_ranch", description: "The ranch screen's refresh.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, result: { content: [{ type: "text", text: "{}" }], structuredContent: {} } };
    const server = fakeServer({
      tools: [FORECAST_TOOL, BOOKING_TOOL, refresh],
      latency: (method, params) => (method === "tools/call" && params?.name === "refresh_ranch" ? 4000 : 40),
    });
    const { rule } = await check(server);
    expect(rule("DL-04")).toMatchObject({ status: "WARN" });
    expect(rule("DL-04").notes).toContain("Over: tools/call refresh_ranch 4000 ms.");
    expect(server.calledTools().filter((name) => !name.startsWith(MISSING))).toEqual(["get_forecast", "get_forecast", "refresh_ranch"]);
    // Its result isn't what DL-05 and DL-07 judge: they stay with the first read-only tool.
    expect(rule("DL-05").notes).toContain("get_forecast");
  });

  it("stops timing other tools once that has taken 30 seconds", async () => {
    const slow = (name: string): FakeTool => ({ name, description: "Slow.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, result: { content: [{ type: "text", text: "ok" }], structuredContent: {} } });
    const server = fakeServer({
      tools: [FORECAST_TOOL, slow("a"), slow("b"), slow("c"), slow("d")],
      latency: (method, params) => (method === "tools/call" && params?.name !== "get_forecast" && !String(params?.name).startsWith(MISSING) ? 20_000 : 10),
    });
    await check(server, { timeoutMs: 60_000 });
    // a and b take 40 seconds between them; c would start past the budget.
    expect(server.calledTools().filter((name) => !name.startsWith(MISSING))).toEqual(["get_forecast", "get_forecast", "a", "b"]);
  });

  it("passes and reports the median and the slowest", async () => {
    let n = 0;
    const server = fakeServer({ latency: () => 10 * ++n });
    const { rule } = await check(server);
    // 7 samples at 10, 20, 30, ... so the median is the 4th.
    expect(rule("DL-04")).toMatchObject({ status: "PASS", notes: expect.stringMatching(/^Median \d+ ms, slowest \d+ ms/) });
  });
});

describe("DL-05 tool results", () => {
  const withResult = (result: unknown) => fakeServer({ tools: [{ ...FORECAST_TOOL, result }] });

  it("warns when the result has no structuredContent", async () => {
    const { report, rule } = await check(withResult({ content: [{ type: "text", text: "Sunny." }] }));
    expect(rule("DL-05")).toMatchObject({ status: "WARN", notes: expect.stringContaining("no structuredContent") });
    expect(report.verdict).toBe("CONDITIONAL");
  });

  it("warns when the result has structuredContent but no text", async () => {
    const { rule } = await check(withResult({ content: [], structuredContent: { summary: "Sunny" } }));
    expect(rule("DL-05")).toMatchObject({ status: "WARN", notes: expect.stringContaining("no text content") });
  });

  it("fails a result with neither", async () => {
    const { rule } = await check(withResult({ content: [{ type: "image", data: "", mimeType: "image/png" }] }));
    expect(rule("DL-05").status).toBe("FAIL");
  });

  it("fails a tool that reports an error, quoting it", async () => {
    const { rule } = await check(withResult({ content: [{ type: "text", text: "Upstream is down" }], isError: true }));
    expect(rule("DL-05")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("Upstream is down") });
    expect(rule("DL-07").status).toBe("SKIP");
  });

  it("answers a server that asks for roots mid-stream, instead of hanging on it", async () => {
    const server = fakeServer({ framing: "sse", tools: [{ ...FORECAST_TOOL, asksForRoots: true }] });
    const { rule } = await check(server, { timeoutMs: 1000 });
    expect(rule("DL-05").status).toBe("PASS");
    expect(server.sent.some((s) => s.body?.id === "roots-1" && JSON.stringify(s.body.result) === `{"roots":[]}`)).toBe(true);
  });
});

describe("DL-06 error handling", () => {
  it.each([
    ["error", "PASS", "JSON-RPC error -32602"],
    ["isError", "PASS", "isError"],
    ["http500", "FAIL", "HTTP 500"],
    ["success", "FAIL", "as if it had worked"],
    ["html", "FAIL", "isn't JSON or SSE"],
    ["bare404", "FAIL", "HTTP 404"],
    ["hang", "FAIL", "no answer within 100 ms"],
    ["deaf", "FAIL", "no answer within 100 ms"],
    ["stall", "FAIL", "no answer within 100 ms"],
  ] as const)("a server answering a missing tool with %s gets %s", async (missingTool, status, note) => {
    const { rule } = await check(fakeServer({ missingTool }), { timeoutMs: 100 });
    expect(rule("DL-06")).toMatchObject({ status, notes: expect.stringContaining(note) });
  });
});

describe("DL-07 repeated calls", () => {
  it("warns, saying where, when the same call returns something different", async () => {
    const results = (n: number) => ({ content: [{ type: "text", text: `Call ${n}` }], structuredContent: { summary: "Sunny", call: n } });
    const { rule } = await check(fakeServer({ tools: [{ ...FORECAST_TOOL, results }] }));
    expect(rule("DL-07").status).toBe("WARN");
    expect(rule("DL-07").notes).toContain("content[0].text");
    expect(rule("DL-07").notes).toContain("structuredContent.call");
    expect(rule("DL-07").notes).not.toContain("summary");
  });
});

describe("DL-08 screens", () => {
  it("skips when no tool declares a screen: Alexa+ uses its data-only flow", async () => {
    const { rule } = await check(fakeServer({ tools: [{ ...FORECAST_TOOL, _meta: undefined }] }));
    expect(rule("DL-08")).toMatchObject({ status: "SKIP", notes: expect.stringContaining("data-only flow") });
  });

  it("fails a screen that can't be read", async () => {
    const { rule } = await check(fakeServer({ resources: {} }));
    expect(rule("DL-08")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("ui://forecast couldn't be read") });
  });

  it("fails a screen that isn't HTML", async () => {
    const { rule } = await check(fakeServer({ resources: { "ui://forecast": { mimeType: "text/plain", text: "Sunny" } } }));
    expect(rule("DL-08")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("text/plain, not HTML") });
  });

  it("accepts plain text/html and the older ui/resourceUri key", async () => {
    const tools = [{ ...FORECAST_TOOL, _meta: { "ui/resourceUri": "ui://forecast" } }];
    const { rule } = await check(fakeServer({ tools, resources: { "ui://forecast": { mimeType: "text/html", text: "<p>Sunny</p>" } } }));
    expect(rule("DL-08")).toMatchObject({ status: "PASS", notes: expect.stringContaining("ui://forecast (text/html)") });
  });

  it("reads a screen named in a tool result, as Amazon's documented result has it", async () => {
    const result = {
      content: [{ type: "text", text: "Sunny." }],
      structuredContent: { summary: "Sunny" },
      _meta: { ui: { resourceUri: "ui://forecast", invoking: "Checking...", invoked: "Checked" } },
    };
    const server = fakeServer({ tools: [{ ...FORECAST_TOOL, _meta: undefined, result }] });
    const { rule } = await check(server);
    expect(rule("DL-08").status).toBe("PASS");
    expect(server.requests().some((r) => r.method === "resources/read")).toBe(true);
  });
});

describe("the report", () => {
  it("is shaped like the contract says", async () => {
    const { report } = await check(fakeServer(), { version: "9.9.9" });
    expect(report).toMatchObject({ tool: "alexa-plus-simulator", version: "9.9.9", serverUrl: SERVER_URL, disclaimer: DISCLAIMER });
    expect(new Date(report.checkedAt).toISOString()).toBe(report.checkedAt);
    expect(report.passCount + report.failCount + report.warnCount + report.skipCount).toBe(report.rules.length);
    expect(report.rules.map((r) => r.id)).toEqual([
      "DL-01", "DL-02", "DL-03", "DL-04", "DL-05", "DL-06", "DL-07", "DL-08",
      "AU-01", "AU-02", "AU-03", "AU-04", "AU-05", "AU-06", "AU-07", "AU-08", "AU-09",
    ]);
  });

  it("refuses a URL it can't check", async () => {
    await expect(runChecks({ serverUrl: "not a url" })).rejects.toThrow(TypeError);
    await expect(runChecks({ serverUrl: "ftp://example.com/mcp" })).rejects.toThrow("must start with https://");
  });

  it("won't send a token or headers over plain http to another machine, as the proxy won't, but takes http on this one", async () => {
    const server = fakeServer();
    for (const serverUrl of ["http://addon.example.com/mcp", "http://192.168.1.20:8787/mcp"]) {
      await expect(check(server, { serverUrl, token: "t0ken", headers: { "X-Api-Key": "k" } })).rejects.toThrow("a remote MCP server must use https://");
    }
    expect(server.sent).toEqual([]);
    const { rule } = await check(fakeServer(), { serverUrl: "http://127.0.0.1:8787/mcp", token: "t0ken" });
    expect(rule("DL-01").status).toBe("PASS");
  });
});

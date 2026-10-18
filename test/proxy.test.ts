import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ALEXA_CLIENT_INFO, ALEXA_PROTOCOL_VERSION } from "../src/shared/contract.ts";
import { startProxy, type ProxyOptions, type RunningProxy } from "../src/proxy/index.ts";
import { FakeUpstream, SESSION_ID, TOOLS, WIDGET_HTML } from "./fake-upstream.ts";
import { BOTH, call, notification, rpc, Stream, until } from "./http-helpers.ts";

/** What Alexa+ sends in `initialize`, per Amazon's docs. */
const ALEXA_INIT = { protocolVersion: ALEXA_PROTOCOL_VERSION, capabilities: { roots: { listChanged: true } }, clientInfo: ALEXA_CLIENT_INFO };
const SECRET = "TOP SECRET, OUTSIDE THE PAGE";

let fake: FakeUpstream;
let dir: string;
let uiDir: string;
const running: RunningProxy[] = [];
const open: Stream[] = [];

beforeAll(async () => {
  fake = await FakeUpstream.start();
  dir = await mkdtemp(join(tmpdir(), "alexa-sim-proxy-"));
  uiDir = join(dir, "ui");
  await mkdir(join(uiDir, "assets"), { recursive: true });
  await writeFile(join(uiDir, "index.html"), "<!doctype html><title>Simulator</title>");
  await writeFile(join(uiDir, "assets", "app.js"), "console.log('simulator');");
  await writeFile(join(uiDir, "assets", "style.css"), "body { margin: 0; }");
  await writeFile(join(uiDir, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  await writeFile(join(uiDir, "assets", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(join(uiDir, "assets", "data.json"), "{}");
  await writeFile(join(dir, "secret.txt"), SECRET);
});

afterAll(async () => {
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => fake.reset());

afterEach(async () => {
  for (const stream of open.splice(0)) stream.close();
  await Promise.all(running.splice(0).map((proxy) => proxy.close()));
});

async function launch(options: Partial<ProxyOptions> = {}): Promise<RunningProxy> {
  const proxy = await startProxy({ upstream: fake.url, port: 0, clientPort: 0, uiDir, ...options });
  running.push(proxy);
  return proxy;
}

/** Opens a stream that's closed after the test. */
async function stream(url: string, options: Parameters<typeof Stream.open>[1] = {}): Promise<Stream> {
  const opened = await Stream.open(url, options);
  open.push(opened);
  return opened;
}

const subscribe = (proxy: RunningProxy) => stream(`${proxy.url}/events`);

/** A POST to the proxy's /mcp, accepting both reply forms as an MCP client does, unless the headers say otherwise. */
const post = (proxy: RunningProxy, body: unknown, headers: Record<string, string> = {}) =>
  call(`${proxy.url}/mcp`, { body, headers: { accept: BOTH, ...headers } });

const health = async (proxy: RunningProxy) => (await call(`${proxy.url}/health`)).json();

const pageOrigin = (proxy: RunningProxy) => proxy.uiUrl;

describe("POST /mcp", () => {
  it("forwards a request and returns the server's status, body and session id", async () => {
    const proxy = await launch();
    const reply = await post(proxy, rpc("initialize", ALEXA_INIT, "init-1"));
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(reply.headers["mcp-session-id"]).toBe(SESSION_ID);
    expect(reply.json()).toMatchObject({ jsonrpc: "2.0", id: "init-1", result: { serverInfo: { name: "fake-upstream" } } });

    const [seen] = fake.seen;
    expect(seen?.method).toBe("POST");
    expect(JSON.parse(seen?.body ?? "")).toEqual(rpc("initialize", ALEXA_INIT, "init-1"));
    expect(seen?.headers["content-type"]).toBe("application/json");
  });

  it("asks the server for both reply forms, whatever the caller accepts", async () => {
    const proxy = await launch();
    await post(proxy, rpc("ping"), { accept: "application/json" });
    await call(`${proxy.url}/mcp`, { body: rpc("ping") });
    expect(fake.seen.map((seen) => seen.headers.accept)).toEqual([BOTH, BOTH]);
  });

  it("returns the server's 202 for a notification", async () => {
    const proxy = await launch();
    const reply = await post(proxy, notification("notifications/initialized"));
    expect(reply.status).toBe(202);
    expect(reply.text).toBe("");
  });

  it("passes the server's error statuses and bodies through", async () => {
    const proxy = await launch();
    fake.failNext = { status: 404, body: "Session not found" };
    const missing = await post(proxy, rpc("tools/list"));
    expect(missing.status).toBe(404);
    expect(missing.text).toBe("Session not found");

    const body = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } });
    fake.failNext = { status: 500, body, contentType: "application/json" };
    const broken = await post(proxy, rpc("tools/list"));
    expect(broken.status).toBe(500);
    expect(broken.headers["content-type"]).toBe("application/json");
    expect(broken.text).toBe(body);
  });

  it("passes the session id and protocol version both ways", async () => {
    const proxy = await launch();
    const reply = await post(proxy, rpc("tools/list"), { "mcp-session-id": SESSION_ID, "mcp-protocol-version": "2025-03-26" });
    expect(fake.seen[0]?.headers).toMatchObject({ "mcp-session-id": SESSION_ID, "mcp-protocol-version": "2025-03-26" });
    // The fake echoes the protocol version back, so this shows the reply's headers pass too.
    expect(reply.headers["mcp-protocol-version"]).toBe("2025-03-26");
  });

  it("passes newer revisions' Mcp- headers and Last-Event-ID through", async () => {
    const proxy = await launch();
    await post(proxy, rpc("tools/call", { name: "echo", arguments: { text: "hi" } }), {
      "mcp-method": "tools/call",
      "mcp-name": "echo",
      "mcp-param-text": "hi",
      "last-event-id": "event-41",
    });
    expect(fake.seen[0]?.headers).toMatchObject({ "mcp-method": "tools/call", "mcp-name": "echo", "mcp-param-text": "hi", "last-event-id": "event-41" });
  });

  it("adds the configured bearer token, which wins over a caller's own", async () => {
    const proxy = await launch({ token: "secret-token" });
    await post(proxy, rpc("ping"));
    await post(proxy, rpc("ping"), { authorization: "Bearer callers-token" });
    expect(fake.seen.map((seen) => seen.headers.authorization)).toEqual(["Bearer secret-token", "Bearer secret-token"]);
  });

  it("passes a caller's own Authorization through when no token is configured", async () => {
    const proxy = await launch();
    await post(proxy, rpc("ping"), { authorization: "Bearer callers-token" });
    await post(proxy, rpc("ping"));
    expect(fake.seen.map((seen) => seen.headers.authorization)).toEqual(["Bearer callers-token", undefined]);
  });

  it("asks a token function for a token on every request", async () => {
    let calls = 0;
    const proxy = await launch({ token: async () => `token-${++calls}` });
    await post(proxy, rpc("ping"));
    await post(proxy, rpc("ping"));
    fake.allowGet = false;
    await call(`${proxy.url}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(fake.seen.map((seen) => seen.headers.authorization)).toEqual(["Bearer token-1", "Bearer token-2", "Bearer token-3"]);
  });

  it("sends no Authorization when the token function has none", async () => {
    const proxy = await launch({ token: async () => undefined });
    await post(proxy, rpc("ping"));
    expect(fake.seen[0]?.headers.authorization).toBeUndefined();
  });

  it("answers 500 with a JSON-RPC error when the token function fails", async () => {
    const proxy = await launch({
      token: async () => {
        throw new Error("the refresh token expired");
      },
    });
    const reply = await post(proxy, rpc("tools/list", undefined, 9));
    expect(reply.status).toBe(500);
    expect(reply.json()).toEqual({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32000, message: "Couldn't get a bearer token for the MCP server: the refresh token expired" },
    });
    expect(fake.seen).toHaveLength(0);
  });

  it("adds the configured extra headers", async () => {
    const proxy = await launch({ headers: { "X-Api-Key": "key-1", "X-Tenant": "home" } });
    await post(proxy, rpc("ping"));
    expect(fake.seen[0]?.headers).toMatchObject({ "x-api-key": "key-1", "x-tenant": "home" });
  });

  it("follows a redirect that keeps the method and body, with the token, on the same origin", async () => {
    const proxy = await launch({ upstream: `${fake.origin}/moved`, token: "secret-token" });
    const reply = await post(proxy, rpc("ping", undefined, "p1"));
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual({ jsonrpc: "2.0", id: "p1", result: {} });
    expect(fake.seen.map((seen) => `${seen.method} ${seen.path} ${seen.headers.authorization}`)).toEqual([
      "POST /moved Bearer secret-token",
      "POST /mcp Bearer secret-token",
    ]);
    expect(fake.seen[1]?.body).toBe(fake.seen[0]?.body);
  });

  it("won't follow a redirect to plain http on another machine", async () => {
    const proxy = await launch({ upstream: `${fake.origin}/elsewhere` });
    const reply = await post(proxy, rpc("ping", undefined, "p2"));
    expect(reply.status).toBe(502);
    expect(reply.json()).toMatchObject({ id: "p2", error: { message: expect.stringContaining("redirected to http://example.com/mcp") } });
  });

  it("answers 502 with a JSON-RPC error for each request when the server can't be reached", async () => {
    // A server that hangs up on every connection fails at once, where a closed port can take seconds on Windows.
    const dead = createNetServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const upstream = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/mcp`;
    try {
      const proxy = await launch({ upstream });
      const single = await post(proxy, rpc("tools/list", undefined, 7));
      expect(single.status).toBe(502);
      expect(single.json()).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32000, message: expect.stringContaining(`Couldn't reach the MCP server at ${upstream}`) } });

      const batch = await post(proxy, [rpc("ping", undefined, "a"), notification("notifications/initialized"), rpc("ping", undefined, "b")]);
      expect(batch.json().map((answer: { id: string }) => answer.id)).toEqual(["a", "b"]);
      expect(proxy.state().errors[0]?.description).toContain("Couldn't reach the MCP server");
    } finally {
      dead.close();
    }
  });
});

describe("event-stream replies", () => {
  it("unwraps one into plain JSON for a caller that accepts only JSON", async () => {
    const proxy = await launch();
    fake.mode = "sse";
    const reply = await post(proxy, rpc("initialize", ALEXA_INIT, "init"), { accept: "application/json" });
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(reply.headers["mcp-session-id"]).toBe(SESSION_ID);
    // The response, not the notification the server sent ahead of it.
    expect(reply.json()).toMatchObject({ jsonrpc: "2.0", id: "init", result: { protocolVersion: ALEXA_PROTOCOL_VERSION } });
    expect(proxy.state().initialized).toBe(true);
  });

  it("answers a JSON-only caller as soon as the response arrives, though the server keeps its stream open", async () => {
    const proxy = await launch();
    fake.mode = "sse";
    fake.holdOpen = true;
    const reply = await post(proxy, rpc("tools/list", undefined, "t"), { accept: "application/json" });
    expect(reply.json()).toMatchObject({ id: "t", result: { tools: TOOLS } });
  });

  it("unwraps a batch into an array of its responses", async () => {
    const proxy = await launch();
    fake.mode = "sse";
    const reply = await post(proxy, [rpc("ping", undefined, "a"), notification("notifications/initialized"), rpc("tools/list", undefined, "b")], {
      accept: "application/json",
    });
    expect(reply.json().map((answer: { id: string }) => answer.id)).toEqual(["a", "b"]);
    expect(proxy.state().rpc.map((record) => record.method).sort()).toEqual(["notifications/initialized", "ping", "tools/list"]);
  });

  it("passes one through as it is for a caller that accepts event streams", async () => {
    const proxy = await launch();
    fake.mode = "sse";
    const reply = await post(proxy, rpc("tools/list", undefined, "t"));
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toBe("text/event-stream");
    expect(reply.text).toContain("notifications/message");
    expect(reply.text).toContain(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "t", result: { tools: TOOLS } })}`);
    expect(proxy.state().tools).toEqual(TOOLS);
  });

  it("opens the caller's event stream as soon as the server opens its own", async () => {
    const proxy = await launch();
    fake.mode = "sse";
    let release!: () => void;
    fake.quietStart = new Promise((resolve) => (release = resolve));
    const reply = await stream(`${proxy.url}/mcp`, { body: rpc("ping", undefined, "p"), headers: { accept: BOTH } });
    expect(reply.headers["content-type"]).toBe("text/event-stream");
    expect(reply.text).toBe("");
    release();
    await reply.next("message", (message) => message.id === "p");
  });

  it("passes on each event as it arrives, before the reply is finished", async () => {
    const proxy = await launch();
    fake.mode = "sse";
    let release!: () => void;
    fake.gate = new Promise((resolve) => (release = resolve));
    const reply = await stream(`${proxy.url}/mcp`, { body: rpc("tools/list", undefined, "t"), headers: { accept: BOTH } });
    expect(reply.headers["content-type"]).toBe("text/event-stream");
    await reply.next("message", (message) => message.method === "notifications/message");
    expect(reply.all("message").some((message) => "result" in message)).toBe(false);
    release();
    await reply.next("message", (message) => message.id === "t");
    await until(() => reply.ended, "the reply to end");
  });
});

describe("GET and DELETE /mcp", () => {
  it("forwards the server's event stream, and closes it upstream when the caller leaves", async () => {
    const proxy = await launch({ token: "secret-token" });
    const events = await stream(`${proxy.url}/mcp`, { headers: { accept: "text/event-stream", "mcp-session-id": SESSION_ID } });
    expect(events.status).toBe(200);
    expect(events.headers["content-type"]).toBe("text/event-stream");
    expect(events.headers["mcp-session-id"]).toBe(SESSION_ID);
    expect(fake.seen[0]?.headers).toMatchObject({ accept: "text/event-stream", "mcp-session-id": SESSION_ID, authorization: "Bearer secret-token" });

    await until(() => fake.streams.size === 1, "the server's stream to open");
    fake.push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(await events.next("message")).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

    events.close();
    await until(() => fake.closedStreams === 1, "the server's stream to close");
  });

  it("passes a server's 405 for GET through", async () => {
    const proxy = await launch();
    fake.allowGet = false;
    const reply = await call(`${proxy.url}/mcp`, { headers: { accept: "text/event-stream" } });
    expect(reply.status).toBe(405);
  });

  it("forwards DELETE and ends the session, but not another client's", async () => {
    const proxy = await launch();
    await post(proxy, rpc("initialize", ALEXA_INIT));
    expect(proxy.state().sessionId).toBe(SESSION_ID);

    const other = await call(`${proxy.url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": "someone-else" } });
    expect(other.status).toBe(200);
    expect(proxy.state()).toMatchObject({ initialized: true, sessionId: SESSION_ID });

    const reply = await call(`${proxy.url}/mcp`, { method: "DELETE", headers: { "mcp-session-id": SESSION_ID } });
    expect(reply.status).toBe(200);
    expect(fake.seen.at(-1)).toMatchObject({ method: "DELETE", headers: { "mcp-session-id": SESSION_ID } });
    expect(proxy.state().initialized).toBe(false);
    expect(proxy.state().sessionId).toBeUndefined();
    expect(await health(proxy)).toEqual({ status: "not-ready" });
  });

  it("reads a request target as a path, never as another host", async () => {
    const proxy = await launch();
    for (const path of ["//evil.example/mcp", "/\\evil.example/mcp"]) {
      const reply = await call(`${proxy.url}/`, { path, body: rpc("ping") });
      expect(reply.status, path).toBe(404);
    }
    expect((await call(`${proxy.url}/`, { path: "/mcp?session=1", body: rpc("ping"), headers: { accept: BOTH } })).status).toBe(200);
    expect(fake.seen).toHaveLength(1);
  });

  it("refuses other methods on /mcp", async () => {
    const proxy = await launch();
    const reply = await call(`${proxy.url}/mcp`, { method: "PUT", body: "{}" });
    expect(reply.status).toBe(405);
    expect(reply.headers.allow).toBe("GET, POST, DELETE");
  });
});

describe("state and events", () => {
  it("reports not-ready on /health until an initialize succeeds, then ok", async () => {
    const proxy = await launch();
    expect(await health(proxy)).toEqual({ status: "not-ready" });
    fake.failNext = { status: 500, body: "boom" };
    await post(proxy, rpc("initialize", ALEXA_INIT));
    expect(await health(proxy)).toEqual({ status: "not-ready" });
    await post(proxy, rpc("initialize", ALEXA_INIT));
    expect(await health(proxy)).toEqual({ status: "ok" });
  });

  it("records an initialize, and emits connected", async () => {
    const proxy = await launch();
    const events = await subscribe(proxy);
    await post(proxy, rpc("initialize", ALEXA_INIT));
    expect(await events.next("connected")).toEqual({
      address: fake.url,
      serverInfo: { name: "fake-upstream", version: "1.0.0" },
      protocolVersion: ALEXA_PROTOCOL_VERSION,
    });
    expect(proxy.state()).toMatchObject({
      upstream: fake.url,
      initialized: true,
      sessionId: SESSION_ID,
      protocolVersion: ALEXA_PROTOCOL_VERSION,
      serverInfo: { name: "fake-upstream", version: "1.0.0" },
      instructions: "Answer questions about the weather.",
    });
  });

  it("records a tools/list, and emits tools-discovered", async () => {
    const proxy = await launch();
    const events = await subscribe(proxy);
    await post(proxy, rpc("tools/list"));
    expect(await events.next("tools-discovered")).toEqual({ tools: TOOLS });
    expect(proxy.state().tools).toEqual(TOOLS);
  });

  it("adds a later tools/list page to the pages before it, and starts over on a fresh list", async () => {
    const proxy = await launch();
    fake.paginate = true;
    const names = () => proxy.state().tools.map((tool) => tool.name);
    await post(proxy, rpc("tools/list"));
    expect(names()).toEqual(["echo"]);
    await post(proxy, rpc("tools/list", { cursor: "page-2" }));
    expect(names()).toEqual(["echo", "show-card", "slow"]);
    await post(proxy, rpc("tools/list"));
    expect(names()).toEqual(["echo"]);
  });

  it("records a resources/read, and emits resource-fetched and, for a screen, widget-html", async () => {
    const proxy = await launch();
    const events = await subscribe(proxy);
    for (const uri of ["ui://card", "file:///notes.txt", "ui://card-blob", "ui://card"]) await post(proxy, rpc("resources/read", { uri }));
    await until(() => events.all("resource-fetched").length === 4, "four resource-fetched events");

    const card = { uri: "ui://card", mimeType: "text/html;profile=mcp-app", contentLength: Buffer.byteLength(WIDGET_HTML) };
    const notes = { uri: "file:///notes.txt", mimeType: "text/plain", contentLength: Buffer.byteLength("Bring an umbrella.") };
    const blob = { uri: "ui://card-blob", mimeType: "text/html;profile=mcp-app", contentLength: Buffer.byteLength(WIDGET_HTML) };
    expect(events.all("resource-fetched")).toEqual([card, notes, blob, card]);
    await until(() => events.all("widget-html").length === 3, "three widget-html events");
    expect(events.all("widget-html")).toEqual([
      { uri: "ui://card", html: WIDGET_HTML },
      { uri: "ui://card-blob", html: WIDGET_HTML },
      { uri: "ui://card", html: WIDGET_HTML },
    ]);
    // Reading a resource again updates its entry rather than adding another.
    expect(proxy.state().resources).toEqual([card, notes, blob]);
  });

  it("records a tools/call, and emits tool-called, whether the tool worked or not", async () => {
    const proxy = await launch();
    const events = await subscribe(proxy);
    await post(proxy, rpc("tools/call", { name: "echo", arguments: { text: "hi" } }, "c1"));
    await post(proxy, rpc("tools/call", { name: "broken", arguments: {} }, "c2"));
    await post(proxy, rpc("tools/call", { name: "missing" }, "c3"));

    const echo = await events.next("tool-called", (data) => data.toolName === "echo");
    expect(echo).toMatchObject({
      toolName: "echo",
      request: { jsonrpc: "2.0", id: "c1", method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } },
      response: { jsonrpc: "2.0", id: "c1", result: { structuredContent: { text: "hi" } } },
    });
    expect(echo.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(echo.ts).toBeGreaterThan(Date.now() - 60_000);
    expect(echo.durationMs).toBeGreaterThanOrEqual(0);
    expect(await events.next("tool-called", (data) => data.toolName === "missing")).toMatchObject({ response: { error: { code: -32602 } } });

    const calls = proxy.state().calls;
    expect(calls.map((c) => [c.tool, c.arguments, c.succeeded])).toEqual([
      ["echo", { text: "hi" }, true],
      ["broken", {}, false],
      ["missing", undefined, false],
    ]);
    // A tool that reports isError ran and failed; only the JSON-RPC error is a protocol error.
    expect(proxy.state().errors.map((error) => error.description)).toEqual(["Unknown tool: missing (-32602)"]);
  });

  it("records JSON-RPC errors and HTTP failures, and emits error", async () => {
    const proxy = await launch();
    const events = await subscribe(proxy);
    await post(proxy, rpc("prompts/list"));
    fake.failNext = { status: 401, body: "Unauthorized", headers: { "www-authenticate": 'Bearer realm="mcp"' } };
    const unauthorized = await post(proxy, rpc("tools/list"));
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers["www-authenticate"]).toBe('Bearer realm="mcp"');
    const badSession = { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } };
    fake.failNext = { status: 400, body: JSON.stringify(badSession), contentType: "application/json" };
    await post(proxy, rpc("tools/list"));

    const expected = [
      { method: "prompts/list", description: "Method not found (-32601)" },
      { method: "tools/list", description: "HTTP 401 Unauthorized from the MCP server, and no bearer token was sent" },
      { method: "tools/list", description: "HTTP 400 Bad Request from the MCP server: Bad Request: No valid session ID provided (-32000)" },
    ];
    expect(proxy.state().errors.map(({ method, description }) => ({ method, description }))).toEqual(expected);
    await until(() => events.all("error").length === 3, "three error events");
    expect(events.all("error")).toEqual(expected);
    expect(proxy.state().rpc.at(-1)).toMatchObject({ method: "tools/list", status: 400, error: { code: -32000 } });
  });

  it("says a 401 refused the token when one was sent", async () => {
    const proxy = await launch({ token: "stale" });
    fake.failNext = { status: 401 };
    await post(proxy, rpc("tools/list"));
    expect(proxy.state().errors[0]?.description).toBe("HTTP 401 Unauthorized from the MCP server, which refused the bearer token");
  });

  it("emits rpc for every exchange with its timing, and marks 500 ms or more as over budget", async () => {
    const proxy = await launch();
    const events = await subscribe(proxy);
    await post(proxy, rpc("ping", undefined, "quick"));
    await post(proxy, rpc("tools/call", { name: "slow", arguments: { ms: 520 } }, "slow"));

    const quick = await events.next("rpc", (record) => record.id === "quick");
    expect(quick).toMatchObject({ id: "quick", method: "ping", status: 200, result: {}, overBudget: false });
    expect(quick.durationMs).toBeLessThan(500);
    expect(quick.ts).toBeGreaterThan(Date.now() - 60_000);
    const slow = await events.next("rpc", (record) => record.id === "slow");
    expect(slow).toMatchObject({ method: "tools/call", params: { name: "slow" }, overBudget: true });
    expect(slow.durationMs).toBeGreaterThanOrEqual(500);
    expect(proxy.state().rpc.map((record) => record.id)).toEqual(["quick", "slow"]);
  });

  it("records each message of a batch, and keeps only the last 500 exchanges", async () => {
    const proxy = await launch();
    const batch = Array.from({ length: 505 }, (_, n) => notification("notifications/message", { n }));
    expect((await post(proxy, batch)).status).toBe(202);
    const rpcLog = proxy.state().rpc;
    expect(rpcLog).toHaveLength(500);
    expect(rpcLog[0]).toMatchObject({ method: "notifications/message", params: { n: 5 }, status: 202 });
    expect(rpcLog.at(-1)).toMatchObject({ params: { n: 504 } });
  });

  it("records a body that isn't JSON-RPC, and the server's refusal of it", async () => {
    const proxy = await launch();
    fake.failNext = { status: 400, body: "Parse error" };
    const reply = await call(`${proxy.url}/mcp`, { body: "{not json", headers: { accept: BOTH } });
    expect(reply.status).toBe(400);
    expect(proxy.state().rpc[0]).toMatchObject({ method: "(invalid)", status: 400 });
    expect(proxy.state().errors[0]?.description).toBe("HTTP 400 Bad Request from the MCP server");
  });

  it("delivers named events to every subscriber", async () => {
    const proxy = await launch();
    const first = await subscribe(proxy);
    const second = await subscribe(proxy);
    expect(first.headers["content-type"]).toBe("text/event-stream");
    await post(proxy, rpc("initialize", ALEXA_INIT));
    for (const events of [first, second]) {
      expect(await events.next("connected")).toMatchObject({ address: fake.url });
      expect(await events.next("rpc")).toMatchObject({ method: "initialize" });
    }
    expect(first.text).toMatch(/^event: connected\ndata: \{.*\}\n\nevent: rpc\ndata: \{.*\}\n\n$/);
  });

  it("sends subscribers a keepalive comment every 15 seconds", async () => {
    const proxy = await launch();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const events = await subscribe(proxy);
      vi.advanceTimersByTime(15_000);
      await until(() => events.text.includes(": keepalive\n\n"), "a keepalive");
      expect(events.text).toBe(": keepalive\n\n");
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves the state as JSON, and state() hands out a copy", async () => {
    const proxy = await launch();
    await post(proxy, rpc("tools/list"));
    const reply = await call(`${proxy.url}/state`);
    expect(reply.headers["content-type"]).toBe("application/json");
    expect(reply.json()).toEqual(JSON.parse(JSON.stringify(proxy.state())));
    proxy.state().tools.length = 0;
    expect(proxy.state().tools).toHaveLength(3);
  });
});

describe("who may call", () => {
  it("refuses a Host other than localhost or 127.0.0.1 on the port, which is how DNS rebinding shows", async () => {
    const proxy = await launch();
    const port = new URL(proxy.url).port;
    for (const host of ["evil.example", `evil.example:${port}`, "localhost:1", `192.168.1.5:${port}`]) {
      const reply = await call(`${proxy.url}/health`, { host });
      expect(reply.status, host).toBe(403);
      expect(reply.json().error.code).toBe("forbidden_host");
    }
    expect((await call(`${proxy.url}/health`, { host: `127.0.0.1:${port}` })).status).toBe(200);
    expect((await call(`${proxy.url}/health`, { host: `LocalHost:${port}` })).status).toBe(200);

    expect((await post(proxy, rpc("ping"))).status).toBe(200);
    expect((await call(`${proxy.url}/mcp`, { body: rpc("ping"), host: "evil.example" })).status).toBe(403);
    expect(fake.seen).toHaveLength(1);

    const page = await call(`${proxy.uiUrl}/`, { host: `evil.example:${new URL(proxy.uiUrl).port}` });
    expect(page.status).toBe(403);
  });

  it("allows the page's origins with CORS, and refuses every other origin without calling the server", async () => {
    const proxy = await launch();
    const clientPort = new URL(proxy.uiUrl).port;
    for (const origin of [`http://localhost:${clientPort}`, `http://127.0.0.1:${clientPort}`]) {
      const reply = await post(proxy, rpc("initialize", ALEXA_INIT), { origin });
      expect(reply.status).toBe(200);
      expect(reply.headers["access-control-allow-origin"]).toBe(origin);
      expect(reply.headers["access-control-expose-headers"]).toContain("Mcp-Session-Id");
      expect(reply.headers.vary).toBe("Origin");
    }
    expect(fake.seen).toHaveLength(2);

    for (const origin of ["https://evil.example", "null", `http://localhost:${new URL(proxy.url).port}`, `https://localhost:${clientPort}`]) {
      const reply = await post(proxy, rpc("tools/call", { name: "echo", arguments: { text: "pwned" } }), { origin });
      expect(reply.status, origin).toBe(403);
      expect(reply.json().error.code).toBe("forbidden_origin");
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect(fake.seen).toHaveLength(2);

    const plain = await call(`${proxy.url}/health`);
    expect(plain.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers the page's CORS preflight", async () => {
    const proxy = await launch();
    const origin = pageOrigin(proxy);
    const reply = await call(`${proxy.url}/mcp`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,mcp-session-id,mcp-protocol-version,mcp-method" },
    });
    expect(reply.status).toBe(204);
    expect(reply.headers).toMatchObject({
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
      "access-control-allow-headers": "content-type,mcp-session-id,mcp-protocol-version,mcp-method",
    });
    const refused = await call(`${proxy.url}/mcp`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(refused.status).toBe(403);
  });

  it("refuses at start a plain http upstream that isn't on this machine", async () => {
    await expect(startProxy({ upstream: "http://example.com/mcp", port: 0, clientPort: 0 })).rejects.toThrow(
      "Refusing http://example.com: a remote MCP server must use https://. Plain http:// is only allowed on this machine (localhost, 127.0.0.1 or [::1]), for a local dev server.",
    );
    await expect(startProxy({ upstream: "ftp://example.com/mcp", port: 0, clientPort: 0 })).rejects.toThrow(/must start with https:\/\//);
    await expect(startProxy({ upstream: "example.com/mcp", port: 0, clientPort: 0 })).rejects.toThrow(/isn't a URL/);
    await launch({ upstream: "https://example.com/mcp" });
    await launch({ upstream: "http://[::1]:9/mcp" });
  });
});

describe("the page", () => {
  it("serves the built page with each file's content type", async () => {
    const proxy = await launch();
    const expected: Record<string, string> = {
      "/": "text/html; charset=utf-8",
      "/index.html": "text/html; charset=utf-8",
      "/assets/app.js": "text/javascript; charset=utf-8",
      "/assets/style.css": "text/css; charset=utf-8",
      "/assets/logo.svg": "image/svg+xml",
      "/assets/icon.png": "image/png",
      "/assets/data.json": "application/json; charset=utf-8",
    };
    for (const [path, type] of Object.entries(expected)) {
      const reply = await call(`${proxy.uiUrl}${path}`);
      expect(reply.status, path).toBe(200);
      expect(reply.headers["content-type"], path).toBe(type);
    }
    expect((await call(`${proxy.uiUrl}/`)).text).toBe("<!doctype html><title>Simulator</title>");
  });

  it("tells the page where the proxy and the server are", async () => {
    const proxy = await launch();
    expect((await call(`${proxy.uiUrl}/config.json`)).json()).toEqual({ proxyUrl: proxy.url, upstream: fake.url });
  });

  it("serves nothing from outside its folder", async () => {
    const proxy = await launch();
    const paths = [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/..%5csecret.txt",
      "/assets/%2e%2e%5c%2e%2e%5csecret.txt",
      "/..\\secret.txt",
      "/%00",
      "/%E0%A4%A",
    ];
    for (const path of paths) {
      const reply = await call(`${proxy.uiUrl}/`, { path });
      expect(reply.status, path).toBeGreaterThanOrEqual(400);
      expect(reply.text, path).not.toContain(SECRET);
    }
  });

  it("answers 404 for a missing file, and 405 for anything but GET", async () => {
    const proxy = await launch();
    expect((await call(`${proxy.uiUrl}/missing.js`)).status).toBe(404);
    expect((await call(`${proxy.uiUrl}/`, { method: "POST", body: "{}" })).status).toBe(405);
  });

  it("serves only /config.json without a page to serve", async () => {
    const proxy = await launch({ uiDir: undefined });
    expect((await call(`${proxy.uiUrl}/`)).status).toBe(404);
    expect((await call(`${proxy.uiUrl}/config.json`)).status).toBe(200);
  });
});

describe("extra routes", () => {
  it("hands a route the request as a web Request and streams its Response back", async () => {
    let seen: { method: string; url: string; header: string | null; body: string } | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const proxy = await launch({
      routes: {
        "/api/model": async (request) => {
          seen = { method: request.method, url: request.url, header: request.headers.get("x-turn"), body: await request.text() };
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(encoder.encode("first "));
              await gate;
              controller.enqueue(encoder.encode("second"));
              controller.close();
            },
          });
          return new Response(body, { status: 201, headers: { "content-type": "text/plain", "x-route": "model" } });
        },
      },
    });
    const reply = await stream(`${proxy.url}/api/model?stream=1`, { body: { messages: [] }, headers: { "x-turn": "7" } });
    expect(reply.status).toBe(201);
    expect(reply.headers).toMatchObject({ "content-type": "text/plain", "x-route": "model" });
    await until(() => reply.text === "first ", "the first chunk");
    release();
    await until(() => reply.ended, "the reply to end");
    expect(reply.text).toBe("first second");
    expect(seen).toEqual({ method: "POST", url: `${proxy.url}/api/model?stream=1`, header: "7", body: '{"messages":[]}' });
  });

  it("applies the Host check and CORS to routes", async () => {
    let calls = 0;
    const proxy = await launch({
      routes: {
        "/api/check": async () => {
          calls++;
          return Response.json({ ok: true });
        },
      },
    });
    const origin = pageOrigin(proxy);
    const allowed = await call(`${proxy.url}/api/check`, { headers: { origin } });
    expect(allowed.json()).toEqual({ ok: true });
    expect(allowed.headers["access-control-allow-origin"]).toBe(origin);
    expect((await call(`${proxy.url}/api/check`, { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call(`${proxy.url}/api/check`, { host: "evil.example" })).status).toBe(403);
    expect(calls).toBe(1);
    expect((await call(`${proxy.url}/api/other`)).status).toBe(404);
  });

  it("answers 500 when a route throws", async () => {
    const proxy = await launch({
      routes: {
        "/api/model": async () => {
          throw new Error("no API key");
        },
      },
    });
    const reply = await call(`${proxy.url}/api/model`, { body: {} });
    expect(reply.status).toBe(500);
    expect(reply.json()).toEqual({ error: { code: "route_failed", message: "/api/model failed: no API key" } });
  });

  it("won't let a route take one of the proxy's own paths", async () => {
    const route = async () => new Response("");
    await expect(startProxy({ upstream: fake.url, port: 0, clientPort: 0, routes: { "/mcp": route } })).rejects.toThrow(/proxy's own paths/);
    await expect(startProxy({ upstream: fake.url, port: 0, clientPort: 0, routes: { "api/model": route } })).rejects.toThrow(/must start with "\/"/);
  });
});

describe("starting and stopping", () => {
  it("picks free ports for port 0 and reports them as localhost URLs", async () => {
    const proxy = await launch();
    expect(proxy.url).toMatch(/^http:\/\/localhost:\d+$/);
    expect(proxy.uiUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(proxy.url).not.toBe(proxy.uiUrl);
    expect(Number(new URL(proxy.url).port)).toBeGreaterThan(0);
  });

  it("says which port is taken", async () => {
    const first = await launch();
    const taken = Number(new URL(first.url).port);
    await expect(startProxy({ upstream: fake.url, port: taken, clientPort: 0 })).rejects.toThrow(
      `Port ${taken} on 127.0.0.1 is already in use, so the proxy can't start there.`,
    );
    await expect(startProxy({ upstream: fake.url, port: 0, clientPort: taken })).rejects.toThrow(
      `Port ${taken} on 127.0.0.1 is already in use, so the simulator page can't start there.`,
    );
  });

  it("closes every open stream on close(), and frees both ports", async () => {
    const proxy = await startProxy({ upstream: fake.url, port: 0, clientPort: 0 });
    const events = await stream(`${proxy.url}/events`);
    const server = await stream(`${proxy.url}/mcp`, { headers: { accept: "text/event-stream" } });
    await until(() => fake.streams.size === 1, "the server's stream to open");
    await proxy.close();
    await until(() => events.ended && server.ended, "both streams to end");
    await until(() => fake.closedStreams === 1, "the server's stream to close");
    await proxy.close();
    for (const url of [proxy.url, proxy.uiUrl]) {
      const probe = createNetServer();
      await new Promise<void>((resolve, reject) => probe.once("error", reject).listen(Number(new URL(url).port), "127.0.0.1", resolve));
      await new Promise((resolve) => probe.close(resolve));
    }
  });

  it("logs each exchange to stderr when verbose", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      const proxy = await launch({ verbose: true });
      await post(proxy, rpc("initialize", ALEXA_INIT));
      await post(proxy, rpc("prompts/list"));
    } finally {
      write.mockRestore();
    }
    expect(lines.some((line) => /^\[proxy\] initialize 200 \d+ ms\n$/.test(line))).toBe(true);
    expect(lines.some((line) => /^\[proxy\] prompts\/list 200 \d+ ms: Method not found \(-32601\)\n$/.test(line))).toBe(true);
  });
});

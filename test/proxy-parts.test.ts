import { join, resolve, sep } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ProxyEvent } from "../src/shared/contract.ts";
import { wantsJsonOnly } from "../src/proxy/forward.ts";
import { parseMessages, Recorder } from "../src/proxy/recorder.ts";
import { formatSseEvent, SseParser, type SseEvent } from "../src/proxy/sse.ts";
import { resolveStaticPath } from "../src/proxy/static.ts";
import { parseUpstream } from "../src/proxy/upstream.ts";

function parseAll(chunks: (string | Uint8Array)[]): SseEvent[] {
  const events: SseEvent[] = [];
  const parser = new SseParser((event) => events.push(event));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return events;
}

describe("SseParser", () => {
  it("reads named events, multi-line data, ids, comments and the default event type", () => {
    const text = [": hello", "event: rpc", "id: 7", "data: {\"a\":1}", "", "data: one", "data: two", "", "data:no-space", "", ""].join("\n");
    expect(parseAll([text])).toEqual([
      { event: "rpc", data: '{"a":1}', id: "7" },
      { event: "message", data: "one\ntwo", id: "7" },
      { event: "message", data: "no-space", id: "7" },
    ]);
  });

  it("treats CRLF and CR as line ends, even when a CRLF is split across chunks", () => {
    expect(parseAll(["data: a\r", "\n\r", "\ndata: b\r\r"])).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ]);
  });

  it("dispatches an empty data line as an empty event, as a priming event is, and nothing without data", () => {
    expect(parseAll(["id: prime\ndata:\n\nevent: lonely\n\n"])).toEqual([{ event: "message", data: "", id: "prime" }]);
  });

  it("drops an event the stream ends in the middle of, and ignores an id with a NUL", () => {
    expect(parseAll(["id: a\0b\ndata: whole\n\ndata: cut off"])).toEqual([{ event: "message", data: "whole" }]);
  });

  it("strips a byte order mark at the very start", () => {
    expect(parseAll([new Uint8Array([0xef, 0xbb, 0xbf]), "data: x\n\n"])).toEqual([{ event: "message", data: "x" }]);
  });

  it("parses any stream the same however it's split into chunks, even inside a character", () => {
    const text = fc.string({ unit: "binary", maxLength: 12 }).filter((value) => !/[\r\n]/.test(value));
    const item = fc.oneof(
      fc.record({
        kind: fc.constant("event" as const),
        type: fc.option(text.filter((value) => value !== ""), { nil: undefined }),
        id: fc.option(text.filter((value) => !value.includes("\0")), { nil: undefined }),
        data: fc.array(text, { minLength: 1, maxLength: 3 }),
      }),
      fc.record({ kind: fc.constant("comment" as const), text }),
    );
    fc.assert(
      fc.property(fc.array(item, { maxLength: 8 }), fc.constantFrom("\n", "\r\n", "\r"), fc.array(fc.nat(), { maxLength: 12 }), (items, eol, cuts) => {
        let stream = "";
        let lastId: string | undefined;
        const expected: SseEvent[] = [];
        for (const entry of items) {
          if (entry.kind === "comment") {
            stream += `:${entry.text}${eol}`;
            continue;
          }
          if (entry.type !== undefined) stream += `event: ${entry.type}${eol}`;
          if (entry.id !== undefined) {
            stream += `id: ${entry.id}${eol}`;
            lastId = entry.id;
          }
          for (const line of entry.data) stream += `data: ${line}${eol}`;
          stream += eol;
          const event: SseEvent = { event: entry.type ?? "message", data: entry.data.join("\n") };
          if (lastId !== undefined) event.id = lastId;
          expected.push(event);
        }
        const bytes = new TextEncoder().encode(stream);
        const points = [...new Set(cuts.map((cut) => cut % (bytes.length + 1)))].sort((a, b) => a - b);
        const chunks = [0, ...points].map((start, i) => bytes.slice(start, [...points, bytes.length][i]));
        expect(parseAll(chunks)).toEqual(expected);
        expect(parseAll([stream])).toEqual(expected);
      }),
    );
  });

  it("writes an event that reads back as itself", () => {
    const data = { text: "line one\nline two", n: 1 };
    expect(parseAll([formatSseEvent("tool-called", data)])).toEqual([{ event: "tool-called", data: JSON.stringify(data) }]);
  });
});

describe("wantsJsonOnly", () => {
  it.each([
    ["application/json", true],
    ["Application/JSON; charset=utf-8", true],
    ["application/*", true],
    ["application/json, text/event-stream;q=0", true],
    ["application/json, text/event-stream", false],
    ["text/event-stream, application/json", false],
    ["application/json, */*", false],
    ["application/json, text/*", false],
    ["*/*", false],
    ["text/event-stream", false],
    ["text/plain", false],
    ["application/json;q=0", false],
    [undefined, false],
  ])("%s gives %s", (accept, expected) => {
    expect(wantsJsonOnly(accept)).toBe(expected);
  });
});

describe("parseUpstream", () => {
  it.each([
    "https://example.com/mcp",
    "https://example.com:8443/mcp?tenant=1",
    "http://localhost:3000/mcp",
    "HTTP://LOCALHOST/mcp",
    "http://127.0.0.1:3000/mcp",
    "http://127.4.5.6/mcp",
    "http://[::1]:3000/mcp",
    // Other spellings of 127.0.0.1, which URL parsing turns into it.
    "http://2130706433/mcp",
    "http://0x7f.1/mcp",
  ])("allows %s", (upstream) => {
    expect(parseUpstream(upstream)).toBeInstanceOf(URL);
  });

  it.each([
    "http://example.com/mcp",
    "http://localhost.example.com/mcp",
    "http://127.0.0.1.nip.io/mcp",
    "http://10.0.0.5/mcp",
    "http://192.168.1.20:3000/mcp",
    "http://[::2]/mcp",
    "http://0.0.0.0:3000/mcp",
    "ws://localhost/mcp",
    "file:///etc/passwd",
    "localhost:3000/mcp",
    "not a url",
  ])("refuses %s", (upstream) => {
    expect(() => parseUpstream(upstream)).toThrow();
  });
});

describe("resolveStaticPath", () => {
  const root = resolve("ui-root");

  it("finds files inside the folder", () => {
    expect(resolveStaticPath(root, "/")).toBe(root);
    expect(resolveStaticPath(root, "/assets/app.js")).toBe(join(root, "assets", "app.js"));
    expect(resolveStaticPath(root, "/assets/my%20file.js")).toBe(join(root, "assets", "my file.js"));
    expect(resolveStaticPath(root, "/a/../b.js")).toBe(join(root, "b.js"));
  });

  it.each(["/..", "/../secret", "/..%2fsecret", "/%2e%2e/secret", "/a/..%2f..%2fsecret", "/%00", "/%E0%A4%A"])("refuses %s", (path) => {
    expect(resolveStaticPath(root, path)).toBeUndefined();
  });

  it.each(["/..%5csecret", "/a/%2e%2e%5c%2e%2e%5csecret"])("keeps %s inside the folder, refusing it where a backslash separates", (path) => {
    // On Windows a backslash climbs like a slash; elsewhere it's part of a file name, which stays inside.
    const found = resolveStaticPath(root, path);
    if (process.platform === "win32") expect(found).toBeUndefined();
    else expect(found?.startsWith(root + sep)).toBe(true);
  });

  it("never resolves outside the folder, whatever the segments", () => {
    const segment = fc.constantFrom("..", ".", "%2e%2e", "%2E%2e", "assets", "a b", "%2f", "%5c", "\\", "..%2f", "..%5c", "C:", "...", "%2e", "~");
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 8 }), (segments) => {
        const found = resolveStaticPath(root, `/${segments.join("/")}`);
        if (found !== undefined) expect(found === root || found.startsWith(root + sep)).toBe(true);
      }),
    );
  });
});

describe("parseMessages", () => {
  it("reads one message or a batch, and nothing that isn't JSON-RPC", () => {
    expect(parseMessages('{"jsonrpc":"2.0","id":1,"method":"ping"}')).toEqual({ messages: [{ jsonrpc: "2.0", id: 1, method: "ping" }], batch: false });
    expect(parseMessages('[{"method":"a"}, 3, {"method":"b"}]')).toEqual({ messages: [{ method: "a" }, { method: "b" }], batch: true });
    for (const text of ["[]", "[1, 2]", "42", "null", '"text"', "{nope"]) expect(parseMessages(text), text).toBeUndefined();
  });
});

describe("Recorder", () => {
  function setup() {
    const events: ProxyEvent[] = [];
    const recorder = new Recorder("https://example.com/mcp", (event) => events.push(event));
    const begin = (body: unknown) => recorder.begin(parseMessages(JSON.stringify(body)), false);
    return { events, recorder, begin };
  }

  it("calls a reply without the request's response an error", () => {
    const { recorder, begin } = setup();
    const exchange = begin({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    exchange.head(200, undefined);
    exchange.receive({ jsonrpc: "2.0", id: 2, result: {} });
    exchange.end("complete");
    expect(recorder.state.errors.map((error) => error.description)).toEqual(["The MCP server's reply (HTTP 200) had no response to this request"]);
  });

  it("records a request the caller gave up on, without calling it an error", () => {
    const { recorder, events, begin } = setup();
    const exchange = begin({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "echo" } });
    exchange.head(200, undefined);
    exchange.end("aborted");
    expect(recorder.state.errors).toEqual([]);
    expect(recorder.state.calls).toMatchObject([{ tool: "echo", succeeded: false }]);
    expect(events.map((event) => event.event)).toEqual(["tool-called", "rpc"]);
  });

  it("answers every request of a batch with an error the server sent with a null id", () => {
    const { recorder, begin } = setup();
    const exchange = begin([
      { jsonrpc: "2.0", id: "a", method: "ping" },
      { jsonrpc: "2.0", id: "b", method: "tools/list" },
    ]);
    exchange.head(404, undefined);
    exchange.receive({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
    exchange.end("complete");
    expect(recorder.state.rpc.map((record) => [record.id, record.status, record.error])).toEqual([
      ["a", 404, { code: -32001, message: "Session not found" }],
      ["b", 404, { code: -32001, message: "Session not found" }],
    ]);
    expect(recorder.state.errors.map((error) => error.description)).toEqual([
      "HTTP 404 Not Found from the MCP server: Session not found (-32001)",
      "HTTP 404 Not Found from the MCP server: Session not found (-32001)",
    ]);
  });

  it("ignores the server's own messages and stray responses on the stream", () => {
    const { recorder, begin } = setup();
    const exchange = begin({ jsonrpc: "2.0", id: 1, method: "ping" });
    exchange.head(200, undefined);
    exchange.receive({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage", params: {} });
    exchange.receive({ jsonrpc: "2.0", method: "notifications/progress", params: {} });
    exchange.receive("not an object");
    expect(exchange.answered).toBe(false);
    exchange.receive({ jsonrpc: "2.0", id: 1, result: {} });
    expect(exchange.answered).toBe(true);
    expect(recorder.state.rpc).toHaveLength(1);
  });

  it("records a resource without a type, its length in bytes, and sends no widget for it", () => {
    const { recorder, events, begin } = setup();
    const exchange = begin({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://x" } });
    exchange.head(200, undefined);
    // Five characters, one of them two bytes in UTF-8.
    exchange.receive({ jsonrpc: "2.0", id: 1, result: { contents: [{ uri: "ui://x", text: "héllo" }] } });
    expect(recorder.state.resources).toEqual([{ uri: "ui://x", contentLength: 6 }]);
    expect(events.map((event) => event.event)).toEqual(["resource-fetched", "rpc"]);
  });

  it("keeps a session that a DELETE for another session doesn't end", () => {
    const { recorder, begin } = setup();
    const exchange = begin({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    exchange.head(200, "s1");
    exchange.receive({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", serverInfo: { name: "x" } } });
    recorder.sessionEnded("s2");
    expect(recorder.state).toMatchObject({ initialized: true, sessionId: "s1" });
    recorder.sessionEnded(undefined);
    expect(recorder.state.initialized).toBe(true);
    recorder.sessionEnded("s1");
    expect(recorder.state.initialized).toBe(false);
  });
});

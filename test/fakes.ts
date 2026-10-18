import { McpServer, WebStandardStreamableHTTPServerTransport, createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod";

/**
 * Fake MCP servers for the readiness check's tests, reached through the
 * check's `fetch` option so nothing touches the network. `fakeServer` is
 * hand-rolled JSON-RPC that can misbehave in every way a rule looks for, on a
 * fake clock so latency costs no real time; `sdkServer` is the MCP SDK's own
 * Streamable HTTP server, so the check is also proven against the real thing.
 */

type Json = Record<string, unknown>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FakeTool {
  name?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Json;
  _meta?: Json;
  /** What every call returns. */
  result?: unknown;
  /** What call number n returns, counting from 1, for a tool whose answer changes. */
  results?: (call: number) => unknown;
  /** Asks the client for its roots mid-stream and answers only once it replies (SSE framing only). */
  asksForRoots?: boolean;
}

export interface FakeOptions {
  framing?: "json" | "sse";
  /** null makes the server stateless. */
  sessionId?: string | null;
  /** What initialize answers; by default it echoes the client's. "" leaves it out. */
  protocolVersion?: string;
  tools?: FakeTool[];
  /** tools/list pages of this many tools, with nextCursor. */
  pageSize?: number;
  /** Screens by URI; any other URI answers with a JSON-RPC error. */
  resources?: Record<string, { mimeType?: string; text?: string }>;
  /** Milliseconds each request takes, on the fake clock. */
  latency?: (method: string, params: Json | undefined) => number;
  /** How a call to a tool that doesn't exist is answered. */
  missingTool?: "error" | "isError" | "http500" | "success" | "hang" | "deaf" | "stall" | "html" | "bare404";
  auth?: { token: string; status?: 401 | 403; wwwAuthenticate?: string; guard?: "all" | "tools/call" };
  /** Documents served by path, like "/.well-known/oauth-protected-resource". */
  documents?: Record<string, unknown>;
  /** The status notifications/initialized gets. */
  initializedStatus?: number;
  /** Answers every request with this id instead of the request's own. */
  answerId?: string | number;
  /** Never answers initialize. */
  hangOnInitialize?: boolean;
}

export interface Sent {
  httpMethod: string;
  url: string;
  headers: Headers;
  body?: Json;
}

export const FORECAST_TOOL: FakeTool = {
  name: "get_forecast",
  description: "Today's forecast.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
  _meta: { ui: { resourceUri: "ui://forecast" } },
  result: {
    content: [{ type: "text", text: "Sunny and 72 today." }],
    structuredContent: { summary: "Sunny", high: 72 },
  },
};

export const BOOKING_TOOL: FakeTool = {
  name: "book_table",
  description: "Books a table.",
  inputSchema: { type: "object", properties: { when: { type: "string" } }, required: ["when"] },
  result: { content: [{ type: "text", text: "Booked." }] },
};

export const FORECAST_SCREEN = { "ui://forecast": { mimeType: "text/html;profile=mcp-app", text: "<div>Sunny</div>" } };

const encoder = new TextEncoder();

/** A stream that emits each part when it's read, waiting on parts that are promises. */
export function streamOf(parts: (() => string | Promise<string>)[]): ReadableStream<Uint8Array> {
  let next = 0;
  return new ReadableStream({
    async pull(controller) {
      const part = parts[next++];
      if (!part) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(await part()));
    },
  });
}

export const sseEvent = (message: unknown, event = "message") => `event: ${event}\ndata: ${JSON.stringify(message)}\n\n`;

/** Never settles, except to reject when the request is aborted, as a hung server looks to fetch. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
  });
}

export function fakeServer(options: FakeOptions = {}) {
  const clock = { t: 0 };
  const sent: Sent[] = [];
  const calls = new Map<string, number>();
  const waitingForReply = new Map<string | number, () => void>();
  const sessionId = options.sessionId === undefined ? "fake-session-1" : options.sessionId;
  const tools = options.tools ?? [FORECAST_TOOL, BOOKING_TOOL];
  const resources: Record<string, { mimeType?: string; text?: string }> = options.resources ?? FORECAST_SCREEN;

  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "POST" ? ((await request.json()) as Json) : undefined;
    sent.push({ httpMethod: request.method, url: request.url, headers: request.headers, ...(body ? { body } : {}) });

    if (url.pathname !== "/mcp") {
      const document = options.documents?.[url.pathname];
      return document === undefined ? new Response("Not Found", { status: 404 }) : Response.json(document);
    }
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (request.method !== "POST" || !body) return new Response("Method Not Allowed", { status: 405 });

    const method = typeof body.method === "string" ? body.method : undefined;
    const auth = options.auth;
    if (auth && (auth.guard !== "tools/call" || method === "tools/call") && request.headers.get("authorization") !== `Bearer ${auth.token}`) {
      const headers: Record<string, string> = auth.wwwAuthenticate ? { "WWW-Authenticate": auth.wwwAuthenticate } : {};
      return new Response(null, { status: auth.status ?? 401, headers });
    }

    // The client's reply to a request this server sent it mid-stream.
    if (!method && "id" in body) {
      waitingForReply.get(body.id as string)?.();
      return new Response(null, { status: 202 });
    }
    if (!("id" in body)) return new Response(null, { status: options.initializedStatus ?? 202 });
    if (method === "initialize" && options.hangOnInitialize) return hang(init);
    if (sessionId && method !== "initialize" && request.headers.get("mcp-session-id") !== sessionId) {
      return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Bad Request: No valid session ID provided" } }, { status: 400 });
    }

    const params = (body.params ?? undefined) as Json | undefined;
    clock.t += options.latency?.(method!, params) ?? 0;
    const id = options.answerId ?? (body.id as string);
    const reply = (payload: Json, extra: Record<string, string> = {}): Response => {
      const message = { jsonrpc: "2.0", id, ...payload };
      if (options.framing === "sse") {
        return new Response(sseEvent(message), { headers: { "Content-Type": "text/event-stream", ...extra } });
      }
      return Response.json(message, { headers: extra });
    };

    switch (method) {
      case "initialize": {
        const asked = (params?.protocolVersion as string | undefined) ?? "";
        const version = options.protocolVersion ?? asked;
        return reply(
          {
            result: {
              ...(version ? { protocolVersion: version } : {}),
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "fake-server", version: "1.2.3" },
            },
          },
          sessionId ? { "Mcp-Session-Id": sessionId } : {},
        );
      }
      case "tools/list": {
        const listed = tools.map(({ result, results, asksForRoots, ...definition }) => definition);
        if (!options.pageSize) return reply({ result: { tools: listed } });
        const start = Number(params?.cursor ?? 0);
        const page = listed.slice(start, start + options.pageSize);
        const more = start + options.pageSize < listed.length;
        return reply({ result: { tools: page, ...(more ? { nextCursor: String(start + options.pageSize) } : {}) } });
      }
      case "tools/call": {
        const name = params?.name as string;
        const tool = tools.find((t) => t.name === name);
        if (!tool) {
          switch (options.missingTool ?? "error") {
            case "isError":
              return reply({ result: { content: [{ type: "text", text: `No tool ${name}` }], isError: true } });
            case "http500":
              return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } }, { status: 500 });
            case "success":
              return reply({ result: { content: [{ type: "text", text: "Done!" }] } });
            case "hang":
              return hang(init);
            case "deaf":
              // Ignores the abort signal too, as some fetch implementations and proxies do.
              return new Promise<Response>(() => {});
            case "stall":
              // Answers, then never sends the event; a body made here doesn't hear the abort signal.
              return new Response(streamOf([() => new Promise<string>(() => {})]), { headers: { "Content-Type": "text/event-stream" } });
            case "html":
              return new Response("<html>Oops</html>", { headers: { "Content-Type": "text/html" } });
            case "bare404":
              return new Response("Not Found", { status: 404 });
            default:
              return reply({ error: { code: -32602, message: `Tool ${name} not found` } });
          }
        }
        const n = (calls.get(name) ?? 0) + 1;
        calls.set(name, n);
        const result = tool.results ? tool.results(n) : tool.result;
        if (tool.asksForRoots && options.framing === "sse") {
          const replied = new Promise<void>((resolve) => waitingForReply.set("roots-1", resolve));
          const stream = streamOf([
            () => sseEvent({ jsonrpc: "2.0", id: "roots-1", method: "roots/list" }),
            async () => {
              await replied;
              return sseEvent({ jsonrpc: "2.0", id, result });
            },
          ]);
          return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        }
        return reply({ result });
      }
      case "resources/read": {
        const uri = params?.uri as string;
        const resource = resources[uri];
        if (!resource) return reply({ error: { code: -32002, message: `Resource not found: ${uri}` } });
        return reply({ result: { contents: [{ uri, ...resource }] } });
      }
      default:
        return reply({ error: { code: -32601, message: `Method not found: ${method}` } });
    }
  };

  return {
    fetch,
    clock,
    now: () => clock.t,
    sent,
    /** The JSON-RPC requests (with ids) the server got, in order. */
    requests: () => sent.filter((s) => s.body && "id" in s.body && typeof s.body.method === "string").map((s) => s.body!),
    calledTools: () =>
      sent
        .filter((s) => s.body?.method === "tools/call")
        .map((s) => (s.body!.params as Json).name as string),
  };
}

/**
 * A server that speaks only the legacy HTTP+SSE transport: POSTs to its SSE
 * URL get 404, and a GET opens a stream that announces where to POST and
 * then stays open, as those servers do.
 */
export function legacySseServer() {
  let canceled = false;
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== "GET") return new Response("Cannot POST /sse", { status: 404 });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: endpoint\ndata: /messages?sessionId=abc123\n\n"));
      },
      cancel() {
        canceled = true;
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  };
  return { fetch, canceled: () => canceled };
}

function buildSdkServer(): McpServer {
  const server = new McpServer({ name: "sdk-server", version: "2.0.0" });
  server.registerTool(
    "get_status",
    {
      description: "The ranch's status right now.",
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: "ui://status" } },
    },
    async () => ({ content: [{ type: "text", text: "All good." }], structuredContent: { ok: true } }),
  );
  server.registerTool(
    "feed_animals",
    { description: "Feeds the animals.", inputSchema: z.object({ ration: z.number() }) },
    async ({ ration }) => ({ content: [{ type: "text", text: `Fed ${ration}.` }] }),
  );
  server.registerResource("status", "ui://status", { mimeType: "text/html;profile=mcp-app" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: "<p>All good</p>" }],
  }));
  return server;
}

/** The MCP SDK's Streamable HTTP server: sessionful with JSON or SSE answers, or stateless through createMcpHandler. */
export function sdkServer(mode: "json" | "sse" | "stateless") {
  const toolCalls: string[] = [];
  const record = async (request: Request) => {
    if (request.method !== "POST") return;
    const body = (await request.clone().json()) as Json;
    if (body.method === "tools/call") toolCalls.push((body.params as Json).name as string);
  };
  if (mode === "stateless") {
    const handler = createMcpHandler(() => buildSdkServer());
    const fetch: Fetch = async (input, init) => {
      const request = new Request(input, init);
      await record(request);
      return handler.fetch(request);
    };
    return { fetch, toolCalls, sessions: new Map<string, unknown>() };
  }
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const fetch: Fetch = async (input, init) => {
    const request = new Request(input, init);
    await record(request);
    const id = request.headers.get("mcp-session-id");
    if (id) {
      const transport = sessions.get(id);
      return transport ? transport.handleRequest(request) : new Response("Session not found", { status: 404 });
    }
    const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: mode === "json",
      keepAliveMs: 0,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    await buildSdkServer().connect(transport);
    return transport.handleRequest(request);
  };
  return { fetch, toolCalls, sessions };
}

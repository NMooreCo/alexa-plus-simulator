import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in MCP server for the proxy's tests: Streamable HTTP on 127.0.0.1,
 * answering JSON-RPC as one JSON body or as an event stream, with a session
 * id, and keeping every request it saw.
 */

export const SESSION_ID = "fake-session-1";
export const WIDGET_HTML = "<!doctype html><html><body><p>Hello from the widget</p></body></html>";

export const TOOLS = [
  { name: "echo", description: "Says the text back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  {
    name: "show-card",
    description: "Shows a card.",
    inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: "ui://card" } },
  },
  { name: "slow", description: "Answers after a delay.", inputSchema: { type: "object" } },
];

export interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

type Message = { jsonrpc: "2.0"; id?: string | number; method?: string; params?: Record<string, unknown> };

const ok = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class FakeUpstream {
  /** The MCP endpoint, like http://127.0.0.1:1234/mcp. */
  url = "";
  /** The server's origin, for its other paths. */
  origin = "";
  readonly seen: Seen[] = [];
  /** How POSTs are answered: one JSON body, or an event stream. */
  mode: "json" | "sse" = "json";
  /** Keep an event-stream reply open after its responses, as some servers do. */
  holdOpen = false;
  /** When set, an event-stream reply waits here after its first message, before the responses. */
  gate: Promise<void> | undefined;
  /** When set, an event-stream reply sends its headers and then nothing until this resolves. */
  quietStart: Promise<void> | undefined;
  /** When set, the next POST gets this answer instead of a JSON-RPC one. */
  failNext: { status: number; body?: string; contentType?: string; headers?: Record<string, string> } | undefined;
  /** Answer tools/list in two pages. */
  paginate = false;
  /** Answer GET /mcp with an event stream; otherwise 405, which servers are allowed to send. */
  allowGet = true;
  /** Where a request to /away is redirected, keeping its method. */
  redirectTo = "";
  /** The open GET /mcp streams, and how many have closed. */
  readonly streams = new Set<ServerResponse>();
  closedStreams = 0;
  private readonly server: Server;

  private constructor() {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        response.destroy(error as Error);
      });
    });
  }

  static async start(): Promise<FakeUpstream> {
    const fake = new FakeUpstream();
    await new Promise<void>((resolve) => fake.server.listen(0, "127.0.0.1", resolve));
    const { port } = fake.server.address() as AddressInfo;
    fake.origin = `http://127.0.0.1:${port}`;
    fake.url = `${fake.origin}/mcp`;
    return fake;
  }

  /** Back to the defaults between tests. */
  reset(): void {
    this.seen.length = 0;
    this.mode = "json";
    this.holdOpen = false;
    this.gate = undefined;
    this.quietStart = undefined;
    this.failNext = undefined;
    this.paginate = false;
    this.allowGet = true;
    this.redirectTo = "";
    this.closedStreams = 0;
  }

  /** The requests to /mcp with this JSON-RPC method. */
  requests(method: string): Seen[] {
    return this.seen.filter((seen) => seen.body.includes(`"method":"${method}"`));
  }

  /** Sends a message on every open GET /mcp stream. */
  push(message: unknown): void {
    for (const stream of this.streams) stream.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const path = request.url ?? "/";
    this.seen.push({ method: request.method ?? "", path, headers: request.headers, body });

    if (path === "/moved") {
      response.writeHead(307, { location: "/mcp" }).end();
      return;
    }
    if (path === "/elsewhere") {
      response.writeHead(307, { location: "http://example.com/mcp" }).end();
      return;
    }
    if (path === "/away") {
      response.writeHead(307, { location: this.redirectTo }).end();
      return;
    }
    if (path !== "/mcp") {
      response.writeHead(404, { "content-type": "text/html" }).end("<h1>Not found</h1>");
      return;
    }
    if (request.method === "GET") return this.openStream(response);
    if (request.method === "DELETE") {
      response.writeHead(200).end();
      return;
    }
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = undefined;
      response.writeHead(failure.status, { "content-type": failure.contentType ?? "text/plain", ...failure.headers }).end(failure.body ?? "");
      return;
    }

    const parsed = JSON.parse(body) as Message | Message[];
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const requests = messages.filter((message) => message.method !== undefined && message.id !== undefined);
    if (!requests.length) {
      response.writeHead(202).end();
      return;
    }
    const answers = await Promise.all(requests.map((message) => this.answer(message)));
    const headers: Record<string, string> = {};
    if (messages.some((message) => message.method === "initialize")) headers["mcp-session-id"] = SESSION_ID;
    const version = request.headers["mcp-protocol-version"];
    if (typeof version === "string") headers["mcp-protocol-version"] = version;

    if (this.mode === "json") {
      response.writeHead(200, { ...headers, "content-type": "application/json" });
      response.end(JSON.stringify(Array.isArray(parsed) ? answers : answers[0]));
      return;
    }
    response.writeHead(200, { ...headers, "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (this.quietStart) {
      response.flushHeaders();
      await this.quietStart;
    }
    // What real servers put ahead of the response: a priming event (an id and empty data), a
    // keepalive comment, and a notification on the request's stream.
    response.write("id: prime-1\ndata:\n\n");
    response.write(": keepalive\n\n");
    response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "working" } })}\n\n`);
    if (this.gate) await this.gate;
    for (const answer of answers) response.write(`id: answer-${String(answer.id)}\nevent: message\ndata: ${JSON.stringify(answer)}\n\n`);
    if (!this.holdOpen) response.end();
  }

  private openStream(response: ServerResponse): void {
    if (!this.allowGet) {
      response.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": SESSION_ID });
    response.flushHeaders();
    this.streams.add(response);
    response.on("close", () => {
      this.streams.delete(response);
      this.closedStreams++;
    });
  }

  private async answer(message: Message): Promise<{ id: unknown } & Record<string, unknown>> {
    const params = message.params ?? {};
    switch (message.method) {
      case "initialize":
        return ok(message.id, {
          protocolVersion: params.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "fake-upstream", version: "1.0.0" },
          instructions: "Answer questions about the weather.",
        });
      case "tools/list":
        if (!this.paginate) return ok(message.id, { tools: TOOLS });
        return params.cursor === "page-2" ? ok(message.id, { tools: TOOLS.slice(1) }) : ok(message.id, { tools: TOOLS.slice(0, 1), nextCursor: "page-2" });
      case "tools/call":
        return this.callTool(message.id, params);
      case "resources/read":
        return this.readResource(message.id, String(params.uri));
      case "ping":
        return ok(message.id, {});
      default:
        return fail(message.id, -32601, "Method not found");
    }
  }

  private async callTool(id: unknown, params: Record<string, unknown>) {
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    switch (params.name) {
      case "echo":
        return ok(id, { content: [{ type: "text", text: String(args.text) }], structuredContent: { text: args.text } });
      case "show-card":
        return ok(id, { content: [{ type: "text", text: "Here's the card." }], _meta: { ui: { resourceUri: "ui://card" } } });
      case "broken":
        return ok(id, { isError: true, content: [{ type: "text", text: "It broke." }] });
      case "slow":
        await delay(Number(args.ms ?? 0));
        return ok(id, { content: [{ type: "text", text: "Done." }] });
      default:
        return fail(id, -32602, `Unknown tool: ${String(params.name)}`);
    }
  }

  private readResource(id: unknown, uri: string) {
    switch (uri) {
      case "ui://card":
        return ok(id, { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: WIDGET_HTML }] });
      case "ui://card-blob":
        return ok(id, { contents: [{ uri, mimeType: "text/html;profile=mcp-app", blob: Buffer.from(WIDGET_HTML).toString("base64") }] });
      case "file:///notes.txt":
        return ok(id, { contents: [{ uri, mimeType: "text/plain", text: "Bring an umbrella." }] });
      default:
        return fail(id, -32002, `Resource not found: ${uri}`);
    }
  }
}

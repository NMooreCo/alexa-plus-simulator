import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { parseMessages, type Ending, type Exchange, type Recorder } from "./recorder.ts";
import { SseParser } from "./sse.ts";
import { RedirectRefused, type Upstream } from "./upstream.ts";
import { readBody, sendJson } from "./web.ts";

/**
 * `/mcp` on the proxy: each request forwarded to the MCP server under test
 * (Streamable HTTP), its reply passed back, and every JSON-RPC exchange
 * recorded on the way through.
 */

/**
 * Where the bearer token comes from: a fixed one, or a function asked on every
 * request. After the server refuses a token from the function with 401, the
 * function is asked again with that token, so it can refresh it, and the
 * request goes once more with what it gives back.
 */
export type TokenSource = string | ((refused?: string) => Promise<string | undefined>);

/** Sent upstream so a server's logs can tell the simulator's traffic apart. */
const USER_AGENT = "alexa-plus-simulator";
/** Both reply forms Streamable HTTP allows, so the server answers the way it would answer Alexa. */
const POST_ACCEPT = "application/json, text/event-stream";
/** Request headers a server needs besides the Mcp-* ones: the body's type, where to resume a stream, and the caller's own credentials. */
const PASSED_UP = new Set(["content-type", "last-event-id", "authorization"]);

/** The configured token function failed: the proxy's problem, not the server's. */
class TokenFailure extends Error {
  constructor(cause: unknown) {
    super(`Couldn't get a bearer token for the MCP server: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export class McpForwarder {
  private readonly extraHeaders: Record<string, string>;

  constructor(
    private readonly upstream: Upstream,
    private readonly recorder: Recorder,
    private readonly token: TokenSource | undefined,
    extraHeaders: Record<string, string> | undefined,
    private readonly log: ((line: string) => void) | undefined,
  ) {
    this.extraHeaders = Object.fromEntries(Object.entries(extraHeaders ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
  }

  async post(request: IncomingMessage, response: ServerResponse, cors: OutgoingHttpHeaders): Promise<void> {
    const signal = watchCaller(response);
    const body = await readBody(request);
    const parsed = parseMessages(body.toString("utf8"));
    const batch = parsed?.batch ?? false;

    let headers: OutgoingHttpHeaders;
    let token: string | undefined;
    try {
      ({ headers, token } = await this.headersFor(request, POST_ACCEPT));
    } catch (error) {
      const exchange = this.recorder.begin(parsed, false);
      exchange.fail(500, (error as Error).message);
      sendJson(response, 500, rpcErrors(batch, exchange.requestIds, (error as Error).message), cors);
      return;
    }

    const exchange = this.recorder.begin(parsed, Boolean(headers.authorization));
    let reply: IncomingMessage;
    try {
      reply = await this.send("POST", headers, token, body, signal);
    } catch (error) {
      if (signal.aborted) {
        exchange.end("aborted");
        return;
      }
      const description = this.unreachable(error);
      exchange.fail(502, description);
      sendJson(response, 502, rpcErrors(batch, exchange.requestIds, description), cors);
      return;
    }

    const status = reply.statusCode ?? 502;
    exchange.head(status, single(reply.headers["mcp-session-id"]));
    if (signal.aborted) {
      reply.destroy();
      exchange.end("aborted");
      return;
    }
    const stream = isEventStream(reply.headers["content-type"]);
    if (stream && exchange.expectsAnswers && wantsJsonOnly(request.headers.accept)) {
      await unwrap(exchange, reply, response, cors, batch, signal);
      return;
    }
    response.writeHead(status, { ...passBack(reply, true), ...cors });
    // An event stream's headers go out at once: its first event may be a while coming.
    if (stream) response.flushHeaders();
    const sink = stream ? streamSink(exchange) : bodySink(exchange);
    let recorded = false;
    const record = (ending: Ending) => {
      if (recorded) return;
      recorded = true;
      sink.end();
      exchange.end(ending);
    };
    // A complete reply is recorded just before its last byte goes out, so whoever reads
    // GET /state after getting the reply finds the exchange there.
    record(await relay(reply, response, sink.push, () => record("complete")));
  }

  /** The server-to-client event stream, passed through as it arrives. */
  async get(request: IncomingMessage, response: ServerResponse, cors: OutgoingHttpHeaders): Promise<void> {
    const reply = await this.open("GET", request, response, cors, "text/event-stream");
    if (!reply) return;
    const status = reply.statusCode ?? 502;
    response.writeHead(status, { ...passBack(reply, true), ...cors });
    response.flushHeaders();
    const stream = isEventStream(reply.headers["content-type"]);
    this.log?.(`GET /mcp ${status}${stream ? ", event stream open" : ""}`);
    const ending = await relay(reply, response, () => {});
    if (stream) this.log?.(`GET /mcp event stream closed${typeof ending === "object" ? `: ${ending.failure}` : ""}`);
  }

  /** Ends the session upstream, then here. */
  async delete(request: IncomingMessage, response: ServerResponse, cors: OutgoingHttpHeaders): Promise<void> {
    const started = performance.now();
    const reply = await this.open("DELETE", request, response, cors, request.headers.accept);
    // Even a refusal (a 405 from a server that doesn't end sessions on request) means the caller is done with this one.
    this.recorder.sessionEnded(single(request.headers["mcp-session-id"]));
    if (!reply) return;
    response.writeHead(reply.statusCode ?? 502, { ...passBack(reply, true), ...cors });
    await relay(reply, response, () => {});
    this.log?.(`DELETE /mcp ${reply.statusCode} ${Math.round(performance.now() - started)} ms`);
  }

  /** Sends a GET or DELETE upstream. When that fails, answers the caller itself and resolves undefined. */
  private async open(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    cors: OutgoingHttpHeaders,
    accept: string | undefined,
  ): Promise<IncomingMessage | undefined> {
    const signal = watchCaller(response);
    try {
      const { headers, token } = await this.headersFor(request, accept);
      return await this.send(method, headers, token, undefined, signal);
    } catch (error) {
      if (signal.aborted) return undefined;
      const local = error instanceof TokenFailure;
      const description = local ? error.message : this.unreachable(error);
      this.log?.(`${method} /mcp failed: ${description}`);
      sendJson(response, local ? 500 : 502, rpcErrors(false, [], description), cors);
      return undefined;
    }
  }

  /**
   * Sends upstream. A 401 for a token the token function gave gets one more
   * try: the function hears which token was refused, so it can refresh, and
   * the request goes again with the new one. Anything else, including a 401
   * for a caller's own Authorization, passes back as it came.
   */
  private async send(method: string, headers: OutgoingHttpHeaders, token: string | undefined, body: Buffer | undefined, signal: AbortSignal): Promise<IncomingMessage> {
    const reply = await this.upstream.send(method, headers, body, signal);
    if (reply.statusCode !== 401 || !token || typeof this.token !== "function") return reply;
    let fresh: string | undefined;
    try {
      fresh = await this.token(token);
    } catch {
      // The server's refusal is the answer the caller should see; the function reports its own trouble.
      return reply;
    }
    if (!fresh || fresh === token) return reply;
    reply.resume();
    this.log?.(`${method} /mcp was refused with 401; sending it again with a refreshed token`);
    return this.upstream.send(method, { ...headers, authorization: `Bearer ${fresh}` }, body, signal);
  }

  /**
   * The headers for the server: what the caller sent that the server needs,
   * then the configured extra headers, then the configured token, which wins
   * over any Authorization the caller sent. Also the token itself, when there
   * is one, so a refusal of it can be retried.
   */
  private async headersFor(request: IncomingMessage, accept: string | undefined): Promise<{ headers: OutgoingHttpHeaders; token?: string }> {
    const headers: OutgoingHttpHeaders = { "user-agent": USER_AGENT };
    for (const [name, value] of Object.entries(request.headers)) {
      // Every Mcp-* header passes, not only the session id and protocol version: newer MCP
      // revisions add per-request ones (Mcp-Method, Mcp-Name, Mcp-Param-*) that servers check.
      if (value !== undefined && (PASSED_UP.has(name) || name.startsWith("mcp-"))) headers[name] = value;
    }
    if (request.method === "POST" && headers["content-type"] === undefined) headers["content-type"] = "application/json";
    Object.assign(headers, this.extraHeaders);
    let token: string | undefined;
    try {
      token = typeof this.token === "function" ? await this.token() : this.token;
    } catch (error) {
      throw new TokenFailure(error);
    }
    if (token) headers.authorization = `Bearer ${token}`;
    if (accept) headers.accept = accept;
    // The reply has to stay readable for the recording, so it mustn't come compressed.
    headers["accept-encoding"] = "identity";
    return token ? { headers, token } : { headers };
  }

  private unreachable(error: unknown): string {
    if (error instanceof RedirectRefused) return error.message;
    return `Couldn't reach the MCP server at ${this.upstream.url.href}: ${(error as Error).message}`;
  }
}

/** Aborted when the caller hangs up before its reply is finished, so the request upstream stops too. */
function watchCaller(response: ServerResponse): AbortSignal {
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableFinished) controller.abort();
  });
  return controller.signal;
}

/**
 * True when the caller takes JSON but not an event stream (an Accept of just
 * application/json, say). That's when an event-stream reply gets unwrapped
 * into the JSON its `data:` lines carry, as Amazon's Local Inspector does. A
 * missing Accept takes anything, so nothing is unwrapped for it.
 */
export function wantsJsonOnly(accept: string | undefined): boolean {
  if (!accept) return false;
  const ranges = accept
    .split(",")
    .map((part) => {
      const [type = "", ...params] = part.split(";").map((piece) => piece.trim().toLowerCase());
      const q = params.find((param) => param.startsWith("q="));
      return { type, q: q === undefined ? 1 : Number(q.slice(2)) };
    })
    .filter((range) => range.type && range.q > 0);
  const takes = (type: string) =>
    ranges.some((range) => range.type === type || range.type === "*/*" || range.type === `${type.split("/")[0]}/*`);
  return takes("application/json") && !takes("text/event-stream");
}

function isEventStream(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The JSON-RPC messages in one JSON text: a message, a batch, or nothing usable. */
function jsonMessages(text: string): unknown[] {
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value : [value];
  } catch {
    return [];
  }
}

/**
 * The reply headers the caller needs: the body's type and encoding, every
 * Mcp-* header (the session id above all), and WWW-Authenticate, which
 * Amazon's auth checklist is particular about. Location never passes: it
 * would send the caller around the proxy.
 */
function passBack(reply: IncomingMessage, withBody: boolean): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.headers)) {
    if (value === undefined) continue;
    const describesBody = name === "content-type" || name === "content-encoding";
    if (name.startsWith("mcp-") || name === "www-authenticate" || (withBody && describesBody)) headers[name] = value;
  }
  if (withBody && isEventStream(reply.headers["content-type"])) headers["cache-control"] = "no-cache, no-transform";
  return headers;
}

/** A JSON-RPC error standing in for a response the server never sent, so the caller's request doesn't hang. */
function rpcError(id: string | number | null, message: string) {
  return { jsonrpc: "2.0", id, error: { code: -32000, message } };
}

function rpcErrors(batch: boolean, ids: (string | number)[], message: string): unknown {
  if (batch && ids.length) return ids.map((id) => rpcError(id, message));
  return rpcError(ids[0] ?? null, message);
}

interface Sink {
  push(chunk: Buffer): void;
  end(): void;
}

/** Reads an event stream's messages as they pass, so each response is timed when it arrives. */
function streamSink(exchange: Exchange): Sink {
  const parser = new SseParser((event) => {
    if (event.event === "message") for (const message of jsonMessages(event.data)) exchange.receive(message);
  });
  return { push: (chunk) => parser.push(chunk), end: () => parser.end() };
}

/** Reads a plain body's messages once it's all in. */
function bodySink(exchange: Exchange): Sink {
  const chunks: Buffer[] = [];
  return {
    push: (chunk) => chunks.push(chunk),
    end: () => {
      for (const message of jsonMessages(Buffer.concat(chunks).toString("utf8"))) exchange.receive(message);
    },
  };
}

/**
 * Copies the server's reply to the caller chunk by chunk as it arrives (an
 * event stream is never held back), and says how it ended: in full, with the
 * caller gone, or broken off by the server. Whichever side failed first is
 * the cause; the other side is then closed.
 */
function relay(from: IncomingMessage, to: ServerResponse, onChunk: (chunk: Buffer) => void, beforeEnd?: () => void): Promise<Ending> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (ending: Ending) => {
      if (settled) return;
      settled = true;
      resolve(ending);
    };
    from.on("data", (chunk: Buffer) => {
      onChunk(chunk);
      if (!to.write(chunk)) from.pause();
    });
    to.on("drain", () => from.resume());
    from.on("end", () => {
      beforeEnd?.();
      to.end();
      settle("complete");
    });
    from.on("error", (error) => {
      settle({ failure: `The MCP server's reply broke off: ${error.message}` });
      to.destroy();
    });
    from.on("close", () => {
      if (from.complete) return;
      settle({ failure: "The MCP server closed the connection partway through its reply" });
      to.destroy();
    });
    to.on("close", () => {
      if (to.writableFinished) return;
      settle("aborted");
      from.destroy();
    });
  });
}

/**
 * Answers a JSON-only caller from an event-stream reply: the response (or a
 * batch's responses) from its `data:` lines, as one JSON body. The server's
 * notifications along the way have no place in a JSON body and are dropped.
 */
async function unwrap(
  exchange: Exchange,
  reply: IncomingMessage,
  response: ServerResponse,
  cors: OutgoingHttpHeaders,
  batch: boolean,
  signal: AbortSignal,
): Promise<void> {
  const parser = new SseParser((event) => {
    if (event.event === "message") for (const message of jsonMessages(event.data)) exchange.receive(message);
  });
  let ending: Ending = "complete";
  try {
    for await (const chunk of reply) {
      parser.push(chunk as Buffer);
      // Answered: stop reading even if the server keeps its stream open (leaving the loop closes it).
      if (exchange.answered) break;
    }
    if (!exchange.answered) parser.end();
  } catch (error) {
    ending = { failure: `The MCP server's event stream broke off: ${(error as Error).message}` };
  }
  if (signal.aborted) {
    exchange.end("aborted");
    return;
  }
  if (!exchange.answered && ending === "complete") ending = { failure: "The MCP server's event stream ended before its response arrived" };
  const answers = [...exchange.answers];
  const missing = exchange.requestIds.filter((id) => !answers.some((answer) => answer.id === id));
  exchange.end(ending);
  const failure = typeof ending === "object" ? ending.failure : "";
  if (!answers.length) {
    sendJson(response, 502, rpcErrors(batch, exchange.requestIds, failure), cors);
    return;
  }
  const body = batch ? [...answers, ...missing.map((id) => rpcError(id, failure))] : answers[0];
  sendJson(response, reply.statusCode ?? 200, body, { ...passBack(reply, false), ...cors });
}

import { ALEXA_CLIENT_INFO, ALEXA_PROTOCOL_VERSION } from "../shared/contract.ts";
import { SseParser } from "./sse.ts";

/**
 * Plain JSON-RPC over Streamable HTTP, written out by hand rather than
 * through an MCP client library, so the check controls exactly what goes on
 * the wire (Alexa+'s documented initialize, string ids, its headers) and can
 * time each round trip from the request to its answer.
 */

/** Alexa+'s documented initialize params, sent as Amazon shows them. */
export const ALEXA_INITIALIZE_PARAMS = {
  protocolVersion: ALEXA_PROTOCOL_VERSION,
  capabilities: { roots: { listChanged: true } },
  clientInfo: { ...ALEXA_CLIENT_INFO },
};

export interface Transport {
  url: string;
  fetch: typeof fetch;
  /** Milliseconds, for timing round trips; tests pass a fake clock. */
  now: () => number;
  /** How long one request may take before it counts as hung. */
  timeoutMs: number;
  /**
   * The developer's own headers (the CLI's --header), on every request to the
   * server's origin: its MCP endpoint and its documents, never another origin's.
   */
  headers?: Record<string, string>;
}

/**
 * The developer's headers with the check's own on top, so the protocol's
 * headers and the token are always what the check means to send.
 */
function headersWith(own: Record<string, string>, developers: Record<string, string> | undefined): Headers {
  const headers = new Headers(developers);
  for (const [name, value] of Object.entries(own)) headers.set(name, value);
  return headers;
}

/** Redirects a GET follows; anything else follows only the two that keep the method and the body, as the proxy does. */
const ANY_REDIRECT = new Set([301, 302, 303, 307, 308]);
const KEEPS_METHOD = new Set([307, 308]);
const MAX_REDIRECTS = 5;

/** Whether the developer gave headers of their own, which count as credentials: one may be an API key. */
function hasHeaders(transport: Partial<Pick<Transport, "headers">>): boolean {
  return Object.keys(transport.headers ?? {}).length > 0;
}

/**
 * Sends a request to the server. One that carries the developer's
 * credentials (a token, or headers given with --header) follows a redirect
 * only within the server's origin, as the proxy does, and refuses one
 * elsewhere: fetch would carry headers of the developer's own naming to
 * wherever the server pointed. Without them, fetch follows redirects as it
 * would anyway (and as a browser, where the check also runs, must).
 */
async function sendTo(transport: Pick<Transport, "fetch">, url: string, init: RequestInit, credentials: boolean): Promise<Response> {
  if (!credentials) return transport.fetch(url, init);
  let target = new URL(url);
  for (let hop = 0; ; hop++) {
    const response = await transport.fetch(target.href, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    const followable = ((init.method ?? "GET") === "GET" ? ANY_REDIRECT : KEEPS_METHOD).has(response.status);
    if (!location || !followable || hop === MAX_REDIRECTS) return response;
    await response.body?.cancel().catch(() => undefined);
    const next = new URL(location, target);
    if (next.origin !== target.origin) {
      throw new Error(`the server redirected to ${next.href}, another origin, where the check won't send your token or headers; if that's the server's address, check it there`);
    }
    target = next;
  }
}

/** How a refresh of a saved sign-in went, for AU-09. */
export type RefreshOutcome =
  | { status: "refreshed"; sameAccessToken: boolean; newRefreshToken: boolean }
  | { status: "failed"; problem: string }
  /** There was no refresh token to refresh with. */
  | { status: "missing" }
  /** Something on this side kept the refresh from being tried, like a client secret that isn't set. */
  | { status: "untried"; reason: string };

/**
 * A bearer token that can change while the check runs, like the token file
 * `link` saves: it refreshes itself before it expires, and once more when
 * the server refuses it.
 */
export interface TokenSource {
  /** The token to send now. Rejects when there's no usable one, which stops the check: that's a setup problem, not the server's. */
  token(): Promise<string>;
  /** Called after the server refused `rejected` with 401: a new token to send the request with once more, or undefined. */
  renew?(rejected: string): Promise<string | undefined>;
  /** For AU-09: how refreshing went, refreshing now when it hasn't come up yet. */
  confirmRefresh?(): Promise<RefreshOutcome>;
}

/** A plain token as a source, or undefined for none, so the session handles one shape. */
export function tokenSource(token: string | TokenSource | undefined): TokenSource | undefined {
  if (typeof token !== "string") return token;
  return token ? { token: async () => token } : undefined;
}

export interface JsonRpcError {
  code?: number;
  message: string;
  data?: unknown;
}

export type Outcome =
  | { kind: "result"; result: unknown }
  | { kind: "error"; error: JsonRpcError }
  /** An HTTP answer with no JSON-RPC message in it, like a bare 404. */
  | { kind: "http"; message: string }
  | { kind: "timeout"; message: string }
  /** No HTTP answer at all. */
  | { kind: "network"; message: string }
  | { kind: "malformed"; message: string };

export interface Exchange {
  method: string;
  /** For notes, like "tools/call get_weather". */
  label: string;
  /** The HTTP status, when the server answered at all. */
  status?: number;
  headers?: Headers;
  /** From sending the request to having its JSON-RPC answer (or giving up). */
  durationMs: number;
  outcome: Outcome;
  /** How the answer came back. */
  framing?: "json" | "sse";
  /** The token was refused with 401, renewed and sent again; this is the second answer. */
  renewed?: boolean;
}

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The media type alone, lowercased, without parameters like charset. */
export function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

/** One line, trimmed to a length a terminal note can carry. */
export function clip(text: string, max = 120): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  // Node's fetch hides the useful part (ECONNREFUSED, a DNS failure) in the cause.
  const cause = error.cause;
  if (cause instanceof Error || isObject(cause)) {
    const detail = (cause as { code?: unknown }).code ?? (cause as { message?: unknown }).message;
    if (typeof detail === "string" && detail && !error.message.includes(detail)) return `${error.message} (${detail})`;
  }
  return error.message;
}

class TimeoutError extends Error {}

/**
 * One request's time limit. It aborts the fetch and also races every await
 * on the answer, since a test's fetch (or a stalled body) may ignore the signal.
 */
export class Deadline {
  readonly controller = new AbortController();
  expired = false;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly expiry: Promise<never>;

  constructor(readonly ms: number) {
    let fail!: (error: Error) => void;
    this.expiry = new Promise<never>((_, reject) => (fail = reject));
    this.expiry.catch(() => undefined);
    this.timer = setTimeout(() => {
      this.expired = true;
      this.controller.abort();
      fail(new TimeoutError(`no answer within ${ms} ms`));
    }, ms);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  race<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.expiry]);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}

function randomHex(length: number): string {
  let out = "";
  while (out.length < length) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** The JSON-RPC answer to request `id` among parsed messages, or the id of a response meant for something else. */
function answerFrom(messages: unknown[], id: string): { answer?: Outcome; otherId?: unknown } {
  let otherId: unknown;
  for (const message of messages) {
    if (!isObject(message) || !("result" in message || "error" in message)) continue;
    // An error with a null id is the server saying it couldn't tell which request failed, so it's this one's.
    if (message.id === id || (message.id === null && "error" in message)) {
      if ("error" in message) return { answer: { kind: "error", error: toError(message.error) } };
      return { answer: { kind: "result", result: message.result } };
    }
    otherId = message.id;
  }
  return { otherId };
}

function wrongId(otherId: unknown, id: string): Outcome {
  return { kind: "malformed", message: `the answer's id is ${JSON.stringify(otherId)}, but the request's was "${id}"` };
}

function toError(error: unknown): JsonRpcError {
  if (!isObject(error)) return { message: String(error) };
  return {
    ...(typeof error.code === "number" ? { code: error.code } : {}),
    message: typeof error.message === "string" ? error.message : "",
    ...("data" in error ? { data: error.data } : {}),
  };
}

function parseJson(text: string): unknown[] | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return undefined;
  }
}

function isServerRequest(message: unknown): message is { id: string | number; method: string } {
  return (
    isObject(message) &&
    typeof message.method === "string" &&
    (typeof message.id === "string" || typeof message.id === "number")
  );
}

/** A client session with one MCP server: initialize, then requests carrying its session id and protocol version. */
export class McpSession {
  sessionId: string | undefined;
  protocolVersion: string | undefined;
  /** The bearer token the latest request carried. */
  bearer: string | undefined;
  private sequence = 0;
  // String ids, as Alexa+ sends ("4e3bdaee-0"), so a server that assumes numbers shows it.
  private readonly idPrefix = randomHex(8);
  private readonly replies = new Set<Promise<void>>();
  private readonly tokens: TokenSource | undefined;

  constructor(
    private readonly transport: Transport,
    token?: string | TokenSource,
  ) {
    this.tokens = tokenSource(token);
  }

  async initialize(): Promise<Exchange> {
    const exchange = await this.request("initialize", ALEXA_INITIALIZE_PARAMS);
    if (exchange.outcome.kind === "result") {
      this.sessionId = exchange.headers?.get("mcp-session-id") ?? undefined;
      const result = exchange.outcome.result;
      if (isObject(result) && typeof result.protocolVersion === "string") this.protocolVersion = result.protocolVersion;
    }
    return exchange;
  }

  /**
   * Sends a request and reads its answer. A token the server refuses with 401
   * is renewed once (a token file refreshes) and the request sent again, timed
   * afresh, since a refresh is the sign-in's cost, not the server's latency.
   */
  async request(method: string, params?: unknown, label = method): Promise<Exchange> {
    const id = `${this.idPrefix}-${this.sequence++}`;
    const message = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    // Not caught, unlike a failed send: a token source that can't give a token stops the check rather than failing a rule.
    if (this.tokens) this.bearer = await this.tokens.token();
    const exchange = await this.send(method, label, message, id);
    if (exchange.status !== 401 || !this.bearer || !this.tokens?.renew) return exchange;
    const fresh = await this.tokens.renew(this.bearer);
    if (!fresh || fresh === this.bearer) return exchange;
    this.bearer = fresh;
    return { ...(await this.send(method, label, message, id)), renewed: true };
  }

  private async send(method: string, label: string, message: unknown, id: string): Promise<Exchange> {
    const deadline = new Deadline(this.transport.timeoutMs);
    const started = this.transport.now();
    const elapsed = () => this.transport.now() - started;
    let response: Response | undefined;
    try {
      response = await this.post(message, deadline);
      const { outcome, framing } = await this.readAnswer(response, id, deadline);
      return { method, label, status: response.status, headers: response.headers, durationMs: elapsed(), outcome, framing };
    } catch (error) {
      const outcome: Outcome = deadline.expired
        ? { kind: "timeout", message: `no answer within ${deadline.ms} ms` }
        : { kind: "network", message: describeError(error) };
      return { method, label, status: response?.status, headers: response?.headers, durationMs: elapsed(), outcome };
    } finally {
      deadline.clear();
    }
  }

  /** Sends a notification; servers answer 202 Accepted with no body. */
  async notify(method: string, params?: unknown): Promise<Exchange> {
    const message = { jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) };
    if (this.tokens) this.bearer = await this.tokens.token();
    const deadline = new Deadline(this.transport.timeoutMs);
    const started = this.transport.now();
    try {
      const response = await this.post(message, deadline);
      let outcome: Outcome = { kind: "result", result: undefined };
      if (response.ok) {
        // Only the status matters, and a body held open (an SSE stream, say) mustn't stall the check.
        await deadline.race(response.body?.cancel() ?? Promise.resolve()).catch(() => undefined);
      } else {
        const body = await deadline.race(response.text());
        outcome = { kind: "http", message: `HTTP ${response.status}${body.trim() ? `: ${clip(body, 80)}` : ""}` };
      }
      return { method, label: method, status: response.status, headers: response.headers, durationMs: this.transport.now() - started, outcome };
    } catch (error) {
      const outcome: Outcome = deadline.expired
        ? { kind: "timeout", message: `no answer within ${deadline.ms} ms` }
        : { kind: "network", message: describeError(error) };
      return { method, label: method, durationMs: this.transport.now() - started, outcome };
    } finally {
      deadline.clear();
    }
  }

  /** Ends the session, as the spec asks clients to, so the check doesn't leave sessions behind on the server. */
  async close(): Promise<void> {
    await Promise.allSettled([...this.replies]);
    if (!this.sessionId) return;
    const deadline = new Deadline(Math.min(this.transport.timeoutMs, 2000));
    try {
      const response = await deadline.race(
        sendTo(this.transport, this.transport.url, { method: "DELETE", headers: this.headers(), signal: deadline.signal }, this.credentials()),
      );
      await deadline.race(response.body?.cancel() ?? Promise.resolve());
    } catch {
      // A server that doesn't support DELETE, or is gone, has nothing left to clean up for us.
    } finally {
      deadline.clear();
    }
  }

  private headers(): Headers {
    const own: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.bearer) own.Authorization = `Bearer ${this.bearer}`;
    if (this.sessionId) own["Mcp-Session-Id"] = this.sessionId;
    if (this.protocolVersion) own["Mcp-Protocol-Version"] = this.protocolVersion;
    return headersWith(own, this.transport.headers);
  }

  /** Whether requests carry the developer's credentials: the token, or headers of their own. */
  private credentials(): boolean {
    return Boolean(this.bearer) || hasHeaders(this.transport);
  }

  private post(message: unknown, deadline: Deadline): Promise<Response> {
    return deadline.race(
      Promise.resolve().then(() =>
        sendTo(
          this.transport,
          this.transport.url,
          { method: "POST", headers: this.headers(), body: JSON.stringify(message), signal: deadline.signal },
          this.credentials(),
        ),
      ),
    );
  }

  private async readAnswer(response: Response, id: string, deadline: Deadline): Promise<{ outcome: Outcome; framing?: "json" | "sse" }> {
    const type = mediaType(response.headers.get("content-type"));
    if (type === "text/event-stream" && response.body) {
      return { outcome: await this.readStream(response.body, id, deadline), framing: "sse" };
    }
    const text = await deadline.race(response.text());
    const messages = text.trim() ? parseJson(text) : undefined;
    const { answer, otherId } = messages ? answerFrom(messages, id) : {};
    if (answer) return { outcome: answer, framing: "json" };
    if (otherId !== undefined) return { outcome: wrongId(otherId, id), framing: "json" };
    if (!response.ok) {
      return { outcome: { kind: "http", message: `HTTP ${response.status}${text.trim() ? `: ${clip(text, 80)}` : ""}` } };
    }
    if (!text.trim()) return { outcome: { kind: "malformed", message: `the answer is empty (HTTP ${response.status})` } };
    if (!messages) {
      return { outcome: { kind: "malformed", message: `the answer isn't JSON or SSE (Content-Type ${type || "missing"}): ${clip(text, 60)}` } };
    }
    return { outcome: { kind: "malformed", message: "the answer isn't a JSON-RPC response" } };
  }

  private async readStream(body: ReadableStream<Uint8Array>, id: string, deadline: Deadline): Promise<Outcome> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    let unreadable = 0;
    let strayId: unknown;
    try {
      for (;;) {
        const { done, value } = await deadline.race(reader.read());
        const events = done ? parser.push(decoder.decode()).concat(parser.end()) : parser.push(decoder.decode(value, { stream: true }));
        for (const event of events) {
          const messages = parseJson(event.data);
          if (!messages) {
            unreadable++;
            continue;
          }
          for (const message of messages) {
            if (isServerRequest(message)) this.reply(message);
          }
          // A stream may carry other messages before the answer, so a stray response doesn't end the read.
          const { answer, otherId } = answerFrom(messages, id);
          if (answer) return answer;
          if (otherId !== undefined) strayId = otherId;
        }
        if (done) break;
      }
    } finally {
      // The answer is in; the server may hold the stream open, and nothing more on it matters here.
      reader.cancel().catch(() => undefined);
    }
    if (strayId !== undefined) return wrongId(strayId, id);
    const note = unreadable ? ` (${unreadable} event${unreadable === 1 ? " wasn't" : "s weren't"} JSON)` : "";
    return { kind: "malformed", message: `the SSE stream ended without an answer${note}` };
  }

  /**
   * Answers a request the server sends mid-stream. Alexa+ declares the roots
   * capability, so a server may ask for roots and wait for the reply before
   * it answers; leaving it unanswered would make a healthy server look hung.
   */
  private reply(request: { id: string | number; method: string }): void {
    const answer =
      request.method === "roots/list"
        ? { jsonrpc: "2.0", id: request.id, result: { roots: [] } }
        : request.method === "ping"
          ? { jsonrpc: "2.0", id: request.id, result: {} }
          : { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    const deadline = new Deadline(this.transport.timeoutMs);
    const sent: Promise<void> = this.post(answer, deadline)
      .then((response) => response.body?.cancel())
      .catch(() => undefined)
      .finally(() => {
        deadline.clear();
        this.replies.delete(sent);
      });
    this.replies.add(sent);
  }
}

/**
 * Whether the URL serves the legacy HTTP+SSE transport, which answers a GET
 * with a stream whose first event, "endpoint", says where to POST. The MCP
 * spec's backward compatibility advice: try a POST first, and on a 4xx, try
 * this. Returns the endpoint it announced.
 */
export async function legacySseEndpoint(transport: Transport, token?: string): Promise<string | undefined> {
  const deadline = new Deadline(Math.min(transport.timeoutMs, 5000));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await deadline.race(
      Promise.resolve().then(() =>
        sendTo(
          transport,
          transport.url,
          { method: "GET", headers: headersWith({ Accept: "text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, transport.headers), signal: deadline.signal },
          Boolean(token) || hasHeaders(transport),
        ),
      ),
    );
    if (!response.ok || mediaType(response.headers.get("content-type")) !== "text/event-stream" || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    for (;;) {
      const { done, value } = await deadline.race(reader.read());
      const events = done ? parser.end() : parser.push(decoder.decode(value, { stream: true }));
      const first = events[0];
      if (first) return first.event === "endpoint" ? first.data || "(an empty endpoint)" : undefined;
      if (done) return undefined;
    }
  } catch {
    return undefined;
  } finally {
    reader?.cancel().catch(() => undefined);
    deadline.clear();
  }
}

export interface Fetched {
  url: string;
  status?: number;
  json?: JsonObject;
  /** Why there's no JSON object, like "HTTP 404". */
  problem?: string;
}

/**
 * GETs a metadata document. The developer's headers go along only when the
 * document is on the MCP server's own origin: an authorization server
 * elsewhere is someone else's, and gets none of them.
 */
export async function getJson(transport: Pick<Transport, "fetch" | "timeoutMs"> & Partial<Pick<Transport, "url" | "headers">>, url: string): Promise<Fetched> {
  const deadline = new Deadline(transport.timeoutMs);
  const ours = transport.url !== undefined && new URL(url).origin === new URL(transport.url).origin;
  const headers = headersWith({ Accept: "application/json" }, ours ? transport.headers : undefined);
  try {
    const response = await deadline.race(Promise.resolve().then(() => sendTo(transport, url, { headers, signal: deadline.signal }, ours && hasHeaders(transport))));
    const text = await deadline.race(response.text());
    if (!response.ok) return { url, status: response.status, problem: `HTTP ${response.status}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { url, status: response.status, problem: "not JSON" };
    }
    return isObject(parsed)
      ? { url, status: response.status, json: parsed }
      : { url, status: response.status, problem: "not a JSON object" };
  } catch (error) {
    return { url, problem: deadline.expired ? `no answer within ${deadline.ms} ms` : describeError(error) };
  } finally {
    deadline.clear();
  }
}

import { randomUUID } from "node:crypto";
import { STATUS_CODES } from "node:http";
import { LATENCY_BUDGET_MS, type ProxyEvent, type ProxyState, type RpcRecord, type ToolInfo } from "../shared/contract.ts";

/** How many exchanges `state.rpc` keeps. */
export const RPC_HISTORY = 500;

/** A JSON-RPC 2.0 message as it arrived, so nothing about its shape is trusted. */
export type JsonRpcMessage = Record<string, unknown>;

export interface ParsedBody {
  messages: JsonRpcMessage[];
  /** Sent as an array (JSON-RPC batching, which the 2025-03-26 revision Alexa speaks allows). */
  batch: boolean;
}

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON-RPC messages in a body, one or a batch, or undefined when the body isn't JSON-RPC at all. */
export function parseMessages(text: string): ParsedBody | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (isObject(value)) return { messages: [value], batch: false };
  if (!Array.isArray(value)) return undefined;
  const messages = value.filter(isObject);
  return messages.length ? { messages, batch: true } : undefined;
}

type RequestId = string | number;

const isRequestId = (id: unknown): id is RequestId => typeof id === "string" || typeof id === "number";

/** True for a message the receiver must answer: a method and a string or number id. */
export const isRequest = (message: JsonRpcMessage): boolean => typeof message.method === "string" && isRequestId(message.id);

/** One message the caller sent, waiting for its record. */
interface Entry {
  message: JsonRpcMessage;
  method: string;
  /** Requests only: the id the server's response must carry. */
  id?: RequestId;
  done: boolean;
}

/** How a reply ended: in full, with the caller hanging up, or broken off (or never sent) by the server side. */
export type Ending = "complete" | "aborted" | { failure: string };

interface Settlement {
  entry: Entry;
  response: JsonRpcMessage | undefined;
  ending: Ending;
  status: number;
  sessionId: string | undefined;
  ts: number;
  durationMs: number;
  /** Whether an Authorization header went upstream, so a 401 can say which way it went wrong. */
  authorized: boolean;
}

/**
 * One POST to /mcp: the message (or batch) the caller sent, matched by id
 * against the messages that come back, whether as one JSON body or as an
 * event stream. Each message gets its record as soon as it's settled, so a
 * request's duration is the time until its own response arrived.
 */
export class Exchange {
  readonly ts = Date.now();
  private readonly started = performance.now();
  private status = 0;
  private sessionId: string | undefined;
  private readonly entries: Entry[];
  private readonly requests = new Map<RequestId, Entry>();
  /** The responses to this exchange's requests, in the order they arrived. */
  readonly answers: JsonRpcMessage[] = [];
  /** An error with a null id: the server's answer to the whole POST, like a missing session. */
  private blanketError: JsonRpcMessage | undefined;

  constructor(
    private readonly recorder: Recorder,
    parsed: ParsedBody | undefined,
    private readonly authorized: boolean,
  ) {
    this.entries = parsed ? parsed.messages.map(toEntry) : [{ message: {}, method: "(invalid)", done: false }];
    for (const entry of this.entries) {
      if (entry.id !== undefined && !this.requests.has(entry.id)) this.requests.set(entry.id, entry);
    }
  }

  /** True when the POST holds at least one request, so a response must come back. */
  get expectsAnswers(): boolean {
    return this.requests.size > 0;
  }

  /** True once every request has its response. */
  get answered(): boolean {
    for (const entry of this.requests.values()) if (!entry.done) return false;
    return true;
  }

  /** The ids of the requests in this exchange, for answering them when the server can't. */
  get requestIds(): RequestId[] {
    return [...this.requests.keys()];
  }

  head(status: number, sessionId: string | undefined): void {
    this.status = status;
    this.sessionId = sessionId;
  }

  /** One message from the server's reply. */
  receive(message: unknown): void {
    // The server's own notifications and requests can ride along on the stream; they answer nothing.
    if (!isObject(message) || "method" in message) return;
    if (!isRequestId(message.id)) {
      if ("error" in message) this.blanketError ??= message;
      return;
    }
    const entry = this.requests.get(message.id);
    if (!entry || entry.done) return;
    this.answers.push(message);
    this.settle(entry, message, "complete");
  }

  /** The reply is over: whatever has no record yet gets one now. */
  end(ending: Ending): void {
    for (const entry of this.entries) {
      if (!entry.done) this.settle(entry, entry.id !== undefined ? this.blanketError : undefined, ending);
    }
  }

  /** Nothing came back from the server: it couldn't be reached, or the request to it couldn't be built. */
  fail(status: number, failure: string): void {
    this.status = status;
    this.end({ failure });
  }

  private settle(entry: Entry, response: JsonRpcMessage | undefined, ending: Ending): void {
    entry.done = true;
    this.recorder.settle({
      entry,
      response,
      ending,
      status: this.status,
      sessionId: this.sessionId,
      ts: this.ts,
      durationMs: Math.round(performance.now() - this.started),
      authorized: this.authorized,
    });
  }
}

function toEntry(message: JsonRpcMessage): Entry {
  if (isRequest(message)) return { message, method: message.method as string, id: message.id as RequestId, done: false };
  if (typeof message.method === "string") return { message, method: message.method, done: false };
  // A response the caller sends back, answering a request the server made on an event stream.
  return { message, method: "(response)", done: false };
}

/**
 * Everything seen this session, as `GET /state` reports it, and the events
 * that report it as it happens.
 */
export class Recorder {
  readonly state: ProxyState;

  constructor(
    upstream: string,
    private readonly emit: (event: ProxyEvent) => void,
    private readonly log?: (line: string) => void,
  ) {
    this.state = { upstream, initialized: false, tools: [], resources: [], calls: [], errors: [], rpc: [] };
  }

  begin(parsed: ParsedBody | undefined, authorized: boolean): Exchange {
    return new Exchange(this, parsed, authorized);
  }

  /** A `DELETE /mcp` ended a session. Another client's session, sharing the proxy, stays as it is. */
  sessionEnded(sessionId: string | undefined): void {
    if (this.state.sessionId !== sessionId) return;
    this.state.initialized = false;
    delete this.state.sessionId;
    delete this.state.protocolVersion;
  }

  /** Records one message of an exchange. Called by Exchange. */
  settle(settlement: Settlement): void {
    const { entry, response, status, ts, durationMs } = settlement;
    const record: RpcRecord = { method: entry.method, status, durationMs, ts, overBudget: durationMs >= LATENCY_BUDGET_MS };
    if (entry.id !== undefined) record.id = entry.id;
    const params = entry.method === "(response)" ? (entry.message.result ?? entry.message.error) : entry.message.params;
    if (params !== undefined) record.params = params;
    if (response && "result" in response) record.result = response.result;
    if (response && "error" in response) record.error = response.error;

    const problem = describeProblem(settlement);
    if (!problem && response && "result" in response) this.apply(entry, response.result, settlement);
    if (entry.method === "tools/call" && entry.id !== undefined) this.called(entry, settlement, !problem);
    if (problem) {
      this.state.errors.push({ method: entry.method, description: problem, ts });
      this.emit({ event: "error", data: { method: entry.method, description: problem } });
    }
    this.state.rpc.push(record);
    if (this.state.rpc.length > RPC_HISTORY) this.state.rpc.splice(0, this.state.rpc.length - RPC_HISTORY);
    this.emit({ event: "rpc", data: record });
    const over = record.overBudget ? ` (over the ${LATENCY_BUDGET_MS} ms budget)` : "";
    this.log?.(`${entry.method} ${status} ${durationMs} ms${over}${problem ? `: ${problem}` : ""}`);
  }

  /** What a successful response tells the simulator about the server. */
  private apply(entry: Entry, result: unknown, { sessionId }: Settlement): void {
    if (!isObject(result)) return;
    const state = this.state;
    if (entry.method === "initialize") {
      state.initialized = true;
      if (sessionId) state.sessionId = sessionId;
      else delete state.sessionId;
      if (typeof result.protocolVersion === "string") state.protocolVersion = result.protocolVersion;
      else delete state.protocolVersion;
      if (result.serverInfo !== undefined) state.serverInfo = result.serverInfo;
      else delete state.serverInfo;
      if (typeof result.instructions === "string") state.instructions = result.instructions;
      else delete state.instructions;
      this.emit({
        event: "connected",
        data: { address: state.upstream, serverInfo: result.serverInfo, protocolVersion: state.protocolVersion },
      });
    } else if (entry.method === "tools/list") {
      const tools = Array.isArray(result.tools) ? result.tools.filter((tool): tool is ToolInfo => isObject(tool) && typeof tool.name === "string") : [];
      // A request with a cursor asks for the next page, which adds to the pages before it.
      const nextPage = isObject(entry.message.params) && entry.message.params.cursor !== undefined;
      state.tools = nextPage ? [...state.tools.filter((tool) => !tools.some((t) => t.name === tool.name)), ...tools] : tools;
      this.emit({ event: "tools-discovered", data: { tools: state.tools } });
    } else if (entry.method === "resources/read" && Array.isArray(result.contents)) {
      for (const content of result.contents) this.fetched(content);
    }
  }

  private fetched(content: unknown): void {
    if (!isObject(content) || typeof content.uri !== "string") return;
    const uri = content.uri;
    const mimeType = typeof content.mimeType === "string" ? content.mimeType : undefined;
    const text = typeof content.text === "string" ? content.text : undefined;
    const blob = typeof content.blob === "string" ? content.blob : undefined;
    const contentLength = text !== undefined ? Buffer.byteLength(text) : blob !== undefined ? Buffer.byteLength(blob, "base64") : 0;
    const resource = mimeType === undefined ? { uri, contentLength } : { uri, mimeType, contentLength };
    const known = this.state.resources.findIndex((r) => r.uri === uri);
    if (known === -1) this.state.resources.push(resource);
    else this.state.resources[known] = resource;
    this.emit({ event: "resource-fetched", data: resource });
    // MCP Apps screens are text/html;profile=mcp-app, and plain text/html renders the same way.
    if (mimeType?.split(";")[0]?.trim().toLowerCase() === "text/html") {
      const html = text ?? Buffer.from(blob ?? "", "base64").toString("utf8");
      this.emit({ event: "widget-html", data: { uri, html } });
    }
  }

  private called(entry: Entry, { response, ts, durationMs }: Settlement, ok: boolean): void {
    const params = isObject(entry.message.params) ? entry.message.params : {};
    const toolName = typeof params.name === "string" ? params.name : "";
    const result = response && "result" in response ? response.result : undefined;
    // A tool that reports isError ran and failed, which the call record should show even though the exchange was fine.
    const succeeded = ok && result !== undefined && !(isObject(result) && result.isError === true);
    this.state.calls.push({ tool: toolName, arguments: params.arguments, succeeded, durationMs, ts });
    this.emit({
      event: "tool-called",
      data: { toolName, request: entry.message, response: response ?? null, eventId: randomUUID(), ts, durationMs },
    });
  }
}

/** What went wrong with one message, in a sentence for the simulator's error list; undefined when nothing did. */
function describeProblem({ entry, response, ending, status, authorized }: Settlement): string | undefined {
  if (typeof ending === "object") return ending.failure;
  const rpcError = response && "error" in response ? describeRpcError(response.error) : undefined;
  if (status >= 400) {
    let text = `HTTP ${status} ${STATUS_CODES[status] ?? ""}`.trimEnd() + " from the MCP server";
    if (status === 401) text += authorized ? ", which refused the bearer token" : ", and no bearer token was sent";
    return rpcError ? `${text}: ${rpcError}` : text;
  }
  if (rpcError) return rpcError;
  if (ending === "aborted" || entry.id === undefined || response) return undefined;
  if (status >= 200 && status < 300) return `The MCP server's reply (HTTP ${status}) had no response to this request`;
  return `HTTP ${status} ${STATUS_CODES[status] ?? ""}`.trimEnd() + " from the MCP server, with no response to this request";
}

function describeRpcError(error: unknown): string {
  if (!isObject(error)) return "JSON-RPC error";
  const message = typeof error.message === "string" && error.message ? error.message : "JSON-RPC error";
  return typeof error.code === "number" ? `${message} (${error.code})` : message;
}

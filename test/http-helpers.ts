import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { SseParser, type SseEvent } from "../src/proxy/sse.ts";

/**
 * Requests over node:http rather than fetch, so each test sets exactly the
 * Host, Origin and Accept it means to (fetch adds an Accept of its own), and
 * connects to 127.0.0.1 whatever the URL's host, which skips the IPv6 attempt
 * "localhost" can cost on Windows.
 */

/** What an MCP client sends: both reply forms. */
export const BOTH = "application/json, text/event-stream";

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  text: string;
  json(): any;
}

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  /** A string is sent as it is; anything else as JSON. */
  body?: unknown;
  /** The Host header; by default the URL's own, like localhost:6277. */
  host?: string;
  /** The request target, sent as it is, for paths a URL would tidy up (like "/../secret"). */
  path?: string;
}

let nextId = 1;

export function rpc(method: string, params?: unknown, id: string | number = nextId++) {
  return { jsonrpc: "2.0", id, method, ...(params !== undefined && { params }) };
}

export function notification(method: string, params?: unknown) {
  return { jsonrpc: "2.0", method, ...(params !== undefined && { params }) };
}

function send(url: string, options: CallOptions, onResponse: (response: IncomingMessage) => void): ClientRequest {
  const target = new URL(url);
  const body = options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  const request = httpRequest(
    {
      host: "127.0.0.1",
      port: target.port,
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      path: options.path ?? `${target.pathname}${target.search}`,
      headers: {
        host: options.host ?? target.host,
        ...(body !== undefined && { "content-type": "application/json" }),
        ...options.headers,
      },
      // A connection of its own, closed after the reply, so nothing lingers between tests.
      agent: false,
    },
    onResponse,
  );
  request.end(body);
  return request;
}

/** One request, resolved once the whole reply is in. */
export function call(url: string, options: CallOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    send(url, options, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: () => JSON.parse(text) });
      });
    }).on("error", reject);
  });
}

/** Polls until the check passes, failing after a while with what it was waiting for. */
export async function until(check: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A reply read as it arrives: an event stream from the proxy, kept open until closed. */
export class Stream {
  status = 0;
  headers: IncomingHttpHeaders = {};
  /** Everything received so far, comments included. */
  text = "";
  readonly events: SseEvent[] = [];
  ended = false;
  private readonly parser = new SseParser((event) => this.events.push(event));
  private request: ClientRequest | undefined;

  /** Resolves once the reply's headers are in. */
  static open(url: string, options: CallOptions = {}): Promise<Stream> {
    const stream = new Stream();
    return new Promise((resolve, reject) => {
      stream.request = send(url, options, (response) => {
        stream.status = response.statusCode ?? 0;
        stream.headers = response.headers;
        response.on("data", (chunk: Buffer) => {
          stream.text += chunk.toString("utf8");
          stream.parser.push(chunk);
        });
        response.on("close", () => {
          stream.ended = true;
        });
        response.on("error", () => {});
        resolve(stream);
      });
      stream.request.on("error", (error) => {
        if (!stream.status) reject(error);
      });
    });
  }

  /** The data of the first event with this name (and matching, when a match is given), waiting for it if need be. */
  async next(name: string, match: (data: any) => boolean = () => true): Promise<any> {
    const find = () => this.all(name).find(match);
    await until(() => find() !== undefined, `a "${name}" event`);
    return find();
  }

  /** The data of every event with this name so far, skipping any that isn't JSON (like a priming event's empty data). */
  all(name: string): any[] {
    return this.events.filter((event) => event.event === name).flatMap((event) => {
      try {
        return [JSON.parse(event.data)];
      } catch {
        return [];
      }
    });
  }

  close(): void {
    this.request?.destroy();
  }
}

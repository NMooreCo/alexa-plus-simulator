import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/** Helpers between Node's http server and the fetch-style Request and Response the extra routes speak. */

export async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export function sendJson(response: ServerResponse, status: number, body: unknown, headers: OutgoingHttpHeaders = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
}

/** The proxy's own errors, in the `{ error: { code, message } }` shape the model route uses too. */
export function sendError(response: ServerResponse, status: number, code: string, message: string, headers: OutgoingHttpHeaders = {}): void {
  sendJson(response, status, { error: { code, message } }, headers);
}

/** The Node request as a web Request. The Host header was checked already, so the URL is a local one. */
export function toWebRequest(request: IncomingMessage, body: Buffer, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD" && body.length > 0;
  return new Request(new URL(request.url ?? "/", `http://${request.headers.host}`), {
    method,
    headers,
    body: hasBody ? body : undefined,
    signal,
  });
}

/**
 * The connection-level headers a web Response may carry that don't belong on
 * this connection. Content-Length goes too: Node sizes the body itself, and a
 * Response passed along from fetch keeps its compressed length after fetch
 * has decompressed the body.
 */
const NOT_FORWARDED = new Set(["connection", "keep-alive", "transfer-encoding", "content-length"]);

/** Writes a web Response to the Node response, streaming its body as it comes. */
export async function sendWebResponse(response: ServerResponse, web: Response, extra: OutgoingHttpHeaders): Promise<void> {
  const headers: OutgoingHttpHeaders = {};
  web.headers.forEach((value, name) => {
    if (!NOT_FORWARDED.has(name) && name !== "set-cookie") headers[name] = value;
  });
  const cookies = web.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  Object.assign(headers, extra);
  response.writeHead(web.status, headers);
  if (!web.body) {
    response.end();
    return;
  }
  // Headers go out now, so a streamed reply (like a model's) shows it started before its first chunk.
  response.flushHeaders();
  try {
    await pipeline(Readable.fromWeb(web.body as NodeReadableStream<Uint8Array>), response);
  } catch {
    // The caller left, or the route's stream failed partway. Dropping the connection is how a cut-off body shows.
    response.destroy();
  }
}

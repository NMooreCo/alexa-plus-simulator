import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";

/**
 * The MCP server under test, reached with Node's own http and https clients
 * rather than fetch: fetch gives up on a response body that's quiet for five
 * minutes, which would cut off a long-lived `GET /mcp` stream, and it
 * decompresses bodies behind the proxy's back.
 */

/** Redirects a POST or DELETE can follow: the two that keep the method and the body. */
const KEEPS_METHOD = new Set([307, 308]);
/** A GET can follow any redirect, since every one of them stays a GET. */
const ANY_REDIRECT = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/** localhost, 127.0.0.0/8 and [::1]: the only hosts a plain http:// upstream may be on. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/**
 * Parses the MCP endpoint under test. Anything but https:// is refused, except
 * http:// on this machine for a local dev server, as Amazon's Local Inspector
 * does: over plain http to a remote host, the bearer token and every tool call
 * would cross the network in the clear.
 */
export function parseUpstream(upstream: string): URL {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    throw new Error(`"${upstream}" isn't a URL. Give the MCP server's full endpoint, like https://example.com/mcp.`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") {
    if (isLoopbackHost(url.hostname)) return url;
    throw new Error(
      `Refusing ${url.origin}: a remote MCP server must use https://. Plain http:// is only allowed on this machine (localhost, 127.0.0.1 or [::1]), for a local dev server.`,
    );
  }
  throw new Error(`Refusing ${upstream}: the MCP server's URL must start with https:// (or http:// for a server on this machine).`);
}

/** The server redirected somewhere the proxy won't send a request (plain http to another machine, say). */
export class RedirectRefused extends Error {}

export class Upstream {
  // Kept-alive connections, so the round trips the proxy times are the ones a
  // connected client sees, not a fresh TLS handshake each time.
  private readonly httpAgent = new HttpAgent({ keepAlive: true });
  private readonly httpsAgent = new HttpsAgent({ keepAlive: true });
  private readonly inFlight = new Set<ClientRequest>();

  constructor(readonly url: URL) {}

  /**
   * Sends one request and resolves with the response once its headers are in.
   * Follows redirects a client would follow, since passing one back would send
   * the caller around the proxy, straight to the server.
   */
  async send(method: string, headers: OutgoingHttpHeaders, body: Buffer | undefined, signal: AbortSignal): Promise<IncomingMessage> {
    let url = this.url;
    let sending = headers;
    for (let hop = 0; ; hop++) {
      const response = await this.once(url, method, sending, body, signal);
      const location = response.headers.location;
      const followable = (method === "GET" ? ANY_REDIRECT : KEEPS_METHOD).has(response.statusCode ?? 0);
      if (!location || !followable || hop === MAX_REDIRECTS) return response;
      response.resume();
      const next = new URL(location, url);
      try {
        parseUpstream(next.href);
      } catch (error) {
        throw new RedirectRefused(`The MCP server redirected to ${next.href}, which the proxy won't follow. ${(error as Error).message}`);
      }
      // As fetch does, a redirect to another origin doesn't carry the credentials along.
      if (next.origin !== url.origin) {
        sending = { ...sending };
        delete sending.authorization;
      }
      url = next;
    }
  }

  private once(url: URL, method: string, headers: OutgoingHttpHeaders, body: Buffer | undefined, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const https = url.protocol === "https:";
      const request = (https ? httpsRequest : httpRequest)(url, {
        method,
        headers: body ? { ...headers, "content-length": body.length } : headers,
        agent: https ? this.httpsAgent : this.httpAgent,
        signal,
      });
      this.inFlight.add(request);
      request.on("close", () => this.inFlight.delete(request));
      // An error after the response arrived surfaces on the response itself;
      // this listener stays so a late one can't go unhandled.
      request.on("error", reject);
      request.on("response", resolve);
      request.end(body);
    });
  }

  /** Ends every request still open, event streams included, and drops the pooled connections. */
  close(): void {
    for (const request of this.inFlight) request.destroy();
    this.inFlight.clear();
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }
}

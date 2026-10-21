import { Agent as HttpAgent, request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isLoopbackHost, parseServerUrl } from "../shared/server-url.ts";

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

/** The MCP endpoint under test: https://, or http:// on this machine only (src/shared/server-url.ts has the rule, which the check shares). */
export { isLoopbackHost, parseServerUrl as parseUpstream };

/** The server redirected to another origin, where the proxy won't send a request. */
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
   * the caller around the proxy, straight to the server; but only within the
   * server's own origin. The proxy talks only to the server you named, and a
   * redirect elsewhere would carry your token and headers (or the page's) to
   * whoever the server pointed at, a service on this machine included.
   */
  async send(method: string, headers: OutgoingHttpHeaders, body: Buffer | undefined, signal: AbortSignal): Promise<IncomingMessage> {
    let url = this.url;
    for (let hop = 0; ; hop++) {
      const response = await this.once(url, method, headers, body, signal);
      const location = response.headers.location;
      const followable = (method === "GET" ? ANY_REDIRECT : KEEPS_METHOD).has(response.statusCode ?? 0);
      if (!location || !followable || hop === MAX_REDIRECTS) return response;
      response.resume();
      const next = new URL(location, url);
      if (next.origin !== url.origin) {
        throw new RedirectRefused(
          `The MCP server redirected to ${next.href}, another origin, which the proxy won't follow: it talks only to the server you named, so your token and headers go nowhere else. If that's the server's address, start the simulator with it.`,
        );
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

import type { IncomingMessage, OutgoingHttpHeaders } from "node:http";

/**
 * Who may talk to the proxy. Both ports bind to 127.0.0.1, but a web page
 * can still reach them: through DNS rebinding (a hostile name that resolves
 * to 127.0.0.1, which the Host header gives away) or with a plain cross-site
 * request (which the Origin header gives away). Either could make the proxy
 * call the MCP server with the configured bearer token, so both are refused.
 */

/** True when the Host header names this port on localhost or 127.0.0.1. */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  const name = host.toLowerCase();
  return name === `localhost:${port}` || name === `127.0.0.1:${port}`;
}

/** The simulator page's own origins: the only pages allowed to call the server port. */
export function pageOrigins(clientPort: number): Set<string> {
  return new Set([`http://localhost:${clientPort}`, `http://127.0.0.1:${clientPort}`]);
}

/** The response headers the page needs to read, which CORS hides unless they're listed. */
const EXPOSED = "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate";
const METHODS = "GET, POST, DELETE, OPTIONS";
const DEFAULT_ALLOWED_HEADERS = "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID";

/** CORS headers for a request from an allowed origin; none for a request without one. */
export function corsHeaders(origin: string | undefined): OutgoingHttpHeaders {
  if (!origin) return {};
  return { "access-control-allow-origin": origin, "access-control-expose-headers": EXPOSED, vary: "Origin" };
}

/**
 * The answer to a preflight. It allows whatever headers the page asks for,
 * since the page is already trusted, and newer MCP revisions add request
 * headers (like Mcp-Method and Mcp-Param-*) that a fixed list would miss.
 */
export function preflightHeaders(request: IncomingMessage): OutgoingHttpHeaders {
  return {
    ...corsHeaders(request.headers.origin),
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": request.headers["access-control-request-headers"] || DEFAULT_ALLOWED_HEADERS,
    "access-control-max-age": "600",
  };
}

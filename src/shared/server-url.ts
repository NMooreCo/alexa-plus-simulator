/**
 * The one rule for the MCP server's URL, which the proxy, the readiness check
 * and link all hold to: https://, or plain http:// only on this machine, for a
 * local dev server, as Amazon's Local Inspector does. Over plain http to
 * another machine, the bearer token, your own headers and every tool call
 * would cross the network readable. It's here, apart from the proxy, because
 * the check also runs in the page.
 */

/** localhost, 127.0.0.0/8 and [::1]: the only hosts a plain http:// server may be on. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

/** Parses the MCP endpoint, or throws a TypeError saying why it won't be used. */
export function parseServerUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`"${value}" isn't a URL. Give the MCP server's full endpoint, like https://example.com/mcp.`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:") {
    if (isLoopbackHost(url.hostname)) return url;
    throw new TypeError(
      `Refusing ${url.origin}: a remote MCP server must use https://. Plain http:// is only allowed on this machine (localhost, 127.0.0.1 or [::1]), for a local dev server.`,
    );
  }
  throw new TypeError(`Refusing ${value}: the MCP server's URL must start with https:// (or http:// for a server on this machine).`);
}

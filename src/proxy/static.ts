import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { sendError } from "./web.ts";

/** The built page's files on the client port. */

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * The file a URL path names inside root, or undefined when the path is
 * malformed or would leave root (through "..", an encoded "%2e%2e", or a
 * backslash, which Windows treats as a separator).
 */
export function resolveStaticPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const base = resolve(root);
  const target = resolve(base, `.${decoded.startsWith("/") ? "" : "/"}${decoded}`);
  return target === base || target.startsWith(base + sep) ? target : undefined;
}

export async function serveStatic(root: string | undefined, pathname: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  let path = root === undefined ? undefined : resolveStaticPath(root, pathname);
  let info = path === undefined ? undefined : await stat(path).catch(() => undefined);
  if (path !== undefined && info?.isDirectory()) {
    path = join(path, "index.html");
    info = await stat(path).catch(() => undefined);
  }
  if (path === undefined || !info?.isFile()) {
    sendError(response, 404, "not_found", `Nothing at ${pathname}.`);
    return;
  }
  response.writeHead(200, {
    "content-type": contentType(path),
    "content-length": info.size,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(path)
    .on("error", () => response.destroy())
    .pipe(response);
}

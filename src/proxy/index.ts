import { createServer, type IncomingMessage, type OutgoingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProxyState } from "../shared/contract.ts";
import { EventHub } from "./events.ts";
import { McpForwarder } from "./forward.ts";
import { corsHeaders, hostAllowed, pageOrigins, preflightHeaders } from "./guard.ts";
import { Recorder } from "./recorder.ts";
import { serveStatic } from "./static.ts";
import { parseUpstream, Upstream } from "./upstream.ts";
import { readBody, sendError, sendJson, sendWebResponse, toWebRequest } from "./web.ts";

/**
 * The local proxy between the simulator (or a coding agent) and the MCP
 * server under test, and the server for the simulator's page.
 *
 * On the server port (6277): POST/GET/DELETE /mcp forwarded upstream, GET
 * /events, GET /health, GET /state, as Amazon's Local Inspector has them, plus
 * any extra routes the CLI mounts (the model route, the readiness check). On
 * the client port (6274): the built page. Both bind to 127.0.0.1 and refuse
 * other hosts and origins.
 */

/** A fetch-style handler the CLI mounts on the server port, like "/api/model". */
export type Route = (request: Request) => Promise<Response>;

export interface ProxyOptions {
  /** The MCP endpoint under test: https://, or http:// on a loopback address only. */
  upstream: string;
  port: number;
  clientPort: number;
  /**
   * Sent upstream as `Authorization: Bearer <token>` on every request, when
   * given. A function is asked on every request, and asked again with the
   * refused token after a 401, so it can refresh it (the request is retried once).
   */
  token?: string | ((refused?: string) => Promise<string | undefined>);
  /** Extra headers sent upstream on every request. */
  headers?: Record<string, string>;
  verbose?: boolean;
  /** The built page to serve on the client port. */
  uiDir?: string;
  /** Extra routes on the server port, by path. */
  routes?: Record<string, Route>;
}

export interface RunningProxy {
  /** Like http://localhost:6277. */
  url: string;
  /** Like http://localhost:6274. */
  uiUrl: string;
  state(): ProxyState;
  close(): Promise<void>;
}

/** The proxy's own paths on the server port, which an extra route can't take over. */
const OWN_PATHS = new Set(["/mcp", "/events", "/health", "/state"]);

export async function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const upstreamUrl = parseUpstream(options.upstream);
  const routes = options.routes ?? {};
  for (const path of Object.keys(routes)) {
    if (!path.startsWith("/")) throw new Error(`An extra route's path must start with "/", and "${path}" doesn't.`);
    if (OWN_PATHS.has(path)) throw new Error(`${path} is one of the proxy's own paths, so an extra route can't use it.`);
  }

  const log = options.verbose ? (line: string) => void process.stderr.write(`[proxy] ${line}\n`) : undefined;
  const hub = new EventHub();
  const recorder = new Recorder(options.upstream, (event) => hub.emit(event), log);
  const upstream = new Upstream(upstreamUrl);
  const forwarder = new McpForwarder(upstream, recorder, options.token, options.headers, log);

  // Either port may be 0 (any free port), so these are only known once both servers listen.
  let serverPort = 0;
  let clientPort = 0;
  let origins = new Set<string>();
  let url = "";

  async function serveProxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!hostAllowed(request.headers.host, serverPort)) return refuseHost(request, response, serverPort);
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return sendError(response, 403, "forbidden_origin", `Refusing a request from ${origin}: only the simulator's own page may call the proxy.`);
    }
    const cors = corsHeaders(origin);
    const path = pathOf(request.url);
    const method = request.method ?? "GET";
    if (path === undefined) return sendError(response, 400, "bad_request", "That request target isn't a path.", cors);
    if (method === "OPTIONS") {
      response.writeHead(204, preflightHeaders(request));
      response.end();
      return;
    }
    if (path === "/mcp") {
      if (method === "POST") return forwarder.post(request, response, cors);
      if (method === "GET") return forwarder.get(request, response, cors);
      if (method === "DELETE") return forwarder.delete(request, response, cors);
      return notAllowed(response, "GET, POST, DELETE", cors);
    }
    if (OWN_PATHS.has(path)) {
      if (method !== "GET") return notAllowed(response, "GET", cors);
      if (path === "/events") return hub.subscribe(response, cors);
      if (path === "/health") return sendJson(response, 200, { status: recorder.state.initialized ? "ok" : "not-ready" }, cors);
      return sendJson(response, 200, recorder.state, cors);
    }
    const route = Object.hasOwn(routes, path) ? routes[path] : undefined;
    if (route) return runRoute(route, path, request, response, cors);
    sendError(response, 404, "not_found", `Nothing at ${path} on the proxy.`, cors);
  }

  async function runRoute(route: Route, path: string, request: IncomingMessage, response: ServerResponse, cors: OutgoingHttpHeaders): Promise<void> {
    const body = await readBody(request);
    // The route can stop its own work (a model call, say) when the caller leaves.
    const caller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) caller.abort();
    });
    let reply: Response;
    try {
      reply = await route(toWebRequest(request, body, caller.signal));
    } catch (error) {
      log?.(`${path} failed: ${(error as Error).message}`);
      if (!caller.signal.aborted) sendError(response, 500, "route_failed", `${path} failed: ${(error as Error).message}`, cors);
      return;
    }
    await sendWebResponse(response, reply, cors);
  }

  async function servePage(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!hostAllowed(request.headers.host, clientPort)) return refuseHost(request, response, clientPort);
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") return notAllowed(response, "GET, HEAD", {});
    const path = pathOf(request.url);
    if (path === undefined) return sendError(response, 400, "bad_request", "That request target isn't a path.");
    // Where the page finds the proxy: the ports aren't fixed, so the page can't assume them.
    if (path === "/config.json") return sendJson(response, 200, { proxyUrl: url, upstream: options.upstream });
    await serveStatic(options.uiDir, path, request, response);
  }

  const server = createServer((request, response) => {
    serveProxy(request, response).catch((error: unknown) => crashed(request, response, error));
  });
  const client = createServer((request, response) => {
    servePage(request, response).catch((error: unknown) => crashed(request, response, error));
  });

  try {
    serverPort = await listen(server, options.port, "proxy");
    clientPort = await listen(client, options.clientPort, "simulator page");
  } catch (error) {
    upstream.close();
    await Promise.all([stop(server), stop(client)]);
    throw error;
  }
  origins = pageOrigins(clientPort);
  url = `http://localhost:${serverPort}`;

  let closing: Promise<void> | undefined;
  return {
    url,
    uiUrl: `http://localhost:${clientPort}`,
    state: () => structuredClone(recorder.state),
    close: () =>
      (closing ??= (async () => {
        hub.close();
        upstream.close();
        await Promise.all([stop(server), stop(client)]);
      })()),
  };
}

/**
 * The request's path, or undefined for a request target that isn't one. It's
 * read as a path on a fixed origin, so a target like "//elsewhere/mcp" stays
 * the path it is rather than turning into a host and "/mcp".
 */
function pathOf(target: string | undefined): string | undefined {
  if (!target?.startsWith("/")) return undefined;
  try {
    return new URL(`http://localhost${target}`).pathname;
  } catch {
    return undefined;
  }
}

function refuseHost(request: IncomingMessage, response: ServerResponse, port: number): void {
  sendError(
    response,
    403,
    "forbidden_host",
    `Refusing a request for host "${request.headers.host ?? ""}": this port only answers requests addressed to localhost:${port} or 127.0.0.1:${port}.`,
  );
}

function notAllowed(response: ServerResponse, allow: string, cors: OutgoingHttpHeaders): void {
  sendError(response, 405, "method_not_allowed", `Use ${allow}.`, { ...cors, allow });
}

/** A request the proxy failed to handle: a bug, worth seeing on stderr even without --verbose. */
function crashed(request: IncomingMessage, response: ServerResponse, error: unknown): void {
  // A caller that hung up partway through sending its request isn't a bug, and there's no one left to answer.
  if (request.destroyed) return;
  process.stderr.write(`[proxy] internal error: ${error instanceof Error ? error.stack : String(error)}\n`);
  if (!response.headersSent) sendError(response, 500, "internal_error", "The proxy failed to handle this request.");
  else response.destroy();
}

function listen(server: Server, port: number, role: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          error.code === "EADDRINUSE"
            ? `Port ${port} on 127.0.0.1 is already in use, so the ${role} can't start there. Stop whatever holds it, or choose another port.`
            : `The ${role} couldn't listen on 127.0.0.1:${port}: ${error.message}`,
        ),
      );
    };
    server.once("error", failed);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", failed);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** Stops listening and drops every open connection, event streams included. */
function stop(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

import type { ProxyState } from "../shared/contract.ts";

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
  /** Sent upstream as `Authorization: Bearer <token>` on every request, when given. */
  token?: string | (() => Promise<string | undefined>);
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

export async function startProxy(_options: ProxyOptions): Promise<RunningProxy> {
  throw new Error("The proxy isn't built yet.");
}

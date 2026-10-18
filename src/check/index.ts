import type { ReadinessReport } from "../shared/contract.ts";
import { checkAuth, probeSignIn } from "./auth.ts";
import { checkDataLayer } from "./data-layer.ts";
import { buildReport } from "./report.ts";

/**
 * The readiness check: Amazon's published Alexa+ MCP add-on requirements
 * (docs/alexa-requirements.md) run against a live MCP server, as a report of
 * rules that pass, fail or warn, each pointing at the requirement it checks.
 */

export { buildReport, formatReport, verdictOf, VERSION } from "./report.ts";
export { validatePackage } from "./package.ts";
export { RULES } from "./rules.ts";

/** Long enough for a cold start, short enough that a hung server fails a rule rather than stalling the check. */
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface CheckOptions {
  /** The MCP endpoint, like https://example.com/mcp. */
  serverUrl: string;
  /** A bearer token for a server that needs one, to check the authenticated calls too. */
  token?: string;
  /** For tests. */
  fetch?: typeof fetch;
  /** How long one request may take before the rule that needed it fails. */
  timeoutMs?: number;
  /** A clock in milliseconds, so tests can fake latency instead of waiting for it. */
  now?: () => number;
  /** The report's version; the CLI can pass package.json's. */
  version?: string;
}

export async function runChecks(options: CheckOptions): Promise<ReadinessReport> {
  let url: URL;
  try {
    url = new URL(options.serverUrl);
  } catch {
    throw new TypeError(`${options.serverUrl} isn't a URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`${options.serverUrl} isn't an http:// or https:// URL.`);

  const transport = {
    url: options.serverUrl,
    // Bound, since a detached fetch throws "Illegal invocation" in browsers and some other runtimes.
    fetch: options.fetch ?? globalThis.fetch.bind(globalThis),
    now: options.now ?? (() => performance.now()),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const dataLayer = await checkDataLayer(transport, options.token);
  // Without a token the data layer's own requests show whether sign-in is needed; with one, ask again without it.
  const signIn = options.token ? await probeSignIn(transport, dataLayer.safeTool) : dataLayer.signIn;
  const auth = await checkAuth(transport, options.serverUrl, signIn);
  return buildReport(options.serverUrl, [...dataLayer.rules, ...auth], options.version ? { version: options.version } : {});
}

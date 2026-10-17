import type { ReadinessReport, RuleResult } from "../shared/contract.ts";

/**
 * The readiness check: Amazon's published Alexa+ MCP add-on requirements
 * (docs/alexa-requirements.md) run against a live MCP server, as a report of
 * rules that pass, fail or warn, each pointing at the requirement it checks.
 */

export interface CheckOptions {
  /** The MCP endpoint, like https://example.com/mcp. */
  serverUrl: string;
  /** A bearer token for a server that needs one, to check the authenticated calls too. */
  token?: string;
  /** For tests. */
  fetch?: typeof fetch;
}

export async function runChecks(_options: CheckOptions): Promise<ReadinessReport> {
  throw new Error("The readiness check isn't built yet.");
}

/** The rules for an add-on package's addon.json, from the quickstart's schema reference. */
export function validatePackage(_addonJson: unknown): RuleResult[] {
  throw new Error("The package check isn't built yet.");
}

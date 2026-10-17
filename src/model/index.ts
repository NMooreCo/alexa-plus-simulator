import type { Route } from "../proxy/index.ts";

/**
 * The simulator's assistant: one model turn per request, in the Messages
 * API's shape, so the page runs the tool loop and the key stays on this
 * machine.
 */

export interface ModelOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

export function modelRoute(_options: ModelOptions): Route {
  return async () => Response.json({ error: { code: "not_built", message: "The model route isn't built yet." } }, { status: 503 });
}

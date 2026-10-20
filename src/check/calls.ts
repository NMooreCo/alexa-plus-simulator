import { clip, isObject, type JsonObject } from "./rpc.ts";

/**
 * Sample calls a developer lists for the check (`--calls calls.json`), so it
 * can exercise tools that need arguments. The check makes a listed call even
 * when its tool isn't marked read-only, since the developer chose it for their
 * own server; it still never calls an unlisted tool that isn't.
 */

/** One call to make: a tool and its arguments, as they'd appear in tools/call. */
export interface ToolCall {
  tool: string;
  arguments?: JsonObject;
}

/** A calls list longer than this is more likely a data file passed by mistake than calls to make. */
export const MAX_CALLS = 100;

const EXAMPLE = `[{ "tool": "get_forecast", "arguments": { "city": "Denver" } }]`;

/**
 * Checks a calls list (parsed JSON, or what a library caller passed) and
 * returns it with every call's arguments filled in. Throws a TypeError that
 * says what's wrong and where, so a bad file is fixed before any call is made.
 */
export function parseCalls(value: unknown, where = "The calls list"): Required<ToolCall>[] {
  if (!Array.isArray(value)) throw new TypeError(`${where} must be a list of calls, like ${EXAMPLE}.`);
  if (!value.length) throw new TypeError(`${where} lists no calls; add one like ${EXAMPLE}.`);
  if (value.length > MAX_CALLS) throw new TypeError(`${where} lists ${value.length} calls; the check makes at most ${MAX_CALLS}.`);
  return value.map((entry, i) => {
    const which = `Call ${i + 1} in ${where}`;
    if (!isObject(entry)) throw new TypeError(`${which} isn't an object with a "tool" and its "arguments", like ${EXAMPLE}.`);
    const tool = entry.tool;
    if (tool === undefined) {
      // tools/call names the tool "name", so that's the likeliest slip.
      const hint = "name" in entry ? `; name the tool with "tool", not "name"` : "";
      throw new TypeError(`${which} has no "tool"${hint}.`);
    }
    if (typeof tool !== "string" || !tool.trim()) throw new TypeError(`${which} has a "tool" that isn't a tool's name: ${clip(JSON.stringify(tool) ?? String(tool), 40)}.`);
    const named = `Call ${i + 1} (${tool}) in ${where}`;
    const extra = Object.keys(entry).filter((key) => key !== "tool" && key !== "arguments");
    if (extra.length) {
      const keys = extra.map((key) => JSON.stringify(key)).join(", ");
      throw new TypeError(`${named} has ${keys} besides "tool" and "arguments".`);
    }
    const args = entry.arguments ?? {};
    if (!isObject(args)) throw new TypeError(`${named} has "arguments" that aren't an object; give them as { "name": value }.`);
    return { tool, arguments: args };
  });
}

/** For notes and labels: the tool's name, with its arguments when it has any, like get_forecast({"city":"Denver"}). */
export function callLabel(tool: string, args: JsonObject): string {
  return Object.keys(args).length ? `${tool}(${clip(JSON.stringify(args), 60)})` : tool;
}

/** Two calls are the same call when they name the same tool with the same arguments. */
export function callKey(tool: string, args: JsonObject): string {
  return `${tool}\u0000${JSON.stringify(args)}`;
}

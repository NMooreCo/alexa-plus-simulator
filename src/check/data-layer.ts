import { ALEXA_PROTOCOL_VERSION, LATENCY_BUDGET_MS, type RuleResult, type RuleStatus } from "../shared/contract.ts";
import { callKey, callLabel, type ToolCall } from "./calls.ts";
import { McpSession, clip, isObject, legacySseEndpoint, mediaType, type Exchange, type JsonObject, type Transport } from "./rpc.ts";
import { RULES, judge, listOf, sentence } from "./rules.ts";

/**
 * The data-layer rules (DL-xx): one session with the server, sending what
 * Alexa+ sends, gathered first and judged after, so each rule reads the same
 * evidence and a failure early on turns later rules into skips with a reason.
 */

/** tools/list is timed this many times, since one sample can be a fluke either way. */
const LIST_SAMPLES = 3;
/** A server that never stops returning nextCursor shouldn't keep the check paging. */
const MAX_PAGES = 20;
/** The other read-only tools timed once each, so a slow one (often a screen's) shows; a cap on how many and how long. */
const MAX_TIMED_TOOLS = 25;
const TIMED_TOOLS_BUDGET_MS = 30_000;

export const DATA_LAYER_RULES = [
  RULES.streamableHttp,
  RULES.protocolVersion,
  RULES.tools,
  RULES.latency,
  RULES.toolResults,
  RULES.errors,
  RULES.idempotency,
  RULES.screens,
];

/** A request sent without a token that the server refused, which is where the auth rules start. */
export interface Challenge {
  /** Like "initialize" or "tools/call get_weather". */
  label: string;
  status: number;
  headers: Headers;
}

/** What requests sent without a token showed about sign-in, for the auth rules. */
export interface SignIn {
  /** The first one the server refused with 401 or 403. */
  challenge?: Challenge;
  /** Why sign-in couldn't be judged, when initialize didn't get far enough to show either way. */
  unknown?: string;
}

/** A read-only call the sign-in probe can repeat without a token, since it can't change anything. */
export interface ProbeCall {
  name: string;
  arguments: JsonObject;
  label: string;
}

export interface DataLayerFindings {
  rules: RuleResult[];
  /** What the data layer's own requests showed about sign-in; only meaningful when they went without a token. */
  signIn: SignIn;
  /** A read-only call the check made, so the sign-in probe can try the same one without a token. */
  probe?: ProbeCall;
}

/**
 * A call whose result DL-05 judges and, for a read-only tool, DL-07 repeats:
 * the check's own pick (the first read-only tool that needs no arguments) or
 * one the developer listed.
 */
interface JudgedCall extends ProbeCall {
  readOnly: boolean;
  first: Exchange;
  /** The same call again, made only for a read-only tool whose first call worked. */
  repeat?: Exchange;
}

interface Evidence {
  withToken: boolean;
  init: Exchange;
  legacyEndpoint?: string;
  sessionId?: string;
  initialized?: Exchange;
  listings: Exchange[];
  /** The listed tools as the server sent them, unchecked; undefined when listing failed. */
  tools?: unknown[];
  listFailure?: { exchange: Exchange; problem?: string };
  /** Whether the developer listed calls, which changes what a skip should suggest. */
  listed: boolean;
  judged: JudgedCall[];
  /** Listed tools the server doesn't list, so they weren't called: Alexa+ only calls tools it was told about. */
  unknown: string[];
  /** One call to each other tool that's safe to call, for the latency rule. */
  otherCalls: Exchange[];
  screens: { uri: string; exchange: Exchange }[];
  missingTool?: { name: string; exchange: Exchange };
}

export function isRefusal(exchange: Exchange): boolean {
  return exchange.status === 401 || exchange.status === 403;
}

export function challengeOf(exchange: Exchange): Challenge {
  return { label: exchange.label, status: exchange.status!, headers: exchange.headers ?? new Headers() };
}

function resultOf(exchange: Exchange): JsonObject | undefined {
  return exchange.outcome.kind === "result" && isObject(exchange.outcome.result) ? exchange.outcome.result : undefined;
}

/** A tool result Alexa+ could use: an object that doesn't report an error. */
function usableResult(exchange: Exchange | undefined): JsonObject | undefined {
  const result = exchange && resultOf(exchange);
  return result && result.isError !== true ? result : undefined;
}

function describe(exchange: Exchange, withToken: boolean): string {
  const outcome = exchange.outcome;
  switch (outcome.kind) {
    case "error": {
      const { code, message } = outcome.error;
      const http = exchange.status && exchange.status >= 300 ? ` with HTTP ${exchange.status}` : "";
      return `JSON-RPC error ${code ?? "(no code)"}${message ? ` (${clip(message, 80)})` : ""}${http}`;
    }
    case "http":
      return isRefusal(exchange) && withToken ? `${outcome.message}, even with the token` : outcome.message;
    case "result":
      return "a result";
    default:
      return outcome.message;
  }
}

function signInNote(label: string, status: number | undefined): string {
  return `The server asks for sign-in for ${label} (HTTP ${status}); run again with a token to check this.`;
}

function toolName(tool: unknown): string | undefined {
  return isObject(tool) && typeof tool.name === "string" && tool.name.trim() ? tool.name : undefined;
}

/** Whether the tool says it only reads, so calling it again can't change anything. */
function isReadOnly(tool: unknown): boolean {
  return isObject(tool) && isObject(tool.annotations) && tool.annotations.readOnlyHint === true;
}

/**
 * Whether the check may call this tool on its own: it must say it's read-only
 * and need no arguments, so calling it with none can't change anything for anyone.
 */
function isSafe(tool: unknown): boolean {
  if (!isObject(tool) || !toolName(tool) || !isReadOnly(tool)) return false;
  const schema = tool.inputSchema;
  return !(isObject(schema) && Array.isArray(schema.required) && schema.required.length > 0);
}

/** A screen's URI from `_meta`, in the MCP Apps form or the older flat key. */
function screenUri(meta: unknown): string | undefined {
  if (!isObject(meta)) return undefined;
  if (isObject(meta.ui) && typeof meta.ui.resourceUri === "string" && meta.ui.resourceUri) return meta.ui.resourceUri;
  const legacy = meta["ui/resourceUri"];
  return typeof legacy === "string" && legacy ? legacy : undefined;
}

export function missingToolName(taken: Set<string>): string {
  // Random, so it can't be one of the server's tools; the check never calls a tool that isn't marked read-only.
  for (;;) {
    const name = `alexa_plus_simulator_no_such_tool_${Math.random().toString(36).slice(2, 8)}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Runs the data-layer rules. `calls` are the developer's sample calls, made
 * as listed (even to a tool not marked read-only) on top of the check's own.
 */
export async function checkDataLayer(transport: Transport, token?: string, calls: Required<ToolCall>[] = []): Promise<DataLayerFindings> {
  const session = new McpSession(transport, token);
  try {
    return await gather(session, transport, token, calls);
  } finally {
    await session.close();
  }
}

async function gather(session: McpSession, transport: Transport, token: string | undefined, calls: Required<ToolCall>[]): Promise<DataLayerFindings> {
  const withToken = Boolean(token);
  const init = await session.initialize();
  if (!withToken && isRefusal(init)) {
    const note = `The server asks for sign-in (initialize was refused with HTTP ${init.status}); run again with a token to check the data layer.`;
    return {
      rules: DATA_LAYER_RULES.map((rule) => judge(rule, "SKIP", note)),
      signIn: { challenge: challengeOf(init) },
    };
  }

  const e: Evidence = { withToken, init, listings: [], listed: calls.length > 0, judged: [], unknown: [], otherCalls: [], screens: [] };
  if (!resultOf(init)) {
    if (init.outcome.kind === "http" && init.status! >= 400 && init.status! < 500 && !isRefusal(init)) {
      e.legacyEndpoint = await legacySseEndpoint(transport, token);
    }
    const note = "The initialize request didn't succeed (see DL-01), so this wasn't checked.";
    return {
      rules: [streamableHttp(e), ...DATA_LAYER_RULES.slice(1).map((rule) => judge(rule, "SKIP", note))],
      signIn: { unknown: "The initialize request didn't succeed (see DL-01), so sign-in wasn't checked." },
    };
  }
  e.sessionId = session.sessionId;
  e.initialized = await session.notify("notifications/initialized");

  await listTools(session, e);
  if (e.tools) {
    for (let i = 1; i < LIST_SAMPLES; i++) e.listings.push(await session.request("tools/list"));
    await callTools(session, transport, e, calls);
  }

  // Screens named on tool definitions (MCP Apps) and in the judged calls' results, as Amazon's documented result has them.
  const uris = new Set<string>();
  for (const tool of e.tools ?? []) {
    const uri = isObject(tool) ? screenUri(tool._meta) : undefined;
    if (uri) uris.add(uri);
  }
  for (const call of e.judged) {
    const uri = screenUri(resultOf(call.first)?._meta);
    if (uri) uris.add(uri);
  }
  for (const uri of uris) e.screens.push({ uri, exchange: await session.request("resources/read", { uri }, `resources/read ${uri}`) });

  const name = missingToolName(new Set((e.tools ?? []).map(toolName).filter((n) => n !== undefined)));
  e.missingTool = { name, exchange: await session.request("tools/call", { name, arguments: {} }, "tools/call (no such tool)") };

  const sent = [...e.listings, ...callExchanges(e), ...e.otherCalls, ...e.screens.map((s) => s.exchange), e.missingTool.exchange];
  const refused = withToken ? undefined : sent.find(isRefusal);
  const probe = e.judged.find((call) => call.readOnly);
  return {
    rules: [
      streamableHttp(e),
      protocolVersion(e),
      toolDefinitions(e),
      latency(e),
      toolResults(e),
      errorHandling(e),
      repeatedCalls(e),
      screens(e),
    ],
    signIn: refused ? { challenge: challengeOf(refused) } : {},
    ...(probe ? { probe: { name: probe.name, arguments: probe.arguments, label: probe.label } } : {}),
  };
}

/**
 * The tool calls: the check's own pick (twice, to compare), then each listed
 * call (a read-only tool's twice), then one call to every other tool that's
 * safe to call. The same tool with the same arguments is only ever called once
 * over (or twice, to compare), however many of these name it.
 */
async function callTools(session: McpSession, transport: Transport, e: Evidence, calls: Required<ToolCall>[]): Promise<void> {
  const tools = e.tools ?? [];
  const made = new Set<string>();
  const judgeCall = async (name: string, args: JsonObject, readOnly: boolean) => {
    const key = callKey(name, args);
    if (made.has(key)) return;
    made.add(key);
    const label = callLabel(name, args);
    const params = { name, arguments: args };
    const call: JudgedCall = { name, arguments: args, label, readOnly, first: await session.request("tools/call", params, `tools/call ${label}`) };
    // Only a read-only tool's call is made again, and only once it worked, so a repeat can't change anything.
    if (readOnly && usableResult(call.first)) call.repeat = await session.request("tools/call", params, `tools/call ${label}`);
    e.judged.push(call);
  };

  const safe = toolName(tools.find(isSafe));
  if (safe) await judgeCall(safe, {}, true);
  for (const listed of calls) {
    const tool = tools.find((t) => toolName(t) === listed.tool);
    if (tool === undefined) {
      if (!e.unknown.includes(listed.tool)) e.unknown.push(listed.tool);
      continue;
    }
    await judgeCall(listed.tool, listed.arguments, isReadOnly(tool));
  }

  // Every other tool that's safe to call, once, since Alexa+'s budget covers each one (a screen's own refresh included).
  const started = transport.now();
  for (const tool of tools.filter(isSafe).slice(0, MAX_TIMED_TOOLS)) {
    const name = toolName(tool)!;
    if (made.has(callKey(name, {}))) continue;
    if (transport.now() - started > TIMED_TOOLS_BUDGET_MS) break;
    made.add(callKey(name, {}));
    e.otherCalls.push(await session.request("tools/call", { name, arguments: {} }, `tools/call ${name}`));
  }
}

/** Every request of the judged calls, repeats included. */
function callExchanges(e: Evidence): Exchange[] {
  return e.judged.flatMap((call) => (call.repeat ? [call.first, call.repeat] : [call.first]));
}

async function listTools(session: McpSession, e: Evidence): Promise<void> {
  const tools: unknown[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const exchange = await session.request("tools/list", cursor ? { cursor } : undefined);
    e.listings.push(exchange);
    const result = resultOf(exchange);
    if (!result || !Array.isArray(result.tools)) {
      e.listFailure = { exchange, ...(result ? { problem: "its result has no tools array" } : {}) };
      return;
    }
    tools.push(...result.tools);
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) break;
  }
  e.tools = tools;
}

function streamableHttp(e: Evidence): RuleResult {
  const rule = RULES.streamableHttp;
  const result = resultOf(e.init);
  if (!result) {
    if (e.legacyEndpoint) {
      return judge(
        rule,
        "FAIL",
        `A POST of initialize was answered with HTTP ${e.init.status}, and a GET opened a legacy HTTP+SSE stream announcing ${clip(e.legacyEndpoint, 80)}: the server speaks only the legacy SSE transport.`,
      );
    }
    if (e.withToken && isRefusal(e.init)) {
      return judge(rule, "FAIL", `The initialize request was refused with HTTP ${e.init.status} even with the token, so nothing else could be checked; check the token.`);
    }
    const what = e.init.outcome.kind === "result" ? "a result that isn't an object" : describe(e.init, e.withToken);
    return judge(rule, "FAIL", `The initialize request failed: ${what}.`);
  }
  const how = `${e.init.framing === "sse" ? "SSE" : "JSON"}, ${e.sessionId ? "with a session id" : "stateless"}`;
  const info = isObject(result.serverInfo) ? result.serverInfo : undefined;
  const name = info && [info.name, info.version].filter((p) => typeof p === "string" && p).join(" ");
  const server = name ? `; the server is ${clip(name, 60)}` : "";
  const initialized = e.initialized;
  if (initialized && (initialized.status === undefined || initialized.status >= 300)) {
    return judge(
      rule,
      "WARN",
      `The initialize request succeeded (${how}), but notifications/initialized was answered with ${describe(initialized, e.withToken)}.`,
    );
  }
  return judge(rule, "PASS", `The initialize request succeeded over Streamable HTTP (${how})${server}.`);
}

function protocolVersion(e: Evidence): RuleResult {
  const rule = RULES.protocolVersion;
  const version = resultOf(e.init)?.protocolVersion;
  if (typeof version !== "string" || !version) return judge(rule, "FAIL", "The initialize result has no protocolVersion.");
  if (version === ALEXA_PROTOCOL_VERSION) return judge(rule, "PASS", `The server negotiated ${version}, the version Alexa+ asks for.`);
  return judge(rule, "WARN", `The server negotiated ${version}; Alexa+ asks for ${ALEXA_PROTOCOL_VERSION}.`);
}

function toolDefinitions(e: Evidence): RuleResult {
  const rule = RULES.tools;
  if (e.listFailure) {
    const { exchange, problem } = e.listFailure;
    if (!e.withToken && isRefusal(exchange)) return judge(rule, "SKIP", signInNote("tools/list", exchange.status));
    return judge(rule, "FAIL", `The tools/list request failed: ${problem ?? describe(exchange, e.withToken)}.`);
  }
  const tools = e.tools ?? [];
  if (!tools.length) return judge(rule, "FAIL", "The tools/list request returned no tools, so Alexa+ has nothing to invoke.");
  const failures: string[] = [];
  const warnings: string[] = [];
  tools.forEach((tool, i) => {
    const name = toolName(tool);
    if (!name || !isObject(tool)) {
      failures.push(`tool ${i + 1} has no name`);
      return;
    }
    const schema = tool.inputSchema;
    if (!isObject(schema)) failures.push(`tool ${name} has no inputSchema object`);
    else if (schema.type !== "object") {
      failures.push(`tool ${name}'s inputSchema ${schema.type === undefined ? "has no type" : `has type ${JSON.stringify(schema.type)}`}, not "object"`);
    }
    if (typeof tool.description !== "string" || !tool.description.trim()) warnings.push(`tool ${name} has no description`);
  });
  if (failures.length) {
    return judge(rule, "FAIL", `${sentence(listOf(failures))}.${warnings.length ? ` Also, ${listOf(warnings)}.` : ""}`);
  }
  if (warnings.length) return judge(rule, "WARN", `${sentence(listOf(warnings))}; Alexa+ goes by tool names and descriptions.`);
  const count = tools.length === 1 ? "1 tool" : `${tools.length} tools`;
  return judge(rule, "PASS", `The server lists ${count}, each with a name, a description and an object inputSchema.`);
}

/** The round trips Amazon's budget covers: initialize, listing, reading screens and calling tools. */
function latency(e: Evidence): RuleResult {
  const rule = RULES.latency;
  const timed = [e.init, ...e.listings, ...callExchanges(e), ...e.otherCalls, ...e.screens.map((s) => s.exchange)].filter(
    (x) => x.outcome.kind !== "network" && !(isRefusal(x) && !e.withToken),
  );
  if (!timed.length) return judge(rule, "SKIP", "No round trips were timed.");
  const sorted = [...timed].sort((a, b) => a.durationMs - b.durationMs);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]!.durationMs : (sorted[mid - 1]!.durationMs + sorted[mid]!.durationMs) / 2;
  const slowest = sorted.at(-1)!;
  const ms = (n: number) => `${Math.round(n)} ms`;
  const over = timed.filter((x) => x.durationMs >= LATENCY_BUDGET_MS).length;
  const trips = `${timed.length} round trip${timed.length === 1 ? "" : "s"}`;
  if (median >= LATENCY_BUDGET_MS) {
    return judge(rule, "FAIL", `Median ${ms(median)}, at or over the ${LATENCY_BUDGET_MS} ms budget; slowest ${ms(slowest.durationMs)} (${slowest.label}); ${over} of ${trips} over.`);
  }
  if (slowest.durationMs >= LATENCY_BUDGET_MS) {
    // Each slow request by name, slowest first, so the one to fix is plain.
    const slow = [...new Set(sorted.filter((x) => x.durationMs >= LATENCY_BUDGET_MS).reverse().map((x) => `${x.label} ${ms(x.durationMs)}`))];
    return judge(rule, "WARN", `Median ${ms(median)}, but ${over} of ${trips} took ${LATENCY_BUDGET_MS} ms or more; slowest ${ms(slowest.durationMs)} (${slowest.label}). Over: ${listOf(slow)}.`);
  }
  return judge(rule, "PASS", `Median ${ms(median)}, slowest ${ms(slowest.durationMs)} (${slowest.label}), over ${trips}.`);
}

/** What one call showed, for a rule that weighs several. */
interface Finding {
  status: RuleStatus;
  /** For a pass, the call's label; otherwise a clause, like "the call to get_forecast failed: ...". */
  note: string;
}

const LIST_FAILED = "The tools/list request didn't succeed, so no tool was called.";

function notesOf(findings: Finding[], status: RuleStatus): string[] {
  return findings.filter((f) => f.status === status).map((f) => f.note);
}

/** Clauses as sentences, up to four, so a note stays readable however many calls went wrong. */
function sentences(clauses: string[], max = 4): string {
  const shown = clauses.slice(0, max).map((clause) => `${sentence(clause)}.`);
  if (clauses.length > max) shown.push(`And ${clauses.length - max} more.`);
  return shown.join(" ");
}

/** The listed calls that weren't made because the server doesn't list their tools. */
function unknownNote(e: Evidence): string {
  if (!e.unknown.length) return "";
  return ` Not called, since the server doesn't list ${e.unknown.length === 1 ? "it" : "them"}: ${listOf(e.unknown)}.`;
}

/** Why no call was judged, and what would change that. */
function nothingCalled(e: Evidence): string {
  const why =
    "No tool is marked read-only (annotations.readOnlyHint) with no required arguments, so none was called; the check never calls a tool that might change something unless you list the call.";
  const how = e.listed ? "" : " To check tools that need arguments, give it sample calls with --calls.";
  return `${why}${how}${unknownNote(e)}`;
}

function firstText(result: JsonObject): string | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  const block = content.find((c) => isObject(c) && c.type === "text" && typeof c.text === "string" && c.text.trim());
  return isObject(block) ? (block.text as string) : undefined;
}

function resultFinding({ first: exchange, label }: JudgedCall, withToken: boolean): Finding {
  if (exchange.outcome.kind !== "result") return { status: "FAIL", note: `the call to ${label} failed: ${describe(exchange, withToken)}` };
  const result = resultOf(exchange);
  if (!result) return { status: "FAIL", note: `the call to ${label} returned a result that isn't an object` };
  const text = firstText(result);
  if (result.isError === true) return { status: "FAIL", note: `the call to ${label} reported an error${text ? `: ${clip(text, 100)}` : ""}` };
  const structured = result.structuredContent !== undefined && result.structuredContent !== null;
  if (text && structured) return { status: "PASS", note: label };
  if (text) return { status: "WARN", note: `the call to ${label} returned text content but no structuredContent` };
  if (structured) return { status: "WARN", note: `the call to ${label} returned structuredContent but no text content block` };
  return { status: "FAIL", note: `the call to ${label} returned neither text content nor structuredContent` };
}

/** Each judged call's result (the check's own pick and every listed call), named in the notes. */
function toolResults(e: Evidence): RuleResult {
  const rule = RULES.toolResults;
  if (!e.tools) return judge(rule, "SKIP", LIST_FAILED);
  if (!e.judged.length) return judge(rule, "SKIP", nothingCalled(e));
  const refused = e.withToken ? undefined : e.judged.find((call) => isRefusal(call.first));
  if (refused) return judge(rule, "SKIP", signInNote(`tools/call ${refused.label}`, refused.first.status));
  const findings = e.judged.map((call) => resultFinding(call, e.withToken));
  const failures = notesOf(findings, "FAIL");
  const warnings = notesOf(findings, "WARN");
  const unknown = unknownNote(e);
  const both = "Amazon's documented tool result has both.";
  const warned = warnings.length === 1 ? `${sentence(warnings[0]!)}; ${both}` : `${sentences(warnings)} ${both}`;
  if (failures.length) return judge(rule, "FAIL", `${sentences(failures)}${warnings.length ? ` ${warned}` : ""}${unknown}`);
  if (warnings.length) return judge(rule, "WARN", `${warned}${unknown}`);
  const passed = notesOf(findings, "PASS");
  const pass =
    passed.length === 1
      ? `The call to ${passed[0]} returned text content and structuredContent.`
      : `Each call returned text content and structuredContent: ${listOf(passed)}.`;
  return judge(rule, "PASS", `${pass}${unknown}`);
}

function errorHandling(e: Evidence): RuleResult {
  const rule = RULES.errors;
  const { exchange } = e.missingTool!;
  const what = "A call to a tool that doesn't exist";
  if (!e.withToken && isRefusal(exchange)) return judge(rule, "SKIP", signInNote("tools/call", exchange.status));
  if (exchange.status !== undefined && exchange.status >= 500) {
    return judge(rule, "FAIL", `${what} was answered with HTTP ${exchange.status}, which Alexa+ can't recover from.`);
  }
  const outcome = exchange.outcome;
  if (outcome.kind === "error") return judge(rule, "PASS", `${what} was answered with ${describe(exchange, e.withToken)}.`);
  const result = resultOf(exchange);
  if (result?.isError === true) return judge(rule, "PASS", `${what} was answered with an error result (isError).`);
  if (outcome.kind === "result") return judge(rule, "FAIL", `${what} was answered as if it had worked.`);
  if (outcome.kind === "timeout") return judge(rule, "FAIL", `${what} got ${outcome.message}.`);
  return judge(rule, "FAIL", `${what} was answered with ${describe(exchange, e.withToken)}, not a JSON-RPC error.`);
}

/** Paths where two JSON values differ, like "content[0].text". */
export function differences(a: unknown, b: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= 50) return out;
  if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences(a[key], b[key], path ? `${path}.${key}` : key, out);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) differences(a[i], b[i], `${path}[${i}]`, out);
  } else if (!Object.is(a, b)) {
    out.push(path || "the whole result");
  }
  return out;
}

function repeatFinding(call: JudgedCall, withToken: boolean): Finding {
  const first = usableResult(call.first);
  if (!first || !call.repeat) return { status: "SKIP", note: `the first call to ${call.label} didn't succeed (see DL-05), so there was nothing to compare` };
  if (call.repeat.outcome.kind !== "result") return { status: "FAIL", note: `repeating the call to ${call.label} failed: ${describe(call.repeat, withToken)}` };
  const paths = differences(first, call.repeat.outcome.result);
  if (!paths.length) return { status: "PASS", note: call.label };
  return { status: "WARN", note: `two calls to ${call.label} with the same arguments returned different results, at ${listOf(paths)}` };
}

/** The judged calls to read-only tools, each made twice; a call that might change something is never repeated. */
function repeatedCalls(e: Evidence): RuleResult {
  const rule = RULES.idempotency;
  if (!e.tools) return judge(rule, "SKIP", LIST_FAILED);
  const readOnly = e.judged.filter((call) => call.readOnly);
  if (!readOnly.length) {
    if (!e.judged.length) return judge(rule, "SKIP", nothingCalled(e));
    return judge(
      rule,
      "SKIP",
      "None of the calls made was to a tool marked read-only (annotations.readOnlyHint), so none was repeated: the check only repeats a call that can't change anything. List a call to a read-only tool with --calls to check one.",
    );
  }
  const refusal = e.withToken ? undefined : readOnly.flatMap((call) => [call.first, ...(call.repeat ? [call.repeat] : [])]).find(isRefusal);
  if (refusal) return judge(rule, "SKIP", signInNote(refusal.label, refusal.status));
  const findings = readOnly.map((call) => repeatFinding(call, e.withToken));
  const problems = [...notesOf(findings, "FAIL"), ...notesOf(findings, "WARN")];
  const passed = notesOf(findings, "PASS");
  const uncompared = notesOf(findings, "SKIP");
  if (!problems.length && !passed.length) return judge(rule, "SKIP", sentences(uncompared));
  const n = uncompared.length;
  const tail = n && findings.length > 1 ? ` ${n === 1 ? "One call wasn't" : `${n} calls weren't`} compared, since the first try didn't succeed (see DL-05).` : "";
  if (problems.length) {
    const others = passed.length ? ` ${passed.length === 1 ? "The other repeated call" : `The other ${passed.length} repeated calls`} returned the same result.` : "";
    return judge(rule, findings.some((f) => f.status === "FAIL") ? "FAIL" : "WARN", `${sentences(problems)}${others}${tail}`);
  }
  const pass =
    passed.length === 1
      ? `Two calls to ${passed[0]} with the same arguments returned the same result.`
      : `Each read-only call, made twice with the same arguments, returned the same result: ${listOf(passed)}.`;
  return judge(rule, "PASS", `${pass}${tail}`);
}

function screens(e: Evidence): RuleResult {
  const rule = RULES.screens;
  if (!e.tools) return judge(rule, "SKIP", "The tools/list request didn't succeed, so no screens were found.");
  if (!e.screens.length) {
    return judge(rule, "SKIP", "No tool declares a screen (_meta.ui.resourceUri), so Alexa+ uses its data-only flow.");
  }
  const refused = e.screens.find((s) => !e.withToken && isRefusal(s.exchange));
  if (refused) return judge(rule, "SKIP", signInNote(`resources/read ${refused.uri}`, refused.exchange.status));
  const problems: string[] = [];
  const found: string[] = [];
  for (const { uri, exchange } of e.screens) {
    const result = resultOf(exchange);
    if (!result) {
      problems.push(`screen ${uri} couldn't be read: ${exchange.outcome.kind === "result" ? "a result that isn't an object" : describe(exchange, e.withToken)}`);
      continue;
    }
    const contents = Array.isArray(result.contents) ? result.contents.filter(isObject) : [];
    if (!contents.length) {
      problems.push(`screen ${uri} came back with no contents`);
      continue;
    }
    const html = contents.find((c) => mediaType(typeof c.mimeType === "string" ? c.mimeType : "") === "text/html");
    if (!html) {
      const types = contents.map((c) => (typeof c.mimeType === "string" ? c.mimeType : "no mimeType"));
      problems.push(`screen ${uri} is ${[...new Set(types)].join(", ")}, not HTML`);
      continue;
    }
    const body = typeof html.text === "string" ? html.text : typeof html.blob === "string" ? html.blob : "";
    if (!body.trim()) {
      problems.push(`screen ${uri} is empty`);
      continue;
    }
    found.push(`${uri} (${html.mimeType})`);
  }
  if (problems.length) return judge(rule, "FAIL", `${sentence(listOf(problems))}.`);
  return judge(rule, "PASS", `${found.length === 1 ? "The screen" : `All ${found.length} screens`} returned HTML: ${listOf(found)}.`);
}

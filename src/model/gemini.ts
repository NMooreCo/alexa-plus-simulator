import type { ModelTurnRequest } from "../shared/contract.ts";
import { systemBlocks } from "./prompt.ts";
import { type Answer, explained, type FetchLike, type ModelReply, type Provider, type ReplyBlock, send, TurnError } from "./provider.ts";
import { count, inputNote, isRecord, messageReply, newId, type Part, readHistory, spoken, toolInput } from "./translate.ts";

/**
 * Google's Gemini API, through generateContent with function calling. (Google
 * now calls generateContent legacy but fully supported, and launches new
 * features on its Interactions API first.) Vertex AI's Gemini needs Google
 * Cloud sign-in rather than an API key, so it isn't here; a gateway in front of
 * it can stand in through GOOGLE_GEMINI_BASE_URL.
 */

/**
 * Gemini 3.8 Flash: Google's newest stable Flash model, with parallel function
 * calling, and one of the two its models page recommends for new projects
 * (3.5 Flash-Lite is the other, faster and less capable). From
 * https://ai.google.dev/gemini-api/docs/models and the function calling guide,
 * https://ai.google.dev/gemini-api/docs/generate-content/function-calling
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";

/** Room for a short spoken answer and its tool calls, with the thinking that counts toward the same limit. */
const MAX_OUTPUT_TOKENS = 8192;

export interface GeminiOptions {
  /** GOOGLE_API_KEY or GEMINI_API_KEY; Google's own libraries take GOOGLE_API_KEY when both are set. */
  apiKey?: string;
  /** GOOGLE_GEMINI_BASE_URL, as Gemini CLI reads it: the API's root, for a proxy or gateway. */
  baseURL?: string;
}

export function hasGeminiCredentials(options: GeminiOptions = {}): boolean {
  return Boolean(options.apiKey);
}

/** Where generateContent is for a model, under the base URL (which may end in a slash). */
export function geminiEndpoint(baseURL: string | undefined, model: string): URL {
  const base = baseURL?.trim() || GEMINI_BASE_URL;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`GOOGLE_GEMINI_BASE_URL isn't a URL: ${base}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`GOOGLE_GEMINI_BASE_URL needs to be an http or https URL, not ${base}`);
  // The API names models "models/<id>", so an id given that way works too.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/v1beta/models/${encodeURIComponent(model.replace(/^models\//, ""))}:generateContent`;
  return url;
}

/**
 * The least thinking that still suits a spoken answer. Gemini 3 and later take
 * a thinking level, and "low" is the lowest every current one allows (3.8 Flash
 * and Gemini 4 refuse "minimal"). Gemini 2.5 refuses a level (it takes a token
 * budget instead), so it, like any model that isn't Gemini, keeps its own default.
 * From https://ai.google.dev/gemini-api/docs/generate-content/thinking
 */
export function thinkingLevel(model: string): "low" | undefined {
  return /^(models\/)?gemini-([3-9]|\d{2,})/i.test(model) ? "low" : undefined;
}

/**
 * Gemini's function names start with a letter or an underscore, and the page's
 * may start with a digit or a dash: those get an underscore in front (as Gemini
 * CLI does for MCP tools), and a reply's calls get their names back.
 */
class FunctionNames {
  private readonly toGemini = new Map<string, string>();
  private readonly toPage = new Map<string, string>();

  constructor(names: string[]) {
    const taken = new Set(names);
    for (const name of names) {
      if (/^[A-Za-z_]/.test(name)) continue;
      let fitted = `_${name}`;
      while (taken.has(fitted)) fitted = `_${fitted}`;
      taken.add(fitted);
      this.toGemini.set(name, fitted);
      this.toPage.set(fitted, name);
    }
  }

  gemini(name: string): string {
    return this.toGemini.get(name) ?? (/^[A-Za-z_]/.test(name) ? name : `_${name}`);
  }

  page(name: string): string {
    return this.toPage.get(name) ?? name;
  }
}

/** JSON Schema's words about the schema itself, which tell the model nothing; Gemini counts the declarations as input. */
const ABOUT_THE_SCHEMA = ["$schema", "$id", "$comment"];

/**
 * A tool's input schema as Gemini's parametersJsonSchema takes it. Gemini's
 * other field, `parameters`, takes only an OpenAPI subset and refuses much of
 * what MCP schemas use ($schema, additionalProperties, $ref, open-ended
 * objects); parametersJsonSchema takes JSON Schema, and it's what Google's own
 * MCP client (Gemini CLI) sends MCP schemas through, unchanged. So the clean-up
 * is small: the schema's words about itself go, and a tool that takes no
 * arguments sends no schema, as the API documents for one.
 */
export function geminiParameters(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;
  const cleaned = Object.fromEntries(Object.entries(schema).filter(([key]) => !ABOUT_THE_SCHEMA.includes(key)));
  const named = isRecord(cleaned.properties) && Object.keys(cleaned.properties).length > 0;
  const open = (cleaned.additionalProperties !== undefined && cleaned.additionalProperties !== false) || isRecord(cleaned.patternProperties);
  return named || open ? cleaned : undefined;
}

/** Ids the route gave calls that came from Gemini without one: they go back without an id, as they came. */
const OWN_ID = "simcall_";

type GeminiPart =
  | { text: string; thoughtSignature?: string }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; id?: string; response: { output: string } | { error: string } } };

export interface GeminiRequest {
  systemInstruction: { parts: { text: string }[] };
  contents: { role: "user" | "model"; parts: GeminiPart[] }[];
  tools?: { functionDeclarations: { name: string; description?: string; parametersJsonSchema?: Record<string, unknown> }[] }[];
  generationConfig: { maxOutputTokens: number; thinkingConfig?: { thinkingLevel: "low" } };
}

/** The page's turn as a generateContent request. */
export function geminiRequest(turn: ModelTurnRequest, model: string): GeminiRequest {
  const names = new FunctionNames(turn.tools.map((t) => t.name));
  const history = readHistory(turn.messages, turn.tools.length > 0);
  // A function response names its call's function (and its id, when Gemini gave one).
  const calledAs = new Map(history.flatMap((m) => m.parts.flatMap((p) => (p.type === "call" ? [[p.id, p.name] as const] : []))));
  const id = (callId: string) => (callId.startsWith(OWN_ID) ? {} : { id: callId });
  const part = (p: Part): GeminiPart => {
    // A thought signature goes back on the very part it came on, as Gemini requires.
    const signed = p.type !== "result" && p.signature ? { thoughtSignature: p.signature } : {};
    if (p.type === "text") return { text: p.text, ...signed };
    if (p.type === "call") return { functionCall: { name: names.gemini(p.name), args: p.input, ...id(p.id) }, ...signed };
    return { functionResponse: { name: names.gemini(calledAs.get(p.id) ?? "unknown"), ...id(p.id), response: p.isError ? { error: p.text } : { output: p.text } } };
  };
  const declarations = turn.tools.map((t) => {
    const parameters = geminiParameters(t.input_schema);
    return {
      name: names.gemini(t.name),
      ...(typeof t.description === "string" && t.description.trim() ? { description: t.description } : {}),
      ...(parameters ? { parametersJsonSchema: parameters } : {}),
    };
  });
  const level = thinkingLevel(model);
  return {
    // The same text the Claude route sends, what stays the same all session first, so Gemini's own prompt caching can reuse it.
    systemInstruction: { parts: systemBlocks(turn.context).map((b) => ({ text: b.text })) },
    contents: history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: m.parts.map(part) })),
    ...(declarations.length ? { tools: [{ functionDeclarations: declarations }] } : {}),
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}) },
  };
}

const FINISH_REASONS: Record<string, ModelReply["stop_reason"]> = {
  STOP: "end_turn",
  MAX_TOKENS: "max_tokens",
  CONTINUATION: "max_tokens",
  SAFETY: "refusal",
  RECITATION: "refusal",
  LANGUAGE: "refusal",
  BLOCKLIST: "refusal",
  PROHIBITED_CONTENT: "refusal",
  SPII: "refusal",
  IMAGE_SAFETY: "refusal",
  IMAGE_PROHIBITED_CONTENT: "refusal",
  IMAGE_RECITATION: "refusal",
  ESCALATION: "refusal",
  PUP_LIMITED_DISABLED: "refusal",
};

/** The model's output that didn't come out as a reply: saying "Done." over it would hide that, so the page hears it failed and the turn is taken back. */
const UNREADABLE = new Set(["MALFORMED_FUNCTION_CALL", "UNEXPECTED_TOOL_CALL", "MISSING_THOUGHT_SIGNATURE", "MALFORMED_RESPONSE"]);

/** A generateContent answer in the Messages API's shape. `tools` are the turn's tool names, for calls to get their names back. */
export function fromGemini(body: unknown, model: string, tools: string[] = []): ModelReply {
  const b = isRecord(body) ? body : {};
  const names = new FunctionNames(tools);
  const metadata = isRecord(b.usageMetadata) ? b.usageMetadata : {};
  const cached = count(metadata.cachedContentTokenCount);
  const fields = {
    id: typeof b.responseId === "string" && b.responseId ? b.responseId : newId("msg_"),
    model: typeof b.modelVersion === "string" && b.modelVersion ? b.modelVersion : model,
    // Gemini's prompt count includes what came from its cache, and its thinking is billed as output, as Claude's is.
    usage: {
      input_tokens: Math.max(0, count(metadata.promptTokenCount) + count(metadata.toolUsePromptTokenCount) - cached),
      output_tokens: count(metadata.candidatesTokenCount) + count(metadata.thoughtsTokenCount),
      ...(metadata.cachedContentTokenCount !== undefined ? { cache_read_input_tokens: cached } : {}),
    },
  };
  const candidate = Array.isArray(b.candidates) && isRecord(b.candidates[0]) ? b.candidates[0] : undefined;
  if (!candidate) {
    // A prompt Gemini won't answer comes back with no candidates and the reason it was blocked.
    if (isRecord(b.promptFeedback) && typeof b.promptFeedback.blockReason === "string") return messageReply({ ...fields, content: [], stop_reason: "refusal" });
    throw new TurnError(502, "model_error", "Gemini answered without a candidate.");
  }
  const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : "STOP";
  if (finish === "MISSING_THOUGHT_SIGNATURE") throw new TurnError(502, "model_error", "Gemini found a thought signature missing from the conversation (MISSING_THOUGHT_SIGNATURE). Start a new conversation.");
  if (UNREADABLE.has(finish)) throw new TurnError(502, "model_error", `Gemini's reply didn't come out right (${finish}). Try again.`);
  const content: ReplyBlock[] = [];
  const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  for (const p of parts) {
    // Thought summaries come only when asked for, and they aren't for saying aloud.
    if (!isRecord(p) || p.thought === true) continue;
    const signed = typeof p.thoughtSignature === "string" && p.thoughtSignature ? { thought_signature: p.thoughtSignature } : {};
    if (typeof p.text === "string") {
      const text = spoken(p.text);
      if (text) content.push({ type: "text", text, ...signed });
    } else if (isRecord(p.functionCall) && typeof p.functionCall.name === "string" && p.functionCall.name) {
      const name = names.page(p.functionCall.name);
      const { input, problem } = toolInput(p.functionCall.args);
      if (problem) content.push(inputNote(name, problem));
      const id = typeof p.functionCall.id === "string" && p.functionCall.id ? p.functionCall.id : newId(OWN_ID);
      content.push({ type: "tool_use", id, name, input, ...signed });
    }
  }
  return messageReply({ ...fields, content, stop_reason: FINISH_REASONS[finish] ?? "end_turn" });
}

/**
 * A failed generateContent call as one of the route's errors. Google's errors
 * say { error: { code, message, status, details } }; a key Gemini doesn't take
 * comes back as a 400 whose details give the reason API_KEY_INVALID.
 */
export function geminiError({ status, body, text }: Answer): TurnError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const said = typeof error.message === "string" ? error.message : text.slice(0, 300);
  const state = (typeof error.status === "string" ? error.status : typeof error.code === "string" ? error.code : "").toUpperCase();
  const reasons = Array.isArray(error.details) ? error.details.flatMap((d) => (isRecord(d) && typeof d.reason === "string" ? [d.reason] : [])) : [];
  // An account Gemini won't serve (no key, a key it doesn't take, billing or a country it isn't offered in) is the key's problem to the page.
  const account = status === 401 || status === 402 || status === 403 || ["UNAUTHENTICATED", "PERMISSION_DENIED", "FAILED_PRECONDITION"].includes(state) || reasons.some((r) => r.startsWith("API_KEY"));
  if (account) return new TurnError(502, "model_key", explained("Gemini didn't accept the API key (or it can't use this model)", said));
  if (status === 429) return new TurnError(429, "rate_limited", explained("Gemini is rate limiting this key", said, "Try again in a moment."));
  if (status === 400) return new TurnError(400, "bad_request", explained("Gemini didn't accept the request", said));
  return new TurnError(502, "model_error", explained(`Gemini answered ${status}`, said));
}

export function geminiProvider(options: GeminiOptions & { model: string; fetch?: FetchLike; retryDelayMs?: number }): Provider {
  const endpoint = geminiEndpoint(options.baseURL, options.model);
  const fetchFn = options.fetch ?? fetch;
  const label = `Gemini (${options.model})`;
  return {
    label,
    summary: options.baseURL ? `${label}, through ${endpoint.origin}` : label,
    async turn(turn, signal) {
      const body = JSON.stringify(geminiRequest(turn, options.model));
      const headers = { "content-type": "application/json", accept: "application/json", "x-goog-api-key": options.apiKey ?? "" };
      const answer = await send(() => fetchFn(endpoint, { method: "POST", headers, body, signal }), "Gemini", signal, options.retryDelayMs);
      if (answer.status < 200 || answer.status > 299) throw geminiError(answer);
      return fromGemini(answer.body, options.model, turn.tools.map((t) => t.name));
    },
  };
}

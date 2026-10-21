import type { ModelTurnRequest } from "../shared/contract.ts";
import { systemBlocks } from "./prompt.ts";
import { type Answer, explained, type FetchLike, type ModelReply, type Provider, type ReplyBlock, send, TurnError } from "./provider.ts";
import { count, inputNote, isRecord, type Message, messageReply, newId, readHistory, spoken, toolInput } from "./translate.ts";

/**
 * OpenAI's Chat Completions API, which many other servers speak too (Azure
 * OpenAI, Ollama, LM Studio, Groq and more), at OPENAI_BASE_URL.
 */

/**
 * GPT-6 Sol: of OpenAI's current models, the newest that calls functions
 * through Chat Completions, with reasoning_effort "none". The flagship, GPT-6
 * Astra, and GPT-6.1 Sol call tools only through the Responses API. From
 * OpenAI's model page and latest-model guide:
 * https://developers.openai.com/api/docs/models/gpt-6-sol
 * https://developers.openai.com/api/docs/guides/latest-model
 */
export const DEFAULT_OPENAI_MODEL = "gpt-6-sol";
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/** Room for a short spoken answer, its tool calls and a reasoning model's low-effort thinking, within what Chat Completions servers generally allow. */
const MAX_COMPLETION_TOKENS = 8192;

export interface OpenAIOptions {
  /** OPENAI_API_KEY. A local server may need none. */
  apiKey?: string;
  /** OPENAI_BASE_URL, for Azure OpenAI or another server that speaks Chat Completions; OpenAI's own otherwise. */
  baseURL?: string;
}

export function hasOpenAICredentials(options: OpenAIOptions = {}): boolean {
  return Boolean(options.apiKey || options.baseURL);
}

/** Where the Chat Completions endpoint is, under the base URL (which may end in a slash, or carry a query an Azure deployment needs). */
export function chatEndpoint(baseURL: string | undefined): URL {
  const base = baseURL?.trim() || OPENAI_BASE_URL;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`OPENAI_BASE_URL isn't a URL: ${base}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`OPENAI_BASE_URL needs to be an http or https URL, not ${base}`);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/chat/completions`;
  return url;
}

/**
 * Low reasoning effort for OpenAI's reasoning models (GPT-6, GPT-5 and the
 * o-series), as the Claude route asks for, so a spoken answer comes quickly.
 * GPT-6 Sol and Luna get "none" instead: it's the only effort with which they
 * call functions through Chat Completions. Any other model (another server's,
 * or a chat model without reasoning) gets no setting, since it may not take one.
 */
export function reasoningEffort(model: string): "none" | "low" | undefined {
  const id = model.toLowerCase();
  if (/^gpt-6-(sol|luna)\b/.test(id)) return "none";
  if (/^(gpt-6|gpt-5|o\d)/.test(id) && !id.includes("chat")) return "low";
  return undefined;
}

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: { type: "function"; function: { name: string; description?: string; parameters: unknown } }[];
  max_completion_tokens: number;
  reasoning_effort?: "none" | "low";
}

function chatMessages(m: Message): ChatMessage[] {
  const text = m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  if (m.role === "assistant") {
    const calls = m.parts.flatMap((p) => (p.type === "call" ? [{ id: p.id, type: "function" as const, function: { name: p.name, arguments: JSON.stringify(p.input) } }] : []));
    return [{ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }];
  }
  // Each result is a message of its own, right after the calls it answers, and then what the person said.
  const results = m.parts.flatMap((p): ChatMessage[] => (p.type === "result" ? [{ role: "tool", tool_call_id: p.id, content: p.isError ? `Error: ${p.text}` : p.text }] : []));
  return [...results, ...(text ? [{ role: "user" as const, content: text }] : [])];
}

/** The page's turn as a Chat Completions request. */
export function chatRequest(turn: ModelTurnRequest, model: string): ChatRequest {
  const effort = reasoningEffort(model);
  return {
    model,
    messages: [
      // One system message (some servers' chat templates take no more), what stays the same all session first, so OpenAI's prompt caching can reuse it.
      { role: "system", content: systemBlocks(turn.context).map((b) => b.text).join("\n\n") },
      ...readHistory(turn.messages, turn.tools.length > 0).flatMap(chatMessages),
    ],
    ...(turn.tools.length
      ? {
          tools: turn.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, ...(typeof t.description === "string" && t.description.trim() ? { description: t.description } : {}), parameters: t.input_schema },
          })),
        }
      : {}),
    max_completion_tokens: MAX_COMPLETION_TOKENS,
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

const FINISH_REASONS: Record<string, ModelReply["stop_reason"]> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

/** A message's text, whether it came as a string or (from some servers) as a list of parts. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((p) => (isRecord(p) && p.type === "text" && typeof p.text === "string" ? p.text : "")).join("");
}

/** A chat completion in the Messages API's shape. `who` names the server in an error. */
export function fromChat(body: unknown, model: string, who = "OpenAI"): ModelReply {
  const b = isRecord(body) ? body : {};
  const choice = Array.isArray(b.choices) && isRecord(b.choices[0]) ? b.choices[0] : undefined;
  const message = choice && isRecord(choice.message) ? choice.message : undefined;
  if (!message) throw new TurnError(502, "model_error", `${capitalized(who)} answered without a message.`);
  const content: ReplyBlock[] = [];
  const refusal = typeof message.refusal === "string" ? message.refusal.trim() : "";
  const text = refusal || spoken(messageText(message.content));
  if (text) content.push({ type: "text", text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    // Only function calls: the route offers no other kind of tool.
    if (!isRecord(call) || !isRecord(call.function) || typeof call.function.name !== "string" || !call.function.name) continue;
    const { input, problem } = toolInput(call.function.arguments);
    if (problem) content.push(inputNote(call.function.name, problem));
    content.push({ type: "tool_use", id: typeof call.id === "string" && call.id ? call.id : newId("call_"), name: call.function.name, input });
  }
  const usage = isRecord(b.usage) ? b.usage : {};
  const details = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const read = count(details.cached_tokens);
  const written = count(details.cache_write_tokens);
  return messageReply({
    id: typeof b.id === "string" && b.id ? b.id : newId("msg_"),
    model: typeof b.model === "string" && b.model ? b.model : model,
    content,
    stop_reason: refusal ? "refusal" : (FINISH_REASONS[typeof choice?.finish_reason === "string" ? choice.finish_reason : ""] ?? "end_turn"),
    // OpenAI counts cached prompt tokens inside prompt_tokens; Anthropic's input_tokens leaves them out, and the page adds them back.
    usage: {
      input_tokens: Math.max(0, count(usage.prompt_tokens) - read - written),
      output_tokens: count(usage.completion_tokens),
      ...(details.cached_tokens !== undefined ? { cache_read_input_tokens: read } : {}),
      ...(details.cache_write_tokens !== undefined ? { cache_creation_input_tokens: written } : {}),
    },
  });
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A failed Chat Completions call as one of the route's errors. */
export function chatError({ status, body, text }: Answer, who = "OpenAI"): TurnError {
  const error = isRecord(body) ? body.error : undefined;
  // OpenAI and most servers say { error: { message } }; some local servers say { error: "..." }.
  const said = isRecord(error) && typeof error.message === "string" ? error.message : typeof error === "string" ? error : text.slice(0, 300);
  const name = capitalized(who);
  if (status === 401 || status === 403) return new TurnError(502, "model_key", explained(`${name} didn't accept the API key (or it can't use this model)`, said));
  if (status === 429) return new TurnError(429, "rate_limited", explained(`${name} is rate limiting this key`, said, "Try again in a moment."));
  // 422 is how some servers built on FastAPI (vLLM, for one) refuse a request.
  if (status === 400 || status === 422) return new TurnError(400, "bad_request", explained(`${name} didn't accept the request`, said));
  return new TurnError(502, "model_error", explained(`${name} answered ${status}`, said));
}

/** One Chat Completions endpoint, and how the simulator names it. */
export interface ChatRoute {
  endpoint: URL;
  /** Sent as a bearer token, as OpenAI and Microsoft Foundry both take a key (and Foundry an Entra ID token); a local server may need none. */
  apiKey?: string;
  model: string;
  /** Who answers, in an error ("OpenAI", "the server at localhost:11434"). */
  who: string;
  label: string;
  summary: string;
  fetch?: FetchLike;
  retryDelayMs?: number;
}

/** Turns through a Chat Completions endpoint: OpenAI's, another server's, or Microsoft Foundry's. */
export function chatProvider(route: ChatRoute): Provider {
  const fetchFn = route.fetch ?? fetch;
  return {
    label: route.label,
    summary: route.summary,
    async turn(turn, signal) {
      const body = JSON.stringify(chatRequest(turn, route.model));
      const headers = { "content-type": "application/json", accept: "application/json", ...(route.apiKey ? { authorization: `Bearer ${route.apiKey}` } : {}) };
      const answer = await send(() => fetchFn(route.endpoint, { method: "POST", headers, body, signal }), route.who, signal, route.retryDelayMs);
      if (answer.status < 200 || answer.status > 299) throw chatError(answer, route.who);
      return fromChat(answer.body, route.model, route.who);
    },
  };
}

export function openaiProvider(options: OpenAIOptions & { model: string; fetch?: FetchLike; retryDelayMs?: number }): Provider {
  const endpoint = chatEndpoint(options.baseURL);
  const own = endpoint.origin === new URL(OPENAI_BASE_URL).origin;
  const label = own ? `OpenAI (${options.model})` : `OpenAI-compatible server at ${endpoint.host} (${options.model})`;
  return chatProvider({
    endpoint,
    apiKey: options.apiKey,
    model: options.model,
    who: own ? "OpenAI" : `the server at ${endpoint.host}`,
    label,
    summary: own ? label : `${label}, through ${endpoint.href}`,
    fetch: options.fetch,
    retryDelayMs: options.retryDelayMs,
  });
}

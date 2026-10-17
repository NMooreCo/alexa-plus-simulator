import Anthropic from "@anthropic-ai/sdk";
import type { ModelTurnRequest } from "../shared/contract.ts";
import type { Route } from "../proxy/index.ts";

/**
 * The simulator's assistant: one Claude turn per request, in the Messages
 * API's shape. The page runs the tool loop (it is the MCP client, so it calls
 * the tools and shows the screens), and the key stays on this machine.
 */

export interface ModelOptions {
  /** ANTHROPIC_API_KEY. Without one the page still works through its Tools panel. */
  apiKey?: string;
  /** ANTHROPIC_BASE_URL, for a gateway that speaks the Claude API. */
  baseURL?: string;
  /** The model id; Claude Opus 5.5 unless set. */
  model?: string;
  /** Anthropic's server-side refusal fallback; on unless turned off (some gateways don't pass it through). */
  fallbacks?: boolean;
  /** For tests: what sends the request. */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

/** How an Alexa+ device talks, for any add-on. The add-on's own instructions come after. */
export const VOICE = `You are the voice of a smart device in someone's home: a simulated Alexa+ on an Amazon Echo, with an add-on (an MCP server) whose tools you can call. What you say is spoken aloud and shown as a caption.

- Speak in plain sentences: no markdown, no bullet points, no emoji, no headings.
- Keep it short, the way Alexa talks: one sentence, two at most, unless they ask for more. A screen carries the detail when there is one.
- Lead with the answer or with what you did. No filler like "Okay" or "Sure", and don't repeat back what they asked.
- Before a tool changes anything (creates, books, buys, sends, deletes or switches something), confirm in one short question first, unless they already asked for exactly that.
- Ask at most one question, and make it the very last thing you say.
- When a tool shows a screen, the screen is already in front of them: say one line about it, not everything on it.
- Lines that start "(On the screen" tell you what someone just did by tapping the display.
- When a tool fails, say plainly what didn't work and offer one next step.
- You help with what the add-on's tools can do. For anything else, say briefly what you can help with.`;

const MAX_BODY = 400_000;
const MAX_MESSAGES = 100;
const MAX_TOOLS = 128;

function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/** The turn, after checking its shape and size; or what's wrong with it. */
function readTurn(raw: string): ModelTurnRequest | string {
  if (raw.length > MAX_BODY) return "That conversation is too long; start a new one.";
  let body: Partial<ModelTurnRequest>;
  try {
    body = JSON.parse(raw) as Partial<ModelTurnRequest>;
  } catch {
    return "Send JSON.";
  }
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > MAX_MESSAGES) return `Send between 1 and ${MAX_MESSAGES} messages; start a new conversation if it's longer.`;
  if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) return `Send at most ${MAX_TOOLS} tools.`;
  for (const t of body.tools) {
    if (!t || typeof t.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name) || typeof t.input_schema !== "object" || t.input_schema === null) {
      return "Each tool needs a name of letters, digits, _ or - (up to 64) and an input schema.";
    }
  }
  return { messages: body.messages, tools: body.tools, context: body.context };
}

/** The system prompt: what stays the same all session (cached), then what changes each turn. */
export function systemBlocks(context: ModelTurnRequest["context"] = {}): Anthropic.Beta.BetaTextBlockParam[] {
  const instructions = clip(context.instructions, 8000).trim();
  const device = clip(context.device, 60).trim();
  return [
    {
      type: "text",
      text: instructions ? `${VOICE}\n\nThe add-on's own instructions:\n${instructions}` : VOICE,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: [
        device ? `This device is an ${device}.` : "",
        context.screen === false
          ? "It has no screen: nothing a tool shows appears here. Say what matters in words (two or three short sentences when a screen would have carried the detail), and never mention a screen, a tab or a tap."
          : "",
        `The time zone is ${clip(context.timeZone, 64) || "unknown"}. It's now ${clip(context.now, 80) || "unknown"}.`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

export function modelRoute(options: ModelOptions): Route {
  const model = options.model?.trim() || DEFAULT_MODEL;
  const client = options.apiKey
    ? new Anthropic({ apiKey: options.apiKey, maxRetries: 1, ...(options.baseURL ? { baseURL: options.baseURL } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) })
    : null;
  return async (request) => {
    if (request.method !== "POST") return error(405, "method", "POST a turn here.");
    if (!client) return error(503, "no_key", "Set ANTHROPIC_API_KEY to talk to the simulator. You can still call tools from the Tools panel.");
    const turn = readTurn(await request.text());
    if (typeof turn === "string") return error(400, "bad_request", turn);
    try {
      const message = await client.beta.messages.create({
        model,
        max_tokens: 16000,
        // Spoken replies: low effort keeps an answer quick.
        output_config: { effort: "low" },
        // A declined request is run again on Anthropic's recommended model for its kind of refusal.
        ...(options.fallbacks === false ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        system: systemBlocks(turn.context),
        tools: turn.tools as Anthropic.Beta.BetaTool[],
        messages: turn.messages as Anthropic.Beta.BetaMessageParam[],
      });
      return Response.json(message, { headers: { "x-model": message.model } });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return error(502, "model_key", "Anthropic didn't accept the API key (or it can't use this model).");
      if (err instanceof Anthropic.RateLimitError) return error(429, "rate_limited", "Anthropic is rate limiting this key. Try again in a moment.");
      if (err instanceof Anthropic.BadRequestError) return error(400, "bad_request", err.message);
      if (err instanceof Anthropic.APIError) return error(502, "model_error", `Anthropic answered ${err.status ?? "with an error"}.`);
      throw err;
    }
  };
}

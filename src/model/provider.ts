import type Anthropic from "@anthropic-ai/sdk";
import type { ModelTurnRequest } from "../shared/contract.ts";

/** What sends a request: fetch, or a test's stand-in. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The route's error codes, each of which the page knows how to explain. */
export type FailureCode = "no_key" | "model_key" | "rate_limited" | "bad_request" | "model_error";

/** A failure the page can explain: the route answers with this status, code and message. */
export class TurnError extends Error {
  constructor(
    readonly status: number,
    readonly code: FailureCode,
    message: string,
  ) {
    super(message);
  }
}

/** A block of a reply: what the model said, or a tool it wants called. */
export type ReplyBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/**
 * A reply in the Messages API's shape, which is what the page reads whichever
 * provider answered. The cache counts are there when the provider reports them,
 * and input_tokens leaves them out, as Anthropic counts it.
 */
export interface ModelReply {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ReplyBlock[];
  stop_reason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/** One provider, set up with its credentials and model. */
export interface Provider {
  /** What the page calls the model, like "Claude (claude-opus-5-5)". */
  label: string;
  /** The CLI's startup line: the model, and where it runs. */
  summary: string;
  /** One turn: the page's request in, a Messages API reply out, or a TurnError. The signal ends when the page stops waiting. */
  turn(turn: ModelTurnRequest, signal: AbortSignal): Promise<ModelReply | Anthropic.Beta.BetaMessage>;
}

/** A provider's answer to one request. */
export interface Answer {
  status: number;
  headers: Headers;
  /** The body as JSON, or undefined when it isn't JSON. */
  body: unknown;
  /** The body as it came, for an error that isn't JSON. */
  text: string;
}

/** Busy (throttled or overloaded) or failing for a moment: worth one more try. */
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
/** Someone is waiting to hear an answer, so a provider that asks for a longer wait gets its error passed on instead. */
const LONGEST_WAIT_MS = 5000;

/**
 * Sends a request, and sends it once more after a pause when the provider was
 * busy or couldn't be reached, as the Anthropic SDK does for the Claude route
 * (maxRetries 1). `request` makes a fresh request each time, so a signed one is
 * signed again. When the page stops waiting, so does this.
 */
export async function send(request: () => Promise<Response>, where: string, signal: AbortSignal, pauseMs = 1000): Promise<Answer> {
  for (let attempt = 1; ; attempt++) {
    let answer: Answer;
    try {
      const res = await request();
      const text = await res.text();
      answer = { status: res.status, headers: res.headers, body: parseJson(text), text };
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt === 1) {
        await pause(pauseMs);
        continue;
      }
      throw new TurnError(502, "model_error", `Couldn't reach ${where}: ${reason(err)}.`);
    }
    if (attempt === 1 && RETRY_STATUSES.has(answer.status) && !signal.aborted) {
      const wait = retryAfter(answer.headers) ?? pauseMs;
      if (wait <= LONGEST_WAIT_MS) {
        await pause(wait);
        continue;
      }
    }
    return answer;
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** How long the provider asked to wait, in milliseconds, if it said. */
function retryAfter(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms !== null && ms.trim() !== "" && Number(ms) >= 0) return Number(ms);
  const value = headers.get("retry-after");
  if (value === null || value.trim() === "") return undefined;
  if (Number(value) >= 0) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * A provider's error for the page to say: the route's own words, then the
 * provider's, which say what to fix (a model without access, a used-up
 * quota), or else `otherwise`. The page speaks it, so it ends like a sentence.
 */
export function explained(ours: string, theirs: string, otherwise = ""): string {
  const said = theirs.trim();
  if (!said) return otherwise ? `${ours}. ${otherwise}` : `${ours}.`;
  return `${ours}: ${/[.!?]$/.test(said) ? said : `${said}.`}`;
}

/** Why fetch failed, from its cause when it has one (like "connect ECONNREFUSED 127.0.0.1:11434"). */
function reason(err: unknown): string {
  const cause = (err as { cause?: { message?: unknown; code?: unknown } } | undefined)?.cause;
  if (typeof cause?.message === "string" && cause.message) return cause.message;
  if (typeof cause?.code === "string") return cause.code;
  return err instanceof Error ? err.message : String(err);
}

import Anthropic from "@anthropic-ai/sdk";
import { systemBlocks } from "./prompt.ts";
import { type FetchLike, type Provider, TurnError } from "./provider.ts";

/**
 * Anthropic's Messages API: the page's turn and the reply are already in its
 * shape, so this one sends the turn as it is and passes Claude's reply back.
 */

/** Claude Opus 5.5. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5-5";

export interface AnthropicOptions {
  /** ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** ANTHROPIC_BASE_URL, for a gateway that speaks the Claude API. */
  baseURL?: string;
  /** Anthropic's server-side refusal fallback; on unless turned off (some gateways don't pass it through). */
  fallbacks?: boolean;
}

export function anthropicProvider(options: AnthropicOptions & { apiKey: string; model: string; fetch?: FetchLike }): Provider {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 1, ...(options.baseURL ? { baseURL: options.baseURL } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  const label = `Claude (${options.model})`;
  return {
    label,
    summary: `${label} through ${options.baseURL ?? "Anthropic"}`,
    async turn(turn) {
      try {
        return await client.beta.messages.create({
          model: options.model,
          max_tokens: 16000,
          // Spoken replies: low effort keeps an answer quick.
          output_config: { effort: "low" },
          // A declined request is run again on Anthropic's recommended model for its kind of refusal.
          ...(options.fallbacks === false ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
          system: systemBlocks(turn.context),
          tools: turn.tools as Anthropic.Beta.BetaTool[],
          messages: turn.messages as Anthropic.Beta.BetaMessageParam[],
        });
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) throw new TurnError(502, "model_key", "Anthropic didn't accept the API key (or it can't use this model).");
        if (err instanceof Anthropic.RateLimitError) throw new TurnError(429, "rate_limited", "Anthropic is rate limiting this key. Try again in a moment.");
        if (err instanceof Anthropic.BadRequestError) throw new TurnError(400, "bad_request", err.message);
        if (err instanceof Anthropic.APIError) throw new TurnError(502, "model_error", `Anthropic answered ${err.status ?? "with an error"}.`);
        throw err;
      }
    },
  };
}

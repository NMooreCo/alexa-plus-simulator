import Anthropic, { type APIError } from "@anthropic-ai/sdk";
import { systemBlocks } from "./prompt.ts";
import { type FetchLike, type Provider, TurnError } from "./provider.ts";

/**
 * Anthropic's Messages API: the page's turn and the reply are already in its
 * shape, so Claude gets the turn as it is and its reply goes back unchanged.
 * Microsoft Foundry serves Claude through the same API (see foundry.ts).
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

/** How one way of reaching Claude sends a turn and names itself. */
export interface ClaudeRoute {
  model: string;
  label: string;
  summary: string;
  /** Anthropic's server-side refusal fallback, which only the Claude API itself offers (not Microsoft Foundry, Bedrock or Vertex). */
  fallbacks: boolean;
  /** What the page hears when a call fails. */
  failure: (err: APIError) => TurnError;
}

/** What a turn needs of an Anthropic client, which Anthropic's own and its Foundry client (which leaves out batches) both have. */
type ClaudeClient = { beta: { messages: Pick<Anthropic["beta"]["messages"], "create"> } };

/** Claude through an Anthropic client: Anthropic's own, or one for a cloud that serves the same API. */
export function claudeProvider(client: ClaudeClient, route: ClaudeRoute): Provider {
  return {
    label: route.label,
    summary: route.summary,
    async turn(turn) {
      try {
        return await client.beta.messages.create({
          model: route.model,
          max_tokens: 16000,
          // Spoken replies: low effort keeps an answer quick.
          output_config: { effort: "low" },
          // A declined request is run again on Anthropic's recommended model for its kind of refusal.
          ...(route.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          system: systemBlocks(turn.context),
          tools: turn.tools as Anthropic.Beta.BetaTool[],
          messages: turn.messages as Anthropic.Beta.BetaMessageParam[],
        });
      } catch (err) {
        if (err instanceof Anthropic.APIError) throw route.failure(err);
        throw err;
      }
    },
  };
}

/** The Claude API's failures, in the words the route has always used for them. */
function anthropicFailure(err: APIError): TurnError {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new TurnError(502, "model_key", "Anthropic didn't accept the API key (or it can't use this model).");
  if (err instanceof Anthropic.RateLimitError) return new TurnError(429, "rate_limited", "Anthropic is rate limiting this key. Try again in a moment.");
  if (err instanceof Anthropic.BadRequestError) return new TurnError(400, "bad_request", err.message);
  return new TurnError(502, "model_error", `Anthropic answered ${err.status ?? "with an error"}.`);
}

export function anthropicProvider(options: AnthropicOptions & { apiKey: string; model: string; fetch?: FetchLike }): Provider {
  const client = new Anthropic({ apiKey: options.apiKey, maxRetries: 1, ...(options.baseURL ? { baseURL: options.baseURL } : {}), ...(options.fetch ? { fetch: options.fetch } : {}) });
  const label = `Claude (${options.model})`;
  return claudeProvider(client, {
    model: options.model,
    label,
    summary: `${label} through ${options.baseURL ?? "Anthropic"}`,
    fallbacks: options.fallbacks !== false,
    failure: anthropicFailure,
  });
}

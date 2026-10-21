import type { APIError } from "@anthropic-ai/sdk";
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import { claudeProvider } from "./anthropic.ts";
import { chatProvider } from "./openai.ts";
import { explained, type FetchLike, type Provider, TurnError } from "./provider.ts";
import { isRecord } from "./translate.ts";

/**
 * Microsoft Foundry, from one resource and one key (or Entra ID token): Claude
 * through Anthropic's Messages API at the resource's /anthropic endpoint, with
 * Anthropic's own Foundry client, and every other model it serves (Azure
 * OpenAI's GPT models, DeepSeek, Llama, Mistral, Grok and more) through its
 * OpenAI-compatible /openai/v1 endpoint. Either way, the model is a deployment's
 * name. From https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry
 * and https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints
 */

/**
 * Claude Opus 5.5 under its default deployment name, which Anthropic's Foundry
 * guide uses throughout; it's hosted on Azure. A deployment named otherwise is
 * --model <deployment name>.
 */
export const DEFAULT_FOUNDRY_MODEL = "claude-opus-5-5";

export type FoundryApi = "anthropic" | "openai";

export interface FoundryOptions {
  /** ANTHROPIC_FOUNDRY_RESOURCE: the resource's name, as in https://{resource}.services.ai.azure.com. */
  resource?: string;
  /** ANTHROPIC_FOUNDRY_BASE_URL, instead of the name: the resource's Claude endpoint, like https://example-resource.services.ai.azure.com/anthropic/. */
  baseURL?: string;
  /** ANTHROPIC_FOUNDRY_API_KEY: the resource's key, which serves all its deployments. */
  apiKey?: string;
  /** AZURE_OPENAI_AUTH_TOKEN, instead of a key: a Microsoft Entra ID token for https://ai.azure.com, which lasts about an hour. */
  token?: string;
  /** --foundry-api: which API the deployment speaks, for a deployment whose name doesn't say. */
  api?: FoundryApi;
}

export function hasFoundryCredentials(options: FoundryOptions = {}): boolean {
  return Boolean((options.resource || options.baseURL) && (options.apiKey || options.token));
}

export function isFoundryApi(value: string): value is FoundryApi {
  return value === "anthropic" || value === "openai";
}

/**
 * Which API a deployment speaks. Claude's default deployment names are its
 * model ids ("claude-opus-5-5"), and a renamed one usually keeps the word, so
 * "claude" anywhere in the name means Claude's API; anything else is the
 * OpenAI-compatible one. --foundry-api settles a name that misleads.
 */
export function foundryApi(model: string, chosen?: FoundryApi): FoundryApi {
  return chosen ?? (/claude/i.test(model) ? "anthropic" : "openai");
}

/** A readable name for a deployment's model, from its name: "DeepSeek" for DeepSeek-V3.2, "OpenAI" for gpt-5.6-sol, and so on. */
export function foundryModelName(deployment: string): string {
  const families: [RegExp, string][] = [
    [/claude/i, "Claude"],
    [/^(gpt|o\d)/i, "OpenAI"],
    [/deepseek/i, "DeepSeek"],
    [/llama/i, "Llama"],
    [/mistral|ministral|codestral|pixtral/i, "Mistral"],
    [/grok/i, "Grok"],
    [/phi/i, "Phi"],
    [/kimi/i, "Kimi"],
    [/qwen/i, "Qwen"],
  ];
  return families.find(([pattern]) => pattern.test(deployment))?.[1] ?? "A model";
}

/** The resource's two endpoints and its host, from its name or its Claude base URL; they go into URLs, so they're checked. */
export function foundryEndpoints(options: FoundryOptions): { host: string; anthropic: string; openai: string } {
  if (options.resource && options.baseURL) throw new Error("Set ANTHROPIC_FOUNDRY_RESOURCE or ANTHROPIC_FOUNDRY_BASE_URL, not both.");
  if (options.resource) {
    // An Azure resource name: letters, digits and dashes, starting and ending with a letter or digit.
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?$/.test(options.resource)) throw new Error(`"${options.resource}" isn't a Foundry resource name (like example-resource).`);
    const host = `${options.resource}.services.ai.azure.com`;
    return { host, anthropic: `https://${host}/anthropic/`, openai: `https://${host}/openai/v1` };
  }
  let url: URL;
  try {
    url = new URL(options.baseURL ?? "");
  } catch {
    throw new Error(`ANTHROPIC_FOUNDRY_BASE_URL isn't a URL: ${options.baseURL}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`ANTHROPIC_FOUNDRY_BASE_URL needs to be an http or https URL, not ${options.baseURL}`);
  return { host: url.host, anthropic: url.href, openai: `${url.origin}/openai/v1` };
}

/** What Foundry said: Anthropic's { error: { message } }, or Azure's { error: { code, message } } from in front of it. */
function said(err: APIError): string {
  const body: unknown = err.error;
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === "string") return body.error.message;
  if (isRecord(body) && typeof body.message === "string") return body.message;
  return err.status === undefined ? err.message : "";
}

/** Claude's failures on Foundry, with what Foundry said: a deployment's name is the usual thing to fix. */
function foundryFailure(err: APIError): TurnError {
  const detail = said(err);
  if (err.status === 401 || err.status === 403) return new TurnError(502, "model_key", explained("Microsoft Foundry didn't accept the credentials (or they can't use this deployment)", detail));
  if (err.status === 429) return new TurnError(429, "rate_limited", explained("Microsoft Foundry is rate limiting these requests", detail, "Try again in a moment."));
  if (err.status === 400) return new TurnError(400, "bad_request", explained("Microsoft Foundry didn't accept the request", detail));
  if (err.status === undefined) return new TurnError(502, "model_error", explained("Couldn't reach Microsoft Foundry", detail));
  return new TurnError(502, "model_error", explained(`Microsoft Foundry answered ${err.status}`, detail));
}

export function foundryProvider(options: FoundryOptions & { model: string; fetch?: FetchLike; retryDelayMs?: number }): Provider {
  const where = foundryEndpoints(options);
  const credential = options.apiKey ? "an API key" : "an Entra ID token";
  if (!options.apiKey && !options.token) throw new Error("Microsoft Foundry needs ANTHROPIC_FOUNDRY_API_KEY or AZURE_OPENAI_AUTH_TOKEN.");
  if (foundryApi(options.model, options.api) === "anthropic") {
    const label = `Claude on Microsoft Foundry (${options.model})`;
    const client = new AnthropicFoundry({
      // Everything is given, even what's empty: the client fills anything left undefined from the ANTHROPIC_FOUNDRY_* variables
      // itself, and two at once (a resource and a base URL) stop it. What the CLI was given decides, and nothing else.
      baseURL: where.anthropic,
      resource: "",
      ...(options.apiKey ? { apiKey: options.apiKey } : { apiKey: "", azureADTokenProvider: async () => options.token ?? "" }),
      maxRetries: 1,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    // Foundry doesn't offer Anthropic's server-side refusal fallback, so it's never asked for.
    return claudeProvider(client, { model: options.model, label, summary: `${label} at ${where.host}, with ${credential}`, fallbacks: false, failure: foundryFailure });
  }
  const label = `${foundryModelName(options.model)} on Microsoft Foundry (${options.model})`;
  return chatProvider({
    endpoint: new URL(`${where.openai}/chat/completions`),
    // Foundry takes the resource's key, or an Entra ID token, as a bearer token on this endpoint.
    apiKey: options.apiKey ?? options.token,
    model: options.model,
    who: "Microsoft Foundry",
    label,
    summary: `${label} at ${where.host}, with ${credential}`,
    fetch: options.fetch,
    retryDelayMs: options.retryDelayMs,
  });
}

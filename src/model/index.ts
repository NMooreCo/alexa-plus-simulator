import type { Route } from "../proxy/index.ts";
import type { ModelTurnRequest } from "../shared/contract.ts";
import { type AnthropicOptions, anthropicProvider, DEFAULT_ANTHROPIC_MODEL } from "./anthropic.ts";
import { type BedrockOptions, bedrockProvider, DEFAULT_BEDROCK_MODEL, hasBedrockCredentials } from "./bedrock.ts";
import { DEFAULT_FOUNDRY_MODEL, type FoundryApi, type FoundryOptions, foundryProvider, hasFoundryCredentials } from "./foundry.ts";
import { DEFAULT_GEMINI_MODEL, type GeminiOptions, geminiProvider, hasGeminiCredentials } from "./gemini.ts";
import { DEFAULT_OPENAI_MODEL, hasOpenAICredentials, type OpenAIOptions, openaiProvider } from "./openai.ts";
import { type FetchLike, type Provider, TurnError } from "./provider.ts";

export { isAwsRegion } from "./bedrock.ts";
export { isFoundryApi } from "./foundry.ts";
export { systemBlocks, VOICE } from "./prompt.ts";

/**
 * The simulator's assistant: one model turn per request, in the Messages
 * API's shape, from Anthropic, Microsoft Foundry, Amazon Bedrock, Google's
 * Gemini or OpenAI (or a server that speaks OpenAI's API). The page runs the
 * tool loop (it is the MCP client, so it calls the tools and shows the
 * screens), and the credentials stay on this machine.
 */

/**
 * In the order they're tried when none is chosen: the providers nearest to
 * what Alexa+ itself runs on (Claude and Amazon Nova) first. Claude through
 * Anthropic, then Claude through Microsoft Foundry (the default there), then
 * Bedrock (Amazon Nova by default), then Gemini, then OpenAI, whose base URL
 * alone (a local server) is the loosest sign that it's wanted.
 */
export const PROVIDERS = ["anthropic", "foundry", "bedrock", "gemini", "openai"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const DEFAULT_MODELS: Record<ProviderName, string> = {
  anthropic: DEFAULT_ANTHROPIC_MODEL,
  foundry: DEFAULT_FOUNDRY_MODEL,
  bedrock: DEFAULT_BEDROCK_MODEL,
  gemini: DEFAULT_GEMINI_MODEL,
  openai: DEFAULT_OPENAI_MODEL,
};

export interface ModelOptions {
  /** Who answers. Without one, the first that has credentials, in the order of PROVIDERS. */
  provider?: ProviderName;
  /** The model id (on Microsoft Foundry, the deployment's name); the provider's default unless set. */
  model?: string;
  anthropic?: AnthropicOptions;
  foundry?: FoundryOptions;
  bedrock?: BedrockOptions;
  gemini?: GeminiOptions;
  openai?: OpenAIOptions;
  /** For tests: what sends each request to the provider. */
  fetch?: FetchLike;
  /** For tests: the pause before a provider is tried again after being busy or out of reach (a second otherwise; Anthropic's SDK keeps its own). */
  retryDelayMs?: number;
}

export interface ModelSetup {
  /** Who answers, or null when none has credentials (so talking is off). */
  provider: ProviderName | null;
  /** The model id, or null when talking is off. */
  model: string | null;
  /** What the page calls the model, like "Claude (claude-opus-5-5)"; null when talking is off. */
  label: string | null;
  /** The CLI's "Model:" line: the provider and model, or how to set one up. */
  summary: string;
  /** POST /api/model. */
  route: Route;
}

const NAMES: Record<ProviderName, string> = { anthropic: "Anthropic", foundry: "Microsoft Foundry", bedrock: "Bedrock", gemini: "Gemini", openai: "OpenAI" };

/** What each provider needs from the environment. */
const NEEDS: Record<ProviderName, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  foundry: "ANTHROPIC_FOUNDRY_API_KEY (or AZURE_OPENAI_AUTH_TOKEN) and ANTHROPIC_FOUNDRY_RESOURCE (or ANTHROPIC_FOUNDRY_BASE_URL)",
  bedrock: "AWS_BEARER_TOKEN_BEDROCK (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)",
  gemini: "GEMINI_API_KEY (or GOOGLE_API_KEY)",
  openai: "OPENAI_API_KEY (or OPENAI_BASE_URL for a server that needs no key)",
};
/** Every provider's, as briefly as each can be set up. */
const ANY =
  "ANTHROPIC_API_KEY; ANTHROPIC_FOUNDRY_API_KEY and ANTHROPIC_FOUNDRY_RESOURCE (Microsoft Foundry); AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (Bedrock); GEMINI_API_KEY; or OPENAI_API_KEY (or OPENAI_BASE_URL for a local server)";

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

function hasCredentials(name: ProviderName, options: ModelOptions): boolean {
  if (name === "anthropic") return Boolean(options.anthropic?.apiKey);
  if (name === "foundry") return hasFoundryCredentials(options.foundry);
  if (name === "bedrock") return hasBedrockCredentials(options.bedrock);
  if (name === "gemini") return hasGeminiCredentials(options.gemini);
  return hasOpenAICredentials(options.openai);
}

/** Who answers: the chosen provider when it has credentials, or the first that does; null when none can. */
export function chooseProvider(options: ModelOptions): ProviderName | null {
  if (options.provider) return hasCredentials(options.provider, options) ? options.provider : null;
  return PROVIDERS.find((name) => hasCredentials(name, options)) ?? null;
}

/** The options from the environment, where the credentials live, and the CLI's flags. */
export function modelOptionsFromEnv(
  env: Record<string, string | undefined>,
  flags: { provider?: ProviderName; model?: string; region?: string; fallbacks?: boolean; foundryApi?: FoundryApi } = {},
): ModelOptions {
  const read = (name: string) => env[name] || undefined;
  return {
    provider: flags.provider,
    model: flags.model,
    anthropic: { apiKey: read("ANTHROPIC_API_KEY"), baseURL: read("ANTHROPIC_BASE_URL"), fallbacks: flags.fallbacks },
    // Anthropic's names for a Foundry resource, as its Foundry client reads them, and Microsoft's for an Entra ID token.
    foundry: {
      resource: read("ANTHROPIC_FOUNDRY_RESOURCE"),
      baseURL: read("ANTHROPIC_FOUNDRY_BASE_URL"),
      apiKey: read("ANTHROPIC_FOUNDRY_API_KEY"),
      token: read("AZURE_OPENAI_AUTH_TOKEN"),
      api: flags.foundryApi,
    },
    // Google's libraries read both names, and GOOGLE_API_KEY wins when both are set.
    gemini: { apiKey: read("GOOGLE_API_KEY") ?? read("GEMINI_API_KEY"), baseURL: read("GOOGLE_GEMINI_BASE_URL") },
    bedrock: {
      region: flags.region ?? read("AWS_REGION") ?? read("AWS_DEFAULT_REGION"),
      bearerToken: read("AWS_BEARER_TOKEN_BEDROCK"),
      accessKeyId: read("AWS_ACCESS_KEY_ID"),
      secretAccessKey: read("AWS_SECRET_ACCESS_KEY"),
      sessionToken: read("AWS_SESSION_TOKEN"),
    },
    openai: { apiKey: read("OPENAI_API_KEY"), baseURL: read("OPENAI_BASE_URL") },
  };
}

/**
 * The model route and what to call its model. It throws for a setting that
 * can't work (an AWS Region, Foundry resource or base URL that isn't one), so
 * the CLI says so at the start rather than on the first turn.
 */
export function setUpModel(options: ModelOptions = {}): ModelSetup {
  const name = chooseProvider(options);
  if (!name) {
    const needs = options.provider ? `${NEEDS[options.provider]} for ${NAMES[options.provider]}` : ANY;
    // The page adds that the Tools tab works without a model, so this says only what to set.
    const message = `Set ${needs} to talk to the simulator.`;
    return { provider: null, model: null, label: null, summary: `none: set ${needs} to talk (the Tools tab works without one)`, route: route(null, message) };
  }
  const model = options.model?.trim() || DEFAULT_MODELS[name];
  const provider = createProvider(name, model, options);
  return { provider: name, model, label: provider.label, summary: provider.summary, route: route(provider, "") };
}

function createProvider(name: ProviderName, model: string, options: ModelOptions): Provider {
  const { fetch, retryDelayMs } = options;
  if (name === "anthropic") return anthropicProvider({ ...options.anthropic, apiKey: options.anthropic?.apiKey ?? "", model, fetch });
  if (name === "foundry") return foundryProvider({ ...options.foundry, model, fetch, retryDelayMs });
  if (name === "bedrock") return bedrockProvider({ ...options.bedrock, model, fetch, retryDelayMs });
  if (name === "gemini") return geminiProvider({ ...options.gemini, model, fetch, retryDelayMs });
  return openaiProvider({ ...options.openai, model, fetch, retryDelayMs });
}

/** The route alone, for a caller that doesn't need its label. */
export function modelRoute(options: ModelOptions): Route {
  return setUpModel(options).route;
}

const MAX_BODY = 400_000;
const MAX_MESSAGES = 100;
const MAX_TOOLS = 128;

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

function failure(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
}

function route(provider: Provider | null, noKey: string): Route {
  return async (request) => {
    if (request.method !== "POST") return failure(405, "method", "POST a turn here.");
    if (!provider) return failure(503, "no_key", noKey);
    const turn = readTurn(await request.text());
    if (typeof turn === "string") return failure(400, "bad_request", turn);
    try {
      const message = await provider.turn(turn, request.signal);
      return Response.json(message, { headers: { "x-model": message.model } });
    } catch (err) {
      if (err instanceof TurnError) return failure(err.status, err.code, err.message);
      throw err;
    }
  };
}

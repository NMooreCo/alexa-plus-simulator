import { AwsClient } from "aws4fetch";
import type { ModelTurnRequest } from "../shared/contract.ts";
import { systemBlocks } from "./prompt.ts";
import { type Answer, explained, type FetchLike, type ModelReply, type Provider, type ReplyBlock, send, TurnError } from "./provider.ts";
import { count, inputNote, isRecord, messageReply, newId, type Part, readHistory, spoken, toolInput } from "./translate.ts";

/**
 * Amazon Bedrock, through the Converse API: one request shape for every
 * Bedrock model that can use tools (Amazon Nova, Claude, Llama, Mistral and
 * more), with a Bedrock API key or IAM credentials.
 */

/**
 * Amazon Nova 2 Lite, the newest generally available Nova, which uses tools
 * through Converse. Its plain id (amazon.nova-2-lite-v1:0) has no in-Region
 * endpoint; the global inference profile serves it from any Region that has
 * it. From the Nova 2 Lite model card:
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-2-lite.html
 */
export const DEFAULT_BEDROCK_MODEL = "global.amazon.nova-2-lite-v1:0";
export const DEFAULT_REGION = "us-east-1";

/** Room for a short spoken answer and its tool calls. Meta's Llama models on Bedrock take no more than 2,048. */
const MAX_TOKENS = 2048;

export interface BedrockOptions {
  /** --region, AWS_REGION or AWS_DEFAULT_REGION; us-east-1 otherwise. */
  region?: string;
  /** AWS_BEARER_TOKEN_BEDROCK: a Bedrock API key, sent as a bearer token. */
  bearerToken?: string;
  /** AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN: IAM credentials, which sign each request (SigV4). */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export function hasBedrockCredentials(options: BedrockOptions = {}): boolean {
  return Boolean(options.bearerToken || (options.accessKeyId && options.secretAccessKey));
}

/** A Region name like us-east-1 or ap-southeast-2; it goes into the endpoint's host name, so nothing else may. */
export function isAwsRegion(value: string): boolean {
  return /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/.test(value);
}

/** A readable name for a Bedrock model id: "Amazon Nova 2 Lite" for (global.)amazon.nova-2-lite-v1:0, "Claude" for an Anthropic model, and so on. */
export function bedrockModelName(id: string): string {
  // The base model's id, without an ARN's path or an inference profile's geography.
  const base = (id.split("/").pop() ?? id).replace(/^(global|us|us-gov|eu|apac|jp|au|ca)\./, "");
  const nova = /^amazon\.nova-(.+?)-v\d/.exec(base);
  if (nova) return `Amazon Nova ${nova[1]!.replace(/(^|-)(\w)/g, (_, dash: string, c: string) => `${dash ? " " : ""}${c.toUpperCase()}`)}`;
  const vendor = /^([a-z0-9-]+)\./.exec(base)?.[1];
  if (!vendor) return "A model";
  return VENDORS[vendor] ?? vendor.charAt(0).toUpperCase() + vendor.slice(1);
}

const VENDORS: Record<string, string> = { anthropic: "Claude", meta: "Llama", mistral: "Mistral", amazon: "Amazon", cohere: "Cohere", deepseek: "DeepSeek", openai: "OpenAI", ai21: "AI21" };

/** Converse's own shapes, as this route sends and reads them. */
type ConverseBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | { toolResult: { toolUseId: string; content: { text: string }[]; status?: "success" | "error" } };

export interface ConverseRequest {
  system: { text: string }[];
  messages: { role: "user" | "assistant"; content: ConverseBlock[] }[];
  inferenceConfig: { maxTokens: number };
  toolConfig?: { tools: { toolSpec: { name: string; description?: string; inputSchema: { json: unknown } } }[] };
}

/**
 * Only Amazon Nova and Claude take a tool result's status, so for any other
 * model a failed tool says so in its text instead. From the ToolResultBlock
 * reference: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolResultBlock.html
 */
function takesStatus(model: string): boolean {
  return /amazon\.nova|anthropic\.claude/.test(model);
}

/**
 * Converse takes tool use ids of letters, digits and _.:- (up to 64). The ids
 * in the conversation came from Bedrock, so they always fit; anything else gets
 * one that does, the same for its call and its result.
 */
class ToolUseIds {
  private readonly made = new Map<string, string>();

  get(id: string): string {
    if (/^[\w.:-]{1,64}$/.test(id)) return id;
    let fitted = this.made.get(id);
    if (!fitted) {
      fitted = `tooluse_sim${this.made.size + 1}`;
      this.made.set(id, fitted);
    }
    return fitted;
  }
}

/** The page's turn as a Converse request. */
export function converseRequest(turn: ModelTurnRequest, model: string): ConverseRequest {
  const ids = new ToolUseIds();
  const status = takesStatus(model);
  const block = (p: Part): ConverseBlock => {
    if (p.type === "text") return { text: p.text };
    if (p.type === "call") return { toolUse: { toolUseId: ids.get(p.id), name: p.name, input: p.input } };
    const text = p.isError && !status ? `Error: ${p.text}` : p.text;
    return { toolResult: { toolUseId: ids.get(p.id), content: [{ text }], ...(status ? { status: p.isError ? ("error" as const) : ("success" as const) } : {}) } };
  };
  return {
    // The same text the Claude route sends: what stays the same all session first, so Bedrock's own prompt caching can reuse it.
    system: systemBlocks(turn.context).map((b) => ({ text: b.text })),
    messages: readHistory(turn.messages, turn.tools.length > 0).map((m) => ({ role: m.role, content: m.parts.map(block) })),
    inferenceConfig: { maxTokens: MAX_TOKENS },
    ...(turn.tools.length
      ? {
          toolConfig: {
            tools: turn.tools.map((t) => ({
              // Converse refuses an empty description, so a tool without one goes without.
              toolSpec: { name: t.name, ...(typeof t.description === "string" && t.description.trim() ? { description: t.description } : {}), inputSchema: { json: t.input_schema } },
            })),
          },
        }
      : {}),
  };
}

const STOP_REASONS: Record<string, ModelReply["stop_reason"]> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  model_context_window_exceeded: "max_tokens",
  guardrail_intervened: "refusal",
  content_filtered: "refusal",
};

/** Converse's answer in the Messages API's shape. */
export function fromConverse(body: unknown, model: string, requestId?: string | null): ModelReply {
  const b = isRecord(body) ? body : {};
  const message = isRecord(b.output) && isRecord(b.output.message) ? b.output.message : undefined;
  if (!message || !Array.isArray(message.content)) throw new TurnError(502, "model_error", "Bedrock answered without a message.");
  const stop = typeof b.stopReason === "string" ? b.stopReason : "end_turn";
  // The model's output didn't parse as a reply; saying "Done." over it would hide that, so the page hears it failed and the turn is taken back.
  if (stop === "malformed_model_output" || stop === "malformed_tool_use") throw new TurnError(502, "model_error", `The model on Bedrock sent a reply that didn't parse (${stop}). Try again.`);
  const content: ReplyBlock[] = [];
  for (const c of message.content) {
    if (!isRecord(c)) continue;
    if (typeof c.text === "string") {
      const text = spoken(c.text);
      if (text) content.push({ type: "text", text });
    } else if (isRecord(c.toolUse) && typeof c.toolUse.name === "string" && c.toolUse.name) {
      const { input, problem } = toolInput(c.toolUse.input);
      if (problem) content.push(inputNote(c.toolUse.name, problem));
      content.push({ type: "tool_use", id: typeof c.toolUse.toolUseId === "string" && c.toolUse.toolUseId ? c.toolUse.toolUseId : newId("tooluse_"), name: c.toolUse.name, input });
    }
    // reasoningContent (a model's reasoning, when it's turned on) and anything else isn't for the page.
  }
  const usage = isRecord(b.usage) ? b.usage : {};
  return messageReply({
    id: requestId ? `msg_${requestId.replaceAll("-", "")}` : newId("msg_"),
    model,
    content,
    stop_reason: STOP_REASONS[stop] ?? "end_turn",
    // With prompt caching, Bedrock's inputTokens already leaves out what was read from or written to the cache, as Anthropic's input_tokens does.
    usage: {
      input_tokens: count(usage.inputTokens),
      output_tokens: count(usage.outputTokens),
      ...(usage.cacheReadInputTokens !== undefined ? { cache_read_input_tokens: count(usage.cacheReadInputTokens) } : {}),
      ...(usage.cacheWriteInputTokens !== undefined ? { cache_creation_input_tokens: count(usage.cacheWriteInputTokens) } : {}),
    },
  });
}

const AUTH_ERRORS = new Set([
  "AccessDeniedException",
  "UnrecognizedClientException",
  "InvalidSignatureException",
  "IncompleteSignature",
  "IncompleteSignatureException",
  "InvalidClientTokenId",
  "ExpiredToken",
  "ExpiredTokenException",
  "MissingAuthenticationToken",
  "MissingAuthenticationTokenException",
  "NotAuthorized",
  "RequestExpired",
  "SignatureDoesNotMatch",
]);
const THROTTLE_ERRORS = new Set(["ThrottlingException", "ServiceQuotaExceededException", "ModelNotReadyException", "TooManyRequestsException"]);

/** Bedrock's exception name, from the x-amzn-ErrorType header ("ValidationException:http://...") or the body's __type. */
function errorType(headers: Headers, body: unknown): string {
  const header = headers.get("x-amzn-errortype");
  if (header) return header.split(":")[0] ?? "";
  const type = isRecord(body) && typeof body.__type === "string" ? body.__type : "";
  return type.split("#").pop() ?? "";
}

/** A failed Converse call as one of the route's errors. */
export function bedrockError({ status, headers, body, text }: Answer): TurnError {
  const type = errorType(headers, body);
  const said = isRecord(body) && typeof body.message === "string" ? body.message : isRecord(body) && typeof body.Message === "string" ? body.Message : text.slice(0, 300);
  if (status === 401 || status === 403 || AUTH_ERRORS.has(type)) return new TurnError(502, "model_key", explained("Bedrock didn't accept the credentials (or they can't use this model)", said));
  if (status === 429 || THROTTLE_ERRORS.has(type)) return new TurnError(429, "rate_limited", explained("Bedrock is throttling these requests", said, "Try again in a moment."));
  if (status === 400 || type === "ValidationException") return new TurnError(400, "bad_request", explained("Bedrock didn't accept the request", said));
  return new TurnError(502, "model_error", explained(`Bedrock answered ${status}${type ? ` (${type})` : ""}`, said));
}

export function bedrockProvider(options: BedrockOptions & { model: string; fetch?: FetchLike; retryDelayMs?: number }): Provider {
  const region = options.region ?? DEFAULT_REGION;
  if (!isAwsRegion(region)) throw new Error(`"${region}" isn't an AWS Region (like us-east-1). Check --region, AWS_REGION and AWS_DEFAULT_REGION.`);
  // Inference profile ids have a colon (us.amazon.nova-pro-v1:0) and ARNs have slashes, so the id is encoded as one path segment.
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(options.model)}/converse`;
  const fetchFn = options.fetch ?? fetch;
  // A Bedrock API key goes as a bearer token. IAM credentials sign each request for the "bedrock" service, as AWS's own SDKs do for bedrock-runtime.
  const signer =
    !options.bearerToken && options.accessKeyId && options.secretAccessKey
      ? new AwsClient({ accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey, sessionToken: options.sessionToken, service: "bedrock", region })
      : undefined;
  if (!options.bearerToken && !signer) throw new Error("Bedrock needs AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.");
  const label = `${bedrockModelName(options.model)} on Bedrock (${options.model})`;
  return {
    label,
    summary: `${label} in ${region}, with ${signer ? "IAM credentials" : "a Bedrock API key"}`,
    async turn(turn, signal) {
      const body = JSON.stringify(converseRequest(turn, options.model));
      const headers = { "content-type": "application/json", accept: "application/json" };
      const answer = await send(
        async () =>
          signer
            ? fetchFn(await signer.sign(url, { method: "POST", headers, body, signal }))
            : fetchFn(url, { method: "POST", headers: { ...headers, authorization: `Bearer ${options.bearerToken}` }, body, signal }),
        "Bedrock",
        signal,
        options.retryDelayMs,
      );
      if (answer.status < 200 || answer.status > 299) throw bedrockError(answer);
      return fromConverse(answer.body, options.model, answer.headers.get("x-amzn-requestid"));
    },
  };
}

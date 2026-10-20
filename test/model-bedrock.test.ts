import { createHash, createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { converseRequest, fromConverse } from "../src/model/bedrock.ts";
import { type ModelOptions, modelRoute } from "../src/model/index.ts";
import { VOICE } from "../src/model/prompt.ts";

/**
 * Bedrock's Converse API, against responses in the shapes its API reference and
 * the Amazon Nova guide document (no live calls: there are no credentials here).
 */

const turn = (body: unknown) => new Request("http://localhost:6277/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  text: string;
  body: Record<string, any>;
}

/** A stand-in for Bedrock that gives each answer in turn (the last one again after that) and keeps what it was sent. */
function bedrock(...answers: (() => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  let next = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const text = await req.text();
    sent.push({ url: req.url, method: req.method, headers: req.headers, text, body: JSON.parse(text) as Record<string, any> });
    return answers[Math.min(next++, answers.length - 1)]!();
  };
  return { sent, fetch };
}

const REQUEST_ID = "5f0d3c6e-7a1b-4c2d-9e8f-0a1b2c3d4e5f";
const ok = (body: unknown) => () => Response.json(body, { headers: { "x-amzn-requestid": REQUEST_ID } });
/** An error the way Bedrock sends one: the exception's name in x-amzn-ErrorType, its message in the body. */
const awsError = (status: number, type: string, message: string, namespace = "com.amazon.bedrock") => () =>
  Response.json({ message }, { status, headers: { "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/${namespace}/`, "x-amzn-requestid": REQUEST_ID } });

/** A text answer, as the Converse API reference shows one. */
const textAnswer = {
  output: { message: { role: "assistant", content: [{ text: "You have three things on today's list." }] } },
  stopReason: "end_turn",
  usage: { inputTokens: 812, outputTokens: 11, totalTokens: 823 },
  metrics: { latencyMs: 412 },
};

/** Two tool calls at once, with the <thinking> Amazon Nova writes around its tool calls, and the cache counts. */
const toolAnswer = {
  output: {
    message: {
      role: "assistant",
      content: [
        { text: "<thinking>They want today's list and the weather, so I'll call show_today and get_weather.</thinking>" },
        { toolUse: { toolUseId: "tooluse_20Z9zl0BQWSXjFuLKdTJcA", name: "show_today", input: {} } },
        { toolUse: { toolUseId: "tooluse_kZJMlvQmRJ6eAyJE5GIl7Q", name: "get_weather", input: { city: "Denver" } } },
      ],
    },
  },
  stopReason: "tool_use",
  usage: { inputTokens: 96, outputTokens: 58, totalTokens: 1178, cacheReadInputTokens: 1024, cacheWriteInputTokens: 0 },
  metrics: { latencyMs: 655 },
};

const context = { instructions: "This server runs a household.", device: "Echo Show 8", screen: true, timeZone: "America/Denver", now: "Tuesday at 7 PM" };
const tools = [
  { name: "show_today", description: "Show today's list", input_schema: { type: "object", properties: {} } },
  { name: "get_weather", description: "", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
];
const ask = (text = "What's on today?") => turn({ messages: [{ role: "user", content: text }], tools, context });
const key: ModelOptions = { bedrock: { bearerToken: "bedrock-api-key" }, retryDelayMs: 0 };

/** A conversation as the page keeps it: Claude-only blocks along the way, two tool calls (one failed), and a new question. */
const history = [
  { role: "user", content: [{ type: "text", text: "(On the screen since you last spoke: tapped Groceries.)" }, { type: "text", text: "What's on my list today?" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Two tools.", signature: "c2ln" },
      { type: "redacted_thinking", data: "cmVkYWN0ZWQ=" },
      { type: "text", text: "Let me look." },
      { type: "tool_use", id: "tooluse_20Z9zl0BQWSXjFuLKdTJcA", name: "show_today", input: {} },
      { type: "tool_use", id: "tooluse_kZJMlvQmRJ6eAyJE5GIl7Q", name: "get_weather", input: { city: "Denver" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "tooluse_kZJMlvQmRJ6eAyJE5GIl7Q", content: "The weather service didn't answer.", is_error: true },
      { type: "tool_result", tool_use_id: "tooluse_20Z9zl0BQWSXjFuLKdTJcA", content: "Milk, eggs, call the vet." },
    ],
  },
  { role: "assistant", content: [{ type: "fallback" }, { type: "text", text: "Milk, eggs and a call to the vet. I couldn't get the weather." }] },
  { role: "user", content: "Add bread." },
];

describe("Bedrock", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the turn to Converse with a Bedrock API key as a bearer token: the system prompt's text, the tools and room for a short answer", async () => {
    const api = bedrock(ok(textAnswer));
    const res = await modelRoute({ ...key, fetch: api.fetch })(ask());
    expect(res.status).toBe(200);
    const sent = api.sent[0]!;
    expect(sent.method).toBe("POST");
    expect(sent.url).toBe("https://bedrock-runtime.us-east-1.amazonaws.com/model/global.amazon.nova-2-lite-v1%3A0/converse");
    expect(sent.headers.get("authorization")).toBe("Bearer bedrock-api-key");
    expect(sent.headers.get("content-type")).toBe("application/json");
    expect(sent.body.system).toHaveLength(2);
    expect(sent.body.system[0].text).toContain(VOICE);
    expect(sent.body.system[0].text).toContain("This server runs a household.");
    expect(sent.body.system[1].text).toContain("Echo Show 8");
    expect(sent.body.inferenceConfig).toEqual({ maxTokens: 2048 });
    expect(sent.body.messages).toEqual([{ role: "user", content: [{ text: "What's on today?" }] }]);
    expect(sent.body.toolConfig.tools).toEqual([
      { toolSpec: { name: "show_today", description: "Show today's list", inputSchema: { json: { type: "object", properties: {} } } } },
      // Converse refuses an empty description, so it's left out.
      { toolSpec: { name: "get_weather", inputSchema: { json: tools[1]!.input_schema } } },
    ]);
    // Anthropic's cache marker means nothing to Converse.
    expect(sent.text).not.toContain("cache_control");
  });

  it("answers a text reply in the Messages API's shape", async () => {
    const res = await modelRoute({ ...key, fetch: bedrock(ok(textAnswer)).fetch })(ask());
    expect(res.headers.get("x-model")).toBe("global.amazon.nova-2-lite-v1:0");
    expect(await res.json()).toEqual({
      id: "msg_5f0d3c6e7a1b4c2d9e8f0a1b2c3d4e5f",
      type: "message",
      role: "assistant",
      model: "global.amazon.nova-2-lite-v1:0",
      content: [{ type: "text", text: "You have three things on today's list." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 812, output_tokens: 11 },
    });
  });

  it("turns several tool calls into tool_use blocks, leaves Nova's thinking unsaid and reports the cache", async () => {
    const res = await modelRoute({ ...key, fetch: bedrock(ok(toolAnswer)).fetch })(ask("What's on today, and the weather?"));
    expect(await res.json()).toMatchObject({
      content: [
        { type: "tool_use", id: "tooluse_20Z9zl0BQWSXjFuLKdTJcA", name: "show_today", input: {} },
        { type: "tool_use", id: "tooluse_kZJMlvQmRJ6eAyJE5GIl7Q", name: "get_weather", input: { city: "Denver" } },
      ],
      stop_reason: "tool_use",
      // Converse's inputTokens already leaves the cache out, as Anthropic's input_tokens does.
      usage: { input_tokens: 96, output_tokens: 58, cache_read_input_tokens: 1024, cache_creation_input_tokens: 0 },
    });
  });

  it("carries the whole conversation: calls with their ids, each result right after (failures marked), Claude's own blocks left out", async () => {
    const api = bedrock(ok(textAnswer));
    await modelRoute({ ...key, model: "us.amazon.nova-pro-v1:0", fetch: api.fetch })(turn({ messages: history, tools, context }));
    expect(api.sent[0]!.body.messages).toEqual([
      { role: "user", content: [{ text: "(On the screen since you last spoke: tapped Groceries.)" }, { text: "What's on my list today?" }] },
      {
        role: "assistant",
        content: [
          { text: "Let me look." },
          { toolUse: { toolUseId: "tooluse_20Z9zl0BQWSXjFuLKdTJcA", name: "show_today", input: {} } },
          { toolUse: { toolUseId: "tooluse_kZJMlvQmRJ6eAyJE5GIl7Q", name: "get_weather", input: { city: "Denver" } } },
        ],
      },
      {
        role: "user",
        // In the order of the calls, with Nova's status for each.
        content: [
          { toolResult: { toolUseId: "tooluse_20Z9zl0BQWSXjFuLKdTJcA", content: [{ text: "Milk, eggs, call the vet." }], status: "success" } },
          { toolResult: { toolUseId: "tooluse_kZJMlvQmRJ6eAyJE5GIl7Q", content: [{ text: "The weather service didn't answer." }], status: "error" } },
        ],
      },
      { role: "assistant", content: [{ text: "Milk, eggs and a call to the vet. I couldn't get the weather." }] },
      { role: "user", content: [{ text: "Add bread." }] },
    ]);
  });

  it("tells a model that doesn't take a result's status that a tool failed in the result's text", () => {
    const request = converseRequest({ messages: history, tools, context }, "meta.llama3-3-70b-instruct-v1:0");
    const results = request.messages[2]!.content;
    expect(results).toEqual([
      { toolResult: { toolUseId: "tooluse_20Z9zl0BQWSXjFuLKdTJcA", content: [{ text: "Milk, eggs, call the vet." }] } },
      { toolResult: { toolUseId: "tooluse_kZJMlvQmRJ6eAyJE5GIl7Q", content: [{ text: "Error: The weather service didn't answer." }] } },
    ]);
  });

  it("signs with SigV4 for the bedrock service when given IAM credentials, as AWS documents the signature", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T19:30:00Z"));
    const api = bedrock(ok(textAnswer));
    const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "IQoJb3JpZ2luX2VjEXAMPLE" };
    const res = await modelRoute({ bedrock: { ...credentials, region: "eu-west-1" }, model: "eu.amazon.nova-2-lite-v1:0", fetch: api.fetch, retryDelayMs: 0 })(ask());
    expect(res.status).toBe(200);
    const sent = api.sent[0]!;
    expect(sent.url).toBe("https://bedrock-runtime.eu-west-1.amazonaws.com/model/eu.amazon.nova-2-lite-v1%3A0/converse");
    const auth = sent.headers.get("authorization")!;
    expect(auth.startsWith("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261019/eu-west-1/bedrock/aws4_request, ")).toBe(true);
    expect(sent.headers.get("x-amz-date")).toBe("20261019T193000Z");
    expect(sent.headers.get("x-amz-security-token")).toBe(credentials.sessionToken);
    const signed = /SignedHeaders=([^,]+)/.exec(auth)![1]!.split(";");
    expect(signed).toEqual(expect.arrayContaining(["host", "x-amz-date", "x-amz-security-token"]));
    expect(/Signature=([0-9a-f]{64})$/.exec(auth)![1]).toBe(sigV4(sent, credentials.secretAccessKey));
  });

  it("puts the model id in the path as one encoded segment: an inference profile's colon, an ARN's slashes", async () => {
    const api = bedrock(ok(textAnswer));
    await modelRoute({ ...key, model: "us.amazon.nova-pro-v1:0", fetch: api.fetch })(ask());
    await modelRoute({ ...key, model: "arn:aws:bedrock:us-east-1:111122223333:inference-profile/us.anthropic.claude-sonnet-5-5", fetch: api.fetch })(ask());
    expect(new URL(api.sent[0]!.url).pathname).toBe("/model/us.amazon.nova-pro-v1%3A0/converse");
    expect(new URL(api.sent[1]!.url).pathname).toBe("/model/arn%3Aaws%3Abedrock%3Aus-east-1%3A111122223333%3Ainference-profile%2Fus.anthropic.claude-sonnet-5-5/converse");
  });

  it("maps each of Converse's stop reasons to one the page knows", () => {
    const stop = (stopReason: string, content: unknown[] = [{ text: "Here." }]) => fromConverse({ output: { message: { role: "assistant", content } }, stopReason, usage: {} }, "m").stop_reason;
    expect(stop("end_turn")).toBe("end_turn");
    expect(stop("stop_sequence")).toBe("end_turn");
    expect(stop("max_tokens")).toBe("max_tokens");
    expect(stop("model_context_window_exceeded")).toBe("max_tokens");
    expect(stop("guardrail_intervened", [{ text: "Sorry, the model cannot answer this question." }])).toBe("refusal");
    expect(stop("content_filtered")).toBe("refusal");
    expect(stop("tool_use", toolAnswer.output.message.content)).toBe("tool_use");
    // A tool call is what the page waits for, whatever the model said about stopping.
    expect(stop("end_turn", toolAnswer.output.message.content)).toBe("tool_use");
    expect(stop("tool_use", [{ text: "Never mind." }])).toBe("end_turn");
    expect(() => stop("malformed_tool_use")).toThrow(/didn't parse/);
    expect(() => stop("malformed_model_output")).toThrow(/didn't parse/);
  });

  it("says what went wrong: the credentials, throttling, the request, or Bedrock itself", async () => {
    const tryWith = async (...answers: (() => Response | Promise<Response>)[]) => {
      const api = bedrock(...answers);
      const res = await modelRoute({ ...key, fetch: api.fetch })(ask());
      return { status: res.status, error: ((await res.json()) as { error: { code: string; message: string } }).error, tries: api.sent.length };
    };
    const invalid = await tryWith(awsError(403, "UnrecognizedClientException", "The security token included in the request is invalid.", "com.amazon.coral.service"));
    expect(invalid).toMatchObject({ status: 502, error: { code: "model_key" }, tries: 1 });
    expect(invalid.error.message).toContain("The security token included in the request is invalid.");
    const noAccess = await tryWith(awsError(403, "AccessDeniedException", "You don't have access to the model with the specified model ID."));
    expect(noAccess).toMatchObject({ status: 502, error: { code: "model_key" } });
    expect(noAccess.error.message).toContain("You don't have access to the model");
    // Throttled twice: tried once more, then the page hears it.
    const throttled = await tryWith(awsError(429, "ThrottlingException", "Too many requests, please wait before trying again."));
    expect(throttled).toMatchObject({ status: 429, error: { code: "rate_limited" }, tries: 2 });
    const invalidRequest = await tryWith(awsError(400, "ValidationException", "The provided model identifier is invalid."));
    expect(invalidRequest).toMatchObject({ status: 400, error: { code: "bad_request", message: "Bedrock didn't accept the request: The provided model identifier is invalid." }, tries: 1 });
    expect(await tryWith(awsError(400, "ServiceQuotaExceededException", "Your request exceeds the service quota for your account."))).toMatchObject({ status: 429, error: { code: "rate_limited" } });
    const broken = await tryWith(awsError(500, "InternalServerException", "The request processing has failed because of an unknown error."));
    expect(broken).toMatchObject({ status: 502, error: { code: "model_error" }, tries: 2 });
    expect(broken.error.message).toContain("Bedrock answered 500 (InternalServerException)");
    expect(await tryWith(awsError(404, "ResourceNotFoundException", "Model not found."))).toMatchObject({ status: 502, error: { code: "model_error" } });
    const unreachable = await tryWith(() => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com"), { code: "ENOTFOUND" }) })));
    expect(unreachable).toMatchObject({ status: 502, error: { code: "model_error" }, tries: 2 });
    expect(unreachable.error.message).toBe("Couldn't reach Bedrock: getaddrinfo ENOTFOUND bedrock-runtime.us-east-1.amazonaws.com.");
  });

  it("tries a throttled request once more, and answers when that works", async () => {
    const api = bedrock(awsError(429, "ThrottlingException", "Too many requests, please wait before trying again."), ok(textAnswer));
    const res = await modelRoute({ ...key, fetch: api.fetch })(ask());
    expect(res.status).toBe(200);
    expect(api.sent).toHaveLength(2);
  });

  it("refuses a Region that isn't one before it goes into a host name", () => {
    expect(() => modelRoute({ bedrock: { bearerToken: "k", region: "attacker.example/" } })).toThrow(/AWS Region/);
  });
});

/**
 * The SigV4 signature, worked out here from AWS's own description of it rather
 * than by aws4fetch: for every service but S3, each segment of the path the
 * request sends is URI-encoded once more, so the model id's %3A signs as %253A.
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
function sigV4(sent: Sent, secret: string): string {
  const url = new URL(sent.url);
  const auth = sent.headers.get("authorization")!;
  const [, date, region, service] = /Credential=[^/]+\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request/.exec(auth)!;
  const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)![1]!;
  const path = url.pathname
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const headers = signedHeaders
    .split(";")
    .map((name) => `${name}:${name === "host" ? url.host : sent.headers.get(name)!.trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  const canonical = [sent.method, path, url.searchParams.toString(), headers, signedHeaders, sha256(sent.text)].join("\n");
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", sent.headers.get("x-amz-date"), scope, sha256(canonical)].join("\n");
  let signingKey: Buffer = createHmac("sha256", `AWS4${secret}`).update(date!).digest();
  for (const part of [region!, service!, "aws4_request"]) signingKey = createHmac("sha256", signingKey).update(part).digest();
  return createHmac("sha256", signingKey).update(toSign).digest("hex");
}

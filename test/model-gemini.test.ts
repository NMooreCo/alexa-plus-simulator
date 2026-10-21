import { describe, expect, it } from "vitest";
import { fromGemini, geminiParameters, geminiRequest, thinkingLevel } from "../src/model/gemini.ts";
import { type ModelOptions, modelRoute } from "../src/model/index.ts";
import { VOICE } from "../src/model/prompt.ts";
import { TurnError } from "../src/model/provider.ts";

/**
 * Google's Gemini API (generateContent), against responses in the shapes
 * Google's API reference, function calling guide and thought signature guide
 * document, and errors in Google's standard error shape (no live calls: there
 * are no credentials here).
 */

const turn = (body: unknown) => new Request("http://localhost:6277/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** A stand-in for Gemini that gives each answer in turn (the last one again after that) and keeps what it was sent. */
function gemini(...answers: (() => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  let next = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, any> });
    return answers[Math.min(next++, answers.length - 1)]!();
  };
  return { sent, fetch };
}

const ok = (body: unknown) => () => Response.json(body);
/** An error in Google's shape: { error: { code, message, status, details } }. */
const googleError = (code: number, status: string, message: string, details?: unknown[]) => () => Response.json({ error: { code, message, status, ...(details ? { details } : {}) } }, { status: code });

/** A spoken answer, with the thought signature Gemini 3 and later put on a reply's last part, and its cache and thinking counts. */
const textAnswer = {
  candidates: [{ content: { parts: [{ text: "You have three things on today's list.", thoughtSignature: "CiQB0e2Kb3ZpY2Ut" }], role: "model" }, finishReason: "STOP", index: 0 }],
  usageMetadata: {
    promptTokenCount: 1180,
    candidatesTokenCount: 11,
    totalTokenCount: 1305,
    cachedContentTokenCount: 1024,
    thoughtsTokenCount: 114,
    promptTokensDetails: [{ modality: "TEXT", tokenCount: 1180 }],
    cacheTokensDetails: [{ modality: "TEXT", tokenCount: 1024 }],
  },
  modelVersion: "gemini-3.8-flash",
  responseId: "kpTVaNqWBuS1qtsP3-uQgAI",
};

/** Two calls at once: the signature is on the first function call only, as Google's guide says it comes. */
const parallelCalls = {
  candidates: [
    {
      content: {
        role: "model",
        parts: [
          { functionCall: { id: "8f2b1a3c", name: "show_today", args: {} }, thoughtSignature: "Q2FsbHNJblBhcmFsbGVs" },
          { functionCall: { id: "1c9d7e4f", name: "get_weather", args: { city: "Denver" } } },
        ],
      },
      finishReason: "STOP",
      index: 0,
    },
  ],
  usageMetadata: { promptTokenCount: 905, candidatesTokenCount: 34, totalTokenCount: 1003, thoughtsTokenCount: 64 },
  modelVersion: "gemini-3.8-flash",
  responseId: "c2Vjb25kUmVzcG9uc2U",
};

const tools = [
  { name: "show_today", description: "Show today's list", input_schema: { type: "object", properties: {} } },
  { name: "get_weather", description: "The weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
];
const context = { instructions: "This server runs a household.", device: "Echo Show 8", screen: true, timeZone: "America/Denver", now: "Tuesday at 7 PM" };
const ask = (text = "What's on today?") => turn({ messages: [{ role: "user", content: text }], tools, context });
const key: ModelOptions = { gemini: { apiKey: "gemini-key" }, retryDelayMs: 0 };

/** A conversation as the page keeps it after the calls above: the signature rides on the block it came with. */
const history = [
  { role: "user", content: [{ type: "text", text: "What's on today, and the weather?" }] },
  {
    role: "assistant",
    content: [
      { type: "tool_use", id: "8f2b1a3c", name: "show_today", input: {}, thought_signature: "Q2FsbHNJblBhcmFsbGVs" },
      { type: "tool_use", id: "1c9d7e4f", name: "get_weather", input: { city: "Denver" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "1c9d7e4f", content: "The weather service didn't answer.", is_error: true },
      { type: "tool_result", tool_use_id: "8f2b1a3c", content: "Milk, eggs, call the vet." },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "Milk, eggs and a call to the vet. I couldn't get the weather.", thought_signature: "QW5zd2VyU2ln" }] },
  { role: "user", content: "Add bread." },
];

describe("Gemini", () => {
  it("sends the turn to generateContent with the key: the system prompt's text, the tools as function declarations and low thinking", async () => {
    const api = gemini(ok(textAnswer));
    const res = await modelRoute({ ...key, fetch: api.fetch })(ask());
    expect(res.status).toBe(200);
    const sent = api.sent[0]!;
    expect(sent.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    expect(sent.headers.get("x-goog-api-key")).toBe("gemini-key");
    expect(sent.body.systemInstruction.parts).toHaveLength(2);
    expect(sent.body.systemInstruction.parts[0].text).toContain(VOICE);
    expect(sent.body.systemInstruction.parts[1].text).toContain("Echo Show 8");
    expect(sent.body.contents).toEqual([{ role: "user", parts: [{ text: "What's on today?" }] }]);
    expect(sent.body.tools).toEqual([
      {
        functionDeclarations: [
          // No arguments, so no schema, as the API documents for a function without parameters.
          { name: "show_today", description: "Show today's list" },
          { name: "get_weather", description: "The weather", parametersJsonSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
        ],
      },
    ]);
    expect(sent.body.generationConfig).toEqual({ maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: "low" } });
  });

  it("answers a text reply in the Messages API's shape, keeping its thought signature and counting cache and thinking as Claude's are", async () => {
    const res = await modelRoute({ ...key, fetch: gemini(ok(textAnswer)).fetch })(ask());
    expect(res.headers.get("x-model")).toBe("gemini-3.8-flash");
    expect(await res.json()).toEqual({
      id: "kpTVaNqWBuS1qtsP3-uQgAI",
      type: "message",
      role: "assistant",
      model: "gemini-3.8-flash",
      content: [{ type: "text", text: "You have three things on today's list.", thought_signature: "CiQB0e2Kb3ZpY2Ut" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      // 1180 prompt tokens, 1024 of them from the cache; 11 said and 114 thought.
      usage: { input_tokens: 156, output_tokens: 125, cache_read_input_tokens: 1024 },
    });
  });

  it("turns parallel function calls into tool_use blocks with Gemini's ids, the signature on the first, and stops for them", async () => {
    const res = await modelRoute({ ...key, fetch: gemini(ok(parallelCalls)).fetch })(ask("What's on today, and the weather?"));
    expect(await res.json()).toMatchObject({
      content: [
        { type: "tool_use", id: "8f2b1a3c", name: "show_today", input: {}, thought_signature: "Q2FsbHNJblBhcmFsbGVs" },
        { type: "tool_use", id: "1c9d7e4f", name: "get_weather", input: { city: "Denver" } },
      ],
      // Gemini says STOP even when it calls functions; the page runs tools only on tool_use.
      stop_reason: "tool_use",
      usage: { input_tokens: 905, output_tokens: 98 },
    });
  });

  it("carries the whole conversation: each signature back on its own part, the results paired by name and id, failures as errors", async () => {
    const api = gemini(ok(textAnswer));
    await modelRoute({ ...key, fetch: api.fetch })(turn({ messages: history, tools, context }));
    expect(api.sent[0]!.body.contents).toEqual([
      { role: "user", parts: [{ text: "What's on today, and the weather?" }] },
      {
        role: "model",
        parts: [
          { functionCall: { name: "show_today", args: {}, id: "8f2b1a3c" }, thoughtSignature: "Q2FsbHNJblBhcmFsbGVs" },
          { functionCall: { name: "get_weather", args: { city: "Denver" }, id: "1c9d7e4f" } },
        ],
      },
      {
        role: "user",
        // In the calls' order, right after them, never interleaved, as the guide requires.
        parts: [
          { functionResponse: { name: "show_today", id: "8f2b1a3c", response: { output: "Milk, eggs, call the vet." } } },
          { functionResponse: { name: "get_weather", id: "1c9d7e4f", response: { error: "The weather service didn't answer." } } },
        ],
      },
      { role: "model", parts: [{ text: "Milk, eggs and a call to the vet. I couldn't get the weather.", thoughtSignature: "QW5zd2VyU2ln" }] },
      { role: "user", parts: [{ text: "Add bread." }] },
    ]);
  });

  it("gives a function whose name starts with a digit an underscore Gemini accepts, and the reply's call its own name back", () => {
    const printing = [{ name: "3d_print", description: "Print a model", input_schema: { type: "object", properties: { file: { type: "string" } } } }];
    const request = geminiRequest(
      {
        messages: [
          { role: "user", content: "Print the vase." },
          { role: "assistant", content: [{ type: "tool_use", id: "a1", name: "3d_print", input: { file: "vase.stl" } }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "a1", content: "Queued." }] },
        ],
        tools: printing,
      },
      "gemini-3.8-flash",
    );
    expect(request.tools![0]!.functionDeclarations[0]!.name).toBe("_3d_print");
    expect(request.contents[1]!.parts[0]).toEqual({ functionCall: { name: "_3d_print", args: { file: "vase.stl" }, id: "a1" } });
    expect(request.contents[2]!.parts[0]).toMatchObject({ functionResponse: { name: "_3d_print" } });
    const reply = fromGemini({ candidates: [{ content: { role: "model", parts: [{ functionCall: { id: "b2", name: "_3d_print", args: { file: "cup.stl" } } }] }, finishReason: "STOP" }] }, "gemini-3.8-flash", ["3d_print"]);
    expect(reply.content).toEqual([{ type: "tool_use", id: "b2", name: "3d_print", input: { file: "cup.stl" } }]);
  });

  it("gives a call Gemini sent without an id one for the page, and sends it back without one, as it came", () => {
    const reply = fromGemini({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "show_today", args: {} } }] }, finishReason: "STOP" }] }, "gemini-2.5-flash", ["show_today"]);
    const use = reply.content[0] as { type: "tool_use"; id: string };
    expect(use.id).toMatch(/^simcall_[0-9a-f]{32}$/);
    const request = geminiRequest(
      {
        messages: [
          { role: "user", content: "What's on today?" },
          { role: "assistant", content: reply.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "Milk." }] },
        ],
        tools,
      },
      "gemini-2.5-flash",
    );
    expect(request.contents[1]!.parts[0]).toEqual({ functionCall: { name: "show_today", args: {} } });
    expect(request.contents[2]!.parts[0]).toEqual({ functionResponse: { name: "show_today", response: { output: "Milk." } } });
  });

  it("takes an MCP tool's JSON Schema as parametersJsonSchema, dropping only what's about the schema itself", () => {
    // As the MCP TypeScript SDK writes a schema with zod, record and all.
    const zod = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        item: { type: "string", minLength: 1 },
        due: { type: "string", format: "date-time" },
        tags: { type: "array", items: { type: "string" } },
        notes: { type: "object", propertyNames: { type: "string" }, additionalProperties: {} },
      },
      required: ["item"],
      additionalProperties: false,
    };
    const { $schema: _dropped, ...rest } = zod;
    expect(geminiParameters(zod)).toEqual(rest);
    // As Python's FastMCP writes one with pydantic: $defs, $ref, a nullable optional and titles.
    const pydantic = {
      $defs: { Address: { type: "object", properties: { street: { type: "string" } }, required: ["street"], title: "Address" } },
      properties: { to: { $ref: "#/$defs/Address" }, note: { anyOf: [{ type: "string" }, { type: "null" }], default: null, title: "Note" } },
      required: ["to"],
      title: "send_letterArguments",
      type: "object",
    };
    expect(geminiParameters(pydantic)).toEqual(pydantic);
    // No arguments at all, however it's written, is no schema; an open-ended object of arguments is still one.
    expect(geminiParameters({ type: "object" })).toBeUndefined();
    expect(geminiParameters({ type: "object", properties: {}, $schema: "http://json-schema.org/draft-07/schema#" })).toBeUndefined();
    expect(geminiParameters({ type: "object", additionalProperties: { type: "number" } })).toEqual({ type: "object", additionalProperties: { type: "number" } });
    expect(geminiParameters("not a schema")).toBeUndefined();
    // The declaration never uses the `parameters` field, whose OpenAPI subset would refuse $ref and additionalProperties.
    const request = geminiRequest({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "add_item", description: "Add", input_schema: zod }] }, "gemini-3.8-flash");
    expect(request.tools![0]!.functionDeclarations[0]).not.toHaveProperty("parameters");
  });

  it("thinks as little as each model allows: low on Gemini 3 and later, and leaves 2.5 and other models their own setting", () => {
    expect(thinkingLevel("gemini-3.8-flash")).toBe("low");
    expect(thinkingLevel("gemini-3.5-flash-lite")).toBe("low");
    expect(thinkingLevel("models/gemini-4-argon")).toBe("low");
    expect(thinkingLevel("gemini-2.5-flash")).toBeUndefined();
    expect(thinkingLevel("gemma-4-27b-it")).toBeUndefined();
    expect(geminiRequest({ messages: [{ role: "user", content: "hi" }], tools: [] }, "gemini-2.5-flash").generationConfig).toEqual({ maxOutputTokens: 8192 });
  });

  it("maps finish reasons, a blocked prompt and a reply that didn't come out right", () => {
    const answer = (finishReason: string, parts: unknown[] = [{ text: "Here." }]) => fromGemini({ candidates: [{ content: { role: "model", parts }, finishReason }] }, "gemini-3.8-flash");
    expect(answer("STOP").stop_reason).toBe("end_turn");
    expect(answer("MAX_TOKENS").stop_reason).toBe("max_tokens");
    expect(answer("SAFETY", []).stop_reason).toBe("refusal");
    expect(answer("PROHIBITED_CONTENT", []).stop_reason).toBe("refusal");
    expect(answer("OTHER").stop_reason).toBe("end_turn");
    expect(() => answer("MALFORMED_FUNCTION_CALL", [])).toThrow(/didn't come out right \(MALFORMED_FUNCTION_CALL\)/);
    expect(() => answer("MISSING_THOUGHT_SIGNATURE", [])).toThrow(TurnError);
    // Thought summaries aren't said aloud.
    expect(answer("STOP", [{ text: "Planning the answer.", thought: true }, { text: "Here." }]).content).toEqual([{ type: "text", text: "Here." }]);
    const blocked = fromGemini({ promptFeedback: { blockReason: "SAFETY", safetyRatings: [] }, usageMetadata: { promptTokenCount: 40, totalTokenCount: 40 } }, "gemini-3.8-flash");
    expect(blocked).toMatchObject({ content: [], stop_reason: "refusal", usage: { input_tokens: 40, output_tokens: 0 } });
  });

  it("says what went wrong: the key, the account, throttling, the request, or Gemini itself", async () => {
    const tryWith = async (...answers: (() => Response | Promise<Response>)[]) => {
      const api = gemini(...answers);
      const res = await modelRoute({ ...key, fetch: api.fetch })(ask());
      return { status: res.status, error: ((await res.json()) as { error: { code: string; message: string } }).error, tries: api.sent.length };
    };
    const invalidKey = await tryWith(
      googleError(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [
        { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com", metadata: { service: "generativelanguage.googleapis.com" } },
      ]),
    );
    expect(invalidKey).toMatchObject({
      status: 502,
      error: { code: "model_key", message: "Gemini didn't accept the API key (or it can't use this model): API key not valid. Please pass a valid API key." },
      tries: 1,
    });
    expect(await tryWith(googleError(403, "PERMISSION_DENIED", "Method doesn't allow unregistered callers (callers without established identity)."))).toMatchObject({ status: 502, error: { code: "model_key" } });
    expect(await tryWith(googleError(400, "FAILED_PRECONDITION", "User location is not supported for the API use."))).toMatchObject({ status: 502, error: { code: "model_key" } });
    // The newer error shape names the problem in `code`; it still reads as the key's.
    expect(await tryWith(() => Response.json({ error: { code: "authentication", message: "The API key is missing, invalid, or expired." } }, { status: 401 }))).toMatchObject({ status: 502, error: { code: "model_key" } });
    const exhausted = await tryWith(
      googleError(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details.", [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "32s" }]),
    );
    expect(exhausted).toMatchObject({ status: 429, error: { code: "rate_limited" }, tries: 2 });
    expect(exhausted.error.message).toContain("You exceeded your current quota");
    expect(await tryWith(googleError(400, "INVALID_ARGUMENT", "* GenerateContentRequest.contents[2].parts[0].function_response.name: Name cannot be empty."))).toMatchObject({
      status: 400,
      error: { code: "bad_request" },
      tries: 1,
    });
    const missing = await tryWith(googleError(404, "NOT_FOUND", "models/gemini-9-flash is not found for API version v1beta, or is not supported for generateContent."));
    expect(missing).toMatchObject({ status: 502, error: { code: "model_error" }, tries: 1 });
    expect(missing.error.message).toMatch(/^Gemini answered 404: models\/gemini-9-flash is not found/);
    expect(await tryWith(googleError(503, "UNAVAILABLE", "The model is overloaded. Please try again later."))).toMatchObject({ status: 502, error: { code: "model_error" }, tries: 2 });
  });

  it("goes through GOOGLE_GEMINI_BASE_URL to a gateway, and takes a model named as the API names it", async () => {
    const api = gemini(ok(textAnswer));
    await modelRoute({ gemini: { apiKey: "gemini-key", baseURL: "https://gateway.example/google/" }, model: "models/gemini-3.5-flash-lite", fetch: api.fetch })(ask());
    expect(api.sent[0]!.url).toBe("https://gateway.example/google/v1beta/models/gemini-3.5-flash-lite:generateContent");
  });
});

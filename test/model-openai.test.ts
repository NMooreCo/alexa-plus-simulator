import { describe, expect, it } from "vitest";
import { type ModelOptions, modelRoute } from "../src/model/index.ts";
import { chatRequest, fromChat, reasoningEffort } from "../src/model/openai.ts";
import { VOICE } from "../src/model/prompt.ts";

/**
 * OpenAI's Chat Completions API, against responses in the shapes OpenAI's API
 * reference documents, and the variations other servers that speak it send
 * (no live calls: there are no credentials here).
 */

const turn = (body: unknown) => new Request("http://localhost:6277/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** A stand-in for a Chat Completions server that gives each answer in turn (the last one again after that) and keeps what it was sent. */
function server(...answers: (() => Response | Promise<Response>)[]) {
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
/** An error the way OpenAI sends one. */
const apiError = (status: number, type: string, code: string | null, message: string) => () => Response.json({ error: { message, type, param: null, code } }, { status });

const completion = (message: Record<string, unknown>, finish_reason: string, usage?: Record<string, unknown>) => ({
  id: "chatcmpl-CXsWy2nTq3kbH1bTXUm0IWMp1i2fA",
  object: "chat.completion",
  created: 1760990000,
  model: "gpt-6-sol-2026-09-22",
  choices: [{ index: 0, message: { role: "assistant", refusal: null, annotations: [], ...message }, logprobs: null, finish_reason }],
  usage: usage ?? {
    prompt_tokens: 1117,
    completion_tokens: 12,
    total_tokens: 1129,
    prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, accepted_prediction_tokens: 0, rejected_prediction_tokens: 0 },
  },
  service_tier: "default",
});

const textAnswer = completion({ content: "You have three things on today's list." }, "stop");
/** Two calls at once (parallel tool calls), as OpenAI's function calling sends them. */
const toolAnswer = completion(
  {
    content: null,
    tool_calls: [
      { id: "call_Ub3nO6NBf9GRDoAWyc5kU9Zg", type: "function", function: { name: "show_today", arguments: "{}" } },
      { id: "call_qVGo5L0zHqGkS1xFjNgJ1CvP", type: "function", function: { name: "get_weather", arguments: '{"city":"Denver"}' } },
    ],
  },
  "tool_calls",
);

const context = { instructions: "This server runs a household.", device: "Echo Show 8", screen: true, timeZone: "America/Denver", now: "Tuesday at 7 PM" };
const tools = [
  { name: "show_today", description: "Show today's list", input_schema: { type: "object", properties: {} } },
  { name: "get_weather", description: "", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
];
const ask = (text = "What's on today?") => turn({ messages: [{ role: "user", content: text }], tools, context });
const key: ModelOptions = { openai: { apiKey: "sk-test" }, retryDelayMs: 0 };

/** A conversation as the page keeps it: Claude-only blocks along the way, two tool calls (one failed), and a new question. */
const history = [
  { role: "user", content: [{ type: "text", text: "(On the screen since you last spoke: tapped Groceries.)" }, { type: "text", text: "What's on my list today?" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Two tools.", signature: "c2ln" },
      { type: "tool_use", id: "call_Ub3nO6NBf9GRDoAWyc5kU9Zg", name: "show_today", input: {} },
      { type: "tool_use", id: "call_qVGo5L0zHqGkS1xFjNgJ1CvP", name: "get_weather", input: { city: "Denver" } },
    ],
  },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "call_qVGo5L0zHqGkS1xFjNgJ1CvP", content: "The weather service didn't answer.", is_error: true },
      { type: "tool_result", tool_use_id: "call_Ub3nO6NBf9GRDoAWyc5kU9Zg", content: "Milk, eggs, call the vet." },
    ],
  },
  { role: "assistant", content: [{ type: "text", text: "Milk, eggs and a call to the vet. I couldn't get the weather." }] },
  { role: "user", content: "Add bread." },
];

describe("OpenAI", () => {
  it("sends the turn to Chat Completions with the key: one system message first, the tools as functions, no reasoning for GPT-6 Sol", async () => {
    const api = server(ok(textAnswer));
    const res = await modelRoute({ ...key, fetch: api.fetch })(ask());
    expect(res.status).toBe(200);
    const sent = api.sent[0]!;
    expect(sent.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer sk-test");
    expect(sent.body.model).toBe("gpt-6-sol");
    // GPT-6 Sol calls functions through Chat Completions only with reasoning off.
    expect(sent.body.reasoning_effort).toBe("none");
    expect(sent.body.max_completion_tokens).toBe(8192);
    expect(sent.body.max_tokens).toBeUndefined();
    expect(sent.body.messages).toHaveLength(2);
    expect(sent.body.messages[0].role).toBe("system");
    expect(sent.body.messages[0].content).toContain(VOICE);
    expect(sent.body.messages[0].content).toContain("This server runs a household.");
    expect(sent.body.messages[0].content.indexOf("This server runs a household.")).toBeLessThan(sent.body.messages[0].content.indexOf("Echo Show 8"));
    expect(sent.body.messages[1]).toEqual({ role: "user", content: "What's on today?" });
    expect(sent.body.tools).toEqual([
      { type: "function", function: { name: "show_today", description: "Show today's list", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "get_weather", parameters: tools[1]!.input_schema } },
    ]);
  });

  it("asks each OpenAI model family for the least reasoning it takes with tools, and other servers' models for none", () => {
    expect(reasoningEffort("gpt-6-sol")).toBe("none");
    expect(reasoningEffort("gpt-6-luna-2026-09-22")).toBe("none");
    expect(reasoningEffort("gpt-6-astra")).toBe("low");
    expect(reasoningEffort("gpt-6.1-sol")).toBe("low");
    expect(reasoningEffort("gpt-5.6-sol")).toBe("low");
    expect(reasoningEffort("gpt-5")).toBe("low");
    expect(reasoningEffort("o4-mini")).toBe("low");
    expect(reasoningEffort("gpt-5-chat-latest")).toBeUndefined();
    expect(reasoningEffort("gpt-4.1")).toBeUndefined();
    expect(reasoningEffort("llama3.2")).toBeUndefined();
    expect(reasoningEffort("gpt-oss:20b")).toBeUndefined();
    expect(chatRequest({ messages: [{ role: "user", content: "hi" }], tools: [] }, "llama3.2").reasoning_effort).toBeUndefined();
  });

  it("talks to a compatible server at OPENAI_BASE_URL, with no key when it needs none", async () => {
    const api = server(ok({ ...textAnswer, model: "llama3.2" }));
    const res = await modelRoute({ openai: { baseURL: "http://localhost:11434/v1/" }, model: "llama3.2", fetch: api.fetch, retryDelayMs: 0 })(ask());
    expect(res.status).toBe(200);
    expect(api.sent[0]!.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(api.sent[0]!.headers.get("authorization")).toBeNull();
    expect(api.sent[0]!.body.model).toBe("llama3.2");
    // An Azure deployment's address may carry a query.
    const azure = server(ok(textAnswer));
    await modelRoute({ openai: { apiKey: "azure-key", baseURL: "https://example-resource.openai.azure.com/openai/v1?api-version=preview" }, model: "gpt-6-sol", fetch: azure.fetch })(ask());
    expect(azure.sent[0]!.url).toBe("https://example-resource.openai.azure.com/openai/v1/chat/completions?api-version=preview");
  });

  it("answers a text reply in the Messages API's shape, counting cached tokens the way Anthropic does", async () => {
    const res = await modelRoute({ ...key, fetch: server(ok(textAnswer)).fetch })(ask());
    expect(res.headers.get("x-model")).toBe("gpt-6-sol-2026-09-22");
    expect(await res.json()).toEqual({
      id: "chatcmpl-CXsWy2nTq3kbH1bTXUm0IWMp1i2fA",
      type: "message",
      role: "assistant",
      model: "gpt-6-sol-2026-09-22",
      content: [{ type: "text", text: "You have three things on today's list." }],
      stop_reason: "end_turn",
      stop_sequence: null,
      // OpenAI's 1117 prompt tokens include the 1024 read from the cache; the page adds them back.
      usage: { input_tokens: 93, output_tokens: 12, cache_read_input_tokens: 1024 },
    });
    const written = fromChat(completion({ content: "Hi." }, "stop", { prompt_tokens: 2000, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1536 } }), "m");
    expect(written.usage).toEqual({ input_tokens: 464, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 1536 });
  });

  it("turns parallel tool calls into tool_use blocks, their JSON arguments read", async () => {
    const res = await modelRoute({ ...key, fetch: server(ok(toolAnswer)).fetch })(ask("What's on today, and the weather?"));
    expect(await res.json()).toMatchObject({
      content: [
        { type: "tool_use", id: "call_Ub3nO6NBf9GRDoAWyc5kU9Zg", name: "show_today", input: {} },
        { type: "tool_use", id: "call_qVGo5L0zHqGkS1xFjNgJ1CvP", name: "get_weather", input: { city: "Denver" } },
      ],
      stop_reason: "tool_use",
    });
  });

  it("calls a tool with no arguments when the model's aren't a JSON object, and says so, rather than failing", () => {
    const reply = fromChat(
      completion(
        {
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "add_item", arguments: '{"item": "milk"' } },
            { id: "call_2", type: "function", function: { name: "show_today", arguments: '["today"]' } },
            { id: "call_3", type: "function", function: { name: "show_week", arguments: "" } },
          ],
        },
        "tool_calls",
      ),
      "gpt-6-sol",
    );
    expect(reply.content).toEqual([
      { type: "text", text: "(The model's arguments for add_item weren't valid JSON, so the simulator calls it with none.)" },
      { type: "tool_use", id: "call_1", name: "add_item", input: {} },
      { type: "text", text: "(The model's arguments for show_today weren't a JSON object, so the simulator calls it with none.)" },
      { type: "tool_use", id: "call_2", name: "show_today", input: {} },
      // No arguments at all is a call with none, not a problem.
      { type: "tool_use", id: "call_3", name: "show_week", input: {} },
    ]);
    expect(reply.stop_reason).toBe("tool_use");
  });

  it("stops for tool calls however a server words it, and gives calls without ids one", () => {
    // Some servers say "stop" with tool calls, send no usage, and leave out ids.
    const reply = fromChat({ id: "chatcmpl-1", model: "qwen3", choices: [{ index: 0, message: { role: "assistant", content: "", tool_calls: [{ type: "function", function: { name: "show_today", arguments: { day: "today" } } }] }, finish_reason: "stop" }] }, "qwen3");
    expect(reply.stop_reason).toBe("tool_use");
    expect(reply.content).toEqual([{ type: "tool_use", id: expect.stringMatching(/^call_[0-9a-f]{32}$/), name: "show_today", input: { day: "today" } }]);
    expect(reply.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it("leaves a reasoning model's <think> unsaid, and reads content sent as parts", () => {
    expect(fromChat(completion({ content: "<think>They want the list.</think>\nMilk and eggs." }, "stop"), "m").content).toEqual([{ type: "text", text: "Milk and eggs." }]);
    expect(fromChat(completion({ content: [{ type: "text", text: "Milk " }, { type: "text", text: "and eggs." }] }, "stop"), "m").content).toEqual([{ type: "text", text: "Milk and eggs." }]);
  });

  it("maps finish reasons, and a refusal is a refusal", () => {
    expect(fromChat(completion({ content: "Milk and" }, "length"), "m").stop_reason).toBe("max_tokens");
    expect(fromChat(completion({ content: null }, "content_filter"), "m").stop_reason).toBe("refusal");
    const refused = fromChat(completion({ content: null, refusal: "I'm sorry, I can't help with that." }, "stop"), "m");
    expect(refused).toMatchObject({ stop_reason: "refusal", content: [{ type: "text", text: "I'm sorry, I can't help with that." }] });
  });

  it("carries the whole conversation: assistant tool calls, then one tool message per result in the calls' order, failures marked", async () => {
    const api = server(ok(textAnswer));
    await modelRoute({ ...key, fetch: api.fetch })(turn({ messages: history, tools, context }));
    expect(api.sent[0]!.body.messages.slice(1)).toEqual([
      { role: "user", content: "(On the screen since you last spoke: tapped Groceries.)\nWhat's on my list today?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_Ub3nO6NBf9GRDoAWyc5kU9Zg", type: "function", function: { name: "show_today", arguments: "{}" } },
          { id: "call_qVGo5L0zHqGkS1xFjNgJ1CvP", type: "function", function: { name: "get_weather", arguments: '{"city":"Denver"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_Ub3nO6NBf9GRDoAWyc5kU9Zg", content: "Milk, eggs, call the vet." },
      { role: "tool", tool_call_id: "call_qVGo5L0zHqGkS1xFjNgJ1CvP", content: "Error: The weather service didn't answer." },
      { role: "assistant", content: "Milk, eggs and a call to the vet. I couldn't get the weather." },
      { role: "user", content: "Add bread." },
    ]);
  });

  it("says what went wrong: the key, the rate limit or quota, the request, or the server", async () => {
    const tryWith = async (options: ModelOptions, ...answers: (() => Response | Promise<Response>)[]) => {
      const api = server(...answers);
      const res = await modelRoute({ ...options, fetch: api.fetch, retryDelayMs: 0 })(ask());
      return { status: res.status, error: ((await res.json()) as { error: { code: string; message: string } }).error, tries: api.sent.length };
    };
    const badKey = await tryWith(key, apiError(401, "invalid_request_error", "invalid_api_key", "Incorrect API key provided: sk-test. You can find your API key at https://platform.openai.com/account/api-keys."));
    expect(badKey).toMatchObject({ status: 502, error: { code: "model_key" }, tries: 1 });
    expect(badKey.error.message).toMatch(/^OpenAI didn't accept the API key/);
    const limited = await tryWith(key, apiError(429, "requests", "rate_limit_exceeded", "Rate limit reached for gpt-6-sol on requests per min (RPM): Limit 500, Used 500, Requested 1."));
    expect(limited).toMatchObject({ status: 429, error: { code: "rate_limited" }, tries: 2 });
    const quota = await tryWith(key, apiError(429, "insufficient_quota", "insufficient_quota", "You exceeded your current quota, please check your plan and billing details."));
    expect(quota.error.message).toContain("You exceeded your current quota");
    const invalid = await tryWith(key, apiError(400, "invalid_request_error", "unsupported_value", "Unsupported value: 'reasoning_effort' does not support 'none' with this model."));
    expect(invalid).toMatchObject({ status: 400, error: { code: "bad_request", message: "OpenAI didn't accept the request: Unsupported value: 'reasoning_effort' does not support 'none' with this model." } });
    const missing = await tryWith(key, apiError(404, "invalid_request_error", "model_not_found", "The model `gpt-7` does not exist or you do not have access to it."));
    expect(missing).toMatchObject({ status: 502, error: { code: "model_error", message: "OpenAI answered 404: The model `gpt-7` does not exist or you do not have access to it." }, tries: 1 });
    const down = await tryWith(key, apiError(500, "server_error", null, "The server had an error while processing your request. Sorry about that!"));
    expect(down).toMatchObject({ status: 502, error: { code: "model_error" }, tries: 2 });
    // A local server that says { error: "..." }, and one that isn't running.
    const local = { openai: { baseURL: "http://localhost:11434/v1" } };
    const pull = await tryWith(local, () => Response.json({ error: 'model "gpt-6-sol" not found, try pulling it first' }, { status: 404 }));
    expect(pull.error.message).toBe('The server at localhost:11434 answered 404: model "gpt-6-sol" not found, try pulling it first.');
    const off = await tryWith(local, () => Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:11434"), { code: "ECONNREFUSED" }) })));
    expect(off).toMatchObject({ status: 502, error: { code: "model_error", message: "Couldn't reach the server at localhost:11434: connect ECONNREFUSED 127.0.0.1:11434." }, tries: 2 });
  });

  it("waits as long as the server asks before trying again, unless that's too long to keep someone waiting", async () => {
    const limited = (seconds: string) => () => Response.json({ error: { message: "Slow down.", type: "requests", code: "rate_limit_exceeded" } }, { status: 429, headers: { "retry-after": seconds } });
    const soon = server(limited("0"), ok(textAnswer));
    expect((await modelRoute({ openai: { apiKey: "k" }, fetch: soon.fetch })(ask())).status).toBe(200);
    expect(soon.sent).toHaveLength(2);
    const later = server(limited("60"), ok(textAnswer));
    expect((await modelRoute({ openai: { apiKey: "k" }, fetch: later.fetch })(ask())).status).toBe(429);
    expect(later.sent).toHaveLength(1);
  });

  it("stops when the page stops waiting", async () => {
    const page = new AbortController();
    let calls = 0;
    // A server that never answers: only the page leaving ends the call.
    const fetch = (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      const signal = init!.signal!;
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    };
    const request = new Request("http://localhost:6277/api/model", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [] }), signal: page.signal });
    const answering = modelRoute({ openai: { apiKey: "k" }, fetch, retryDelayMs: 0 })(request);
    setTimeout(() => page.abort(), 10);
    await expect(answering).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

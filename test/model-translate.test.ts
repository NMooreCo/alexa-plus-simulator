import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type ConverseRequest, converseRequest, fromConverse } from "../src/model/bedrock.ts";
import { type ChatRequest, chatRequest, fromChat } from "../src/model/openai.ts";
import { type ModelReply, TurnError } from "../src/model/provider.ts";
import { readHistory, spoken, toolInput } from "../src/model/translate.ts";

/**
 * The page's conversation, in the Messages API's shape, going to Bedrock and
 * OpenAI and their replies coming back: whatever the history or the reply,
 * every tool call keeps its result beside it and the page gets blocks it reads.
 */

const TOOLS = ["show_today", "add_item", "get_weather", "set_timer"].map((name) => ({ name, description: `The ${name} tool`, input_schema: { type: "object" } }));

describe("reading the page's conversation", () => {
  it("joins back-to-back messages from one side and leaves out blank text, Claude's own blocks and empty messages", () => {
    const history = readHistory(
      [
        { role: "user", content: "Hi." },
        { role: "user", content: [{ type: "text", text: "  " }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "Hm.", signature: "c2ln" }, { type: "fallback" }] },
        { role: "user", content: [{ type: "text", text: "What's on today?" }] },
      ],
      true,
    );
    expect(history).toEqual([{ role: "user", parts: [{ type: "text", text: "Hi." }, { type: "text", text: "What's on today?" }] }]);
  });

  it("answers a call that never got a result (a reply cut off at its limit), so the provider doesn't refuse the conversation", () => {
    const call = { type: "tool_use", id: "call_1", name: "add_item", input: { item: "milk" } };
    expect(readHistory([{ role: "user", content: "Add milk." }, { role: "assistant", content: [call] }, { role: "user", content: "Never mind." }], true)).toEqual([
      { role: "user", parts: [{ type: "text", text: "Add milk." }] },
      { role: "assistant", parts: [{ type: "call", id: "call_1", name: "add_item", input: { item: "milk" } }] },
      {
        role: "user",
        parts: [
          { type: "result", id: "call_1", text: "This call didn't run.", isError: true },
          { type: "text", text: "Never mind." },
        ],
      },
    ]);
    // A conversation that ends on calls gets their results too.
    expect(readHistory([{ role: "user", content: "Add milk." }, { role: "assistant", content: [call] }], true).at(-1)).toEqual({
      role: "user",
      parts: [{ type: "result", id: "call_1", text: "This call didn't run.", isError: true }],
    });
  });

  it("keeps a result that answers no call as text, and reads a result given as blocks", () => {
    expect(readHistory([{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_9", content: [{ type: "text", text: "42" }, { type: "image", source: {} }] }] }], true)).toEqual([
      { role: "user", parts: [{ type: "text", text: "(A tool result that answers no call: 42\n[An image])" }] },
    ]);
    const empty = readHistory([{ role: "user", content: "x" }, { role: "assistant", content: [{ type: "tool_use", id: "a", name: "t", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "" }] }], true);
    expect(empty[2]!.parts[0]).toMatchObject({ type: "result", text: "(The tool returned nothing.)" });
  });

  it("tells calls and results as text when there are no tools on offer", () => {
    const history = readHistory(
      [
        { role: "user", content: "Add milk." },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "add_item", input: { item: "milk" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "No such list.", is_error: true }] },
      ],
      false,
    );
    expect(history.slice(1)).toEqual([
      { role: "assistant", parts: [{ type: "text", text: '(Called add_item with {"item":"milk"}.)' }] },
      { role: "user", parts: [{ type: "text", text: "(add_item failed: No such list.)" }] },
    ]);
    expect(converseRequest({ messages: [{ role: "user", content: "x" }], tools: [] }, "m").toolConfig).toBeUndefined();
  });

  it("says nothing of a model's written reasoning, and reads tool arguments without ever failing", () => {
    expect(spoken("<thinking>Call show_today.</thinking>Here's today.")).toBe("Here's today.");
    expect(spoken("<THINK>x</THINK> Done. <thinking>cut off")).toBe("Done.");
    expect(spoken("Three things.")).toBe("Three things.");
    expect(toolInput('{"a":1}')).toEqual({ input: { a: 1 } });
    expect(toolInput({ a: 1 })).toEqual({ input: { a: 1 } });
    expect(toolInput(" ")).toEqual({ input: {} });
    expect(toolInput("{")).toEqual({ input: {}, problem: "weren't valid JSON" });
    expect(toolInput("null")).toEqual({ input: {}, problem: "weren't a JSON object" });
    expect(toolInput(7)).toEqual({ input: {}, problem: "weren't a JSON object" });
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const { input } = toolInput(raw);
        expect(typeof input === "object" && input !== null && !Array.isArray(input)).toBe(true);
      }),
    );
  });
});

// ---------- Properties ----------

const words = fc.stringMatching(/^[A-Za-z0-9 ,.'?!]{1,30}$/).filter((s) => s.trim().length > 0);
const toolName = fc.constantFrom(...TOOLS.map((t) => t.name));
const toolArgs = fc.dictionary(fc.stringMatching(/^[a-z]{1,8}$/), fc.oneof(fc.string({ maxLength: 10 }), fc.integer(), fc.boolean(), fc.constant(null)), { maxKeys: 3 });
/** Ids as Anthropic, OpenAI and Bedrock write them, and one Converse wouldn't take. */
const idStyle = fc.constantFrom("toolu_01", "call_", "tooluse_", "an odd id/");

/** One exchange as the page has it: what was said, maybe some tool calls and their results, and the answer. */
const exchange = fc.record({
  said: fc.array(words, { minLength: 1, maxLength: 3 }),
  thinking: fc.boolean(),
  preamble: fc.option(words, { nil: undefined }),
  calls: fc.array(fc.record({ name: toolName, input: toolArgs, result: words, isError: fc.boolean() }), { maxLength: 3 }),
  // The page sends results together, but in no promised order.
  reversed: fc.boolean(),
  // A model can answer with nothing at all, and the page keeps that empty reply too.
  answer: fc.option(words, { nil: undefined }),
});

type Exchange = typeof exchange extends fc.Arbitrary<infer T> ? T : never;
interface Pair {
  id: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
}

/** The page's messages for some exchanges, and each group of calls with its results, in the calls' order. */
function conversation(exchanges: Exchange[], style: string): { messages: unknown[]; groups: Pair[][] } {
  const messages: unknown[] = [];
  const groups: Pair[][] = [];
  let n = 0;
  for (const x of exchanges) {
    messages.push({ role: "user", content: x.said.map((text) => ({ type: "text", text })) });
    const pairs = x.calls.map((c) => ({ id: `${style}${++n}`, input: c.input, result: c.result, isError: c.isError }));
    const start = [...(x.thinking ? [{ type: "thinking", thinking: "Hm.", signature: "c2ln" }] : []), ...(x.preamble ? [{ type: "text", text: x.preamble }] : [])];
    const answer = x.answer ? [{ type: "text", text: x.answer }] : [];
    if (!pairs.length) {
      messages.push({ role: "assistant", content: [...start, ...answer] });
      continue;
    }
    messages.push({ role: "assistant", content: [...start, ...pairs.map((p, i) => ({ type: "tool_use", id: p.id, name: x.calls[i]!.name, input: p.input }))] });
    const results = pairs.map((p) => ({ type: "tool_result", tool_use_id: p.id, content: p.result, ...(p.isError ? { is_error: true } : {}) }));
    messages.push({ role: "user", content: x.reversed ? results.reverse() : results });
    messages.push({ role: "assistant", content: answer });
    groups.push(pairs);
  }
  messages.push({ role: "user", content: "And then?" });
  return { messages, groups };
}

type ConverseResult = { toolUseId: string; content: { text: string }[]; status?: string };

/** A Converse request's calls, grouped by message, each group checked to be answered in order at the start of the next message, with roles taking turns from the user. */
function conversePairs(request: ConverseRequest): { ids: string[]; results: ConverseResult[] }[] {
  const groups: { ids: string[]; results: ConverseResult[] }[] = [];
  request.messages.forEach((m, i) => {
    expect(m.role).toBe(i % 2 === 0 ? "user" : "assistant");
    const ids = m.content.flatMap((b) => ("toolUse" in b ? [b.toolUse.toolUseId] : []));
    const results = (request.messages[i + 1]?.content ?? []).slice(0, ids.length).flatMap((b) => ("toolResult" in b ? [b.toolResult] : []));
    for (const id of ids) expect(id).toMatch(/^[\w.:-]{1,64}$/);
    if (ids.length) {
      expect(results.map((r) => r.toolUseId)).toEqual(ids);
      groups.push({ ids, results });
    }
  });
  // No result anywhere but right after its call.
  const answered = groups.reduce((sum, g) => sum + g.ids.length, 0);
  expect(request.messages.flatMap((m) => m.content.filter((b) => "toolResult" in b))).toHaveLength(answered);
  return groups;
}

type ChatTool = { tool_call_id: string; content: string };

/** A Chat Completions request's calls, grouped by message, each group checked to be followed by exactly its tool messages, in order. */
function chatPairs(request: ChatRequest): { ids: string[]; inputs: unknown[]; results: ChatTool[] }[] {
  const groups: { ids: string[]; inputs: unknown[]; results: ChatTool[] }[] = [];
  request.messages.forEach((m, i) => {
    if (m.role !== "assistant" || !m.tool_calls) return;
    const ids = m.tool_calls.map((c) => c.id);
    const after = request.messages.slice(i + 1, i + 1 + ids.length);
    expect(after.map((a) => a.role)).toEqual(ids.map(() => "tool"));
    expect(request.messages[i + 1 + ids.length]?.role).not.toBe("tool");
    const results = after as ChatTool[];
    expect(results.map((r) => r.tool_call_id)).toEqual(ids);
    groups.push({ ids, inputs: m.tool_calls.map((c) => JSON.parse(c.function.arguments) as unknown), results });
  });
  expect(request.messages.filter((m) => m.role === "tool")).toHaveLength(groups.reduce((sum, g) => sum + g.ids.length, 0));
  return groups;
}

/** JSON's view of a value (so -0 and 0 count as the same, as they do once sent). */
const asJson = (v: unknown) => JSON.parse(JSON.stringify(v)) as unknown;

describe("any conversation the page could keep", () => {
  it("goes to Converse with every call answered by its own result, in order, right after it", () => {
    fc.assert(
      fc.property(fc.array(exchange, { minLength: 1, maxLength: 4 }), idStyle, fc.constantFrom("global.amazon.nova-2-lite-v1:0", "meta.llama3-3-70b-instruct-v1:0"), (exchanges, style, model) => {
        const { messages, groups } = conversation(exchanges, style);
        const pairs = conversePairs(converseRequest({ messages, tools: TOOLS, context: {} }, model));
        expect(pairs.map((g) => g.ids.length)).toEqual(groups.map((g) => g.length));
        pairs.forEach((g, i) => {
          const expected = groups[i]!;
          // Ids Converse takes stay as they are; others are swapped for ones it does, the same for the call and its result.
          if (style !== "an odd id/") expect(g.ids).toEqual(expected.map((p) => p.id));
          expect(new Set(g.ids).size).toBe(g.ids.length);
          const nova = model.includes("nova");
          expect(g.results.map((r) => ({ text: r.content[0]!.text, status: r.status }))).toEqual(
            expected.map((p) => (nova ? { text: p.result, status: p.isError ? "error" : "success" } : { text: p.isError ? `Error: ${p.result}` : p.result, status: undefined })),
          );
        });
      }),
    );
  });

  it("goes to Chat Completions with each tool_calls message followed by exactly its tool messages, ids and arguments intact", () => {
    fc.assert(
      fc.property(fc.array(exchange, { minLength: 1, maxLength: 4 }), idStyle, (exchanges, style) => {
        const { messages, groups } = conversation(exchanges, style);
        const pairs = chatPairs(chatRequest({ messages, tools: TOOLS, context: {} }, "gpt-6-sol"));
        expect(pairs.map((g) => g.ids)).toEqual(groups.map((g) => g.map((p) => p.id)));
        expect(pairs.map((g) => g.inputs)).toEqual(groups.map((g) => g.map((p) => asJson(p.input))));
        expect(pairs.map((g) => g.results.map((r) => r.content))).toEqual(groups.map((g) => g.map((p) => (p.isError ? `Error: ${p.result}` : p.result))));
      }),
    );
  });
});

const STOPS = ["end_turn", "tool_use", "max_tokens", "refusal"];

/** A reply the page can read: text worth saying, tool calls it can run, a stop it knows, and counts. */
function expectPageReply(reply: ModelReply): void {
  expect(reply).toMatchObject({ type: "message", role: "assistant", stop_sequence: null });
  expect(reply.id).toMatch(/\S/);
  expect(reply.model).toMatch(/\S/);
  expect(STOPS).toContain(reply.stop_reason);
  for (const block of reply.content) {
    if (block.type === "text") expect(block.text.trim()).not.toBe("");
    else {
      expect(block.type).toBe("tool_use");
      expect(block.id).toMatch(/\S/);
      expect(block.name).toMatch(/\S/);
      expect(typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)).toBe(true);
    }
  }
  const calls = reply.content.some((b) => b.type === "tool_use");
  if (reply.stop_reason === "tool_use") expect(calls).toBe(true);
  if (reply.stop_reason === "end_turn") expect(calls).toBe(false);
  for (const n of Object.values(reply.usage)) expect(Number.isInteger(n) && n >= 0).toBe(true);
}

/** The next turn as the page builds it: the reply as it came, its tools' results when it stopped for them, and what was said next. */
function nextTurn(reply: ModelReply): unknown[] {
  const uses = reply.content.filter((b) => b.type === "tool_use");
  return [
    { role: "user", content: "What's on today?" },
    { role: "assistant", content: reply.content },
    ...(reply.stop_reason === "tool_use" && uses.length ? [{ role: "user", content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "Done." })) }] : []),
    { role: "user", content: "Thanks." },
  ];
}

const converseBlock = fc.oneof(
  words.map((text) => ({ text })),
  words.map((text) => ({ text: `<thinking>${text}</thinking>` })),
  fc.record({ name: toolName, input: toolArgs }).map((use) => ({ toolUse: { toolUseId: "", ...use } })),
  // Reasoning, marked so it can't be mistaken for anything `words` makes.
  fc.constant({ reasoningContent: { reasoningText: { text: "§ reasoning §", signature: "c2ln" } } }),
);
const converseAnswer = fc.record({
  // Each call gets its own id, as Bedrock's are ("tooluse_" and 22 characters).
  content: fc.array(converseBlock, { maxLength: 5 }).map((blocks) => blocks.map((b, i) => ("toolUse" in b ? { toolUse: { ...b.toolUse, toolUseId: `tooluse_${String(i).padStart(22, "x")}` } } : b))),
  stopReason: fc.constantFrom("end_turn", "tool_use", "max_tokens", "stop_sequence", "guardrail_intervened", "content_filtered", "malformed_model_output", "malformed_tool_use", "model_context_window_exceeded"),
  usage: fc.record({ inputTokens: fc.nat(), outputTokens: fc.nat(), totalTokens: fc.nat(), cacheReadInputTokens: fc.nat(), cacheWriteInputTokens: fc.nat() }, { requiredKeys: ["inputTokens", "outputTokens", "totalTokens"] }),
});

const chatArguments = fc.oneof(toolArgs.map((a) => JSON.stringify(a)), fc.string({ maxLength: 20 }), fc.constant(""), fc.constant("[1,2]"), fc.constant('{"item": "milk"'));
const chatAnswer = fc.record({
  content: fc.option(fc.string({ maxLength: 40 }), { nil: null }),
  // Mostly none, as in real replies.
  refusal: fc.oneof({ arbitrary: fc.constant(null), weight: 4 }, { arbitrary: words, weight: 1 }),
  calls: fc.array(fc.record({ id: fc.option(fc.stringMatching(/^[A-Za-z0-9]{24}$/), { nil: undefined }), name: toolName, arguments: chatArguments }), { maxLength: 4 }),
  finish: fc.constantFrom("stop", "tool_calls", "length", "content_filter", "function_call"),
  usage: fc.option(fc.record({ prompt_tokens: fc.nat(), completion_tokens: fc.nat(), prompt_tokens_details: fc.record({ cached_tokens: fc.nat() }) }), { nil: undefined }),
});

describe("any reply a provider could send", () => {
  it("from Converse, comes back as blocks the page reads, and goes back paired; or as an error the page explains", () => {
    fc.assert(
      fc.property(converseAnswer, (a) => {
        const body = { output: { message: { role: "assistant", content: a.content } }, stopReason: a.stopReason, usage: a.usage, metrics: { latencyMs: 300 } };
        if (a.stopReason.startsWith("malformed")) {
          expect(() => fromConverse(body, "global.amazon.nova-2-lite-v1:0")).toThrow(TurnError);
          return;
        }
        const reply = fromConverse(body, "global.amazon.nova-2-lite-v1:0", "5f0d3c6e");
        expectPageReply(reply);
        // Every call, in order; nothing of the reasoning.
        expect(reply.content.filter((b) => b.type === "tool_use").map((b) => b.id)).toEqual(a.content.flatMap((b) => ("toolUse" in b ? [b.toolUse.toolUseId] : [])));
        expect(JSON.stringify(reply.content)).not.toMatch(/<thinking>|§/);
        conversePairs(converseRequest({ messages: nextTurn(reply), tools: TOOLS, context: {} }, "global.amazon.nova-2-lite-v1:0"));
      }),
    );
  });

  it("from Chat Completions, comes back as blocks the page reads whatever the arguments, and goes back paired", () => {
    fc.assert(
      fc.property(chatAnswer, (a) => {
        const tool_calls = a.calls.map((c) => ({ ...(c.id ? { id: `call_${c.id}` } : {}), type: "function", function: { name: c.name, arguments: c.arguments } }));
        const body = { id: "chatcmpl-1", object: "chat.completion", created: 1, model: "gpt-6-sol", choices: [{ index: 0, message: { role: "assistant", content: a.content, refusal: a.refusal, ...(tool_calls.length ? { tool_calls } : {}) }, finish_reason: a.finish }], usage: a.usage };
        const reply = fromChat(body, "gpt-6-sol");
        expectPageReply(reply);
        const uses = reply.content.filter((b) => b.type === "tool_use");
        expect(uses.map((u) => u.name)).toEqual(a.calls.map((c) => c.name));
        a.calls.forEach((c, i) => {
          const { input } = toolInput(c.arguments);
          expect(uses[i]!.input).toEqual(input);
        });
        if (a.refusal) expect(reply.stop_reason).toBe("refusal");
        chatPairs(chatRequest({ messages: nextTurn(reply), tools: TOOLS, context: {} }, "gpt-6-sol"));
      }),
    );
  });
});

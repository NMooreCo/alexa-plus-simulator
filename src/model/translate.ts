import { randomUUID } from "node:crypto";
import { type ModelReply, type ReplyBlock, TurnError } from "./provider.ts";

/**
 * What the Bedrock and OpenAI translations share. The page keeps the
 * conversation in the Messages API's shape; this reads it into plain messages
 * of text, tool calls and tool results that either format can carry, with
 * every call's result in the very next message, as both APIs require. And on
 * the way back, it puts a reply into the Messages API's shape.
 */

/** A text or a call can carry the thought signature Gemini gave it, for Gemini alone to read. */
export type Part =
  | { type: "text"; text: string; signature?: string }
  | { type: "call"; id: string; name: string; input: Record<string, unknown>; signature?: string }
  | { type: "result"; id: string; text: string; isError: boolean };

export interface Message {
  role: "user" | "assistant";
  parts: Part[];
}

type Call = Extract<Part, { type: "call" }>;
type Result = Extract<Part, { type: "result" }>;

/** What a tool result says when it came back empty, in the page's own words. */
const EMPTY_RESULT = "(The tool returned nothing.)";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function bad(message: string): TurnError {
  return new TurnError(400, "bad_request", message);
}

/**
 * The page's conversation as plain messages: blank text and empty messages
 * left out, back-to-back messages from one side joined (Converse wants the
 * roles to take turns), and each tool call answered in the next message. With
 * no tools on offer, calls and results become text, since neither API takes
 * them without tool definitions.
 */
export function readHistory(messages: unknown[], withTools: boolean): Message[] {
  const read = messages.map(readMessage).filter((m) => m.parts.length > 0);
  const paired = pairCalls(joinRoles(read));
  return withTools ? paired : asText(paired);
}

function readMessage(raw: unknown, index: number): Message {
  const where = `Message ${index + 1}`;
  if (!isRecord(raw)) throw bad(`${where} isn't an object.`);
  const { role, content } = raw;
  if (role !== "user" && role !== "assistant") throw bad(`${where} needs a role of user or assistant.`);
  if (typeof content === "string") return { role, parts: content.trim() ? [{ type: "text", text: content }] : [] };
  if (!Array.isArray(content)) throw bad(`${where} needs its content as text or a list of blocks.`);
  const parts: Part[] = [];
  for (const block of content) {
    if (!isRecord(block)) throw bad(`${where} has a block that isn't an object.`);
    const signed = nonEmpty(block.thought_signature) ? { signature: block.thought_signature } : {};
    if (block.type === "text") {
      if (typeof block.text !== "string") throw bad(`${where} has a text block with no text.`);
      if (block.text.trim()) parts.push({ type: "text", text: block.text, ...signed });
    } else if (block.type === "tool_use") {
      if (role !== "assistant" || !nonEmpty(block.id) || !nonEmpty(block.name)) throw bad(`${where} has a tool_use block that isn't the assistant's or has no id and name.`);
      parts.push({ type: "call", id: block.id, name: block.name, input: isRecord(block.input) ? block.input : {}, ...signed });
    } else if (block.type === "tool_result") {
      if (role !== "user" || !nonEmpty(block.tool_use_id)) throw bad(`${where} has a tool_result block that isn't the user's or has no tool_use_id.`);
      parts.push({ type: "result", id: block.tool_use_id, text: resultText(block.content), isError: block.is_error === true });
    }
    // Thinking, redacted thinking and fallback markers are Anthropic's own and mean nothing to
    // another model, and the page sends nothing else, so any other block is left out.
  }
  return { role, parts };
}

/** A tool result as text: the page sends a string, and the Messages API also allows a list of blocks. */
function resultText(content: unknown): string {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((b) => (isRecord(b) && b.type === "text" && typeof b.text === "string" ? b.text : isRecord(b) && b.type === "image" ? "[An image]" : ""))
            .filter(Boolean)
            .join("\n")
        : "";
  return text.trim() ? text : EMPTY_RESULT;
}

function joinRoles(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last?.role === m.role) last.parts.push(...m.parts);
    else out.push({ role: m.role, parts: [...m.parts] });
  }
  return out;
}

/**
 * Every call answered in the next message, and every result answering a call
 * in the message before it. A call with no result (a reply cut off at its
 * token limit, say) gets one saying it didn't run, rather than the provider
 * refusing the whole conversation; a result that answers no call is kept as text.
 */
function pairCalls(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      out.push(m);
      continue;
    }
    const before = out.at(-1);
    out.push({ role: "user", parts: answer(before ? calls(before) : [], m.parts) });
  }
  const last = out.at(-1);
  if (last?.role === "assistant" && calls(last).length) out.push({ role: "user", parts: answer(calls(last), []) });
  return out;
}

function calls(m: Message): Call[] {
  return m.role === "assistant" ? m.parts.filter((p): p is Call => p.type === "call") : [];
}

/** A user message's parts with each call's result first, in the calls' order, then the rest. */
function answer(asked: Call[], parts: Part[]): Part[] {
  const results = new Map<string, Result>();
  const rest: Part[] = [];
  for (const p of parts) {
    if (p.type !== "result") rest.push(p);
    else if (asked.some((c) => c.id === p.id) && !results.has(p.id)) results.set(p.id, p);
    else rest.push({ type: "text", text: `(A tool result that answers no call: ${p.text})` });
  }
  const answered = asked.map((c): Result => results.get(c.id) ?? { type: "result", id: c.id, text: "This call didn't run.", isError: true });
  return [...answered, ...rest];
}

/** Calls and results told as text, for a turn with no tools on offer. */
function asText(messages: Message[]): Message[] {
  const names = new Map(messages.flatMap((m) => calls(m).map((c) => [c.id, c.name] as const)));
  return messages.map((m) => ({
    role: m.role,
    parts: m.parts.map((p): Part => {
      if (p.type === "call") return { type: "text", text: `(Called ${p.name} with ${JSON.stringify(p.input)}.)` };
      if (p.type === "result") return { type: "text", text: `(${names.get(p.id) ?? "The tool"} ${p.isError ? "failed" : "answered"}: ${p.text})` };
      return p;
    }),
  }));
}

/**
 * What a model said, without the reasoning some write into their text (Amazon
 * Nova's <thinking> around a tool call, a local reasoning model's <think>),
 * which isn't for saying aloud. A tag left open runs to the end.
 */
export function spoken(text: string): string {
  return text.replace(/<(thinking|think)>[\s\S]*?(?:<\/\1>|$)/gi, "").trim();
}

/**
 * A tool call's arguments as an object. OpenAI sends them as a JSON string the
 * model wrote, which isn't always valid; arguments that aren't a JSON object
 * become none, with the problem said.
 */
export function toolInput(raw: unknown): { input: Record<string, unknown>; problem?: string } {
  if (isRecord(raw)) return { input: raw };
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return { input: {} };
  if (typeof raw !== "string") return { input: {}, problem: "weren't a JSON object" };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { input: parsed } : { input: {}, problem: "weren't a JSON object" };
  } catch {
    return { input: {}, problem: "weren't valid JSON" };
  }
}

/** The note that goes before a call whose arguments couldn't be read, so whoever reads the conversation knows why the tool got none. */
export function inputNote(name: string, problem: string): ReplyBlock {
  return { type: "text", text: `(The model's arguments for ${name} ${problem}, so the simulator calls it with none.)` };
}

/** A token count, or 0 for anything that isn't one. */
export function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** A fresh id, for a reply or a call that came without one. */
export function newId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

/**
 * The reply in the Messages API's shape. A reply with tool calls stops for
 * them (the page runs tools only on tool_use, and some servers say "stop" even
 * then); one without stops at the end of its turn, unless it ran out of room
 * or was refused.
 */
export function messageReply(fields: Pick<ModelReply, "id" | "model" | "content" | "stop_reason" | "usage">): ModelReply {
  const hasCalls = fields.content.some((b) => b.type === "tool_use");
  const stop = fields.stop_reason === "end_turn" || fields.stop_reason === "tool_use" ? (hasCalls ? "tool_use" : "end_turn") : fields.stop_reason;
  return { id: fields.id, type: "message", role: "assistant", model: fields.model, content: fields.content, stop_reason: stop, stop_sequence: null, usage: fields.usage };
}

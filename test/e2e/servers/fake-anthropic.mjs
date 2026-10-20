// A stand-in for the Claude API's Messages endpoint, so the browser tests can
// talk to the simulator end to end without a key or a network. It answers as a
// model would on the tasks example: asked anything, it calls show_tasks; given
// the result, it says one line and asks a question back, so a turn asked by
// voice has an answer to listen for.
//
//   node test/e2e/servers/fake-anthropic.mjs [--port 6382]
//
// The simulator under test runs with ANTHROPIC_API_KEY=test and
// ANTHROPIC_BASE_URL pointing here. What its model route sends is checked as
// the real API would check it (the key, the version header, a tool_result for
// every tool_use), so a request the real API would refuse is refused here too,
// with the reason, and the test that sent it fails saying why.
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const KEY = "test";
// The browser tests expect these words (test/e2e/talking.spec.ts).
const ANSWER = "That's your list. Want me to check one off?";

let turns = 0;

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

function refuse(response, status, type, message) {
  send(response, status, { type: "error", error: { type, message } });
}

function blocks(message) {
  if (Array.isArray(message?.content)) return message.content;
  return typeof message?.content === "string" ? [{ type: "text", text: message.content }] : [];
}

/** The model's next turn, or why the real API would refuse the request. */
function nextTurn(body) {
  const last = body.messages.at(-1);
  if (last?.role !== "user") return { error: "The last message must be the user's." };
  const results = blocks(last).filter((b) => b.type === "tool_result");
  if (results.length) {
    const asked = blocks(body.messages.at(-2))
      .filter((b) => b.type === "tool_use")
      .map((b) => b.id);
    const missing = asked.filter((id) => !results.some((r) => r.tool_use_id === id));
    if (!asked.length || missing.length) return { error: `Each tool_result needs the tool_use before it, and each tool_use its tool_result; missing: ${missing.join(", ") || "the tool_use"}.` };
    const failed = results.some((r) => r.is_error);
    return { stop: "end_turn", content: [{ type: "text", text: failed ? "The list didn't come back." : ANSWER }] };
  }
  const tool = (body.tools ?? []).find((t) => t.name === "show_tasks");
  if (!tool) return { stop: "end_turn", content: [{ type: "text", text: "There's no list to show." }] };
  return { stop: "tool_use", content: [{ type: "tool_use", id: `toolu_e2e_${turns}`, name: tool.name, input: {} }] };
}

async function handle(request, response) {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "POST" || path !== "/v1/messages") return refuse(response, 404, "not_found_error", `This stand-in only answers POST /v1/messages, not ${request.method} ${path}.`);
  if (request.headers["x-api-key"] !== KEY) return refuse(response, 401, "authentication_error", "invalid x-api-key");
  if (!request.headers["anthropic-version"]) return refuse(response, 400, "invalid_request_error", "anthropic-version: header is required");
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return refuse(response, 400, "invalid_request_error", "The body isn't JSON.");
  }
  if (typeof body?.model !== "string" || typeof body.max_tokens !== "number" || !Array.isArray(body.messages) || !body.messages.length) {
    return refuse(response, 400, "invalid_request_error", "model, max_tokens and messages are required.");
  }
  // Teach it to stream before the simulator asks for a stream, or every talking test fails here, saying so.
  if (body.stream) return refuse(response, 400, "invalid_request_error", "This stand-in doesn't stream.");
  turns++;
  const turn = nextTurn(body);
  if (turn.error) return refuse(response, 400, "invalid_request_error", turn.error);
  send(response, 200, {
    id: `msg_e2e_${turns}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: turn.content,
    stop_reason: turn.stop,
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
}

const { values } = parseArgs({ options: { port: { type: "string", default: "6382" } } });
const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (!response.headersSent) refuse(response, 500, "api_error", error instanceof Error ? error.message : String(error));
    else response.destroy();
  });
});
server.listen(Number(values.port), "127.0.0.1", () => console.log(`The stand-in for the Claude API is at http://127.0.0.1:${values.port}`));

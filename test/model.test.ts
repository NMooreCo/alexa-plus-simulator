import { describe, expect, it, vi } from "vitest";
import { modelRoute, systemBlocks, VOICE } from "../src/model/index.ts";

const turn = (body: unknown) => new Request("http://localhost:6277/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const reply = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "Here's today." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 4 } };

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** A stand-in for Anthropic that answers every request with `answer` and keeps what it was sent. */
function anthropic(answer: () => Response = () => Response.json(reply)) {
  const sent: Sent[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, any> });
    return answer();
  };
  return { sent, fetch };
}

const apiError = (status: number, type: string) => () => Response.json({ type: "error", error: { type, message: type } }, { status, headers: { "retry-after": "0" } });

describe("the model route", () => {
  it("says plainly that a key is needed, and that the Tools panel works without one", async () => {
    const res = await modelRoute({})(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: "no_key" } });
  });

  it("asks Claude Opus 5.5 at low effort, with the refusal fallback, the voice rules cached and the turn's details after them", async () => {
    const api = anthropic();
    const res = await modelRoute({ apiKey: "key", fetch: api.fetch })(
      turn({
        messages: [{ role: "user", content: "What's on today?" }],
        tools: [{ name: "show_today", description: "Show today", input_schema: { type: "object" } }],
        context: { instructions: "This server runs a household.", device: "Echo Show 8", screen: true, timeZone: "America/Denver", now: "Tuesday at 7 PM" },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: [{ type: "text", text: "Here's today." }] });
    const sent = api.sent[0]!;
    expect(new URL(sent.url).pathname).toBe("/v1/messages");
    expect(sent.headers.get("x-api-key")).toBe("key");
    expect(sent.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(sent.body).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", output_config: { effort: "low" }, tools: [{ name: "show_today" }] });
    expect(sent.body.system[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(sent.body.system[0].text).toContain("This server runs a household.");
    expect(sent.body.system[1].text).toContain("Echo Show 8");
    expect(sent.body.system[1].text).toContain("America/Denver");
    expect(sent.body.system[1].cache_control).toBeUndefined();
  });

  it("can leave the fallback off for a gateway that doesn't pass it through, and takes another model and base URL", async () => {
    const api = anthropic();
    await modelRoute({ apiKey: "key", fallbacks: false, model: "claude-sonnet-5-5", baseURL: "https://gateway.example", fetch: api.fetch })(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }));
    const url = new URL(api.sent[0]!.url);
    expect(url.origin + url.pathname).toBe("https://gateway.example/v1/messages");
    expect(api.sent[0]!.body.fallbacks).toBeUndefined();
    expect(api.sent[0]!.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
    expect(api.sent[0]!.body.model).toBe("claude-sonnet-5-5");
  });

  it("tells a device with no screen to say it all in words", () => {
    expect(systemBlocks({ screen: false, device: "Echo Dot" })[1]!.text).toContain("It has no screen");
    expect(systemBlocks({ screen: true })[1]!.text).not.toContain("no screen");
    expect(systemBlocks({})[0]!.text).toBe(VOICE);
  });

  it("refuses a malformed or oversized turn before it costs anything", async () => {
    const fetch = vi.fn();
    const route = modelRoute({ apiKey: "key", fetch });
    expect((await route(turn({ messages: [], tools: [] }))).status).toBe(400);
    expect((await route(turn({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "bad name!", input_schema: {} }] }))).status).toBe(400);
    expect((await route(turn({ messages: [{ role: "user", content: "x".repeat(400_001) }], tools: [] }))).status).toBe(400);
    expect((await route(new Request("http://localhost/api/model", { method: "POST", body: "not json" }))).status).toBe(400);
    expect((await route(new Request("http://localhost/api/model", { method: "GET" }))).status).toBe(405);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says what went wrong with the key, the rate limit or the request", async () => {
    const ask = (answer: () => Response) => modelRoute({ apiKey: "key", fetch: anthropic(answer).fetch })(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }));
    const bad = await ask(apiError(401, "authentication_error"));
    expect(bad.status).toBe(502);
    expect(await bad.json()).toMatchObject({ error: { code: "model_key" } });
    expect((await ask(apiError(429, "rate_limit_error"))).status).toBe(429);
    expect(await (await ask(apiError(400, "invalid_request_error"))).json()).toMatchObject({ error: { code: "bad_request" } });
    expect(await (await ask(apiError(529, "overloaded_error"))).json()).toMatchObject({ error: { code: "model_error" } });
  });
});

import { describe, expect, it, vi } from "vitest";
import { chooseProvider, modelOptionsFromEnv, modelRoute, setUpModel, systemBlocks, VOICE } from "../src/model/index.ts";

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
  it("says plainly that credentials are needed, naming every provider's (the page adds that the Tools tab works without them)", async () => {
    const res = await modelRoute({})(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("no_key");
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_FOUNDRY_API_KEY",
      "ANTHROPIC_FOUNDRY_RESOURCE",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "GEMINI_API_KEY",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ]) {
      expect(body.error.message).toContain(name);
    }
    expect(body.error.message).not.toContain("Tools");
  });

  it("asks Claude Opus 5.5 at low effort, with the refusal fallback, the voice rules cached and the turn's details after them", async () => {
    const api = anthropic();
    const res = await modelRoute({ anthropic: { apiKey: "key" }, fetch: api.fetch })(
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
    await modelRoute({ anthropic: { apiKey: "key", fallbacks: false, baseURL: "https://gateway.example" }, model: "claude-sonnet-5-5", fetch: api.fetch })(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }));
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
    for (const options of [
      { anthropic: { apiKey: "key" } },
      { foundry: { apiKey: "key", resource: "example-resource" } },
      { bedrock: { bearerToken: "key" } },
      { gemini: { apiKey: "key" } },
      { openai: { apiKey: "key" } },
    ]) {
      const route = modelRoute({ ...options, fetch });
      expect((await route(turn({ messages: [], tools: [] }))).status).toBe(400);
      expect((await route(turn({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "bad name!", input_schema: {} }] }))).status).toBe(400);
      expect((await route(turn({ messages: [{ role: "user", content: "x".repeat(400_001) }], tools: [] }))).status).toBe(400);
      expect((await route(new Request("http://localhost/api/model", { method: "POST", body: "not json" }))).status).toBe(400);
      expect((await route(new Request("http://localhost/api/model", { method: "GET" }))).status).toBe(405);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses messages another provider couldn't read, without calling it", async () => {
    const fetch = vi.fn();
    const route = modelRoute({ openai: { apiKey: "key" }, fetch });
    for (const messages of [["hi"], [{ role: "system", content: "hi" }], [{ role: "user", content: 7 }], [{ role: "user", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }]]) {
      const res = await route(turn({ messages, tools: [] }));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says what went wrong with the key, the rate limit or the request", async () => {
    const ask = (answer: () => Response) => modelRoute({ anthropic: { apiKey: "key" }, fetch: anthropic(answer).fetch })(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }));
    const bad = await ask(apiError(401, "authentication_error"));
    expect(bad.status).toBe(502);
    expect(await bad.json()).toMatchObject({ error: { code: "model_key" } });
    expect((await ask(apiError(429, "rate_limit_error"))).status).toBe(429);
    expect(await (await ask(apiError(400, "invalid_request_error"))).json()).toMatchObject({ error: { code: "bad_request" } });
    expect(await (await ask(apiError(529, "overloaded_error"))).json()).toMatchObject({ error: { code: "model_error" } });
  });

  it.each([
    ["Anthropic", { anthropic: { apiKey: "key" } }],
    ["Gemini", { gemini: { apiKey: "key" } }],
    ["OpenAI", { openai: { apiKey: "key" } }],
  ] as const)("gives up on a turn %s doesn't answer in time, says so, and stops the request", async (_, credentials) => {
    let stopped = false;
    // A provider that takes the request and never answers, until it's told to stop.
    const hung = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          stopped = true;
          reject(init.signal!.reason);
        });
      });
    const started = Date.now();
    const res = await modelRoute({ ...credentials, fetch: hung, turnTimeoutMs: 100, retryDelayMs: 0 })(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }));
    expect(res.status).toBe(504);
    expect(await res.json()).toEqual({ error: { code: "timeout", message: "The model didn't answer within 1 second. Try again." } });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(stopped).toBe(true);
  });
});

describe("choosing the model", () => {
  const env = {
    anthropic: { ANTHROPIC_API_KEY: "sk-ant" },
    bedrockKey: { AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key" },
    bedrockIam: { AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", AWS_SECRET_ACCESS_KEY: "secret" },
    openai: { OPENAI_API_KEY: "sk-openai" },
    local: { OPENAI_BASE_URL: "http://localhost:11434/v1" },
    foundry: { ANTHROPIC_FOUNDRY_API_KEY: "foundry-key", ANTHROPIC_FOUNDRY_RESOURCE: "example-resource" },
    gemini: { GEMINI_API_KEY: "gemini-key" },
  };
  const choose = (vars: Record<string, string>, flags: Parameters<typeof modelOptionsFromEnv>[1] = {}) => chooseProvider(modelOptionsFromEnv(vars, flags));

  it("takes the first provider with credentials: Anthropic, Microsoft Foundry, Bedrock, Gemini, then OpenAI", () => {
    const all = { ...env.openai, ...env.gemini, ...env.bedrockKey, ...env.foundry, ...env.anthropic };
    expect(choose({})).toBeNull();
    expect(choose(all)).toBe("anthropic");
    expect(choose({ ...all, ANTHROPIC_API_KEY: "" })).toBe("foundry");
    expect(choose({ ...env.openai, ...env.gemini, ...env.bedrockKey })).toBe("bedrock");
    expect(choose({ ...env.openai, ...env.gemini, ...env.bedrockIam })).toBe("bedrock");
    expect(choose({ ...env.openai, ...env.gemini })).toBe("gemini");
    expect(choose({ ...env.openai, GOOGLE_API_KEY: "google-key" })).toBe("gemini");
    expect(choose(env.openai)).toBe("openai");
    // A local server needs no key, only its address.
    expect(choose(env.local)).toBe("openai");
    // Half of an IAM key pair isn't credentials, nor is a Foundry key without its resource, and an empty variable is no variable.
    expect(choose({ AWS_ACCESS_KEY_ID: "AKIDEXAMPLE", ANTHROPIC_FOUNDRY_API_KEY: "foundry-key", ANTHROPIC_API_KEY: "" })).toBeNull();
    // A Foundry resource answers to an Entra ID token as well as its key.
    expect(choose({ ANTHROPIC_FOUNDRY_BASE_URL: "https://example-resource.services.ai.azure.com/anthropic/", AZURE_OPENAI_AUTH_TOKEN: "entra-token" })).toBe("foundry");
  });

  it("uses the provider it's told to, and only with its own credentials", () => {
    expect(choose({ ...env.anthropic, ...env.openai }, { provider: "openai" })).toBe("openai");
    expect(choose({ ...env.anthropic, ...env.gemini }, { provider: "gemini" })).toBe("gemini");
    expect(choose(env.anthropic, { provider: "bedrock" })).toBeNull();
  });

  it("takes GOOGLE_API_KEY over GEMINI_API_KEY when both are set, as Google's libraries do", () => {
    expect(modelOptionsFromEnv({ GEMINI_API_KEY: "gemini-key", GOOGLE_API_KEY: "google-key" }).gemini?.apiKey).toBe("google-key");
    expect(modelOptionsFromEnv({ GEMINI_API_KEY: "gemini-key" }).gemini?.apiKey).toBe("gemini-key");
  });

  it("names what a chosen provider still needs, and only that", async () => {
    const said = async (setup: ReturnType<typeof setUpModel>) => ((await (await setup.route(turn({ messages: [{ role: "user", content: "hi" }], tools: [] }))).json()) as { error: { message: string } }).error.message;
    const bedrock = setUpModel({ provider: "bedrock" });
    expect(bedrock).toMatchObject({ provider: null, model: null, label: null });
    expect(bedrock.summary).toBe("none: set AWS_BEARER_TOKEN_BEDROCK (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) for Bedrock to talk (the Tools tab works without one)");
    expect(await said(bedrock)).toBe("Set AWS_BEARER_TOKEN_BEDROCK (or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY) for Bedrock to talk to the simulator.");
    expect(await said(setUpModel({ provider: "anthropic" }))).toBe("Set ANTHROPIC_API_KEY for Anthropic to talk to the simulator.");
    expect(await said(setUpModel({ provider: "foundry" }))).toBe(
      "Set ANTHROPIC_FOUNDRY_API_KEY (or AZURE_OPENAI_AUTH_TOKEN) and ANTHROPIC_FOUNDRY_RESOURCE (or ANTHROPIC_FOUNDRY_BASE_URL) for Microsoft Foundry to talk to the simulator.",
    );
    expect(await said(setUpModel({ provider: "gemini" }))).toBe("Set GEMINI_API_KEY (or GOOGLE_API_KEY) for Gemini to talk to the simulator.");
    // A Foundry key without its resource isn't enough.
    expect(setUpModel(modelOptionsFromEnv({ ANTHROPIC_FOUNDRY_API_KEY: "key" }, { provider: "foundry" })).provider).toBeNull();
    expect(setUpModel({}).summary).toMatch(/^none: set ANTHROPIC_API_KEY; ANTHROPIC_FOUNDRY_API_KEY and ANTHROPIC_FOUNDRY_RESOURCE/);
  });

  it("calls each model something readable, and says where it runs", () => {
    const setUp = (vars: Record<string, string>, flags: Parameters<typeof modelOptionsFromEnv>[1] = {}) => setUpModel(modelOptionsFromEnv(vars, flags));
    expect(setUp(env.anthropic)).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5", label: "Claude (claude-opus-5-5)", summary: "Claude (claude-opus-5-5) through Anthropic" });
    expect(setUp({ ...env.anthropic, ANTHROPIC_BASE_URL: "https://gateway.example" }).summary).toBe("Claude (claude-opus-5-5) through https://gateway.example");
    expect(setUp(env.bedrockKey)).toMatchObject({
      provider: "bedrock",
      model: "global.amazon.nova-2-lite-v1:0",
      label: "Amazon Nova 2 Lite on Bedrock (global.amazon.nova-2-lite-v1:0)",
      summary: "Amazon Nova 2 Lite on Bedrock (global.amazon.nova-2-lite-v1:0) in us-east-1, with a Bedrock API key",
    });
    expect(setUp(env.bedrockIam, { model: "us.amazon.nova-pro-v1:0", region: "us-west-2" })).toMatchObject({
      label: "Amazon Nova Pro on Bedrock (us.amazon.nova-pro-v1:0)",
      summary: "Amazon Nova Pro on Bedrock (us.amazon.nova-pro-v1:0) in us-west-2, with IAM credentials",
    });
    expect(setUp(env.bedrockKey, { model: "us.anthropic.claude-sonnet-5-5" }).label).toBe("Claude on Bedrock (us.anthropic.claude-sonnet-5-5)");
    expect(setUp(env.bedrockKey, { model: "meta.llama3-3-70b-instruct-v1:0" }).label).toBe("Llama on Bedrock (meta.llama3-3-70b-instruct-v1:0)");
    expect(setUp(env.bedrockKey, { model: "arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/a1b2c3" }).label).toBe(
      "A model on Bedrock (arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/a1b2c3)",
    );
    expect(setUp(env.openai)).toMatchObject({ provider: "openai", model: "gpt-6-sol", label: "OpenAI (gpt-6-sol)", summary: "OpenAI (gpt-6-sol)" });
    expect(setUp(env.local, { model: "llama3.2" })).toMatchObject({
      label: "OpenAI-compatible server at localhost:11434 (llama3.2)",
      summary: "OpenAI-compatible server at localhost:11434 (llama3.2), through http://localhost:11434/v1/chat/completions",
    });
    // A blank --model is no --model.
    expect(setUp(env.openai, { model: "  " }).model).toBe("gpt-6-sol");
    expect(setUp(env.foundry)).toMatchObject({
      provider: "foundry",
      model: "claude-opus-5-5",
      label: "Claude on Microsoft Foundry (claude-opus-5-5)",
      summary: "Claude on Microsoft Foundry (claude-opus-5-5) at example-resource.services.ai.azure.com, with an API key",
    });
    expect(setUp(env.foundry, { model: "DeepSeek-V3.2" }).label).toBe("DeepSeek on Microsoft Foundry (DeepSeek-V3.2)");
    expect(setUp(env.foundry, { model: "gpt-5.6-sol" }).label).toBe("OpenAI on Microsoft Foundry (gpt-5.6-sol)");
    // A deployment whose name doesn't say what it is speaks the API it's told to.
    expect(setUp(env.foundry, { model: "voice-prod", foundryApi: "anthropic" }).label).toBe("Claude on Microsoft Foundry (voice-prod)");
    expect(setUp(env.foundry, { model: "voice-prod" }).label).toBe("A model on Microsoft Foundry (voice-prod)");
    expect(setUp(env.gemini)).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash", label: "Gemini (gemini-3.8-flash)", summary: "Gemini (gemini-3.8-flash)" });
    expect(setUp({ ...env.gemini, GOOGLE_GEMINI_BASE_URL: "https://gateway.example/google/" }).summary).toBe("Gemini (gemini-3.8-flash), through https://gateway.example");
  });

  it("reads Bedrock's region from --region, then AWS_REGION, then AWS_DEFAULT_REGION", () => {
    const region = (vars: Record<string, string>, flag?: string) => modelOptionsFromEnv({ ...env.bedrockKey, ...vars }, { region: flag }).bedrock?.region;
    expect(region({ AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "ap-southeast-2" }, "us-west-2")).toBe("us-west-2");
    expect(region({ AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "ap-southeast-2" })).toBe("eu-west-1");
    expect(region({ AWS_DEFAULT_REGION: "ap-southeast-2" })).toBe("ap-southeast-2");
    expect(setUpModel(modelOptionsFromEnv(env.bedrockKey)).summary).toContain(" in us-east-1,");
  });

  it("stops at the start on a Region or base URL that can't work", () => {
    expect(() => setUpModel(modelOptionsFromEnv({ ...env.bedrockKey, AWS_REGION: "evil.example/x?" }))).toThrow(/AWS Region/);
    expect(() => setUpModel(modelOptionsFromEnv({ OPENAI_BASE_URL: "localhost:11434" }))).toThrow(/OPENAI_BASE_URL/);
    expect(() => setUpModel(modelOptionsFromEnv({ OPENAI_API_KEY: "sk", OPENAI_BASE_URL: "not a url" }))).toThrow(/OPENAI_BASE_URL/);
    // A Foundry resource's name goes into a host name, so it's only letters, digits and dashes; and it's the name or the URL, as Anthropic's client takes them.
    expect(() => setUpModel(modelOptionsFromEnv({ ...env.foundry, ANTHROPIC_FOUNDRY_RESOURCE: "evil.example/x" }))).toThrow(/Foundry resource name/);
    expect(() => setUpModel(modelOptionsFromEnv({ ...env.foundry, ANTHROPIC_FOUNDRY_BASE_URL: "https://example-resource.services.ai.azure.com/anthropic/" }))).toThrow(/not both/);
    expect(() => setUpModel(modelOptionsFromEnv({ ...env.gemini, GOOGLE_GEMINI_BASE_URL: "nope" }))).toThrow(/GOOGLE_GEMINI_BASE_URL/);
    // A bad setting for a provider that isn't answering doesn't matter.
    expect(setUpModel(modelOptionsFromEnv({ ...env.anthropic, AWS_REGION: "nowhere", OPENAI_BASE_URL: "nope" })).provider).toBe("anthropic");
  });
});

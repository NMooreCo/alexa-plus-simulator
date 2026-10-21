import { afterEach, describe, expect, it, vi } from "vitest";
import { foundryApi } from "../src/model/foundry.ts";
import { type ModelOptions, modelRoute } from "../src/model/index.ts";

/**
 * Microsoft Foundry, against responses in the shapes Anthropic's Foundry guide,
 * Anthropic's API reference and Azure OpenAI's reference document (no live
 * calls: there are no credentials here).
 */

const turn = (body: unknown) => new Request("http://localhost:6277/api/model", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** Where a request went, without the ?beta=true that Anthropic's client adds for its beta Messages call (which Foundry serves too). */
const path = (url: string) => {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
};

interface Sent {
  url: string;
  headers: Headers;
  body: Record<string, any>;
}

/** A stand-in for Foundry that gives each answer in turn (the last one again after that) and keeps what it was sent. */
function foundry(...answers: (() => Response | Promise<Response>)[]) {
  const sent: Sent[] = [];
  let next = 0;
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    sent.push({ url: req.url, headers: req.headers, body: (await req.json()) as Record<string, any> });
    return answers[Math.min(next++, answers.length - 1)]!();
  };
  return { sent, fetch };
}

/** Claude's reply, as the Messages API gives it on Foundry. */
const claudeReply = {
  id: "msg_01XFDUDYJgAACzvnptvVoYEL",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [{ type: "text", text: "You have three things on today's list." }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 812, output_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
};

/** A chat completion as Azure OpenAI gives one, with its content filter results, here with two tool calls. */
const chatReply = {
  choices: [
    {
      content_filter_results: {},
      finish_reason: "tool_calls",
      index: 0,
      logprobs: null,
      message: {
        annotations: [],
        content: null,
        refusal: null,
        role: "assistant",
        tool_calls: [
          { function: { arguments: "{}", name: "show_today" }, id: "call_Ub3nO6NBf9GRDoAWyc5kU9Zg", type: "function" },
          { function: { arguments: '{"city":"Denver"}', name: "get_weather" }, id: "call_qVGo5L0zHqGkS1xFjNgJ1CvP", type: "function" },
        ],
      },
    },
  ],
  created: 1760990000,
  id: "chatcmpl-CXsWy2nTq3kbH1bTXUm0IWMp1i2fA",
  model: "gpt-5.6-sol-2026-07-09",
  object: "chat.completion",
  prompt_filter_results: [{ prompt_index: 0, content_filter_results: { hate: { filtered: false, severity: "safe" } } }],
  usage: { completion_tokens: 41, prompt_tokens: 920, total_tokens: 961, prompt_tokens_details: { cached_tokens: 0 } },
};

/** An error the way Azure's front door sends one, quick to retry in tests. */
const azureError = (status: number, code: string, message: string) => () => Response.json({ error: { code, message } }, { status, headers: { "retry-after": "0", "retry-after-ms": "0" } });

const tools = [
  { name: "show_today", description: "Show today's list", input_schema: { type: "object", properties: {} } },
  { name: "get_weather", description: "The weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
];
const ask = () => turn({ messages: [{ role: "user", content: "What's on today?" }], tools, context: { device: "Echo Show 8", screen: true } });
const resource = { resource: "example-resource", apiKey: "foundry-key" };

describe("Microsoft Foundry", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends a Claude deployment's turn to the resource's Anthropic endpoint with the key, and never asks for Anthropic's refusal fallback", async () => {
    const api = foundry(() => Response.json(claudeReply));
    const res = await modelRoute({ foundry: resource, fetch: api.fetch })(ask());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ content: [{ type: "text", text: "You have three things on today's list." }], stop_reason: "end_turn" });
    const sent = api.sent[0]!;
    expect(path(sent.url)).toBe("https://example-resource.services.ai.azure.com/anthropic/v1/messages");
    expect(sent.headers.get("x-api-key")).toBe("foundry-key");
    expect(sent.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent.headers.get("authorization")).toBeNull();
    // Foundry doesn't offer the server-side fallback, so neither its beta nor its parameter goes.
    expect(sent.headers.get("anthropic-beta") ?? "").not.toContain("server-side-fallback");
    expect(sent.body.fallbacks).toBeUndefined();
    expect(sent.body).toMatchObject({ model: "claude-opus-5-5", output_config: { effort: "low" }, tools: [{ name: "show_today" }, { name: "get_weather" }] });
    expect(sent.body.system[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
  });

  it("sends an Entra ID token as a bearer token, and takes the resource's base URL instead of its name", async () => {
    const api = foundry(() => Response.json(claudeReply));
    await modelRoute({ foundry: { baseURL: "https://example-resource.services.ai.azure.com/anthropic/", token: "entra-token" }, fetch: api.fetch })(ask());
    expect(path(api.sent[0]!.url)).toBe("https://example-resource.services.ai.azure.com/anthropic/v1/messages");
    expect(api.sent[0]!.headers.get("authorization")).toBe("Bearer entra-token");
    expect(api.sent[0]!.headers.get("x-api-key")).toBeNull();
  });

  it("goes only where it was told, whatever ANTHROPIC_FOUNDRY_* says in this process's own environment", async () => {
    // Anthropic's Foundry client reads these itself for anything left out; the simulator gives it everything.
    vi.stubEnv("ANTHROPIC_FOUNDRY_RESOURCE", "someone-elses-resource");
    vi.stubEnv("ANTHROPIC_FOUNDRY_BASE_URL", "https://elsewhere.example/anthropic/");
    vi.stubEnv("ANTHROPIC_FOUNDRY_API_KEY", "someone-elses-key");
    const api = foundry(() => Response.json(claudeReply));
    const res = await modelRoute({ foundry: resource, fetch: api.fetch })(ask());
    expect(res.status).toBe(200);
    expect(path(api.sent[0]!.url)).toBe("https://example-resource.services.ai.azure.com/anthropic/v1/messages");
    expect(api.sent[0]!.headers.get("x-api-key")).toBe("foundry-key");
  });

  it("sends any other deployment to the resource's OpenAI-compatible endpoint, with the key as a bearer token", async () => {
    const api = foundry(() => Response.json(chatReply));
    const res = await modelRoute({ foundry: resource, model: "gpt-5.6-sol", fetch: api.fetch, retryDelayMs: 0 })(ask());
    const sent = api.sent[0]!;
    expect(sent.url).toBe("https://example-resource.services.ai.azure.com/openai/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer foundry-key");
    // The deployment's name is the model, and it's a GPT-5 deployment, so it gets GPT-5's low reasoning effort.
    expect(sent.body).toMatchObject({ model: "gpt-5.6-sol", reasoning_effort: "low", max_completion_tokens: 8192 });
    expect(sent.body.messages[0].role).toBe("system");
    expect(await res.json()).toMatchObject({
      model: "gpt-5.6-sol-2026-07-09",
      content: [
        { type: "tool_use", id: "call_Ub3nO6NBf9GRDoAWyc5kU9Zg", name: "show_today", input: {} },
        { type: "tool_use", id: "call_qVGo5L0zHqGkS1xFjNgJ1CvP", name: "get_weather", input: { city: "Denver" } },
      ],
      stop_reason: "tool_use",
    });
    // An Entra ID token goes the same way there.
    const entra = foundry(() => Response.json(chatReply));
    await modelRoute({ foundry: { resource: "example-resource", token: "entra-token" }, model: "DeepSeek-V3.2", fetch: entra.fetch })(ask());
    expect(entra.sent[0]!.headers.get("authorization")).toBe("Bearer entra-token");
    expect(entra.sent[0]!.body.reasoning_effort).toBeUndefined();
  });

  it("picks the API from the deployment's name, and takes --foundry-api over it", async () => {
    expect(foundryApi("claude-opus-5-5")).toBe("anthropic");
    expect(foundryApi("my-claude-deployment")).toBe("anthropic");
    expect(foundryApi("gpt-6-sol")).toBe("openai");
    expect(foundryApi("Llama-4-Maverick-17B-128E-Instruct-FP8")).toBe("openai");
    expect(foundryApi("voice-prod", "anthropic")).toBe("anthropic");
    expect(foundryApi("claude-as-a-name-for-gpt", "openai")).toBe("openai");
    const api = foundry(() => Response.json(claudeReply));
    await modelRoute({ foundry: { ...resource, api: "anthropic" }, model: "voice-prod", fetch: api.fetch })(ask());
    expect(new URL(api.sent[0]!.url).pathname).toBe("/anthropic/v1/messages");
    expect(api.sent[0]!.body.model).toBe("voice-prod");
  });

  it("says what went wrong with a Claude deployment in Foundry's own words: the key, the deployment, the rate limit or the request", async () => {
    const tryWith = async (...answers: (() => Response)[]) => {
      const api = foundry(...answers);
      const res = await modelRoute({ foundry: resource, fetch: api.fetch })(ask());
      return { status: res.status, error: ((await res.json()) as { error: { code: string; message: string } }).error, tries: api.sent.length };
    };
    const key = await tryWith(azureError(401, "401", "Access denied due to invalid subscription key or wrong API endpoint. Make sure to provide a valid key for an active subscription and use a correct regional API endpoint for your resource."));
    expect(key).toMatchObject({ status: 502, error: { code: "model_key" }, tries: 1 });
    expect(key.error.message).toMatch(/^Microsoft Foundry didn't accept the credentials \(or they can't use this deployment\): Access denied/);
    const missing = await tryWith(azureError(404, "DeploymentNotFound", "The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again."));
    expect(missing).toMatchObject({ status: 502, error: { code: "model_error" } });
    expect(missing.error.message).toBe("Microsoft Foundry answered 404: The API deployment for this resource does not exist. If you created the deployment within the last 5 minutes, please wait a moment and try again.");
    // Rate limited twice: Anthropic's client tries once more, then the page hears it.
    const limited = await tryWith(azureError(429, "429", "Requests to the Messages API have exceeded call rate limit of your current pricing tier. Please retry after 2 seconds."));
    expect(limited).toMatchObject({ status: 429, error: { code: "rate_limited" }, tries: 2 });
    const invalid = await tryWith(() => Response.json({ type: "error", error: { type: "invalid_request_error", message: "messages: roles must alternate" } }, { status: 400 }));
    expect(invalid).toMatchObject({ status: 400, error: { code: "bad_request", message: "Microsoft Foundry didn't accept the request: messages: roles must alternate." } });
  });

  it("says what went wrong with another deployment as Foundry, not as OpenAI", async () => {
    const tryWith = async (answer: () => Response) => {
      const api = foundry(answer);
      const res = await modelRoute({ foundry: resource, model: "gpt-5.6-sol", fetch: api.fetch, retryDelayMs: 0 })(ask());
      return { status: res.status, error: ((await res.json()) as { error: { code: string; message: string } }).error };
    };
    expect(await tryWith(azureError(401, "401", "Access denied due to invalid subscription key or wrong API endpoint."))).toMatchObject({
      status: 502,
      error: { code: "model_key", message: "Microsoft Foundry didn't accept the API key (or it can't use this model): Access denied due to invalid subscription key or wrong API endpoint." },
    });
    // Azure's content filter refuses a prompt with a 400 of its own.
    const filtered = () =>
      Response.json(
        {
          error: {
            message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy. Please modify your prompt and retry.",
            type: null,
            param: "prompt",
            code: "content_filter",
            status: 400,
            innererror: { code: "ResponsibleAIPolicyViolation" },
          },
        },
        { status: 400 },
      );
    expect(await tryWith(filtered)).toMatchObject({ status: 400, error: { code: "bad_request" } });
    expect(await tryWith(azureError(429, "429", "Rate limit is exceeded. Try again in 1 seconds."))).toMatchObject({ status: 429, error: { code: "rate_limited" } });
  });

  it("names the provider's variables when it has no credentials, and refuses a setting that can't work", async () => {
    const res = await modelRoute({ provider: "foundry", foundry: { resource: "example-resource" } } satisfies ModelOptions)(ask());
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("ANTHROPIC_FOUNDRY_API_KEY");
    expect(() => modelRoute({ foundry: { resource: "a.b", apiKey: "k" } })).toThrow(/Foundry resource name/);
    expect(() => modelRoute({ foundry: { baseURL: "ftp://example-resource/anthropic", apiKey: "k" } })).toThrow(/http or https/);
  });
});

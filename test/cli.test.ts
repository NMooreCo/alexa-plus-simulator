import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error The example is plain JavaScript.
import { startExample } from "../examples/tasks/server.mjs";
import { examplePhrases, type Io, main, withRules } from "../src/run.ts";
import type { ReadinessReport, RuleResult } from "../src/shared/contract.ts";
import { FakeAuth } from "./fake-auth.ts";

function capture(env: Record<string, string | undefined> = {}, openBrowser?: (url: string) => unknown) {
  const out: string[] = [];
  const err: string[] = [];
  let stop!: () => void;
  let started!: (urls: { url: string; uiUrl: string }) => void;
  const running = new Promise<{ url: string; uiUrl: string }>((r) => (started = r));
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), env, stopped: new Promise<void>((r) => (stop = r)), started, ...(openBrowser ? { openBrowser } : {}) };
  return { io, out, err, stop, running };
}

const ACCEPT = { "content-type": "application/json", accept: "application/json" };

/** A server behind a gateway that refuses any request without a header of its own, as one behind an access proxy does. */
async function startGateway(target: string, [name, value]: [string, string]) {
  const upstream = new URL(target);
  let refused = 0;
  const server = createServer((request, response) => {
    if (request.headers[name] !== value) {
      refused++;
      response.writeHead(403, { "content-type": "text/plain" }).end("Forbidden by the gateway");
      return;
    }
    const forward = httpRequest({ host: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: { ...request.headers, host: upstream.host } }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    forward.on("error", () => response.destroy());
    request.pipe(forward);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${upstream.pathname}`,
    get refused() {
      return refused;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

describe("the command line", () => {
  let example: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    example = (await startExample({ port: 0 })) as typeof example;
  });
  afterAll(() => example.close());

  it("explains itself, and says what's wrong with what it was given", async () => {
    const help = capture();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out.join("\n")).toContain("alexa-plus-simulator check <mcp-url>");
    // Other Chat Completions servers in the README's own words, which vouch for none of them by name.
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const openai = /^\| `openai` \| (.+?) \|/m.exec(readme)![1]!.replaceAll("`", "");
    const said = help.out.join("\n").replace(/\s+/g, " ");
    expect(said).toContain(openai);
    expect(said).not.toMatch(/Ollama|LM Studio|Groq/);
    const bare = capture();
    expect(await main([], bare.io)).toBe(1);
    const bad = capture();
    expect(await main(["not a url"], bad.io)).toBe(2);
    expect(bad.err[0]).toContain("isn't a URL");
    const unknown = capture();
    expect(await main(["--frobnicate"], unknown.io)).toBe(2);
    const header = capture();
    expect(await main([example.url, "--header", "no colon"], header.io)).toBe(2);
  });

  it("runs the simulator: the page's config, what the simulator can do, MCP through the proxy and the readiness check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-"));
    const addon = join(dir, "addon.json");
    await writeFile(addon, JSON.stringify({ storeListing: { locales: { "en-US": { examplePhrases: ["Alexa, what's on my list?", "Alexa, add milk to my list"] } } } }));
    const sim = capture({});
    const done = main([example.url, "--server-port", "0", "--client-port", "0", "--addon", addon], sim.io);
    const { url, uiUrl } = await sim.running;
    try {
      const config = (await (await fetch(`${uiUrl}/config.json`)).json()) as { proxyUrl: string; upstream: string };
      expect(config.upstream).toBe(example.url);
      const info = (await (await fetch(`${url}/api/info`)).json()) as { model: string | null; provider: string | null; phrases: string[] };
      expect(info.model).toBeNull();
      expect(info.provider).toBeNull();
      expect(info.phrases).toEqual(["Alexa, what's on my list?", "Alexa, add milk to my list"]);

      const init = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: ACCEPT,
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
      });
      expect(init.status).toBe(200);
      expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("tasks-example");
      expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: "ok" });

      const model = await fetch(`${url}/api/model`, { method: "POST", headers: ACCEPT, body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], tools: [] }) });
      expect(model.status).toBe(503);

      const check = await fetch(`${url}/api/check`, { method: "POST" });
      expect(check.status).toBe(200);
      const report = (await check.json()) as ReadinessReport;
      expect(report.tool).toBe("alexa-plus-simulator");
      expect(report.rules.some((r) => r.category === "mcp-data")).toBe(true);
      // The package's rules are in it too.
      expect(report.rules.some((r) => r.category === "package")).toBe(true);
      expect(sim.out.join("\n")).toContain(uiUrl);
      expect(sim.out.join("\n")).toContain("Model:     none: set ANTHROPIC_API_KEY; ANTHROPIC_FOUNDRY_API_KEY and ANTHROPIC_FOUNDRY_RESOURCE (Microsoft Foundry);");
    } finally {
      sim.stop();
      expect(await done).toBe(0);
    }
  });

  it("says which model stands in for Alexa+, from the credentials it finds or the provider it's told", async () => {
    const sim = capture({ AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key", AWS_REGION: "eu-west-1", OPENAI_API_KEY: "sk-test" });
    const done = main([example.url, "--server-port", "0", "--client-port", "0"], sim.io);
    const { url } = await sim.running;
    try {
      expect(await (await fetch(`${url}/api/info`)).json()).toMatchObject({ model: "Amazon Nova 2 Lite on Bedrock (global.amazon.nova-2-lite-v1:0)", provider: "bedrock" });
      expect(sim.out).toContain("  Model:     Amazon Nova 2 Lite on Bedrock (global.amazon.nova-2-lite-v1:0) in eu-west-1, with a Bedrock API key");
    } finally {
      sim.stop();
      expect(await done).toBe(0);
    }
    const told = capture({ AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key", OPENAI_API_KEY: "sk-test" });
    const running = main([example.url, "--server-port", "0", "--client-port", "0", "--provider", "openai", "--model", "gpt-5.6-sol"], told.io);
    const urls = await told.running;
    try {
      expect(await (await fetch(`${urls.url}/api/info`)).json()).toMatchObject({ model: "OpenAI (gpt-5.6-sol)", provider: "openai" });
    } finally {
      told.stop();
      expect(await running).toBe(0);
    }
    // Microsoft Foundry comes before Bedrock, and a deployment can be told which API it speaks.
    const foundry = capture({ ANTHROPIC_FOUNDRY_API_KEY: "foundry-key", ANTHROPIC_FOUNDRY_RESOURCE: "example-resource", AWS_BEARER_TOKEN_BEDROCK: "bedrock-api-key" });
    const onFoundry = main([example.url, "--server-port", "0", "--client-port", "0", "--model", "voice-prod", "--foundry-api", "anthropic"], foundry.io);
    const foundryUrls = await foundry.running;
    try {
      expect(await (await fetch(`${foundryUrls.url}/api/info`)).json()).toMatchObject({ model: "Claude on Microsoft Foundry (voice-prod)", provider: "foundry" });
      expect(foundry.out).toContain("  Model:     Claude on Microsoft Foundry (voice-prod) at example-resource.services.ai.azure.com, with an API key");
    } finally {
      foundry.stop();
      expect(await onFoundry).toBe(0);
    }
    const unknown = capture();
    expect(await main([example.url, "--provider", "mistral"], unknown.io)).toBe(2);
    expect(unknown.err[0]).toBe('--provider takes anthropic, foundry, bedrock, gemini or openai, not "mistral".');
    const api = capture();
    expect(await main([example.url, "--foundry-api", "responses"], api.io)).toBe(2);
    expect(api.err[0]).toBe('--foundry-api takes anthropic or openai, not "responses".');
    const region = capture();
    expect(await main([example.url, "--region", "us-east-1.example.com"], region.io)).toBe(2);
    expect(region.err[0]).toContain("isn't an AWS Region");
    const base = capture({ OPENAI_BASE_URL: "localhost:11434" });
    expect(await main([example.url], base.io)).toBe(1);
    expect(base.err[0]).toContain("OPENAI_BASE_URL");
  });

  it("serves each --extension for the page to import, and lists them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-"));
    const file = join(dir, "hello.js");
    await writeFile(file, "export default (sim) => ({ beforeTurn: () => ['hello'] });\n");
    const sim = capture({});
    const done = main([example.url, "--server-port", "0", "--client-port", "0", "--extension", file], sim.io);
    const { url } = await sim.running;
    try {
      const info = (await (await fetch(`${url}/api/info`)).json()) as { extensions: string[] };
      expect(info.extensions).toEqual(["/extensions/0.js"]);
      const served = await fetch(`${url}${info.extensions[0]}`);
      expect(served.headers.get("content-type")).toContain("text/javascript");
      expect(await served.text()).toContain("export default");
    } finally {
      sim.stop();
      expect(await done).toBe(0);
    }
    const missing = capture();
    expect(await main([example.url, "--extension", join(dir, "nope.js")], missing.io)).toBe(2);
    expect(missing.err[0]).toContain("Couldn't read the extension");
  });

  it("checks a server from the command line, writes the report, and fails the run only when a rule fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-"));
    const out = join(dir, "readiness-report.json");
    const run = capture();
    const code = await main(["check", example.url, "--out", out], run.io);
    const report = JSON.parse(await readFile(out, "utf8")) as ReadinessReport;
    expect(code).toBe(report.verdict === "NOT_READY" ? 1 : 0);
    expect(run.out.join("\n")).toContain(report.verdict);
    const json = capture();
    await main(["check", example.url, "--json"], json.io);
    expect((JSON.parse(json.out.join("\n")) as ReadinessReport).serverUrl).toBe(example.url);
  });

  it("writes the reports into folders that don't exist yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-"));
    const out = join(dir, "reports", "today", "readiness-report.json");
    const html = join(dir, "pages", "readiness.html");
    const run = capture();
    const code = await main(["check", example.url, "--out", out, "--html", html], run.io);
    const report = JSON.parse(await readFile(out, "utf8")) as ReadinessReport;
    expect(code).toBe(report.verdict === "NOT_READY" ? 1 : 0);
    expect(await readFile(html, "utf8")).toContain(report.verdict);
    expect(run.out).toContain(`Wrote ${out}.`);
  });

  it("makes the sample calls in --calls, in check and in the simulator's check", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-"));
    const calls = join(dir, "calls.json");
    await writeFile(calls, JSON.stringify([{ tool: "add_task", arguments: { text: "Bring the hose in" } }]));
    const run = capture();
    await main(["check", example.url, "--calls", calls, "--json"], run.io);
    const report = JSON.parse(run.out.join("\n")) as ReadinessReport;
    const results = report.rules.find((r) => r.id === "DL-05")!;
    // add_task isn't read-only, but it was listed: made once, judged, and named.
    expect(results).toMatchObject({ status: "PASS", notes: `Each call returned text content and structuredContent: show_tasks; add_task({"text":"Bring the hose in"}).` });
    expect(report.rules.find((r) => r.id === "DL-07")!.notes).toBe("Two calls to show_tasks with the same arguments returned the same result.");

    const sim = capture({});
    const done = main([example.url, "--server-port", "0", "--client-port", "0", "--calls", calls], sim.io);
    const { url } = await sim.running;
    try {
      const fromPage = (await (await fetch(`${url}/api/check`, { method: "POST" })).json()) as ReadinessReport;
      expect(fromPage.rules.find((r) => r.id === "DL-05")!.notes).toContain(`add_task({"text":"Bring the hose in"})`);
    } finally {
      sim.stop();
      expect(await done).toBe(0);
    }
  });

  it("sends --header to a server behind a gateway, from check and from the simulator's check", async () => {
    const gateway = await startGateway(example.url, ["x-gateway-key", "open-sesame"]);
    try {
      const run = capture();
      expect(await main(["check", gateway.url, "--header", "X-Gateway-Key: open-sesame", "--json"], run.io)).toBe(0);
      const report = JSON.parse(run.out.join("\n")) as ReadinessReport;
      expect(report.rules.find((r) => r.id === "DL-01")!.status).toBe("PASS");
      expect(report.verdict).toBe("READY");

      const sim = capture({});
      const done = main([gateway.url, "--server-port", "0", "--client-port", "0", "--header", "X-Gateway-Key: open-sesame"], sim.io);
      const { url } = await sim.running;
      try {
        const fromPage = (await (await fetch(`${url}/api/check`, { method: "POST" })).json()) as ReadinessReport;
        expect(fromPage.rules.find((r) => r.id === "DL-01")!.status).toBe("PASS");
      } finally {
        sim.stop();
        expect(await done).toBe(0);
      }
      // Every request the gateway let through carried the header; without it, nothing gets past.
      expect(gateway.refused).toBe(0);
    } finally {
      await gateway.close();
    }
    const bad = capture();
    expect(await main(["check", example.url, "--header", "Two Words: x"], bad.io)).toBe(2);
    expect(bad.err[0]).toBe(`--header takes "Name: value", and "Two Words" isn't a header name.`);
  });

  it("says what's wrong with a calls file before checking anything", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-"));
    const write = async (name: string, text: string) => {
      const file = join(dir, name);
      await writeFile(file, text);
      return file;
    };
    const cases: [string, string][] = [
      [await write("broken.json", "[{ tool: "), "Couldn't read"],
      [await write("object.json", `{ "tool": "add_task" }`), "must be a list of calls"],
      [await write("named.json", `[{ "name": "add_task" }]`), `name the tool with "tool", not "name"`],
      [join(dir, "nope.json"), "Couldn't read"],
    ];
    for (const [file, message] of cases) {
      const run = capture();
      expect(await main(["check", example.url, "--calls", file], run.io)).toBe(2);
      expect(run.err[0]).toContain(message);
      expect(run.out).toEqual([]);
    }
  });

  it("validates a package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-"));
    const addon = join(dir, "addon.json");
    await writeFile(addon, JSON.stringify({ manifestVersion: "2.0" }));
    const run = capture();
    expect(await main(["validate", addon], run.io)).toBe(1);
    expect(run.out.join("\n")).toContain("FAIL");
    const missing = capture();
    expect(await main(["validate", join(dir, "nope.json")], missing.io)).toBe(2);
  });
});

describe("signing in from the command line", () => {
  let auth: FakeAuth;
  beforeAll(async () => {
    auth = await FakeAuth.start({ registration: true });
  });
  afterAll(() => auth.close());

  it("links, then checks and simulates with the token file", async () => {
    // A ~ inside the path, as in Windows' short folder names (RUNNER~1), needs no quotes in the commands it prints.
    const file = join(await mkdtemp(join(tmpdir(), "alexa-sim~1-")), ".alexa-plus-simulator", "tokens.json");
    // The fake plays the browser, so no real one opens.
    const linking = capture({}, (url) => auth.browse(url));
    expect(await main(["link", auth.mcpUrl, "--callback-port", "0", "--token-file", file], linking.io)).toBe(0);
    expect(linking.out).toContain(`  alexa-plus-simulator check ${auth.mcpUrl} --token-file ${file}`);
    const saved = JSON.parse(await readFile(file, "utf8")) as { accessToken: string };
    expect(linking.out.join("\n")).not.toContain(saved.accessToken);

    const checking = capture();
    await main(["check", auth.mcpUrl, "--token-file", file, "--json"], checking.io);
    const report = JSON.parse(checking.out.join("\n")) as ReadinessReport;
    expect(report.rules.find((r) => r.id === "DL-01")!.status).toBe("PASS");
    expect(report.rules.find((r) => r.id === "AU-09")!.status).toBe("PASS");

    const sim = capture({});
    const done = main([auth.mcpUrl, "--server-port", "0", "--client-port", "0", "--token-file", file], sim.io);
    const { url } = await sim.running;
    try {
      const listed = await fetch(`${url}/mcp`, { method: "POST", headers: ACCEPT, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(listed.status).toBe(200);
      expect(sim.out).toContain(`  Sign-in:   ${file}, refreshed as it expires`);
    } finally {
      sim.stop();
      expect(await done).toBe(0);
    }
  });

  it("says what's wrong with how a token file was given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-"));
    const missing = join(dir, "tokens.json");
    const both = capture();
    expect(await main(["check", auth.mcpUrl, "--token-file", missing, "--token", "abc"], both.io)).toBe(2);
    expect(both.err[0]).toBe("Use --token or --token-file, not both.");
    const none = capture();
    expect(await main(["check", auth.mcpUrl, "--token-file", missing], none.io)).toBe(2);
    expect(none.err[0]).toBe(`There's no token file at ${missing}. Sign in first: alexa-plus-simulator link ${auth.mcpUrl} --token-file ${missing}`);
    const token = capture();
    expect(await main(["link", auth.mcpUrl, "--token", "abc"], token.io)).toBe(2);
    const refused = capture();
    expect(await main(["link", "http://example.com/mcp", "--token-file", missing], refused.io)).toBe(1);
    expect(refused.err[0]).toContain("Refusing the MCP server's URL, http://example.com/mcp: it must use https://");
    // check holds to the same rule, as a usage problem, before sending the token anywhere.
    const plain = capture();
    expect(await main(["check", "http://example.com/mcp", "--token", "abc"], plain.io)).toBe(2);
    expect(plain.err[0]).toBe("Refusing http://example.com: a remote MCP server must use https://. Plain http:// is only allowed on this machine (localhost, 127.0.0.1 or [::1]), for a local dev server.");
    expect(plain.out).toEqual([]);
  });
});

describe("the pieces", () => {
  it("finds example phrases wherever the package keeps them, without repeats", () => {
    expect(examplePhrases({ a: { examplePhrases: ["one", "two"] }, b: [{ examplePhrases: ["two", "three", 4] }] })).toEqual(["one", "two", "three"]);
    expect(examplePhrases(undefined)).toEqual([]);
  });

  it("works out the verdict again when the package's rules join the report", () => {
    const rule = (status: RuleResult["status"]): RuleResult => ({ id: "X", category: "package", title: "x", status, notes: "", source: { title: "", url: "", quote: "" } });
    const base: ReadinessReport = { tool: "alexa-plus-simulator", version: "0.1.0", serverUrl: "", checkedAt: "2026-10-18T19:00:00.000Z", verdict: "READY", passCount: 1, failCount: 0, warnCount: 0, skipCount: 0, rules: [rule("PASS")], disclaimer: "" };
    expect(withRules(base, [rule("WARN")])).toMatchObject({ verdict: "CONDITIONAL", passCount: 1, warnCount: 1, checkedAt: base.checkedAt });
    expect(withRules(base, [rule("WARN"), rule("FAIL"), rule("SKIP")])).toMatchObject({ verdict: "NOT_READY", failCount: 1, skipCount: 1 });
    expect(withRules(base, [])).toMatchObject({ verdict: "READY" });
  });
});

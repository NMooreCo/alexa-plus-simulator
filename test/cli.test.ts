import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error The example is plain JavaScript.
import { startExample } from "../examples/tasks/server.mjs";
import { examplePhrases, type Io, main, withRules } from "../src/run.ts";
import type { ReadinessReport, RuleResult } from "../src/shared/contract.ts";

function capture(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let stop!: () => void;
  let started!: (urls: { url: string; uiUrl: string }) => void;
  const running = new Promise<{ url: string; uiUrl: string }>((r) => (started = r));
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l), env, stopped: new Promise<void>((r) => (stop = r)), started };
  return { io, out, err, stop, running };
}

const ACCEPT = { "content-type": "application/json", accept: "application/json" };

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
      const info = (await (await fetch(`${url}/api/info`)).json()) as { model: string | null; phrases: string[] };
      expect(info.model).toBeNull();
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
    } finally {
      sim.stop();
      expect(await done).toBe(0);
    }
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

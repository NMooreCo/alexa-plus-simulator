import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
// @ts-expect-error The example is plain JavaScript.
import { startExample } from "../examples/tasks/server.mjs";
import { htmlReport } from "../src/report/html.ts";
import { main } from "../src/run.ts";
import type { ReadinessReport } from "../src/shared/contract.ts";
import { buildReport } from "../src/check/index.ts";
import { checkScreens, judgeScreens, launchBrowser, type ScreenShot, screenCalls, VISUAL_SOURCES } from "../src/visual/index.ts";

const shot = (over: Partial<ScreenShot> = {}): ScreenShot => ({
  tool: "show_tasks",
  uri: "ui://tasks/list",
  device: "show-8",
  deviceName: "Echo Show 8",
  width: 1280,
  height: 800,
  contentWidth: 1280,
  blocked: [],
  errors: [],
  ...over,
});
const statuses = (rules: { id: string; status: string }[]) => Object.fromEntries(rules.map((r) => [r.id, r.status]));

describe("judging the screens", () => {
  it("passes screens that render, fit, load only what they declare and stay quiet", () => {
    const rules = judgeScreens([shot(), shot({ device: "show-15", deviceName: "Echo Show 15", width: 1920, contentWidth: 1920 })], 1);
    expect(statuses(rules)).toEqual({ "VR-01": "PASS", "VR-02": "PASS", "VR-03": "PASS", "VR-04": "PASS" });
    expect(rules[0]!.notes).toContain("Echo Show 8; Echo Show 15");
    expect(rules.every((r) => r.category === "visual")).toBe(true);
  });

  it("fails one that doesn't render, and judges the rest only on what did", () => {
    const rules = judgeScreens([shot({ failure: "it showed nothing" }), shot({ tool: "show_week", uri: "ui://week", contentWidth: 1400 })], 2);
    expect(statuses(rules)).toMatchObject({ "VR-01": "FAIL", "VR-02": "WARN" });
    expect(rules[0]!.notes).toContain("show_tasks on the Echo Show 8: it showed nothing");
    expect(rules[1]!.notes).toContain("show_week on the Echo Show 8 is 1400 px wide on a 1280 px screen");
  });

  it("fails what loads undeclared and warns on script errors", () => {
    const rules = judgeScreens([shot({ blocked: [{ url: "https://cdn.example/a.png", directive: "img-src" }], errors: ["Uncaught Error: boom"] })], 1);
    expect(statuses(rules)).toMatchObject({ "VR-03": "FAIL", "VR-04": "WARN" });
    expect(rules[2]!.notes).toContain("https://cdn.example/a.png (img-src) in show_tasks");
    expect(rules[3]!.notes).toContain("boom");
  });

  it("skips with the reason: no screens at all, or none that could be shown safely", () => {
    expect(judgeScreens([], 0).every((r) => r.status === "SKIP" && r.notes.includes("data-only flow"))).toBe(true);
    expect(judgeScreens([], 2, "give sample calls with --calls").every((r) => r.status === "SKIP" && r.notes.includes("--calls"))).toBe(true);
  });

  it("quotes Amazon exactly as the requirements doc does", async () => {
    const doc = await readFile(fileURLToPath(new URL("../docs/alexa-requirements.md", import.meta.url)), "utf8");
    for (const source of Object.values(VISUAL_SOURCES)) {
      expect(doc).toContain(source.quote);
      expect(doc).toContain(source.url);
    }
  });
});

describe("choosing what to show", () => {
  const tools = [
    { name: "show_tasks", annotations: { readOnlyHint: true }, inputSchema: {}, _meta: { ui: { resourceUri: "ui://tasks" } } },
    { name: "refresh_tasks", annotations: { readOnlyHint: true }, inputSchema: {}, _meta: { ui: { resourceUri: "ui://tasks" } } },
    { name: "add_task", annotations: { readOnlyHint: false }, inputSchema: { required: ["text"] }, _meta: { ui: { resourceUri: "ui://tasks/added" } } },
    { name: "show_day", annotations: { readOnlyHint: true }, inputSchema: { required: ["day"] }, _meta: { "ui/resourceUri": "ui://day" } },
    { name: "plain", annotations: { readOnlyHint: true }, inputSchema: {} },
  ];

  it("shows each screen once, through a read-only tool that needs no arguments, never a change it wasn't given", () => {
    expect(screenCalls(tools)).toEqual({ declared: 3, calls: [{ tool: "show_tasks", uri: "ui://tasks", arguments: {} }] });
  });

  it("uses the developer's sample calls for screens that need arguments", () => {
    const { calls } = screenCalls(tools, [{ tool: "show_day", arguments: { day: "2026-10-23" } }, { tool: "add_task", arguments: { text: "Feed the dogs" } }]);
    expect(calls.map((c) => [c.tool, c.uri])).toEqual([
      ["show_tasks", "ui://tasks"],
      ["show_day", "ui://day"],
      ["add_task", "ui://tasks/added"],
    ]);
  });
});

describe("the HTML report", () => {
  it("escapes what it shows, links each requirement, and shows the screenshots relative to itself", () => {
    const report = buildReport("https://a.example/mcp?x=<y>", [
      { id: "VR-01", category: "visual", title: "Renders on both surfaces", status: "PASS", notes: "All <good>", source: { ...VISUAL_SOURCES.bothSurfaces } },
    ]);
    report.artifacts = [{ kind: "screenshot", tool: "show_tasks", uri: "ui://tasks", device: "show-15", path: join("out", "shots", "show_tasks-show-15.png") }];
    const html = htmlReport(report, join("out", "report.html"));
    expect(html).toContain("https://a.example/mcp?x=&lt;y&gt;");
    expect(html).toContain("All &lt;good&gt;");
    expect(html).not.toContain("<good>");
    expect(html).toContain(`href="${VISUAL_SOURCES.bothSurfaces.url}"`);
    expect(html).toContain('src="shots/show_tasks-show-15.png"');
    expect(html).toContain("Echo Show 15");
  });
});

/** A server whose screen does everything wrong: too wide, loads an image it didn't declare, and throws. */
async function startBadScreen(): Promise<{ url: string; close: () => Promise<void> }> {
  const uri = "ui://bad/screen";
  const html = `<!doctype html><html><head><style>body{margin:0;font:28px system-ui;color:#fff;background:#123}.wide{width:3000px;height:40px;background:#456}</style></head>
<body><h1>A screen that misbehaves</h1><div class="wide"></div><img src="https://images.example/undeclared.png" alt="">
<script>
let id = 0; const send = (m) => parent.postMessage(m, "*");
addEventListener("message", (e) => { const m = e.data; if (m && m.jsonrpc === "2.0" && m.id === 1 && !m.method) { send({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }); setTimeout(() => { throw new Error("boom from the screen"); }, 0); } });
send({ jsonrpc: "2.0", id: ++id, method: "ui/initialize", params: { appInfo: { name: "bad", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26" } });
</script></body></html>`;
  const build = () => {
    const server = new McpServer({ name: "bad-screen", version: "1.0.0" });
    registerAppTool(server, "show_bad", { title: "Show the bad screen", description: "Shows a screen.", inputSchema: z.object({}), annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: uri } } }, async () => ({
      content: [{ type: "text", text: "Shown." }],
      structuredContent: { ok: true },
    }));
    registerAppResource(server, "Bad", uri, { description: "A screen" }, async () => ({ contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: html }] }));
    return server;
  };
  const handler = createMcpHandler(build);
  const http = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const body = req.method === "POST" && chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await handler.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const { port } = http.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => http.close(() => r())) };
}

// The real thing, in a headless browser, when this machine has one (CI's runners have Chrome).
const browser = await launchBrowser().then(
  async ({ browser: b, name }) => {
    await b.close();
    return name;
  },
  () => null,
);
const uiDir = fileURLToPath(new URL("../dist/ui", import.meta.url));

describe.skipIf(!browser)(`rendering screens in a headless browser (${browser ?? "none found"})`, () => {
  let example: { url: string; close: () => Promise<void> };
  let bad: { url: string; close: () => Promise<void> };
  beforeAll(async () => {
    example = (await startExample({ port: 0 })) as typeof example;
    bad = await startBadScreen();
  });
  afterAll(async () => {
    await example?.close();
    await bad?.close();
  });

  it("passes the example's screen on every device and saves a screenshot of each", { timeout: 120_000 }, async () => {
    const outDir = await mkdtemp(join(tmpdir(), "alexa-sim-shots-"));
    const result = await checkScreens({ serverUrl: example.url, uiDir, outDir, browser: browser! });
    expect(statuses(result.rules)).toEqual({ "VR-01": "PASS", "VR-02": "PASS", "VR-03": "PASS", "VR-04": "PASS" });
    expect(result.shots.map((s) => s.device)).toEqual(["show-5", "show-8", "show-15"]);
    for (const s of result.shots) expect((await stat(s.path!)).size).toBeGreaterThan(1000);
  });

  it("runs from the command line: the report names each screenshot, and the page shows them", { timeout: 120_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "alexa-sim-cli-"));
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: () => {}, env: {} };
    const html = join(dir, "report.html");
    const code = await main(["check", example.url, "--visual", "--screenshots", join(dir, "shots"), "--html", html, "--json", "--browser", browser!], io);
    const report = JSON.parse(out.join("\n")) as ReadinessReport;
    expect(code).toBe(0);
    expect(report.rules.filter((r) => r.category === "visual").map((r) => r.status)).toEqual(["PASS", "PASS", "PASS", "PASS"]);
    expect(report.artifacts?.map((a) => a.device)).toEqual(["show-5", "show-8", "show-15"]);
    expect(await readFile(html, "utf8")).toContain('src="shots/show_tasks-show-15.png"');
  });

  it("catches a screen that's too wide, loads what it didn't declare, and throws", { timeout: 120_000 }, async () => {
    const result = await checkScreens({ serverUrl: bad.url, uiDir, devices: ["show-8"], browser: browser! });
    const byId = Object.fromEntries(result.rules.map((r) => [r.id, r]));
    expect(byId["VR-01"]!.status).toBe("PASS");
    expect(byId["VR-02"]).toMatchObject({ status: "WARN", notes: expect.stringContaining("3000 px wide on a 1280 px screen") });
    expect(byId["VR-03"]).toMatchObject({ status: "FAIL", notes: expect.stringContaining("https://images.example/undeclared.png (img-src)") });
    expect(byId["VR-04"]).toMatchObject({ status: "WARN", notes: expect.stringContaining("boom from the screen") });
  });
});

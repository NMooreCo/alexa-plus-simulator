import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, ConsoleMessage, Page } from "playwright-core";
import { type ProxyOptions, startProxy } from "../proxy/index.ts";
import { DEVICES, type RuleResult, VERSION } from "../shared/contract.ts";

/**
 * The screen check (check --visual): what Amazon's Local Inspector does in its
 * visual mode, as far as Amazon has published it. It runs the simulator's own
 * page in a headless browser, shows each screen the server offers on each
 * device the way the simulator does (under the policy its resource declares),
 * takes a screenshot, and judges what it saw.
 */

/** Small and large surfaces, the smallest small one included. */
export const DEFAULT_DEVICES = ["show-5", "show-8", "show-15"];

const LOCAL_INSPECTOR = { title: "Local Inspector", url: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-local-inspector" };
const QUICKSTART = { title: "Create an MCP Add-on (quickstart)", url: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart" };

/** The published requirements these rules check, quoted exactly as docs/alexa-requirements.md has them (a test holds them to it). */
export const VISUAL_SOURCES = {
  bothSurfaces: { ...LOCAL_INSPECTOR, quote: "Your widget must render correctly on both surfaces to meet the visual requirements for certification." },
  mcpApps: { ...QUICKSTART, quote: "If you expect to provide visuals, follow the MCP Apps standard." },
};

const RULES = {
  renders: { id: "VR-01", title: "Renders on both surfaces", source: VISUAL_SOURCES.bothSurfaces },
  fits: { id: "VR-02", title: "Fits the screen", source: VISUAL_SOURCES.bothSurfaces },
  declared: { id: "VR-03", title: "Loads only what it declares", source: VISUAL_SOURCES.mcpApps },
  errors: { id: "VR-04", title: "No script errors", source: VISUAL_SOURCES.mcpApps },
} as const;

type Rule = (typeof RULES)[keyof typeof RULES];

function judge(rule: Rule, status: RuleResult["status"], notes: string): RuleResult {
  return { id: rule.id, category: "visual", title: rule.title, status, notes, source: rule.source };
}

/** One screen on one device, as the check saw it. */
export interface ScreenShot {
  tool: string;
  uri: string;
  device: string;
  deviceName: string;
  /** The screen's size on this device. */
  width: number;
  height: number;
  /** Why it didn't show, when it didn't: it never started, the call came back as an error, or it showed nothing. */
  failure?: string;
  /** How wide its content is; wider than the screen means it scrolls sideways. */
  contentWidth?: number;
  /** What its policy blocked: undeclared origins. */
  blocked: { url: string; directive: string }[];
  /** Errors its scripts logged or threw. */
  errors: string[];
  /** The screenshot, when one was saved. */
  path?: string;
}

/** A call that shows a screen. */
export interface ScreenCall {
  tool: string;
  uri: string;
  arguments: Record<string, unknown>;
}

function listOf(items: string[], max = 4): string {
  if (items.length <= max) return items.length > 1 ? `${items.slice(0, -1).join("; ")}; ${items.at(-1)}` : (items[0] ?? "");
  return `${items.slice(0, max).join("; ")}; and ${items.length - max} more`;
}

const where = (s: ScreenShot) => `${s.tool} on the ${s.deviceName}`;

/**
 * The visual rules, from what the check saw. `declared` is how many screens
 * the server's tools name; `skipped` says why none could be shown when none was.
 */
export function judgeScreens(shots: ScreenShot[], declared: number, skipped?: string): RuleResult[] {
  if (!declared) {
    const note = "No tool declares a screen (_meta.ui.resourceUri), so Alexa+ uses its data-only flow and there's nothing to render.";
    return Object.values(RULES).map((r) => judge(r, "SKIP", note));
  }
  if (!shots.length) {
    const note = skipped ?? "No screen could be shown.";
    return Object.values(RULES).map((r) => judge(r, "SKIP", note));
  }
  const screens = new Set(shots.map((s) => s.uri)).size;
  const devices = [...new Set(shots.map((s) => s.deviceName))];
  const shown = shots.filter((s) => !s.failure);
  const rules: RuleResult[] = [];

  const failed = shots.filter((s) => s.failure).map((s) => `${where(s)}: ${s.failure}`);
  rules.push(
    failed.length
      ? judge(RULES.renders, "FAIL", `${failed.length} of ${shots.length} didn't render: ${listOf(failed)}.`)
      : judge(RULES.renders, "PASS", `${screens === 1 ? "The screen" : `All ${screens} screens`} rendered on the ${listOf(devices)}${skipped ? `. ${skipped}` : "."}`),
  );

  const wide = shown.filter((s) => s.contentWidth !== undefined && s.contentWidth > s.width + 1).map((s) => `${where(s)} is ${s.contentWidth} px wide on a ${s.width} px screen`);
  rules.push(
    wide.length
      ? judge(RULES.fits, "WARN", `Content runs off the side, so it scrolls sideways: ${listOf(wide)}.`)
      : judge(RULES.fits, shown.length ? "PASS" : "SKIP", shown.length ? "Every screen fits its device's width." : "No screen rendered, so none was measured."),
  );

  const blocked = [...new Set(shown.flatMap((s) => s.blocked.map((b) => `${b.url} (${b.directive}) in ${s.tool}`)))];
  rules.push(
    blocked.length
      ? judge(RULES.declared, "FAIL", `Screens loaded things their resource didn't declare in _meta.ui.csp, which a host following the MCP Apps standard blocks: ${listOf(blocked)}.`)
      : judge(RULES.declared, shown.length ? "PASS" : "SKIP", shown.length ? "No screen tried to load anything it didn't declare." : "No screen rendered, so none was watched."),
  );

  const errors = [...new Set(shown.flatMap((s) => s.errors.map((e) => `${s.tool}: ${e.slice(0, 160)}`)))];
  rules.push(
    errors.length
      ? judge(RULES.errors, "WARN", `Screens logged or threw errors: ${listOf(errors)}.`)
      : judge(RULES.errors, shown.length ? "PASS" : "SKIP", shown.length ? "No screen logged or threw an error." : "No screen rendered, so none was watched."),
  );
  return rules;
}

interface ToolLike {
  name: string;
  inputSchema?: { required?: unknown };
  annotations?: { readOnlyHint?: unknown };
  _meta?: Record<string, unknown>;
}

function screenUri(t: ToolLike): string | undefined {
  const meta = t._meta as { ui?: { resourceUri?: unknown }; "ui/resourceUri"?: unknown } | undefined;
  const uri = meta?.ui?.resourceUri ?? meta?.["ui/resourceUri"];
  return typeof uri === "string" ? uri : undefined;
}

/**
 * Which calls to make to see each screen once: a tool marked read-only that
 * needs no arguments, or a sample call the developer gave for it. Never a
 * tool that might change something, unless the developer named the call.
 */
export function screenCalls(tools: ToolLike[], given: { tool: string; arguments?: Record<string, unknown> }[] = []): { calls: ScreenCall[]; declared: number } {
  const byUri = new Map<string, ScreenCall>();
  const declared = new Set<string>();
  for (const t of tools) {
    const uri = screenUri(t);
    if (!uri) continue;
    declared.add(uri);
    const required = Array.isArray(t.inputSchema?.required) ? t.inputSchema.required.length : 0;
    if (t.annotations?.readOnlyHint === true && !required && !byUri.has(uri)) byUri.set(uri, { tool: t.name, uri, arguments: {} });
  }
  for (const g of given) {
    const t = tools.find((x) => x.name === g.tool);
    const uri = t && screenUri(t);
    if (uri && !byUri.has(uri)) byUri.set(uri, { tool: g.tool, uri, arguments: g.arguments ?? {} });
  }
  return { calls: [...byUri.values()], declared: declared.size };
}

export interface ScreenCheckOptions {
  /** The MCP endpoint. */
  serverUrl: string;
  /** A token, or a function the proxy asks for one (and again with a refused one, to refresh it). */
  token?: ProxyOptions["token"];
  headers?: Record<string, string>;
  /** The simulator's built page. */
  uiDir: string;
  /** Where screenshots go; none are saved without one. */
  outDir?: string;
  /** Device ids; the Echo Show 5, 8 and 15 by default. */
  devices?: string[];
  /** Sample calls for screens whose tools need arguments. */
  calls?: { tool: string; arguments?: Record<string, unknown> }[];
  /** "chrome", "msedge" or "chromium"; the first one installed, in that order, by default. */
  browser?: string;
}

export interface ScreenCheck {
  rules: RuleResult[];
  shots: ScreenShot[];
  /** The browser that rendered them. */
  browser: string;
}

/** Opens a headless browser: the one asked for, or the first installed. */
export async function launchBrowser(prefer?: string): Promise<{ browser: Browser; name: string }> {
  const { chromium } = await import("playwright-core");
  const tries = prefer ? [prefer] : ["chrome", "msedge", "chromium"];
  const failures: string[] = [];
  for (const name of tries) {
    try {
      return { browser: await chromium.launch({ headless: true, ...(name === "chromium" ? {} : { channel: name }) }), name };
    } catch (err) {
      failures.push(`${name}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
  throw new Error(`No browser to render the screens in. Install Chrome or Edge, or run "npx playwright install chromium", or name one with --browser. (${failures.join("; ")})`);
}

const SAFE_NAME = /[^a-z0-9_-]+/gi;

/** What the page's script sees, typed here since this file is built for Node (the functions below run in the browser). */
interface PageGlobals {
  alexaPlusSimulator: {
    tools(): unknown[];
    show(tool: string, args: unknown): Promise<{ isError?: boolean; content?: { type: string; text?: string }[] }>;
  };
}
interface ScreenGlobals {
  document: {
    documentElement: { scrollWidth: number };
    body: { innerText: string; scrollWidth: number } | null;
    querySelectorAll(selector: string): { length: number };
  };
}

/** Shows each screen on each device and judges them. */
export async function checkScreens(o: ScreenCheckOptions): Promise<ScreenCheck> {
  const devices = (o.devices ?? DEFAULT_DEVICES).map((id) => DEVICES.find((d) => d.id === id)).filter((d) => d && d.surface !== "none");
  const proxy = await startProxy({
    upstream: o.serverUrl,
    port: 0,
    clientPort: 0,
    ...(o.token ? { token: o.token } : {}),
    ...(o.headers ? { headers: o.headers } : {}),
    uiDir: o.uiDir,
    routes: { "/api/info": async () => Response.json({ version: VERSION, model: null, phrases: [], extensions: [] }) },
  });
  const { browser, name } = await launchBrowser(o.browser);
  const shots: ScreenShot[] = [];
  let calls: ScreenCall[] = [];
  let declared = 0;
  let skipped: string | undefined;
  let unreachable: string | undefined;
  try {
    if (o.outDir) await mkdir(o.outDir, { recursive: true });
    for (const device of devices) {
      const page = await browser.newPage({ viewport: { width: 2600, height: 1500 } });
      // What the screen's own scripts logged: errors, and the policy's refusals (an eval probe isn't one; libraries like zod try it and carry on).
      let logged: string[] = [];
      page.on("console", (m: ConsoleMessage) => {
        if (m.type() === "error" && m.location().url.startsWith("about:")) logged.push(m.text());
      });
      page.on("pageerror", (e) => logged.push(e.message));
      try {
        await page.goto(`${proxy.uiUrl}/?device=${device!.id}`);
        await page.waitForFunction(() => "alexaPlusSimulator" in globalThis, null, { timeout: 30_000 });
        const status = (await page.locator("#status").textContent()) ?? "";
        if (status.startsWith("Couldn't connect")) {
          unreachable = status;
          break;
        }
        if (!calls.length && !declared) {
          const tools = (await page.evaluate(() => (globalThis as unknown as PageGlobals).alexaPlusSimulator.tools())) as ToolLike[];
          ({ calls, declared } = screenCalls(tools, o.calls));
          const unshown = declared - calls.length;
          if (unshown > 0) skipped = `${unshown} screen${unshown === 1 ? "" : "s"} weren't shown: no tool that shows ${unshown === 1 ? "it" : "them"} is marked read-only with no required arguments; give sample calls with --calls.`;
        }
        for (const call of calls) {
          logged = [];
          const before = await page.locator("#talk-log li").count();
          const shot: ScreenShot = { tool: call.tool, uri: call.uri, device: device!.id, deviceName: device!.name, width: device!.width!, height: device!.height!, blocked: [], errors: [] };
          const shown = (await page.evaluate(
            async ({ tool, args }) => {
              const sim = (globalThis as unknown as PageGlobals).alexaPlusSimulator;
              try {
                const r = await sim.show(tool, args);
                return r.isError ? { error: r.content?.find((c) => c.type === "text")?.text ?? "an error result" } : {};
              } catch (err) {
                return { failed: err instanceof Error ? err.message : String(err) };
              }
            },
            { tool: call.tool, args: call.arguments },
          )) as { error?: string; failed?: string };
          if (shown.failed) shot.failure = shown.failed;
          else if (shown.error) shot.failure = `the call came back as an error: ${shown.error.slice(0, 120)}`;
          else {
            // Fonts, images and the screen's first render settle.
            await page.waitForTimeout(1200);
            const frame = await (await page.$("#app-host iframe"))?.contentFrame();
            const seen = await frame?.evaluate(() => {
              const { document } = globalThis as unknown as ScreenGlobals;
              const d = document.documentElement;
              const b = document.body;
              return {
                text: (b?.innerText ?? "").trim().length,
                media: document.querySelectorAll("img, svg, canvas, video, picture").length,
                width: Math.max(d.scrollWidth, b?.scrollWidth ?? 0),
              };
            });
            if (!seen || (seen.text === 0 && seen.media === 0)) shot.failure = "it showed nothing";
            else shot.contentWidth = seen.width;
            if (o.outDir) {
              shot.path = join(o.outDir, `${call.tool.replace(SAFE_NAME, "_")}-${device!.id}.png`);
              await page.locator("#screen").screenshot({ path: shot.path, animations: "disabled" });
            }
          }
          // What the simulator logged about this screen: the policy's refusals, with the field to declare them in.
          const notes = (await page.locator("#talk-log li").allTextContents()).slice(0, (await page.locator("#talk-log li").count()) - before);
          for (const n of notes) {
            const m = /tried to load (.+?) \(([^)]*)\) without declaring it/.exec(n);
            if (m) shot.blocked.push({ url: m[1]!, directive: m[2]! });
          }
          shot.errors = logged.filter((e) => !/Content Security Policy|unsafe-eval|Refused to (load|evaluate|apply|connect|frame)/i.test(e));
          shots.push(shot);
        }
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
    await proxy.close();
  }
  if (unreachable) {
    const note = `The page couldn't connect, so no screen was shown (see DL-01): ${unreachable}`;
    return { rules: Object.values(RULES).map((r) => judge(r, "SKIP", note)), shots, browser: name };
  }
  return { rules: judgeScreens(shots, declared, skipped), shots, browser: name };
}

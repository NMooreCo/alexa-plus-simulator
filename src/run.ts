import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildReport, formatReport, runChecks, validatePackage } from "./check/index.ts";
import { DEFAULT_MODEL, modelRoute } from "./model/index.ts";
import { type Route, startProxy } from "./proxy/index.ts";
import { htmlReport } from "./report/html.ts";
import { DEFAULT_CLIENT_PORT, DEFAULT_SERVER_PORT, DISCLAIMER, type ReadinessReport, type RuleResult, VERSION } from "./shared/contract.ts";
import { checkScreens } from "./visual/index.ts";

export const USAGE = `Alexa+ simulator ${VERSION} (unofficial; not affiliated with Amazon)

Usage:
  alexa-plus-simulator <mcp-url> [options]      Talk to your MCP server on a simulated Echo
  alexa-plus-simulator check <mcp-url> [options] Check it against Alexa+'s published requirements
  alexa-plus-simulator validate <addon.json>     Check an add-on package's addon.json

Options:
  --token <token>        Bearer token for a server that needs sign-in (or set MCP_TOKEN)
  --header "Name: value" Another header on every request to the server (repeatable)
  --addon <addon.json>   Your add-on package: its example phrases show as suggestions, and the check includes it
  --extension <file.js>  An extension for the page: an ES module whose default export is the extension (repeatable)
  --server-port <port>   The proxy's port (default ${DEFAULT_SERVER_PORT})
  --client-port <port>   The page's port (default ${DEFAULT_CLIENT_PORT})
  --model <id>           The Claude model standing in for Alexa+ (default ${DEFAULT_MODEL})
  --no-fallbacks         Leave Anthropic's refusal fallback off (for a gateway that doesn't pass it through)
  --open                 Open the simulator in the browser
  --verbose              Log every exchange
  --out <file>           check: also write the report as JSON
  --html <file>          check: also write the report as a page to share, with the screenshots
  --visual               check: show every screen on the Echo Show 5, 8 and 15 in a headless browser, and judge them
  --screenshots <dir>    check --visual: where the screenshots go (default readiness-screenshots)
  --browser <name>       check --visual: chrome, msedge or chromium (default: the first one installed)
  --json                 check, validate: print JSON instead of a summary

Talking needs ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL for a gateway); the Tools tab works without it.
${DISCLAIMER}`;

const OPTIONS = {
  token: { type: "string" },
  header: { type: "string", multiple: true },
  addon: { type: "string" },
  extension: { type: "string", multiple: true },
  "server-port": { type: "string" },
  "client-port": { type: "string" },
  model: { type: "string" },
  "no-fallbacks": { type: "boolean" },
  open: { type: "boolean" },
  verbose: { type: "boolean" },
  out: { type: "string" },
  json: { type: "boolean" },
  html: { type: "string" },
  visual: { type: "boolean" },
  screenshots: { type: "string" },
  browser: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;

/** Where output goes; tests pass their own. */
export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Resolves when the simulator should stop (Ctrl+C); tests resolve it themselves. */
  stopped?: Promise<void>;
  /** Called with the running simulator's URLs, for tests. */
  started?: (urls: { url: string; uiUrl: string }) => void;
}

const defaultIo = (): Io => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
});

class UsageError extends Error {}

function port(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(`${value} isn't a port.`);
  return n;
}

function headers(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list ?? []) {
    const at = h.indexOf(":");
    if (at < 1) throw new UsageError(`--header takes "Name: value", not ${JSON.stringify(h)}.`);
    out[h.slice(0, at).trim()] = h.slice(at + 1).trim();
  }
  return out;
}

function mcpUrl(value: string | undefined): string {
  if (!value) throw new UsageError("Name your MCP server's URL, like https://example.com/mcp.");
  try {
    return new URL(value).toString();
  } catch {
    throw new UsageError(`${value} isn't a URL.`);
  }
}

async function readAddon(path: string | undefined): Promise<unknown> {
  if (!path) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (err) {
    throw new UsageError(`Couldn't read ${path}: ${err instanceof Error ? err.message : err}`);
  }
}

/** The add-on's example phrases, wherever the package keeps them (they're per locale). */
export function examplePhrases(addon: unknown): string[] {
  const found: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || !v || typeof v !== "object") return;
    for (const [k, child] of Object.entries(v)) {
      if (k === "examplePhrases" && Array.isArray(child)) found.push(...child.filter((p): p is string => typeof p === "string"));
      else walk(child, depth + 1);
    }
  };
  walk(addon, 0);
  return [...new Set(found)].slice(0, 8);
}

const VERDICT_ORDER: Record<RuleResult["status"], number> = { FAIL: 0, WARN: 1, PASS: 2, SKIP: 3 };

/** The report with the package's rules added, its counts and verdict worked out again. */
export function withRules(report: ReadinessReport, extra: RuleResult[]): ReadinessReport {
  return buildReport(report.serverUrl, [...report.rules, ...extra], { version: report.version, checkedAt: new Date(report.checkedAt) });
}

function formatRules(rules: RuleResult[]): string {
  return [...rules]
    .sort((a, b) => VERDICT_ORDER[a.status] - VERDICT_ORDER[b.status])
    .map((r) => `${r.status.padEnd(4)}  ${r.id}  ${r.title}: ${r.notes}`)
    .join("\n");
}

function openBrowser(url: string) {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

async function simulate(target: string, values: ParsedValues, io: Io): Promise<number> {
  const upstream = mcpUrl(target);
  const addon = await readAddon(values.addon);
  const token = values.token ?? io.env.MCP_TOKEN;
  const apiKey = io.env.ANTHROPIC_API_KEY;
  const model = values.model ?? DEFAULT_MODEL;
  const phrases = examplePhrases(addon);
  // Each extension is served by the proxy for the page to import; read now, so a missing file says so at the start.
  const extensions = await Promise.all(
    (values.extension ?? []).map(async (file, i) => {
      try {
        return { path: `/extensions/${i}.js`, source: await readFile(file, "utf8") };
      } catch (err) {
        throw new UsageError(`Couldn't read the extension ${file}: ${err instanceof Error ? err.message : err}`);
      }
    }),
  );
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const routes: Record<string, Route> = {
    "/api/model": modelRoute({ apiKey, baseURL: io.env.ANTHROPIC_BASE_URL, model, fallbacks: !values["no-fallbacks"] }),
    "/api/info": async () => json({ version: VERSION, model: apiKey ? model : null, phrases, extensions: extensions.map((e) => e.path) }),
    ...Object.fromEntries(
      extensions.map(({ path, source }): [string, Route] => [path, async () => new Response(source, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } })]),
    ),
    "/api/check": async (request) => {
      if (request.method !== "POST") return json({ error: { code: "method", message: "POST to run the check." } }, 405);
      try {
        const report = await runChecks({ serverUrl: upstream, token });
        return json(addon === undefined ? report : withRules(report, validatePackage(addon)));
      } catch (err) {
        return json({ error: { code: "check_failed", message: err instanceof Error ? err.message : String(err) } }, 500);
      }
    },
  };
  const proxy = await startProxy({
    upstream,
    port: port(values["server-port"], DEFAULT_SERVER_PORT),
    clientPort: port(values["client-port"], DEFAULT_CLIENT_PORT),
    token,
    headers: headers(values.header),
    verbose: values.verbose,
    uiDir: uiDir(),
    routes,
  });
  io.out(`Alexa+ simulator ${VERSION} (unofficial)`);
  io.out(`  Simulator: ${proxy.uiUrl}`);
  io.out(`  Proxy:     ${proxy.url}/mcp -> ${upstream}`);
  io.out(`  Model:     ${apiKey ? model : "none: set ANTHROPIC_API_KEY to talk (the Tools tab works without it)"}`);
  if (addon !== undefined) io.out(`  Add-on:    ${values.addon} (${phrases.length} example phrase${phrases.length === 1 ? "" : "s"})`);
  io.out("Press Ctrl+C to stop.");
  io.started?.({ url: proxy.url, uiUrl: proxy.uiUrl });
  if (values.open) openBrowser(proxy.uiUrl);
  await (io.stopped ?? new Promise<void>((resolve) => process.once("SIGINT", () => resolve())));
  await proxy.close();
  return 0;
}

/** The built page: beside the CLI once built, or in dist when running from source (tests). */
function uiDir(): string {
  const here = fileURLToPath(new URL("../ui", import.meta.url));
  return existsSync(join(here, "assets")) ? here : fileURLToPath(new URL("../dist/ui", import.meta.url));
}

async function check(target: string, values: ParsedValues, io: Io): Promise<number> {
  const serverUrl = mcpUrl(target);
  const addon = await readAddon(values.addon);
  const token = values.token ?? io.env.MCP_TOKEN;
  const base = await runChecks({ serverUrl, token });
  let report = addon === undefined ? base : withRules(base, validatePackage(addon));
  if (values.visual) {
    const screenshots = values.screenshots ?? "readiness-screenshots";
    const screens = await checkScreens({ serverUrl, token, headers: headers(values.header), uiDir: uiDir(), outDir: screenshots, ...(values.browser ? { browser: values.browser } : {}) });
    report = withRules(report, screens.rules);
    report.artifacts = screens.shots.filter((s) => s.path).map((s) => ({ kind: "screenshot", tool: s.tool, uri: s.uri, device: s.device, path: s.path! }));
    if (!values.json) io.out(`Rendered ${screens.shots.length} screen${screens.shots.length === 1 ? "" : "s"} in ${screens.browser}; the screenshots are in ${screenshots}.`);
  }
  if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
  if (values.html) await writeFile(values.html, htmlReport(report, values.html));
  io.out(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (!values.json) for (const file of [values.out, values.html]) if (file) io.out(`Wrote ${file}.`);
  return report.verdict === "NOT_READY" ? 1 : 0;
}

async function validate(path: string | undefined, values: ParsedValues, io: Io): Promise<number> {
  if (!path) throw new UsageError("Name the addon.json to check.");
  const rules = validatePackage(await readAddon(path));
  io.out(values.json ? JSON.stringify(rules, null, 2) : formatRules(rules));
  return rules.some((r) => r.status === "FAIL") ? 1 : 0;
}

type ParsedValues = ReturnType<typeof parse>["values"];

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

/** Runs the CLI; resolves with the exit code. */
export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  try {
    const { values, positionals } = parse(argv);
    if (values.version) {
      io.out(VERSION);
      return 0;
    }
    if (values.help || !positionals.length) {
      io.out(USAGE);
      return values.help ? 0 : 1;
    }
    const [first, second] = positionals;
    if (first === "check") return await check(second!, values, io);
    if (first === "validate") return await validate(second, values, io);
    return await simulate(first!, values, io);
  } catch (err) {
    if (err instanceof UsageError || (err instanceof TypeError && "code" in err && String(err.code).startsWith("ERR_PARSE_ARGS"))) {
      io.err(err.message);
      io.err("Run alexa-plus-simulator --help for the options.");
      return 2;
    }
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildReport, formatReport, parseCalls, runChecks, type ToolCall, type TokenSource, validatePackage } from "./check/index.ts";
import { sameResource } from "./check/auth.ts";
import { CLIENT_SECRET_ENV, DEFAULT_CALLBACK_PORT, DEFAULT_TOKEN_FILE, link, TokenFile } from "./link/index.ts";
import { DEFAULT_MODELS, isAwsRegion, isFoundryApi, isProviderName, modelOptionsFromEnv, setUpModel } from "./model/index.ts";
import { type ProxyOptions, type Route, startProxy } from "./proxy/index.ts";
import { htmlReport } from "./report/html.ts";
import { DEFAULT_CLIENT_PORT, DEFAULT_SERVER_PORT, DISCLAIMER, type ReadinessReport, type RuleResult, VERSION } from "./shared/contract.ts";
import { parseServerUrl } from "./shared/server-url.ts";
import { checkScreens } from "./visual/index.ts";

export const USAGE = `Alexa+ simulator ${VERSION} (unofficial; not affiliated with Amazon)

Usage:
  alexa-plus-simulator <mcp-url> [options]      Talk to your MCP server on a simulated Echo
  alexa-plus-simulator check <mcp-url> [options] Check it against Alexa+'s published requirements
  alexa-plus-simulator validate <addon.json>     Check an add-on package's addon.json
  alexa-plus-simulator link <mcp-url> [options]  Sign in to a server the way Alexa+ account linking does, saving tokens for --token-file

Options:
  --token <token>        Bearer token for a server that needs sign-in (or set MCP_TOKEN)
  --token-file <file>    Tokens from link, sent like --token and refreshed as they expire (not with --token);
                         link: where to save them (default ${DEFAULT_TOKEN_FILE})
  --header "Name: value" Another header on every request to the server, the check's included (repeatable)
  --addon <addon.json>   Your add-on package: its example phrases show as suggestions, and the check includes it
  --calls <calls.json>   Sample calls for the check, like [{ "tool": "get_forecast", "arguments": { "city": "Denver" } }]:
                         made even to a tool not marked read-only, and repeated only for read-only ones
  --extension <file.js>  An extension for the page: an ES module whose default export is the extension (repeatable)
  --server-port <port>   The proxy's port (default ${DEFAULT_SERVER_PORT})
  --client-port <port>   The page's port (default ${DEFAULT_CLIENT_PORT})
  --provider <name>      Who stands in for Alexa+'s model: anthropic, foundry, bedrock, gemini or openai
                         (default: the first with credentials, in that order)
  --model <id>           The model, or on Microsoft Foundry the deployment (default ${DEFAULT_MODELS.anthropic}, ${DEFAULT_MODELS.foundry} on
                         Foundry, ${DEFAULT_MODELS.bedrock} on Bedrock, ${DEFAULT_MODELS.gemini} on Gemini, ${DEFAULT_MODELS.openai} on OpenAI)
  --region <region>      Bedrock's AWS Region (default AWS_REGION, AWS_DEFAULT_REGION or us-east-1)
  --foundry-api <api>    Which API a Foundry deployment speaks, anthropic or openai, when its name doesn't say
                         (default: anthropic for a name with "claude" in it)
  --no-fallbacks         Leave Anthropic's refusal fallback off (for a gateway that doesn't pass it through)
  --open                 Open the simulator in the browser
  --verbose              Log every exchange
  --out <file>           check: also write the report as JSON
  --html <file>          check: also write the report as a page to share, with the screenshots
  --visual               check: show every screen on the Echo Show 5, 8 and 15 in a headless browser, and judge them
  --screenshots <dir>    check --visual: where the screenshots go (default readiness-screenshots)
  --browser <name>       check --visual: chrome, msedge or chromium (default: the first one installed)
  --json                 check, validate: print JSON instead of a summary
  --client-id <id>       link: a client you made, with its secret (if any) in ${CLIENT_SECRET_ENV}; without one,
                         link registers a client for testing when the authorization server allows it
  --callback-port <port> link: where the sign-in comes back, as http://127.0.0.1:<port>/callback (default ${DEFAULT_CALLBACK_PORT})

Talking needs a model: ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL for a gateway); ANTHROPIC_FOUNDRY_API_KEY (or
AZURE_OPENAI_AUTH_TOKEN) with ANTHROPIC_FOUNDRY_RESOURCE (or ANTHROPIC_FOUNDRY_BASE_URL) for Microsoft Foundry;
AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (and AWS_SESSION_TOKEN), for Bedrock;
GEMINI_API_KEY or GOOGLE_API_KEY (and GOOGLE_GEMINI_BASE_URL for a gateway) for Gemini; or OPENAI_API_KEY, and
OPENAI_BASE_URL for another server that speaks Chat Completions, such as Azure OpenAI or a model server on your
own machine (none tried yet). The Tools tab works without one.
${DISCLAIMER}`;

const OPTIONS = {
  token: { type: "string" },
  "token-file": { type: "string" },
  "client-id": { type: "string" },
  "callback-port": { type: "string" },
  header: { type: "string", multiple: true },
  addon: { type: "string" },
  calls: { type: "string" },
  extension: { type: "string", multiple: true },
  "server-port": { type: "string" },
  "client-port": { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  region: { type: "string" },
  "foundry-api": { type: "string" },
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
  /** Opens a page in the browser; tests pass their own, which can follow link's sign-in itself. */
  openBrowser?: (url: string) => unknown;
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

/** A header's name as HTTP allows it (RFC 9110's token), so a bad one is a usage problem here rather than a failure on every request. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

function headers(list: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of list ?? []) {
    const at = h.indexOf(":");
    if (at < 1) throw new UsageError(`--header takes "Name: value", not ${JSON.stringify(h)}.`);
    const name = h.slice(0, at).trim();
    const value = h.slice(at + 1).trim();
    if (!HEADER_NAME.test(name)) throw new UsageError(`--header takes "Name: value", and ${JSON.stringify(name)} isn't a header name.`);
    if (/[\r\n\0]/.test(value)) throw new UsageError(`--header ${name} has a line break in its value.`);
    out[name] = value;
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

/** The sample calls for the check, read and checked at the start so a bad file is fixed before any call is made. */
async function readCalls(path: string | undefined): Promise<ToolCall[] | undefined> {
  if (!path) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new UsageError(`Couldn't read ${path}: ${err instanceof Error ? err.message : err}`);
  }
  try {
    return parseCalls(parsed, path);
  } catch (err) {
    throw new UsageError((err as Error).message);
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
  // On Windows, not through cmd's start: cmd reads the & between query parameters as the end of the command,
  // which cut link's sign-in address short. rundll32 hands the URL to the default browser untouched.
  const [cmd, args] =
    process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/** The bearer token for the check and the proxy: --token or MCP_TOKEN as given, or link's token file, which refreshes itself. */
async function signIn(target: string, values: ParsedValues, io: Io): Promise<{ check?: string | TokenSource; proxy?: ProxyOptions["token"] }> {
  const file = values["token-file"];
  if (file === undefined) {
    const token = values.token ?? io.env.MCP_TOKEN;
    return { check: token, proxy: token };
  }
  if (values.token !== undefined) throw new UsageError("Use --token or --token-file, not both.");
  let tokens: TokenFile;
  try {
    tokens = await TokenFile.load(file, { env: io.env, warn: io.err });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new UsageError(`There's no token file at ${file}. Sign in first: alexa-plus-simulator link ${target} --token-file ${file}`);
    }
    throw new UsageError((err as Error).message);
  }
  if (!sameResource(tokens.mcpUrl, target)) io.err(`Note: ${file} was linked for ${tokens.mcpUrl}, not ${target}, so its token may not work here.`);
  let told = false;
  const proxy = async (refused?: string) => {
    try {
      return refused ? await tokens.renew(refused) : await tokens.token();
    } catch (err) {
      // The page sees the proxy's error on each request; the terminal hears it once.
      if (!told) io.err((err as Error).message);
      told = true;
      throw err;
    }
  };
  return { check: tokens, proxy };
}

async function simulate(target: string, values: ParsedValues, io: Io): Promise<number> {
  const upstream = mcpUrl(target);
  const addon = await readAddon(values.addon);
  const calls = await readCalls(values.calls);
  const extra = headers(values.header);
  const tokens = await signIn(upstream, values, io);
  const provider = values.provider;
  if (provider !== undefined && !isProviderName(provider)) throw new UsageError(`--provider takes anthropic, foundry, bedrock, gemini or openai, not ${JSON.stringify(provider)}.`);
  if (values.region !== undefined && !isAwsRegion(values.region)) throw new UsageError(`${values.region} isn't an AWS Region, like us-east-1.`);
  const foundryApi = values["foundry-api"];
  if (foundryApi !== undefined && !isFoundryApi(foundryApi)) throw new UsageError(`--foundry-api takes anthropic or openai, not ${JSON.stringify(foundryApi)}.`);
  // The provider and its model, from the flags and the credentials in the environment.
  const model = setUpModel(modelOptionsFromEnv(io.env, { provider, model: values.model, region: values.region, fallbacks: !values["no-fallbacks"], foundryApi }));
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
    "/api/model": model.route,
    "/api/info": async () => json({ version: VERSION, model: model.label, provider: model.provider, phrases, extensions: extensions.map((e) => e.path) }),
    ...Object.fromEntries(
      extensions.map(({ path, source }): [string, Route] => [path, async () => new Response(source, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } })]),
    ),
    "/api/check": async (request) => {
      if (request.method !== "POST") return json({ error: { code: "method", message: "POST to run the check." } }, 405);
      try {
        const report = await runChecks({ serverUrl: upstream, token: tokens.check, calls, headers: extra });
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
    token: tokens.proxy,
    headers: extra,
    verbose: values.verbose,
    uiDir: uiDir(),
    routes,
  });
  io.out(`Alexa+ simulator ${VERSION} (unofficial)`);
  io.out(`  Simulator: ${proxy.uiUrl}`);
  io.out(`  Proxy:     ${proxy.url}/mcp -> ${upstream}`);
  io.out(`  Model:     ${model.summary}`);
  if (addon !== undefined) io.out(`  Add-on:    ${values.addon} (${phrases.length} example phrase${phrases.length === 1 ? "" : "s"})`);
  if (values["token-file"] !== undefined) io.out(`  Sign-in:   ${values["token-file"]}, refreshed as it expires`);
  io.out("Press Ctrl+C to stop.");
  io.started?.({ url: proxy.url, uiUrl: proxy.uiUrl });
  if (values.open) (io.openBrowser ?? openBrowser)(proxy.uiUrl);
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
  try {
    parseServerUrl(serverUrl);
  } catch (err) {
    // Plain http to another machine, say: a URL the check won't use, so a usage problem, before anything is sent.
    throw new UsageError((err as Error).message);
  }
  const addon = await readAddon(values.addon);
  const calls = await readCalls(values.calls);
  const extra = headers(values.header);
  const tokens = await signIn(serverUrl, values, io);
  const base = await runChecks({ serverUrl, token: tokens.check, calls, headers: extra });
  let report = addon === undefined ? base : withRules(base, validatePackage(addon));
  if (values.visual) {
    const screenshots = values.screenshots ?? "readiness-screenshots";
    const screens = await checkScreens({
      serverUrl,
      ...(tokens.proxy ? { token: tokens.proxy } : {}),
      headers: extra,
      uiDir: uiDir(),
      outDir: screenshots,
      // A sample call for a screen whose tool needs arguments shows that screen too.
      ...(calls ? { calls } : {}),
      ...(values.browser ? { browser: values.browser } : {}),
    });
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

async function linkCommand(target: string | undefined, values: ParsedValues, io: Io): Promise<number> {
  const mcp = mcpUrl(target);
  if (values.token !== undefined) throw new UsageError("link signs in to get a token, so it doesn't take --token.");
  await link({
    mcpUrl: mcp,
    ...(values["client-id"] ? { clientId: values["client-id"] } : {}),
    ...(io.env[CLIENT_SECRET_ENV] ? { clientSecret: io.env[CLIENT_SECRET_ENV] } : {}),
    callbackPort: port(values["callback-port"], DEFAULT_CALLBACK_PORT),
    tokenFile: values["token-file"] ?? DEFAULT_TOKEN_FILE,
    open: io.openBrowser ?? openBrowser,
    out: io.out,
  });
  return 0;
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
    if (first === "link") return await linkCommand(second, values, io);
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

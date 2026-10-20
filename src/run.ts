import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildReport, formatReport, parseCalls, runChecks, type ToolCall, type TokenSource, validatePackage } from "./check/index.ts";
import { sameResource } from "./check/auth.ts";
import { CLIENT_SECRET_ENV, DEFAULT_CALLBACK_PORT, DEFAULT_TOKEN_FILE, link, TokenFile } from "./link/index.ts";
import { DEFAULT_MODEL, modelRoute } from "./model/index.ts";
import { type ProxyOptions, type Route, startProxy } from "./proxy/index.ts";
import { DEFAULT_CLIENT_PORT, DEFAULT_SERVER_PORT, DISCLAIMER, type ReadinessReport, type RuleResult, VERSION } from "./shared/contract.ts";

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
  --header "Name: value" Another header on every request to the server (repeatable)
  --addon <addon.json>   Your add-on package: its example phrases show as suggestions, and the check includes it
  --calls <calls.json>   Sample calls for the check, like [{ "tool": "get_forecast", "arguments": { "city": "Denver" } }]:
                         made even to a tool not marked read-only, and repeated only for read-only ones
  --extension <file.js>  An extension for the page: an ES module whose default export is the extension (repeatable)
  --server-port <port>   The proxy's port (default ${DEFAULT_SERVER_PORT})
  --client-port <port>   The page's port (default ${DEFAULT_CLIENT_PORT})
  --model <id>           The Claude model standing in for Alexa+ (default ${DEFAULT_MODEL})
  --no-fallbacks         Leave Anthropic's refusal fallback off (for a gateway that doesn't pass it through)
  --open                 Open the simulator in the browser
  --verbose              Log every exchange
  --out <file>           check: also write the report as JSON
  --json                 check, validate: print JSON instead of a summary
  --client-id <id>       link: a client you made, with its secret (if any) in ${CLIENT_SECRET_ENV}; without one,
                         link registers a client for testing when the authorization server allows it
  --callback-port <port> link: where the sign-in comes back, as http://127.0.0.1:<port>/callback (default ${DEFAULT_CALLBACK_PORT})

Talking needs ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL for a gateway); the Tools tab works without it.
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
  model: { type: "string" },
  "no-fallbacks": { type: "boolean" },
  open: { type: "boolean" },
  verbose: { type: "boolean" },
  out: { type: "string" },
  json: { type: "boolean" },
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
  const tokens = await signIn(upstream, values, io);
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
        const report = await runChecks({ serverUrl: upstream, token: tokens.check, calls });
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
    headers: headers(values.header),
    verbose: values.verbose,
    uiDir: fileURLToPath(new URL("../ui", import.meta.url)),
    routes,
  });
  io.out(`Alexa+ simulator ${VERSION} (unofficial)`);
  io.out(`  Simulator: ${proxy.uiUrl}`);
  io.out(`  Proxy:     ${proxy.url}/mcp -> ${upstream}`);
  io.out(`  Model:     ${apiKey ? model : "none: set ANTHROPIC_API_KEY to talk (the Tools tab works without it)"}`);
  if (addon !== undefined) io.out(`  Add-on:    ${values.addon} (${phrases.length} example phrase${phrases.length === 1 ? "" : "s"})`);
  if (values["token-file"] !== undefined) io.out(`  Sign-in:   ${values["token-file"]}, refreshed as it expires`);
  io.out("Press Ctrl+C to stop.");
  io.started?.({ url: proxy.url, uiUrl: proxy.uiUrl });
  if (values.open) (io.openBrowser ?? openBrowser)(proxy.uiUrl);
  await (io.stopped ?? new Promise<void>((resolve) => process.once("SIGINT", () => resolve())));
  await proxy.close();
  return 0;
}

async function check(target: string, values: ParsedValues, io: Io): Promise<number> {
  const serverUrl = mcpUrl(target);
  const addon = await readAddon(values.addon);
  const calls = await readCalls(values.calls);
  const tokens = await signIn(serverUrl, values, io);
  const base = await runChecks({ serverUrl, token: tokens.check, calls });
  const report = addon === undefined ? base : withRules(base, validatePackage(addon));
  if (values.out) await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
  io.out(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  if (values.out && !values.json) io.out(`Wrote ${values.out}.`);
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

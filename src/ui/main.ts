import { type Extension, startSimulator } from "./simulator.ts";
import "./style.css";

/**
 * The CLI's page: the simulator on the local proxy, with the extensions
 * given to the CLI (--extension), which the proxy serves.
 */

interface Config {
  proxyUrl: string;
  upstream: string;
}

interface Info {
  version: string;
  /** The model standing in for Alexa+, or null without an API key. */
  model: string | null;
  /** The add-on's example phrases, from --addon. */
  phrases: string[];
  /** Where the proxy serves each --extension. */
  extensions?: string[];
}

const config = (await fetch("/config.json").then((r) => r.json())) as Config;
const api = (path: string) => new URL(path, config.proxyUrl).toString();
const info = (await fetch(api("/api/info"))
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)) as Info | null;

const extensions: Extension[] = [];
for (const path of info?.extensions ?? []) {
  try {
    const mod = (await import(/* @vite-ignore */ api(path))) as { default?: unknown };
    if (typeof mod.default === "function") extensions.push(mod.default as Extension);
    else console.error(`${path} has no default export to run as an extension.`);
  } catch (err) {
    console.error(`The extension at ${path} didn't load:`, err);
  }
}

const sim = await startSimulator({
  root: document.getElementById("app")!,
  mcpUrl: api("/mcp"),
  serverUrl: config.upstream,
  proxyUrl: config.proxyUrl,
  modelUrl: api("/api/model"),
  ...(info?.model ? { modelLabel: `Claude (${info.model})` } : {}),
  check: api("/api/check"),
  suggestions: info?.phrases ?? [],
  extensions,
});

if (!info?.model) {
  sim.root.querySelector("#model-note")!.textContent = "No ANTHROPIC_API_KEY, so talking is off. Call tools yourself from the Tools tab, or restart the simulator with the key set.";
}

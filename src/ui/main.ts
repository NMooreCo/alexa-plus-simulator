import type Anthropic from "@anthropic-ai/sdk";
import { Client, StreamableHTTPClientTransport, SUPPORTED_PROTOCOL_VERSIONS, type Tool } from "@modelcontextprotocol/client";
import { AppBridge, getToolUiResourceUri, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { ALEXA_CLIENT_INFO, ALEXA_PROTOCOL_VERSION, DEVICES, LATENCY_BUDGET_MS, type Device, type ProxyState, type ReadinessReport, type RpcRecord, type RuleCategory } from "../shared/contract.ts";
import { CSP_VIOLATION, cspFix, echoable, type ResourceCsp, resultText, rpcLabel, schemaSkeleton, ToolNames, withCsp } from "./lib.ts";
import "./style.css";

/**
 * The simulator's page. It is the MCP client, as Alexa+ is: it connects to
 * the server through the simulator's proxy (which records every exchange),
 * initializes the way Alexa+ does, lists the tools, calls them and renders
 * their MCP Apps screens on a simulated Echo. Claude, through the proxy's
 * /api/model, stands in for Alexa+'s own model and only decides what to say
 * or which tool to call next.
 */

type Msg = Anthropic.Beta.BetaMessageParam;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type Reply = Anthropic.Beta.BetaMessage;
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

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
}

const MAX_STEPS = 8;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const stageEl = $("device").parentElement!;
const deviceEl = $("device");
const screenEl = $("screen");
const idleEl = $("idle");
const appHost = $("app-host");
const captionEl = $("caption");
const heardEl = $("heard");
const saidEl = $("said");
const lightbar = $("lightbar");
const statusEl = $("status");
const micBtn = $<HTMLButtonElement>("mic");
const micLabel = $("mic-label");
const askForm = $<HTMLFormElement>("ask-form");
const askInput = $<HTMLInputElement>("ask-input");
const handsFreeEl = $<HTMLInputElement>("handsfree");
const voiceNote = $("voice-note");
const talkLog = $("talk-log");
const trafficLog = $("traffic-log");
const themeEl = $<HTMLSelectElement>("theme");
const devicePick = $<HTMLSelectElement>("device-pick");
const toolPick = $<HTMLSelectElement>("tool-pick");
const toolArgs = $<HTMLTextAreaElement>("tool-args");
const toolResultEl = $("tool-result");
const toolMeta = $("tool-meta");

const config = (await fetch("/config.json").then((r) => r.json())) as Config;
const api = (path: string) => new URL(path, config.proxyUrl).toString();
const info = (await fetch(api("/api/info"))
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null)) as Info | null;
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

$("upstream").textContent = config.upstream;

const state = {
  messages: [] as Msg[],
  /** What someone did on the screen since the assistant last spoke. */
  screenNotes: [] as string[],
  busy: false,
};

function setStatus(text: string, tone: "" | "bad" = "") {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(`alexa-plus-simulator:${key}`);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(`alexa-plus-simulator:${key}`, value);
  } catch {
    // Remembering is a convenience; the page works without it.
  }
}

// ---------- The device ----------

const params = new URLSearchParams(location.search);
let device: Device = DEVICES.find((d) => d.id === (params.get("device") ?? stored("device"))) ?? DEVICES.find((d) => d.id === "show-8")!;

for (const d of DEVICES) {
  const option = document.createElement("option");
  option.value = d.id;
  option.textContent = d.surface === "none" ? `${d.name} (no screen)` : `${d.name} (${d.surface} screen)`;
  devicePick.append(option);
}
themeEl.value = stored("theme") === "light" ? "light" : "dark";

function fit() {
  if (!device.width || !device.height) return;
  // The bezel is drawn outside the device, inside the stage.
  const room = stageEl.clientWidth - 30;
  const tall = Math.max(240, innerHeight - 220);
  const scale = Math.min(1, room / device.width, tall / device.height);
  screenEl.style.transform = `scale(${scale})`;
  deviceEl.style.width = `${device.width * scale}px`;
  deviceEl.style.height = `${device.height * scale}px`;
}
new ResizeObserver(fit).observe(stageEl);

/** Puts the page on another device: its screen size, or no screen at all. */
async function setDevice(d: Device) {
  device = d;
  devicePick.value = d.id;
  store("device", d.id);
  const url = new URL(location.href);
  url.searchParams.set("device", d.id);
  history.replaceState(null, "", url);
  const dot = d.surface === "none";
  document.body.classList.toggle("dot", dot);
  // A Dot has no screen: its light ring is the device's edge, and what was heard and said shows under it.
  if (dot) {
    deviceEl.append(lightbar);
    deviceEl.after(captionEl);
    deviceEl.style.width = "";
    await unmount();
  } else {
    screenEl.append(captionEl, lightbar);
    screenEl.style.width = `${d.width}px`;
    screenEl.style.height = `${d.height}px`;
    fit();
  }
  $("surface").textContent = dot ? "Voice only" : d.surface === "small" ? `Small surface (10" and below), ${d.width} x ${d.height}` : `Large surface (11" and above), ${d.width} x ${d.height}`;
  $("device-note").textContent = dot
    ? `A simulated Alexa+ on an ${d.name}: no screen, so everything has to work by voice.`
    : `A simulated Alexa+ on an ${d.name}. Alexa+ renders a tool's MCP Apps screen when the tool names one in _meta.ui.resourceUri, and Amazon asks that screens work on both surfaces.`;
  if (mounted) await mounted.bridge.sendHostContextChange({ containerDimensions: { width: d.width!, height: d.height! } });
  else if (!dot && lastScreen) await showScreen(lastScreen.tool, lastScreen.uri, lastScreen.args, lastScreen.result).catch(() => {});
}
devicePick.addEventListener("change", () => void setDevice(DEVICES.find((d) => d.id === devicePick.value)!));
themeEl.addEventListener("change", () => {
  store("theme", themeEl.value);
  void mounted?.bridge.sendHostContextChange({ theme: themeEl.value as "dark" | "light" });
});

function tick() {
  $("idle-clock").textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
setInterval(tick, 15_000);
tick();
$("idle-hint").textContent = info?.phrases[0] ? `Try "${info.phrases[0]}"` : "Say something, or type it in the panel.";

function setLight(s: "idle" | "listening" | "thinking" | "speaking") {
  lightbar.dataset.state = s;
}

let captionTimer: ReturnType<typeof setTimeout> | undefined;
function caption(heard: string, said: string) {
  heardEl.textContent = heard ? `"${heard}"` : "";
  saidEl.textContent = said;
  captionEl.hidden = !heard && !said;
  clearTimeout(captionTimer);
  if (said) captionTimer = setTimeout(() => (captionEl.hidden = true), 9000 + said.length * 40);
}

// ---------- Logs ----------

function addLog(list: HTMLElement, who: string, text: string, meta = "", bad = false): HTMLLIElement {
  const li = document.createElement("li");
  if (bad) li.className = "bad";
  const time = document.createElement("span");
  time.className = "when";
  time.textContent = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const tag = document.createElement("span");
  tag.className = "who";
  tag.dataset.who = who;
  tag.textContent = who;
  const body = document.createElement("span");
  body.className = "what";
  body.textContent = text;
  li.append(time, tag, body);
  if (meta) {
    const m = document.createElement("span");
    m.className = "meta";
    m.textContent = meta;
    li.append(m);
  }
  list.prepend(li);
  while (list.children.length > 300) list.lastElementChild?.remove();
  return li;
}

function clip(value: unknown, max = 6000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > max ? `${text.slice(0, max)}\n... (${text.length - max} more characters)` : text;
}

let trafficTotal = 0;
let trafficSlow = 0;

/** One JSON-RPC exchange, as the proxy saw it. */
function addTraffic(rec: RpcRecord) {
  trafficTotal++;
  if (rec.overBudget) trafficSlow++;
  const failed = rec.status >= 400 || rec.error !== undefined;
  const li = addLog(trafficLog, String(rec.status), rpcLabel(rec.method, rec.params), "", failed);
  li.querySelector(".when")!.textContent = new Date(rec.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const meta = document.createElement("span");
  meta.className = rec.overBudget ? "meta slow" : "meta";
  meta.textContent = `${Math.round(rec.durationMs)} ms${rec.overBudget ? ` (Alexa+ asks for under ${LATENCY_BUDGET_MS} ms)` : ""}`;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "Request and response";
  const pre = document.createElement("pre");
  pre.className = "result";
  pre.textContent = `${clip({ method: rec.method, params: rec.params })}\n\n${clip(rec.error !== undefined ? { error: rec.error } : { result: rec.result })}`;
  details.append(summary, pre);
  li.append(meta, details);
  const count = $("traffic-count");
  count.textContent = `(${trafficTotal})`;
  count.dataset.tone = trafficSlow ? "bad" : "";
  $("budget-note").textContent = trafficSlow
    ? `${trafficSlow} of ${trafficTotal} requests took ${LATENCY_BUDGET_MS} ms or more. Alexa+ asks for a round trip under ${LATENCY_BUDGET_MS} ms.`
    : `Every MCP request this page makes, through the simulator's proxy. Alexa+ asks for a round trip under ${LATENCY_BUDGET_MS} ms.`;
}

/** The proxy's record of every exchange: what happened before this page opened, then each one as it happens. */
async function watchProxy() {
  const seen = (await fetch(api("/state"))
    .then((r) => r.json())
    .catch(() => null)) as ProxyState | null;
  for (const rec of seen?.rpc.slice(-100) ?? []) addTraffic(rec);
  const events = new EventSource(api("/events"));
  events.addEventListener("rpc", (e) => addTraffic(JSON.parse((e as MessageEvent<string>).data) as RpcRecord));
  events.addEventListener("error", (e) => {
    // The proxy's own "error" events carry data; the browser's connection errors don't.
    if (e instanceof MessageEvent && e.data) {
      const { method, description } = JSON.parse(e.data as string) as { method?: string; description: string };
      addLog(talkLog, "error", `${method ? `${method}: ` : ""}${description}`, "", true);
    } else if (events.readyState === EventSource.CLOSED) {
      setStatus("Lost the simulator's proxy. Is it still running?", "bad");
    }
  });
}

// ---------- MCP ----------

let client!: Client;
const tools = new Map<string, Tool>();
const names = new ToolNames();
let modelTools: Anthropic.Beta.BetaTool[] = [];
const uiByTool = new Map<string, string>();
let instructions = "";

function visibleToModel(t: Tool): boolean {
  const visibility = (t._meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  return !Array.isArray(visibility) || visibility.includes("model");
}

/** Connects the way Alexa+ does: its client name and version, its capabilities, and protocol version 2025-03-26 first. */
async function connect() {
  client = new Client(
    { ...ALEXA_CLIENT_INFO },
    {
      capabilities: { roots: { listChanged: true } },
      supportedProtocolVersions: [ALEXA_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS.filter((v) => v !== ALEXA_PROTOCOL_VERSION)],
    },
  );
  client.setRequestHandler("roots/list", () => ({ roots: [] }));
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", config.proxyUrl)));
  instructions = client.getInstructions() ?? "";
  tools.clear();
  uiByTool.clear();
  modelTools = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const t of page.tools) tools.set(t.name, t);
    cursor = page.nextCursor;
  } while (cursor && tools.size < 1000);
  for (const t of tools.values()) {
    try {
      const uri = getToolUiResourceUri(t);
      if (uri) uiByTool.set(t.name, uri);
    } catch (err) {
      addLog(talkLog, "error", `${t.name}: ${message(err)}`, "", true);
    }
    // A tool only screens may call is the screen's business, not the assistant's.
    if (!visibleToModel(t)) continue;
    const { $schema: _drop, ...schema } = (t.inputSchema ?? { type: "object" }) as Record<string, unknown>;
    modelTools.push({ name: names.add(t.name), description: t.description ?? t.title ?? t.name, input_schema: schema as Anthropic.Beta.BetaTool["input_schema"] });
  }
  const server = client.getServerVersion();
  const version = client.getNegotiatedProtocolVersion() ?? "";
  const screens = new Set(uiByTool.values()).size;
  setStatus(
    `Connected to ${server?.name ?? "the server"}${server?.version ? ` ${server.version}` : ""}: ${tools.size} tool${tools.size === 1 ? "" : "s"}, ${screens} screen${screens === 1 ? "" : "s"}` +
      (version && version !== ALEXA_PROTOCOL_VERSION ? `. It answered protocol ${version}; Alexa+ asks for ${ALEXA_PROTOCOL_VERSION}.` : "."),
  );
  renderServer(version);
  fillToolPicker();
}

// ---------- Screens (MCP Apps) ----------

interface Mounted {
  uri: string;
  bridge: AppBridge;
  iframe: HTMLIFrameElement;
  ready: Promise<void>;
}
let mounted: Mounted | null = null;
/** The last screen a tool showed, to show again on a device that has a screen. */
let lastScreen: { tool: Tool; uri: string; args: Record<string, unknown>; result: ToolResult } | null = null;
const pages = new Map<string, { html: string; csp?: ResourceCsp }>();

async function page(uri: string) {
  const cached = pages.get(uri);
  if (cached) return cached;
  const res = await client.readResource({ uri });
  const c = res.contents[0] as { text?: string; blob?: string; _meta?: { ui?: { csp?: ResourceCsp } } } | undefined;
  const html = c?.text ?? (c?.blob ? new TextDecoder().decode(Uint8Array.from(atob(c.blob), (ch) => ch.charCodeAt(0))) : "");
  if (!html) throw new Error(`${uri} came back without HTML.`);
  const p = { html, csp: c?._meta?.ui?.csp };
  pages.set(uri, p);
  return p;
}

function hostContext(tool?: Tool) {
  return {
    theme: themeEl.value as "dark" | "light",
    displayMode: "fullscreen" as const,
    availableDisplayModes: ["fullscreen" as const],
    containerDimensions: { width: device.width ?? 0, height: device.height ?? 0 },
    platform: "web" as const,
    locale: "en-US",
    timeZone,
    deviceCapabilities: { touch: true, hover: false },
    // Keep the screen's content clear of the light bar.
    safeAreaInsets: { top: 0, right: 0, bottom: 10, left: 0 },
    ...(tool ? { toolInfo: { tool } } : {}),
  };
}

async function unmount() {
  const m = mounted;
  mounted = null;
  if (!m) return;
  await withTimeout(m.bridge.teardownResource({}), 1000, "teardown").catch(() => {});
  await m.bridge.close().catch(() => {});
  m.iframe.remove();
  idleEl.hidden = false;
}

async function mount(tool: Tool, uri: string) {
  const { html, csp } = await page(uri);
  await unmount();
  const iframe = document.createElement("iframe");
  iframe.title = `${tool.title ?? tool.name} screen`;
  iframe.setAttribute("sandbox", "allow-scripts");
  appHost.replaceChildren(iframe);
  const bridge = new AppBridge(
    client,
    { name: "Alexa+ simulator", version: info?.version ?? "0.1.0" },
    { serverTools: {}, logging: {}, openLinks: {}, updateModelContext: { text: {} }, message: { text: {} } },
    { hostContext: hostContext(tool) },
  );
  let ready!: () => void;
  const readyP = new Promise<void>((r) => (ready = r));
  bridge.oninitialized = () => ready();
  bridge.onupdatemodelcontext = async ({ content }) => {
    for (const c of content ?? []) {
      if (c.type !== "text") continue;
      state.screenNotes.push(c.text.slice(0, 2000));
      addLog(talkLog, "screen", `told the assistant: ${c.text}`);
    }
    return {};
  };
  bridge.onmessage = async ({ content }) => {
    const text = (content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join(" ");
    if (text) void ask(text, "screen");
    return {};
  };
  bridge.onopenlink = async ({ url }) => {
    if (!/^https?:\/\//i.test(url)) return { isError: true };
    window.open(url, "_blank", "noopener,noreferrer");
    addLog(talkLog, "screen", `opened ${url}`);
    return {};
  };
  bridge.onrequestdisplaymode = async () => ({ mode: "fullscreen" });
  bridge.onloggingmessage = ({ level, data }) => addLog(talkLog, "screen", `log (${level}): ${typeof data === "string" ? data : JSON.stringify(data)}`);
  bridge.onrequestteardown = () => void unmount();
  await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
  iframe.srcdoc = withCsp(html, csp);
  mounted = { uri, bridge, iframe, ready: readyP };
  idleEl.hidden = true;
}

/** Shows a tool's screen with its result, reusing the one already up when it's the same screen. */
async function showScreen(tool: Tool, uri: string, args: Record<string, unknown>, result: ToolResult) {
  lastScreen = { tool, uri, args, result };
  if (device.surface === "none") return;
  if (!mounted || mounted.uri !== uri) await mount(tool, uri);
  const m = mounted!;
  await withTimeout(m.ready, 10_000, `The screen ${uri} didn't start: it never sent ui/notifications/initialized.`);
  await m.bridge.sendToolInput({ arguments: args });
  await m.bridge.sendToolResult(result as Parameters<AppBridge["sendToolResult"]>[0]);
}

// What a screen's policy blocked, from the watcher withCsp puts in it.
addEventListener("message", (e) => {
  const data = e.data as { type?: string; blocked?: string; directive?: string } | null;
  if (data?.type !== CSP_VIOLATION || !mounted || e.source !== mounted.iframe.contentWindow) return;
  const directive = data.directive ?? "";
  addLog(talkLog, "error", `The screen tried to load ${data.blocked || "something"} (${directive}) without declaring it. Add its origin to _meta.ui.csp.${cspFix(directive)} on the resource.`, "", true);
});

// ---------- The assistant ----------

class NoKey extends Error {}

async function callModel(): Promise<Reply> {
  const started = performance.now();
  const res = await fetch(api("/api/model"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: state.messages,
      tools: modelTools,
      context: {
        instructions,
        timeZone,
        now: new Date().toLocaleString("en-US", { timeZone, dateStyle: "full", timeStyle: "short" }),
        device: device.name,
        screen: device.surface !== "none",
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Reply & { error?: { code?: string; message?: string } };
  if (!res.ok) {
    if (body.error?.code === "no_key") throw new NoKey(body.error.message ?? "No API key.");
    throw new Error(body.error?.message ?? "The assistant didn't answer.");
  }
  const ms = Math.round(performance.now() - started);
  const u = body.usage;
  const tokens = u ? `${u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)} in (${u.cache_read_input_tokens ?? 0} cached), ${u.output_tokens} out` : "";
  addLog(talkLog, "model", body.stop_reason === "tool_use" ? "chose tools" : "answered", `${body.model} · ${ms} ms · ${tokens}`);
  return body;
}

async function runTool(use: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const name = names.mcp(use.name) ?? use.name;
  const tool = tools.get(name);
  const args = (use.input ?? {}) as Record<string, unknown>;
  addLog(talkLog, "assistant", `calls ${name} ${JSON.stringify(args)}`);
  if (!tool) return { type: "tool_result", tool_use_id: use.id, content: `There's no tool named ${use.name}.`, is_error: true };
  try {
    const result = await client.callTool({ name, arguments: args });
    const uri = uiByTool.get(name);
    if (uri && !result.isError) await showScreen(tool, uri, args, result).catch((err) => addLog(talkLog, "error", `The screen for ${name} didn't show: ${message(err)}`, "", true));
    return { type: "tool_result", tool_use_id: use.id, content: resultText(result).slice(0, 20_000) || "(The tool returned nothing.)", is_error: Boolean(result.isError) };
  } catch (err) {
    return { type: "tool_result", tool_use_id: use.id, content: message(err) || "That tool didn't answer.", is_error: true };
  }
}

/** What someone said, typed, or a screen sent; `voice` when it came through the microphone, so a question back can listen for the answer. */
async function ask(text: string, via: "voice" | "typed" | "screen" = "typed") {
  text = text.trim();
  if (!text || state.busy) return;
  askedByVoice = via === "voice";
  state.busy = true;
  stopSpeaking();
  setLight("thinking");
  caption(via === "screen" ? "" : text, "");
  addLog(talkLog, via === "screen" ? "screen" : "you", via === "screen" ? `said for you: ${text}` : text);
  const before = state.messages.length;
  const content: BlockParam[] = [];
  const notes = state.screenNotes.splice(0);
  if (notes.length) content.push({ type: "text", text: `(On the screen since you last spoke: ${notes.join(" ")})` });
  content.push({ type: "text", text });
  state.messages.push({ role: "user", content });
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await callModel();
      const blocks = echoable(reply.content);
      state.messages.push({ role: "assistant", content: blocks as BlockParam[] });
      const uses = blocks.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      const said = blocks
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      if (reply.stop_reason === "tool_use" && uses.length) {
        if (said) caption(text, said);
        // Every result goes back together, in one message.
        state.messages.push({ role: "user", content: await Promise.all(uses.map(runTool)) });
        continue;
      }
      respond(text, reply.stop_reason === "refusal" ? "Sorry, I can't help with that." : said || "Done.");
      return;
    }
    respond(text, "That took more steps than I'd like. Try asking another way.");
  } catch (err) {
    // An unanswered turn would leave the conversation half-finished: take it back.
    state.messages.length = before;
    state.screenNotes.unshift(...notes);
    if (err instanceof NoKey) {
      caption(text, "");
      setLight("idle");
      addLog(talkLog, "error", "Talking needs an Anthropic API key: restart the simulator with ANTHROPIC_API_KEY set. The Tools tab calls tools without one.", "", true);
      showTab("tools");
      return;
    }
    respond(text, message(err) || "Something went wrong.");
  } finally {
    state.busy = false;
  }
}

function respond(heard: string, said: string) {
  caption(heard, said);
  addLog(talkLog, "alexa", said);
  // Asked by voice and answered with a question (wherever in the answer it was asked): listen for the answer once it's said, as an Echo's follow-up mode does.
  followUp = askedByVoice && said.includes("?");
  speak(said);
}

// ---------- Speaking ----------

function voice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
  return voices.find((v) => /Aria|Jenny|Samantha|Google US English/.test(v.name)) ?? voices.find((v) => v.lang === "en-US") ?? voices[0];
}

/** Whether the last thing asked came through the microphone. */
let askedByVoice = false;
/** The assistant just asked a question of someone who spoke: listen for the answer once it's said. */
let followUp = false;
/** Hands-free, until when an answer needs no "Alexa" first. */
let followUpUntil = 0;

function speak(text: string) {
  if (!text || !("speechSynthesis" in window)) return setLight("idle");
  const u = new SpeechSynthesisUtterance(text);
  const v = voice();
  if (v) u.voice = v;
  u.rate = 1.04;
  u.onstart = () => {
    setLight("speaking");
    pauseListening();
  };
  u.onend = u.onerror = doneSpeaking;
  speechSynthesis.speak(u);
}

function doneSpeaking() {
  setLight("idle");
  resumeListening();
  if (!followUp) return;
  followUp = false;
  if (handsFreeEl.checked) followUpUntil = Date.now() + 8000;
  else if (RecognitionCtor && !listening) startListening(false);
}

function stopSpeaking() {
  // Cut off, it isn't waiting for an answer.
  followUp = false;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---------- Listening ----------

interface Recognition extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}
const RecognitionCtor = ((window as unknown as { SpeechRecognition?: new () => Recognition }).SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition) as (new () => Recognition) | undefined;

let recognition: Recognition | null = null;
let listening = false;
let pausedForSpeech = false;
// Phones sometimes hear the wake word as "Alexis" or "Alexia".
const WAKE = /\b(?:hey\s+)?(?:alexa|alexis|alexia)\b[\s,.!?]*(.*)$/i;

function startListening(handsFree: boolean) {
  if (!RecognitionCtor) return;
  recognition?.stop();
  const r = new RecognitionCtor();
  r.lang = "en-US";
  // One phrase per session, and hands-free starts the next when it ends: Chrome on Android doesn't keep a continuous session going.
  r.continuous = false;
  r.interimResults = true;
  r.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i]!;
      const words = result[0]?.transcript ?? "";
      if (!result.isFinal) {
        if (!handsFree || WAKE.test(words)) caption(handsFree ? (WAKE.exec(words)?.[1] ?? "") : words, "");
        continue;
      }
      if (!handsFree) return void ask(words, "voice");
      // Right after a question, or after "Alexa" on its own, what's said next needs no "Alexa" first.
      const woke = WAKE.exec(words);
      const command = woke?.[1]?.trim() || (Date.now() < followUpUntil ? words.trim() : "");
      if (command) {
        followUpUntil = 0;
        voiceNote.textContent = "";
        void ask(command, "voice");
      } else if (woke) {
        followUpUntil = Date.now() + 8000;
        setLight("listening");
      } else if (words.trim()) {
        // Show what it heard, so a missed "Alexa" isn't a mystery.
        voiceNote.textContent = `Heard "${words.trim()}" without "Alexa" first.`;
      }
    }
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed") {
      voiceNote.textContent = "The microphone is blocked for this page. Type instead, or allow it in the browser.";
      handsFreeEl.checked = false;
      return;
    }
    if (e.error !== "no-speech" && e.error !== "aborted") voiceNote.textContent = `Listening stopped (${e.error}).`;
  };
  r.onend = () => {
    // A session that's already been replaced mustn't start another.
    if (recognition !== r) return;
    listening = false;
    micBtn.setAttribute("aria-pressed", "false");
    micLabel.textContent = "Talk";
    if (lightbar.dataset.state === "listening" && Date.now() >= followUpUntil) setLight("idle");
    if (handsFreeEl.checked && !pausedForSpeech) setTimeout(() => startListening(true), 300);
  };
  recognition = r;
  r.start();
  listening = true;
  micBtn.setAttribute("aria-pressed", "true");
  micLabel.textContent = handsFree ? "Listening for Alexa" : "Listening";
  if (!handsFree) setLight("listening");
}

function pauseListening() {
  if (!handsFreeEl.checked) return;
  pausedForSpeech = true;
  recognition?.stop();
}

function resumeListening() {
  if (!pausedForSpeech) return;
  pausedForSpeech = false;
  if (handsFreeEl.checked) startListening(true);
}

if (!RecognitionCtor) {
  micBtn.disabled = true;
  handsFreeEl.disabled = true;
  voiceNote.textContent = "Talking needs Chrome or Edge; typing works everywhere.";
}

micBtn.addEventListener("click", () => {
  if (listening && !handsFreeEl.checked) return recognition?.stop();
  stopSpeaking();
  startListening(false);
});
handsFreeEl.addEventListener("change", () => {
  if (handsFreeEl.checked) startListening(true);
  else recognition?.stop();
});
askForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = askInput.value;
  askInput.value = "";
  void ask(text);
});

for (const phrase of info?.phrases ?? []) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = phrase;
  // Alexa hears the request, not the wake word.
  b.addEventListener("click", () => void ask(phrase.replace(/^\s*alexa[\s,]*/i, "")));
  $("chips").append(b);
}

$("model-note").textContent = info?.model
  ? `Claude (${info.model}) stands in for Alexa+'s own model: it decides what to say and which tools to call. This page is the MCP client, as Alexa+ is.`
  : "No ANTHROPIC_API_KEY, so talking is off. Call tools yourself from the Tools tab, or restart the simulator with the key set.";

// ---------- Tabs ----------

function showTab(name: string) {
  for (const tab of document.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")) {
    const on = tab.id === `tab-${name}`;
    tab.setAttribute("aria-selected", String(on));
    $(tab.getAttribute("aria-controls")!).hidden = !on;
  }
}
for (const tab of document.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")) tab.addEventListener("click", () => showTab(tab.id.replace("tab-", "")));

// ---------- Tools, called by hand ----------

function badges(t: Tool): HTMLElement[] {
  const out: [string, string][] = [];
  if (uiByTool.has(t.name)) out.push(["screen", "good"]);
  if (t.annotations?.readOnlyHint) out.push(["read-only", ""]);
  if (t.annotations?.destructiveHint) out.push(["destructive", "warn"]);
  if (!visibleToModel(t)) out.push(["screens only", ""]);
  return out.map(([text, tone]) => {
    const b = document.createElement("span");
    b.className = "badge";
    b.dataset.tone = tone;
    b.textContent = text;
    return b;
  });
}

function fillToolPicker() {
  const previous = toolPick.value;
  toolPick.replaceChildren(
    ...[...tools.values()].map((t) => {
      const option = document.createElement("option");
      option.value = t.name;
      option.textContent = t.title && t.title !== t.name ? `${t.name} (${t.title})` : t.name;
      return option;
    }),
  );
  if (tools.has(previous)) toolPick.value = previous;
  describeTool();
}

function describeTool() {
  const t = tools.get(toolPick.value);
  const about = $("tool-about");
  about.replaceChildren();
  if (!t) return;
  about.append(t.description ?? "", ...badges(t));
  toolArgs.value = JSON.stringify(schemaSkeleton(t.inputSchema), null, 2);
}
toolPick.addEventListener("change", describeTool);

$("tool-call").addEventListener("click", async () => {
  const t = tools.get(toolPick.value);
  if (!t) return;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolArgs.value || "{}") as Record<string, unknown>;
  } catch (err) {
    toolMeta.textContent = `That isn't valid JSON: ${message(err)}`;
    return;
  }
  toolMeta.textContent = "Calling...";
  const started = performance.now();
  try {
    const result = await client.callTool({ name: t.name, arguments: args });
    const ms = Math.round(performance.now() - started);
    toolMeta.textContent = `${result.isError ? "Came back as an error" : "Done"} in ${ms} ms`;
    toolResultEl.textContent = clip(result, 50_000);
    toolResultEl.hidden = false;
    const uri = uiByTool.get(t.name);
    if (uri && !result.isError) await showScreen(t, uri, args, result);
  } catch (err) {
    toolMeta.textContent = message(err);
  }
});

// ---------- The readiness check ----------

const CATEGORIES: [RuleCategory, string][] = [
  ["mcp-data", "Data layer"],
  ["auth", "Sign-in"],
  ["visual", "Screens"],
  ["package", "Package"],
];
const ORDER = { FAIL: 0, WARN: 1, PASS: 2, SKIP: 3 } as const;
let lastReport: ReadinessReport | null = null;

function renderReport(report: ReadinessReport) {
  const out = $("check-report");
  out.replaceChildren();
  const verdict = document.createElement("div");
  verdict.className = "verdict";
  verdict.dataset.verdict = report.verdict;
  const strong = document.createElement("strong");
  strong.textContent = report.verdict.replace("_", " ");
  const counts = document.createElement("span");
  counts.className = "meta";
  counts.textContent = `${report.passCount} passed, ${report.warnCount} warnings, ${report.failCount} failed, ${report.skipCount} skipped`;
  verdict.append(strong, counts);
  const disclaimer = document.createElement("p");
  disclaimer.className = "disclaimer";
  disclaimer.textContent = report.disclaimer;
  out.append(verdict, disclaimer);
  for (const [category, title] of CATEGORIES) {
    const rules = report.rules.filter((r) => r.category === category).sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    if (!rules.length) continue;
    const h = document.createElement("h2");
    h.textContent = title;
    const list = document.createElement("ul");
    list.className = "rules";
    for (const r of rules) {
      const li = document.createElement("li");
      const chip = document.createElement("span");
      chip.className = "status-chip";
      chip.dataset.status = r.status;
      chip.textContent = r.status;
      const id = document.createElement("span");
      id.className = "rule-id";
      id.textContent = r.id;
      const notes = document.createElement("p");
      notes.textContent = r.notes;
      const source = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Amazon's requirement";
      const quote = document.createElement("blockquote");
      quote.textContent = r.source.quote;
      const link = document.createElement("a");
      link.href = r.source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = r.source.title;
      source.append(summary, quote, link);
      li.append(chip, id, r.title, notes, source);
      list.append(li);
    }
    out.append(h, list);
  }
}

$("check-run").addEventListener("click", async () => {
  const run = $<HTMLButtonElement>("check-run");
  run.disabled = true;
  run.textContent = "Checking...";
  try {
    const res = await fetch(api("/api/check"), { method: "POST" });
    const body = (await res.json()) as ReadinessReport & { error?: { message?: string } };
    if (!res.ok) throw new Error(body.error?.message ?? `The check answered ${res.status}.`);
    lastReport = body;
    renderReport(body);
    $("check-save").hidden = false;
  } catch (err) {
    $("check-report").textContent = `The check didn't finish: ${message(err)}`;
  } finally {
    run.disabled = false;
    run.textContent = "Run the readiness check again";
  }
});

$("check-save").addEventListener("click", () => {
  if (!lastReport) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(lastReport, null, 2)], { type: "application/json" }));
  a.download = "readiness-report.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

// ---------- The server ----------

function renderServer(protocolVersion: string) {
  const server = client.getServerVersion();
  const facts: [string, string][] = [
    ["Server", server ? `${server.name} ${server.version}` : "Unknown"],
    ["Protocol", protocolVersion ? `${protocolVersion}${protocolVersion === ALEXA_PROTOCOL_VERSION ? " (what Alexa+ asks for)" : ` (Alexa+ asks for ${ALEXA_PROTOCOL_VERSION})`}` : "Unknown"],
    ["Endpoint", config.upstream],
    ["Proxy", config.proxyUrl],
  ];
  const dl = $("server-facts");
  dl.replaceChildren();
  for (const [k, v] of facts) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  $("server-instructions").textContent = instructions || "(The server gave no instructions.)";
  const list = $("server-tools");
  list.replaceChildren(
    ...[...tools.values()].map((t) => {
      const li = document.createElement("li");
      const name = document.createElement("code");
      name.textContent = t.name;
      const about = document.createElement("p");
      about.textContent = t.description ?? "(No description. Alexa+ picks tools by their names and descriptions.)";
      li.append(name, ...badges(t), about);
      return li;
    }),
  );
}

// ---------- Start ----------

function newConversation() {
  state.messages = [];
  state.screenNotes = [];
  stopSpeaking();
  caption("", "");
  addLog(talkLog, "page", "New conversation");
}
$("reset").addEventListener("click", newConversation);

async function start() {
  try {
    await connect();
  } catch (err) {
    setStatus(`Couldn't connect to ${config.upstream}: ${message(err)}`, "bad");
  }
}

$("reconnect").addEventListener("click", async () => {
  await unmount();
  lastScreen = null;
  pages.clear();
  await client?.close().catch(() => {});
  newConversation();
  setStatus("Connecting...");
  await start();
});

await setDevice(device);
void watchProxy();
await start();

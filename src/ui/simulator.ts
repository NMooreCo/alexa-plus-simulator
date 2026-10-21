import type Anthropic from "@anthropic-ai/sdk";
import { Client, StreamableHTTPClientTransport, SUPPORTED_PROTOCOL_VERSIONS, type Tool } from "@modelcontextprotocol/client";
import { AppBridge, getToolUiResourceUri, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { runChecks } from "../check/index.ts";
import { ALEXA_CLIENT_INFO, ALEXA_PROTOCOL_VERSION, DEVICES, LATENCY_BUDGET_MS, VERSION, type Device, type ProxyState, type ReadinessReport, type RpcRecord, type RuleCategory, type ToolInfo } from "../shared/contract.ts";
import type { CallOptions, Extension, ExtensionHooks, Light, ModelFailure, RequestKind, ScreenInfo, Simulator, SimulatorOptions, Suggestion, ToolResult } from "./api.ts";
import { CSP_VIOLATION, cspFix, echoable, type ResourceCsp, resultText, rpcLabel, schemaSkeleton, ToolNames, withCsp } from "./lib.ts";
import { TEMPLATE } from "./template.ts";

export type * from "./api.ts";
export { DEVICES };

/**
 * The simulator. It is the MCP client, as Alexa+ is: it connects the way
 * Alexa+ does, lists the tools, calls them and renders their MCP Apps
 * screens on a simulated Echo. A model route stands in for Alexa+'s own
 * model and only decides what to say or which tool to call next. Extensions
 * add to it (see api.ts).
 */

type Msg = Anthropic.Beta.BetaMessageParam;
type BlockParam = Anthropic.Beta.BetaContentBlockParam;
type Reply = Anthropic.Beta.BetaMessage;

const MAX_STEPS = 8;

class ModelError extends Error {
  constructor(readonly failure: ModelFailure) {
    super(failure.message);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(what)), ms))]);
}

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

/** A JSON-RPC message from a reply, plain or as Server-Sent Events. */
function rpcMessage(text: string, contentType: string | null): { result?: unknown; error?: unknown } | undefined {
  try {
    if ((contentType ?? "").includes("text/event-stream")) {
      const data = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean)
        .at(-1);
      return data ? (JSON.parse(data) as { result?: unknown; error?: unknown }) : undefined;
    }
    return text ? (JSON.parse(text) as { result?: unknown; error?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

export async function startSimulator(options: SimulatorOptions): Promise<Simulator> {
  const root = options.root ?? document.body;
  root.classList.add("alexa-sim");
  if (options.compact) root.classList.add("compact");
  root.innerHTML = TEMPLATE;
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;

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
  const chipsEl = $("chips");

  const mcpUrl = new URL(options.mcpUrl, location.href);
  const serverUrl = options.serverUrl ?? mcpUrl.href;
  const proxyUrl = options.proxyUrl;
  const hooks: ExtensionHooks[] = [];
  const quietTools = new Set(options.quietTools ?? []);
  /** Tools called quietly right now (callTool's quiet option), by how many such calls are out. */
  const quietCalls = new Map<string, number>();
  const isQuiet = (name: string) => quietTools.has(name) || (quietCalls.get(name) ?? 0) > 0;
  const timeZone = () => hooks.map((h) => h.timeZone?.()).find(Boolean) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = () => hooks.find((h) => h.now)?.now?.() ?? new Date();
  const headersFor = (kind: RequestKind) => Object.assign({}, ...hooks.map((h) => h.headers?.(kind) ?? {})) as Record<string, string>;

  $("title").textContent = options.title ?? "Alexa+ simulator";
  $("lede").textContent = options.lede ?? `An open, unofficial stand-in for Alexa+, connected to ${serverUrl} as its MCP client. Not affiliated with or endorsed by Amazon.`;

  const state = {
    messages: [] as Msg[],
    /** What someone did on the screen since the assistant last spoke. */
    screenNotes: [] as string[],
    /** Lines extensions asked to have heard before the person's next words. */
    notes: [] as string[],
    busy: false,
    /** Who's calling tools right now, for the traffic log. */
    actor: "screen",
  };

  function setStatus(text: string, tone: "" | "bad" = "") {
    statusEl.textContent = text;
    statusEl.dataset.tone = tone;
  }

  // ---------- The device ----------

  const offered = options.devices ? DEVICES.filter((d) => options.devices!.includes(d.id)) : DEVICES;
  const params = new URLSearchParams(location.search);
  let device: Device =
    offered.find((d) => d.id === (options.device ?? params.get("device") ?? stored("device"))) ?? offered.find((d) => d.id === "show-8") ?? offered[0]!;

  for (const d of offered) {
    const option = document.createElement("option");
    option.value = d.id;
    option.textContent = d.surface === "none" ? `${d.name} (no screen)` : `${d.name} (${d.surface} screen)`;
    devicePick.append(option);
  }
  themeEl.value = stored("theme") === "light" ? "light" : "dark";
  if (options.place) {
    $("device-label").hidden = false;
    $("device-place").textContent = options.place;
  }

  function fit() {
    if (!device.width || !device.height) return;
    // The bezel is drawn outside the device, inside the stage.
    const room = stageEl.clientWidth - 30;
    const tall = options.compact ? Math.max(120, innerHeight * 0.5) : Math.max(240, innerHeight - 220);
    const scale = Math.min(1, room / device.width, tall / device.height);
    // At full size, no transform at all: the screen renders crisper.
    screenEl.style.transform = scale < 1 ? `scale(${scale})` : "";
    deviceEl.style.width = `${device.width * scale}px`;
    deviceEl.style.height = `${device.height * scale}px`;
  }
  new ResizeObserver(fit).observe(stageEl);

  /** Puts the page on another device: its screen size, or no screen at all. */
  async function setDevice(d: Device) {
    device = d;
    devicePick.value = d.id;
    store("device", d.id);
    if (!options.device) {
      const url = new URL(location.href);
      url.searchParams.set("device", d.id);
      history.replaceState(history.state, "", url);
    }
    const dot = d.surface === "none";
    root.classList.toggle("dot", dot);
    $("device-model").textContent = d.name;
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
    $("device-note").textContent =
      options.deviceNote?.(d) ??
      (dot
        ? `A simulated Alexa+ on an ${d.name}: no screen, so everything has to work by voice.`
        : `A simulated Alexa+ on an ${d.name}. Alexa+ renders a tool's MCP Apps screen when the tool names one in _meta.ui.resourceUri, and Amazon asks that screens work on both surfaces.`);
    if (mounted) await mounted.bridge.sendHostContextChange({ containerDimensions: { width: d.width!, height: d.height! } });
    else if (!dot && lastScreen) {
      // Shown again fresh when its tool only reads (taps may have changed things since); a change isn't made twice.
      const { tool, uri, args, result } = lastScreen;
      const fresh = tool.annotations?.readOnlyHint ? await callTool(tool.name, args).catch(() => result) : result;
      await showScreen(tool, uri, args, fresh.isError ? result : fresh).catch(() => {});
    }
  }
  devicePick.addEventListener("change", () => void setDevice(offered.find((d) => d.id === devicePick.value)!));
  themeEl.addEventListener("change", () => {
    store("theme", themeEl.value);
    void mounted?.bridge.sendHostContextChange({ theme: themeEl.value as "dark" | "light" });
  });

  function tick() {
    $("idle-clock").textContent = now().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timeZone() });
  }
  setInterval(tick, 15_000);

  function setLight(s: Light) {
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
  const budgetNote = () =>
    trafficSlow
      ? `${trafficSlow} of ${trafficTotal} requests took ${LATENCY_BUDGET_MS} ms or more. Alexa+ asks for a round trip under ${LATENCY_BUDGET_MS} ms.`
      : `Every MCP request this page makes${proxyUrl ? ", through the simulator's proxy" : ""}. Alexa+ asks for a round trip under ${LATENCY_BUDGET_MS} ms.`;
  $("budget-note").textContent = budgetNote();

  /** One JSON-RPC exchange; `actor` says who made it when the page knows. */
  function addTraffic(rec: RpcRecord, actor?: string) {
    trafficTotal++;
    if (rec.overBudget) trafficSlow++;
    const failed = rec.status >= 400 || rec.error !== undefined;
    const li = addLog(trafficLog, actor ?? String(rec.status), rpcLabel(rec.method, rec.params), "", failed);
    li.querySelector(".when")!.textContent = new Date(rec.ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" });
    const meta = document.createElement("span");
    meta.className = rec.overBudget ? "meta slow" : "meta";
    meta.textContent = `${actor ? `${rec.status} · ` : ""}${Math.round(rec.durationMs)} ms${rec.overBudget ? ` (Alexa+ asks for under ${LATENCY_BUDGET_MS} ms)` : ""}`;
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
    $("budget-note").textContent = budgetNote();
  }

  const rpcKey = (rec: RpcRecord) => `${rec.ts}|${rec.method}|${JSON.stringify(rec.id ?? null)}`;

  /**
   * The proxy's record of every exchange: what happened before this page
   * opened, then each one as it happens. It listens first and catches up
   * second, so nothing between the two is missed, and shows an exchange
   * that's in both once.
   */
  async function watchProxy(base: string) {
    const api = (path: string) => new URL(path, base).toString();
    const events = new EventSource(api("/events"));
    let early: RpcRecord[] | null = [];
    events.addEventListener("rpc", (e) => {
      const rec = JSON.parse((e as MessageEvent<string>).data) as RpcRecord;
      if (early) early.push(rec);
      else addTraffic(rec);
    });
    events.addEventListener("error", (e) => {
      // The proxy's own "error" events carry data; the browser's connection errors don't.
      if (e instanceof MessageEvent && e.data) {
        const { method, description } = JSON.parse(e.data as string) as { method?: string; description: string };
        addLog(talkLog, "error", `${method ? `${method}: ` : ""}${description}`, "", true);
      } else if (events.readyState === EventSource.CLOSED) {
        setStatus("Lost the simulator's proxy. Is it still running?", "bad");
      }
    });
    await new Promise<void>((resolve) => {
      events.addEventListener("open", () => resolve(), { once: true });
      setTimeout(resolve, 3000);
    });
    const seen = (await fetch(api("/state"))
      .then((r) => r.json())
      .catch(() => null)) as ProxyState | null;
    const caughtUp = seen?.rpc.slice(-100) ?? [];
    const known = new Set(caughtUp.map(rpcKey));
    for (const rec of caughtUp) addTraffic(rec);
    for (const rec of early) if (!known.has(rpcKey(rec))) addTraffic(rec);
    early = null;
  }

  /**
   * The MCP client's own requests, with the extensions' headers. Through the
   * proxy the proxy records them; otherwise the page does, reading each reply
   * from a copy so the client never waits on the log.
   */
  const mcpFetch: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(headersFor("mcp"))) headers.set(k, v);
    const request = { ...init, headers };
    if (proxyUrl) return fetch(input, request);
    const actor = state.actor;
    const started = performance.now();
    const ts = Date.now();
    let sent: { id?: string | number | null; method?: string; params?: { name?: string } } | undefined;
    try {
      if (typeof init?.body === "string") sent = JSON.parse(init.body) as typeof sent;
    } catch {
      // Not JSON-RPC; not logged.
    }
    // Whether it's quiet is settled as it goes out; the log is written once the reply is in.
    const quiet = sent?.method === "tools/call" && typeof sent.params?.name === "string" && isQuiet(sent.params.name);
    const res = await fetch(input, request);
    if (!sent?.method) return res;
    const { method, params, id } = sent;
    void res
      .clone()
      .text()
      .then((text) => {
        const durationMs = performance.now() - started;
        const reply = rpcMessage(text, res.headers.get("content-type"));
        const failed = res.status >= 400 || reply?.error !== undefined || (reply?.result as { isError?: boolean } | undefined)?.isError === true;
        if (!failed && quiet) return;
        addTraffic({ id, method, params, status: res.status, durationMs, ts, overBudget: durationMs >= LATENCY_BUDGET_MS, result: reply?.result, error: reply?.error }, actor);
      })
      .catch(() => {});
    return res;
  };

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
    state.actor = "page";
    client = new Client(
      { ...ALEXA_CLIENT_INFO },
      {
        capabilities: { roots: { listChanged: true } },
        supportedProtocolVersions: [ALEXA_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS.filter((v) => v !== ALEXA_PROTOCOL_VERSION)],
      },
    );
    client.setRequestHandler("roots/list", () => ({ roots: [] }));
    try {
      await client.connect(new StreamableHTTPClientTransport(mcpUrl, { fetch: mcpFetch }));
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
    } finally {
      state.actor = "screen";
    }
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
    tick();
  }

  /** A tool call through the client, with who made it in the traffic log. */
  async function callTool(name: string, args: Record<string, unknown> = {}, callOptions: CallOptions = {}): Promise<ToolResult> {
    const was = state.actor;
    state.actor = callOptions.actor ?? "page";
    if (callOptions.quiet) quietCalls.set(name, (quietCalls.get(name) ?? 0) + 1);
    try {
      return (await client.callTool({ name, arguments: args })) as ToolResult;
    } finally {
      state.actor = was;
      if (callOptions.quiet) quietCalls.set(name, (quietCalls.get(name) ?? 1) - 1);
    }
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
    const was = state.actor;
    state.actor = "page";
    try {
      const res = await client.readResource({ uri });
      const c = res.contents[0] as { text?: string; blob?: string; _meta?: { ui?: { csp?: ResourceCsp } } } | undefined;
      const html = c?.text ?? (c?.blob ? new TextDecoder().decode(Uint8Array.from(atob(c.blob), (ch) => ch.charCodeAt(0))) : "");
      if (!html) throw new Error(`${uri} came back without HTML.`);
      const p = { html, csp: c?._meta?.ui?.csp };
      pages.set(uri, p);
      return p;
    } finally {
      state.actor = was;
    }
  }

  function hostContext(tool?: Tool) {
    return {
      theme: themeEl.value as "dark" | "light",
      displayMode: "fullscreen" as const,
      availableDisplayModes: ["fullscreen" as const],
      containerDimensions: { width: device.width ?? 0, height: device.height ?? 0 },
      platform: "web" as const,
      locale: "en-US",
      timeZone: timeZone(),
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
      { name: "Alexa+ simulator", version: VERSION },
      { serverTools: {}, logging: {}, openLinks: {}, updateModelContext: { text: {} }, message: { text: {} } },
      { hostContext: hostContext(tool) },
    );
    let ready!: () => void;
    const readyP = new Promise<void>((r) => (ready = r));
    bridge.oninitialized = () => ready();
    bridge.onupdatemodelcontext = async ({ content }) => {
      for (const c of content ?? []) {
        if (c.type !== "text") continue;
        let note: string | null = c.text.slice(0, 2000);
        for (const h of hooks) if (note !== null && h.screenNote) note = h.screenNote(note);
        if (note === null) continue;
        state.screenNotes.push(note);
        addLog(talkLog, "screen", `told the assistant: ${note}`);
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

  /** Calls a tool and puts its screen up when it has one. */
  async function show(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const result = await callTool(name, args);
    const tool = tools.get(name);
    const uri = uiByTool.get(name);
    if (tool && uri && !result.isError) await showScreen(tool, uri, args, result);
    return result;
  }

  function screenInfo(): ScreenInfo | null {
    return lastScreen ? { tool: lastScreen.tool.name, uri: lastScreen.uri, arguments: lastScreen.args, result: lastScreen.result } : null;
  }

  /** The screen that's up, called again: as it is when its tool only reads, or through a tool that reads the same screen. */
  async function refreshScreen() {
    const screen = screenInfo();
    if (!screen || !lastScreen) return;
    let call = hooks.map((h) => h.refresh?.(screen)).find((c) => c !== undefined);
    if (call === undefined) {
      if (lastScreen.tool.annotations?.readOnlyHint) call = { tool: screen.tool, arguments: screen.arguments };
      else {
        const reader = [...tools.values()].find((t) => t.annotations?.readOnlyHint && uiByTool.get(t.name) === screen.uri);
        call = reader ? { tool: reader.name, arguments: {} } : null;
      }
    }
    if (!call) return;
    try {
      const result = await callTool(call.tool, call.arguments);
      const tool = tools.get(call.tool);
      if (tool && !result.isError) await showScreen(tool, screen.uri, call.arguments, result);
    } catch {
      // The screen keeps what it had.
    }
  }

  // What a screen's policy blocked, from the watcher withCsp puts in it: each thing once per screen.
  const reported = new WeakMap<Mounted, Set<string>>();
  addEventListener("message", (e) => {
    const data = e.data as { type?: string; blocked?: string; directive?: string } | null;
    if (data?.type !== CSP_VIOLATION || !mounted || e.source !== mounted.iframe.contentWindow) return;
    const blocked = data.blocked || "something";
    const directive = data.directive ?? "";
    const seen = reported.get(mounted) ?? new Set<string>();
    reported.set(mounted, seen);
    if (seen.has(`${blocked} ${directive}`)) return;
    seen.add(`${blocked} ${directive}`);
    if (blocked === "eval" || blocked === "wasm-eval") {
      // Libraries such as zod test whether eval works and carry on without it, so this is a note, not a failure.
      addLog(talkLog, "screen", "tried eval, which its policy blocks (as hosts generally do). Libraries like zod only test for it and carry on; if the screen breaks, it needs code that doesn't depend on eval.");
      return;
    }
    addLog(talkLog, "error", `The screen tried to load ${blocked} (${directive}) without declaring it. Add its origin to _meta.ui.csp.${cspFix(directive)} on the resource.`, "", true);
  });

  // ---------- The assistant ----------

  async function callModel(): Promise<Reply> {
    if (!options.modelUrl) throw new ModelError({ status: 503, code: "no_model", message: "Talking is off here." });
    const started = performance.now();
    // Longer than the CLI's route waits for its provider (60 seconds), so that route's own answer, which says what happened, comes first.
    const waitMs = options.modelTimeoutMs ?? 75_000;
    let res: Response;
    let body: Reply & { error?: { code?: string; message?: string } };
    try {
      res = await fetch(options.modelUrl, {
        method: "POST",
        headers: { "content-type": "application/json", ...headersFor("model") },
        body: JSON.stringify({
          messages: state.messages,
          tools: modelTools,
          context: {
            instructions,
            timeZone: timeZone(),
            now: now().toLocaleString("en-US", { timeZone: timeZone(), dateStyle: "full", timeStyle: "short" }),
            device: device.name,
            screen: device.surface !== "none",
            ...Object.assign({}, ...hooks.map((h) => h.modelContext?.() ?? {})),
          },
        }),
        signal: AbortSignal.timeout(waitMs),
      });
      body = (await res.json().catch((err: unknown) => {
        if (err instanceof Error && err.name === "TimeoutError") throw err;
        return {};
      })) as typeof body;
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        const seconds = Math.max(1, Math.round(waitMs / 1000));
        throw new ModelError({ status: 504, code: "timeout", message: `The assistant didn't answer within ${seconds} second${seconds === 1 ? "" : "s"}. Try again.` });
      }
      throw err;
    }
    if (!res.ok) throw new ModelError({ status: res.status, code: body.error?.code, message: body.error?.message ?? "The assistant didn't answer." });
    const ms = Math.round(performance.now() - started);
    const u = body.usage;
    const tokens = u ? `${u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)} in (${u.cache_read_input_tokens ?? 0} cached), ${u.output_tokens} out` : "";
    const family = /claude|gpt|nova|llama|gemini|mistral/.exec(body.model.toLowerCase())?.[0] ?? "model";
    addLog(talkLog, family, body.stop_reason === "tool_use" ? "chose tools" : "answered", `${body.model} · ${ms} ms · ${tokens}`);
    return body;
  }

  async function runTool(use: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const name = names.mcp(use.name) ?? use.name;
    const tool = tools.get(name);
    const args = (use.input ?? {}) as Record<string, unknown>;
    addLog(talkLog, "assistant", `calls ${name} ${JSON.stringify(args)}`);
    if (!tool) return { type: "tool_result", tool_use_id: use.id, content: `There's no tool named ${use.name}.`, is_error: true };
    try {
      const result = await callTool(name, args, { actor: "assistant" });
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
    for (const line of hooks.flatMap((h) => h.beforeTurn?.() ?? [])) content.push({ type: "text", text: line });
    const screenNotes = state.screenNotes.splice(0);
    if (screenNotes.length) content.push({ type: "text", text: `(On the screen since you last spoke: ${screenNotes.join(" ")})` });
    const notes = state.notes.splice(0);
    for (const line of notes) content.push({ type: "text", text: line });
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
      state.screenNotes.unshift(...screenNotes);
      state.notes.unshift(...notes);
      if (err instanceof ModelError) {
        for (const h of hooks) {
          if (h.modelFailed && (await h.modelFailed(err.failure, text))) {
            setLight("idle");
            return;
          }
        }
        if (err.failure.code === "no_key" || err.failure.code === "no_model") {
          caption(text, "");
          setLight("idle");
          addLog(
            talkLog,
            "error",
            // The route says what to set; the Tools tab works either way.
            err.failure.code === "no_key" ? `${err.failure.message} The Tools tab calls tools without one.` : "Talking is off here. The Tools tab calls tools.",
            "",
            true,
          );
          showTab("tools");
          return;
        }
      }
      respond(text, message(err) || "Something went wrong.");
    } finally {
      state.busy = false;
    }
  }

  /** The last thing the assistant said, for extensions (a scripted demo answers only a question). */
  let lastSaid = "";

  function respond(heard: string, said: string) {
    lastSaid = said;
    caption(heard, said);
    addLog(talkLog, "alexa", said);
    // Asked by voice and answered with a question (wherever in the answer it was asked): listen for the answer once it's said, as an Echo's follow-up mode does.
    followUp = askedByVoice && said.includes("?");
    speak(said);
  }

  // ---------- Speaking ----------

  function browserVoice(): SpeechSynthesisVoice | undefined {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith("en"));
    return voices.find((v) => /Aria|Jenny|Samantha|Google US English/.test(v.name)) ?? voices.find((v) => v.lang === "en-US") ?? voices[0];
  }

  /** Whether the last thing asked came through the microphone. */
  let askedByVoice = false;
  /** The assistant just asked a question of someone who spoke: listen for the answer once it's said. */
  let followUp = false;
  /** Hands-free, until when an answer needs no "Alexa" first. */
  let followUpUntil = 0;
  /** A count that stopping bumps, so a voice that finishes late doesn't end what came after it. */
  let voiceTurn = 0;
  let speakingNow = false;
  let voiceAbort: AbortController | null = null;

  /** Says it in the first extension's voice that has one, else (or when that fails) in the browser's. */
  function speak(text: string, light: Light = "speaking") {
    if (!text) return setLight("idle");
    const turn = ++voiceTurn;
    voiceAbort?.abort();
    const abort = new AbortController();
    voiceAbort = abort;
    speakingNow = true;
    const started = () => {
      if (turn !== voiceTurn) return;
      setLight(light);
      pauseListening();
    };
    const inBrowser = () =>
      new Promise<void>((resolve) => {
        if (!("speechSynthesis" in window)) return resolve();
        let quiet: ReturnType<typeof setInterval> | undefined;
        const finish = () => {
          clearInterval(quiet);
          resolve();
        };
        const u = new SpeechSynthesisUtterance(text);
        const v = browserVoice();
        if (v) u.voice = v;
        u.rate = 1.04;
        u.onstart = started;
        u.onend = u.onerror = finish;
        abort.signal.addEventListener("abort", finish, { once: true });
        speechSynthesis.speak(u);
        // Done once the browser has gone quiet too: some never fire onend (Chrome on long lines), or never speak at all.
        quiet = setInterval(() => {
          if (!speechSynthesis.speaking && !speechSynthesis.pending) finish();
        }, 500);
      });
    const voice = hooks.find((h) => h.speak);
    void (async () => {
      try {
        if (voice?.speak) {
          try {
            await voice.speak(text, started, abort.signal);
            return;
          } catch {
            if (abort.signal.aborted) return;
          }
        }
        await inBrowser();
      } finally {
        if (turn === voiceTurn) {
          speakingNow = false;
          voiceAbort = null;
          doneSpeaking();
        }
      }
    })();
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
    const was = speakingNow;
    voiceTurn++;
    speakingNow = false;
    voiceAbort?.abort();
    voiceAbort = null;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (was) doneSpeaking();
  }

  function speaking(): boolean {
    return speakingNow || ("speechSynthesis" in window && (speechSynthesis.speaking || speechSynthesis.pending));
  }

  async function untilQuiet(timeoutMs = 45_000) {
    const until = Date.now() + timeoutMs;
    while (speaking() && Date.now() < until) await pause(250);
  }

  async function say(text: string, sayOptions: { light?: Light } = {}) {
    speak(text, sayOptions.light ?? "speaking");
    await untilQuiet();
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
  $<HTMLFormElement>("ask-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>("ask-input");
    const text = input.value;
    input.value = "";
    void ask(text);
  });

  // ---------- Suggestions ----------

  function setSuggestions(items: Suggestion[]) {
    const shown = options.compact ? items.slice(0, 3) : items;
    chipsEl.replaceChildren(
      ...shown.map((s) => {
        const item = typeof s === "string" ? { text: s } : s;
        const b = document.createElement("button");
        b.type = "button";
        if (item.label) {
          const tag = document.createElement("span");
          tag.className = "chip-label";
          tag.textContent = item.label;
          b.append(tag, " ");
          b.setAttribute("aria-label", `${item.label}: ${item.text}`);
        }
        b.append(item.text);
        // Alexa hears the request, not the wake word.
        b.addEventListener("click", () => void (item.run ? item.run() : ask(item.text.replace(/^\s*alexa[\s,]*/i, ""))));
        return b;
      }),
    );
    const first = shown[0];
    $("idle-hint").textContent = first ? `Try "${typeof first === "string" ? first : first.text}"` : "Say something, or type it in the panel.";
  }
  setSuggestions(options.suggestions ?? []);

  $("model-note").textContent = options.modelUrl
    ? `${options.modelLabel ?? "A model"} stands in for Alexa+'s own model: it decides what to say and which tools to call. This page is the MCP client, as Alexa+ is.`
    : "Talking is off: no model is set up. Call tools yourself from the Tools tab.";

  // ---------- Tabs ----------

  function showTab(name: string) {
    for (const tab of root.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")) {
      const on = tab.id === `tab-${name}`;
      tab.setAttribute("aria-selected", String(on));
      $(tab.getAttribute("aria-controls")!).hidden = !on;
    }
  }
  for (const tab of root.querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")) tab.addEventListener("click", () => showTab(tab.id.replace("tab-", "")));
  // A compact device shows its traffic: the proof that it's a real MCP client.
  if (options.compact) showTab("traffic");

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
      const result = await callTool(t.name, args, { actor: "you" });
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

  const check = options.check ?? false;
  if (check === false) $("tab-readiness").hidden = true;
  $("check-about").textContent =
    check === "browser"
      ? "Checks this MCP server against Amazon's published Alexa+ requirements, from your browser: the transport, tools, latency, results, errors and screens. It calls only tools marked read-only."
      : "Checks the server against Amazon's published Alexa+ requirements: the transport, tools, latency, results, errors, screens and sign-in. It calls the server directly, including tools marked read-only.";

  $("check-run").addEventListener("click", async () => {
    const run = $<HTMLButtonElement>("check-run");
    run.disabled = true;
    run.textContent = "Checking...";
    try {
      let report: ReadinessReport;
      if (check === "browser") {
        report = await runChecks({ serverUrl: mcpUrl.href });
      } else {
        const res = await fetch(String(check), { method: "POST" });
        const body = (await res.json()) as ReadinessReport & { error?: { message?: string } };
        if (!res.ok) throw new Error(body.error?.message ?? `The check answered ${res.status}.`);
        report = body;
      }
      lastReport = report;
      renderReport(report);
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
      ["Endpoint", serverUrl],
      ...(proxyUrl ? [["Proxy", proxyUrl] as [string, string]] : []),
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
    $("server-tools").replaceChildren(
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
    state.notes = [];
    stopSpeaking();
    caption("", "");
    for (const h of hooks) h.reset?.();
    addLog(talkLog, "page", "New conversation");
  }
  $("reset").addEventListener("click", newConversation);

  async function start() {
    try {
      await connect();
    } catch (err) {
      setStatus(`Couldn't connect to ${serverUrl}: ${message(err)}`, "bad");
      return;
    }
    for (const h of hooks) {
      try {
        await h.connected?.();
      } catch (err) {
        addLog(talkLog, "error", `An extension didn't start: ${message(err)}`, "", true);
      }
    }
    if (options.home && device.surface !== "none") await show(options.home.tool, options.home.arguments ?? {}).catch((err) => addLog(talkLog, "error", `The home screen didn't show: ${message(err)}`, "", true));
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

  const sim: Simulator = {
    root,
    get device() {
      return device;
    },
    devices: offered,
    get instructions() {
      return instructions;
    },
    get busy() {
      return state.busy;
    },
    get light() {
      return (lightbar.dataset.state ?? "idle") as Light;
    },
    get lastSaid() {
      return lastSaid;
    },
    get screen() {
      return screenInfo();
    },
    tools: () => [...tools.values()] as ToolInfo[],
    ask,
    say,
    note: (text) => void state.notes.push(text),
    newConversation,
    speaking,
    untilQuiet,
    callTool,
    show,
    refreshScreen,
    setDevice: async (id) => {
      const d = offered.find((x) => x.id === id);
      if (d) await setDevice(d);
    },
    setLight,
    caption,
    log: (who, text, meta = "") => void addLog(talkLog, who, text, meta),
    ui: {
      header: $("slot-header"),
      panel: $("slot-panel"),
      footer: $("slot-footer"),
      screen: $("slot-screen"),
      device: $("slot-device"),
      suggestions: setSuggestions,
    },
  };

  await setDevice(device);
  tick();
  for (const extension of options.extensions ?? []) {
    const added = await (extension as Extension)(sim);
    if (added) hooks.push(added);
  }
  if (proxyUrl) void watchProxy(proxyUrl);
  await start();
  return sim;
}

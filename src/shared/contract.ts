/**
 * What the simulator's pieces agree on: the proxy's events and state, shaped
 * like Amazon's Local Inspector so a coding agent's workflow for one works
 * with the other; the devices; the model route's request; and the readiness
 * report. See docs/alexa-requirements.md for where each number comes from.
 */

export const DEFAULT_SERVER_PORT = 6277;
export const DEFAULT_CLIENT_PORT = 6274;

/** The protocol version Amazon documents Alexa+ sending in `initialize`. */
export const ALEXA_PROTOCOL_VERSION = "2025-03-26";
/** The `clientInfo` Amazon documents Alexa+ sending. */
export const ALEXA_CLIENT_INFO = { name: "Alexa+ MCP Client", version: "1.0.0" } as const;
/** "Your MCP server must meet a round-trip query response latency of less than 500 ms." */
export const LATENCY_BUDGET_MS = 500;

/** Alexa's two screen breakpoints ("Small: 10" and below", "Large: 11" and above"), and no screen at all. */
export type Surface = "small" | "large" | "none";

export interface Device {
  id: string;
  name: string;
  surface: Surface;
  /** The screen in CSS pixels; a device with no screen has none. */
  width?: number;
  height?: number;
}

export const DEVICES: Device[] = [
  { id: "show-5", name: "Echo Show 5", surface: "small", width: 960, height: 480 },
  { id: "show-8", name: "Echo Show 8", surface: "small", width: 1280, height: 800 },
  { id: "show-10", name: "Echo Show 10", surface: "small", width: 1280, height: 800 },
  { id: "show-15", name: "Echo Show 15", surface: "large", width: 1920, height: 1080 },
  { id: "show-21", name: "Echo Show 21", surface: "large", width: 1920, height: 1080 },
  { id: "dot", name: "Echo Dot", surface: "none" },
];

export interface ToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/** One JSON-RPC exchange through the proxy, for the simulator's traffic log. */
export interface RpcRecord {
  id?: string | number | null;
  method: string;
  params?: unknown;
  /** The upstream's HTTP status. */
  status: number;
  durationMs: number;
  /** Milliseconds since the epoch, when the request was sent. */
  ts: number;
  result?: unknown;
  error?: unknown;
  /** Slower than Alexa's 500 ms budget. */
  overBudget: boolean;
}

/**
 * Events on the proxy's `GET /events` (Server-Sent Events). The first six
 * are named and shaped like the Local Inspector's; `rpc` is this simulator's
 * own, one per JSON-RPC exchange.
 */
export type ProxyEvent =
  | { event: "connected"; data: { address: string; serverInfo: unknown; protocolVersion?: string } }
  | { event: "tools-discovered"; data: { tools: ToolInfo[] } }
  | { event: "resource-fetched"; data: { uri: string; mimeType?: string; contentLength: number } }
  | { event: "widget-html"; data: { uri: string; html: string } }
  | { event: "tool-called"; data: { toolName: string; request: unknown; response: unknown; eventId: string; ts: number; durationMs: number } }
  | { event: "error"; data: { method?: string; description: string } }
  | { event: "rpc"; data: RpcRecord };

/** The proxy's `GET /state`: everything seen this session. */
export interface ProxyState {
  upstream: string;
  initialized: boolean;
  sessionId?: string;
  protocolVersion?: string;
  serverInfo?: unknown;
  instructions?: string;
  tools: ToolInfo[];
  resources: { uri: string; mimeType?: string; contentLength: number }[];
  calls: { tool: string; arguments: unknown; succeeded: boolean; durationMs: number; ts: number }[];
  errors: { method?: string; description: string; ts: number }[];
  /** The most recent exchanges, newest last. */
  rpc: RpcRecord[];
}

/** The model route's request (`POST /api/model` on the proxy's port), in the Messages API's shape. */
export interface ModelTurnRequest {
  messages: unknown[];
  tools: { name: string; description: string; input_schema: unknown }[];
  context?: {
    /** The MCP server's own `instructions` from `initialize`. */
    instructions?: string;
    now?: string;
    timeZone?: string;
    /** The device, like "Echo Show 8"; and false for one with no screen. */
    device?: string;
    screen?: boolean;
  };
}

export type RuleStatus = "PASS" | "FAIL" | "WARN" | "SKIP";
export type Verdict = "READY" | "CONDITIONAL" | "NOT_READY";
export type RuleCategory = "mcp-data" | "auth" | "visual" | "package";

export interface RuleResult {
  /** Like "DL-01" (data layer), "AU-01" (authentication), "VR-01" (visual), "PK-01" (package). */
  id: string;
  category: RuleCategory;
  title: string;
  status: RuleStatus;
  /** What was found, in a sentence or two. */
  notes: string;
  /** The published requirement this rule checks. */
  source: { title: string; url: string; quote: string };
}

/** The readiness report (`readiness-report.json`). Unofficial: Amazon hasn't published its full rubric. */
export interface ReadinessReport {
  tool: "alexa-plus-simulator";
  version: string;
  serverUrl: string;
  checkedAt: string;
  /** READY: every evaluated rule passes. CONDITIONAL: warnings, no failures. NOT_READY: a rule fails. */
  verdict: Verdict;
  passCount: number;
  failCount: number;
  warnCount: number;
  skipCount: number;
  rules: RuleResult[];
  disclaimer: string;
}

export const DISCLAIMER =
  "Unofficial. Not affiliated with or endorsed by Amazon. These checks follow Amazon's published Alexa+ MCP add-on requirements, which Amazon calls preliminary; passing them is a good sign, not a certification.";

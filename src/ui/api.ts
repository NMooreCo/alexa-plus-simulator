import type { Device, ToolInfo } from "../shared/contract.ts";

export type { Device, ToolInfo };

/**
 * The simulator's page as a library: start it in any page, point it at an
 * MCP server and a model route, and add to it with extensions. The CLI's own
 * page is one use; an add-on's hosted demo, with its own extensions, is
 * another.
 */

/** The device's light: the bar along an Echo Show's bottom edge, or an Echo Dot's ring. */
export type Light = "idle" | "listening" | "thinking" | "speaking" | "notify";

/** A tool's result, as an MCP server returns it. */
export interface ToolResult {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The screen that's up: the call that showed it, and its result. */
export interface ScreenInfo {
  tool: string;
  uri: string;
  arguments: Record<string, unknown>;
  result: ToolResult;
}

/** A model request that failed, for an extension to handle. */
export interface ModelFailure {
  /** The model route's HTTP status. */
  status: number;
  /** The route's own error code, like "no_key" or a host's "passcode". */
  code?: string;
  message: string;
}

/** Something to try: said as it's written, or run by the extension that offered it. */
export type Suggestion = string | { text: string; /** A small tag before the text, like who says it. */ label?: string; run?: () => void | Promise<void> };

/** Which requests an extension's headers go on. */
export type RequestKind = "mcp" | "model";

/**
 * What an extension can change. Every hook is optional; where several
 * extensions give one, they're used in the order the extensions were given:
 * headers, context and turn lines from all of them, the voice, clock and
 * screen refresh from the first that has one.
 */
export interface ExtensionHooks {
  /** Headers on every request of this kind, read afresh for each one. */
  headers?(kind: RequestKind): Record<string, string> | undefined;
  /** The MCP connection is up (on start, and again after Reconnect). Runs before the home screen shows. */
  connected?(): void | Promise<void>;
  /** A new conversation started. */
  reset?(): void;
  /** Lines the person's turn starts with, before what they said (like who Alexa recognized). */
  beforeTurn?(): string[] | undefined;
  /** More for the model request's context, like where the device is. */
  modelContext?(): Record<string, unknown> | undefined;
  /**
   * A model request failed. Return true when this extension took care of it:
   * the turn is taken back, and the extension can ask it again later.
   */
  modelFailed?(failure: ModelFailure, question: string): boolean | Promise<boolean>;
  /**
   * Says text in this extension's own voice. Call started() when the sound
   * begins; resolve when it's done; stop when the signal aborts. Throw to fall
   * back to the browser's voice.
   */
  speak?(text: string, started: () => void, signal: AbortSignal): Promise<void>;
  /** The time the assistant hears and the idle clock shows, when it isn't now. */
  now?(): Date;
  /** The time zone, when it isn't the browser's. */
  timeZone?(): string | undefined;
  /** What a screen told the assistant, as it should go into the next turn; null drops it. */
  screenNote?(text: string): string | null;
  /** The call that shows the screen again for whoever's speaking now; null shows nothing, undefined leaves it to the simulator. */
  refresh?(screen: ScreenInfo): { tool: string; arguments: Record<string, unknown> } | null | undefined;
}

/** An extension: called once, before the simulator connects, to add to the page and return its hooks. */
export type Extension = (sim: Simulator) => ExtensionHooks | void | Promise<ExtensionHooks | void>;

export interface CallOptions {
  /** Kept out of the traffic log unless it fails (a screen's polling, say). */
  quiet?: boolean;
  /** Who the traffic log says made the call; "page" by default. */
  actor?: string;
}

/** The running simulator, as extensions and the host page see it. */
export interface Simulator {
  /** The page's root element. */
  readonly root: HTMLElement;
  readonly device: Device;
  /** The devices on offer. */
  readonly devices: Device[];
  /** The server's instructions, from initialize. */
  readonly instructions: string;
  /** Whether the assistant is working on a turn. */
  readonly busy: boolean;
  /** The light right now: idle means nothing is going on. */
  readonly light: Light;
  /** The last thing the assistant said. */
  readonly lastSaid: string;
  /** The screen that's up, if any. */
  readonly screen: ScreenInfo | null;
  /** The server's tools. */
  tools(): ToolInfo[];
  /** Asks the assistant as if someone said it; "voice" listens for the answer to a question back. */
  ask(text: string, via?: "voice" | "typed" | "screen"): Promise<void>;
  /** Says something on its own (an alert, say) on the given light; resolves once it's said. */
  say(text: string, options?: { light?: Light }): Promise<void>;
  /** A line the assistant hears before the person's next words, once. */
  note(text: string): void;
  /** Starts the conversation over. */
  newConversation(): void;
  /** Whether the device is saying something, or about to. */
  speaking(): boolean;
  /** Resolves once the device has finished saying something, or after timeoutMs (45 seconds by default). */
  untilQuiet(timeoutMs?: number): Promise<void>;
  /** Calls a tool through the simulator's MCP client. */
  callTool(name: string, args?: Record<string, unknown>, options?: CallOptions): Promise<ToolResult>;
  /** Calls a tool and puts its screen up, like a home screen. */
  show(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  /** Shows the screen that's up again, fresh, for whoever's speaking now. */
  refreshScreen(): Promise<void>;
  setDevice(id: string): Promise<void>;
  setLight(light: Light): void;
  /** What was heard and what was said, on the device. */
  caption(heard: string, said: string): void;
  /** A line in the Conversation log. */
  log(who: string, text: string, meta?: string): void;
  /** Places on the page for an extension's own pieces. */
  readonly ui: {
    /** Under the title, for a line about the add-on. */
    header: HTMLElement;
    /** In the panel under the talk bar. */
    panel: HTMLElement;
    /** Buttons and links at the bottom of the panel. */
    footer: HTMLElement;
    /** Over the device's screen, in the screen's own pixels (it scales with the screen); its children take clicks. */
    screen: HTMLElement;
    /** Over the whole device, unscaled, for a card that asks for something; its children take clicks. */
    device: HTMLElement;
    /** Replaces the suggestions. */
    suggestions(items: Suggestion[]): void;
  };
}

export interface SimulatorOptions {
  /** Where the simulator goes; the page's body by default. */
  root?: HTMLElement;
  /** The MCP endpoint, resolved against the page. */
  mcpUrl: string;
  /** The server's own address, when mcpUrl reaches it through a proxy; mcpUrl otherwise. */
  serverUrl?: string;
  /** The model route, taking and answering the simulator's /api/model shape; null leaves talking off. */
  modelUrl?: string | null;
  /** How long to wait for the model route's answer to one turn before saying it didn't come; 75 seconds by default. */
  modelTimeoutMs?: number;
  /** What the page calls the model, like "Claude (claude-opus-5-5)". */
  modelLabel?: string;
  /** The simulator's local proxy: its /events feed the traffic log. Without one, the page records its own requests. */
  proxyUrl?: string;
  /** The readiness check: a route that runs it (the proxy's /api/check), "browser" to run it in the page against mcpUrl, or false for none. */
  check?: string | false;
  /** The device to start on, by id; an Echo Show 8 by default (or the ?device= in the address). */
  device?: string;
  /** The devices to offer, by id; all of them by default. */
  devices?: string[];
  /** A tool whose screen is up from the start, like a home screen. */
  home?: { tool: string; arguments?: Record<string, unknown> };
  suggestions?: Suggestion[];
  /** The panel's title. */
  title?: string;
  /** The line under the title. */
  lede?: string;
  /** The line under the device. */
  deviceNote?: (device: Device) => string;
  /** The device and the talk bar alone, for a page that shows several devices side by side. */
  compact?: boolean;
  /** Where the device is, shown over it, like "Barn". */
  place?: string;
  /** Tools whose successful calls stay out of the traffic log (a screen's polling). */
  quietTools?: string[];
  extensions?: Extension[];
}

/**
 * The page's pure helpers, kept apart from the DOM so they can be tested in
 * Node: the screens' Content Security Policy, tool names the model accepts,
 * argument skeletons, and what goes back to the model.
 */

/** What an MCP Apps resource declares in `_meta.ui.csp`. */
export interface ResourceCsp {
  connectDomains?: unknown;
  resourceDomains?: unknown;
  frameDomains?: unknown;
  baseUriDomains?: unknown;
}

/** The message a screen's violation watcher posts to the page. */
export const CSP_VIOLATION = "alexa-plus-simulator/csp-violation";

// An origin like https://api.example.com, https://*.example.com or wss://host:8443; anything else (quotes, semicolons, paths) is dropped.
const ORIGIN = /^(?:https?|wss?):\/\/(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d{1,5})?$/i;

function origins(list: unknown): string[] {
  return Array.isArray(list) ? list.filter((s): s is string => typeof s === "string" && ORIGIN.test(s)) : [];
}

/**
 * The policy a screen runs under, as the MCP Apps standard has a host build
 * it: nothing from the network unless the resource declares the origin, and
 * inline scripts and styles (a screen is one HTML document).
 */
export function cspFor(csp: ResourceCsp = {}): string {
  const res = origins(csp.resourceDomains).join(" ");
  const connect = origins(csp.connectDomains).join(" ");
  const frame = origins(csp.frameDomains).join(" ");
  const base = origins(csp.baseUriDomains).join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${res}`,
    `style-src 'unsafe-inline' ${res}`,
    `img-src data: blob: ${res}`,
    `font-src data: ${res}`,
    `media-src data: blob: ${res}`,
    `connect-src ${connect || "'none'"}`,
    `frame-src ${frame || "'none'"}`,
    `base-uri ${base || "'none'"}`,
  ]
    .map((d) => d.trim())
    .join("; ");
}

/**
 * The screen's HTML with its policy first in <head>, and a watcher that
 * tells the page what the policy blocked, so a screen that loads something it
 * didn't declare says so instead of quietly looking broken.
 *
 * The two go in just past the document's prolog (see prologEnd), ahead of
 * anything that makes an element, so the HTML parser opens <head> for them
 * whatever the screen's own markup says; its own <html> and <head> tags then
 * add to those. Looking for "<head>" instead finds one in a comment, a script
 * or an attribute just as readily, and a policy put there is no policy at all.
 */
export function withCsp(html: string, csp?: ResourceCsp): string {
  const policy = cspFor(csp).replaceAll('"', "&quot;");
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    `<script>document.addEventListener("securitypolicyviolation",function(e){parent.postMessage({type:"${CSP_VIOLATION}",blocked:e.blockedURI,directive:e.effectiveDirective},"*")})</script>`;
  const at = prologEnd(html);
  return html.slice(0, at) + head + html.slice(at);
}

/** What the HTML standard counts as whitespace before the document's first element. */
const PROLOG_SPACE = new Set(["\t", "\n", "\f", "\r", " "]);

/**
 * Where a document's prolog ends: the whitespace, comments and doctype an
 * HTML parser reads before it makes any element. Each piece ends where the
 * HTML standard's tokenizer ends it ("<!-->" and "<!--->" are whole
 * comments, "--!>" closes one, "<?...>" and "<!...>" are comments up to the
 * next ">"), since tags spliced into a comment are only more comment.
 * Anything else ends the prolog, even a stray character some browsers skip:
 * tags spliced in ahead of it still open <head>, where after it they might
 * land in <body>. Splicing in after the prolog keeps a doctype first, so a
 * screen renders in the mode it would have; a piece that runs to the end of
 * the document ends the prolog at its start instead, so nothing spliced in
 * can fall inside it.
 */
export function prologEnd(html: string): number {
  let at = 0;
  for (;;) {
    while (at < html.length && PROLOG_SPACE.has(html[at]!)) at++;
    let end: number | undefined;
    if (html.startsWith("<!--", at)) end = commentEnd(html, at + 4);
    else if (/^<!doctype/i.test(html.slice(at, at + 9))) end = after(">", html, at + 9);
    else if (html.startsWith("</>", at)) end = at + 3;
    else if (/^(?:<!|<\?|<\/[^a-z>])/i.test(html.slice(at, at + 3))) end = after(">", html, at + 2);
    else return at;
    if (end === undefined) return at;
    at = end;
  }
}

/** Just past the next `text` from `from`, or undefined when there's none before the end. */
function after(text: string, html: string, from: number): number | undefined {
  const found = html.indexOf(text, from);
  return found < 0 ? undefined : found + text.length;
}

/** Where a comment whose "<!--" ends at `body` ends, by the tokenizer's rules, or undefined when it runs to the end. */
function commentEnd(html: string, body: number): number | undefined {
  if (html.startsWith(">", body)) return body + 1;
  if (html.startsWith("->", body)) return body + 2;
  const close = /--!?>/g;
  close.lastIndex = body;
  const found = close.exec(html);
  return found ? found.index + found[0].length : undefined;
}

/** Which directive to declare an origin under, for the note that says how to fix a blocked load. */
export function cspFix(directive: string): string {
  if (directive.startsWith("connect")) return "connectDomains";
  if (directive.startsWith("frame")) return "frameDomains";
  if (directive.startsWith("base")) return "baseUriDomains";
  return "resourceDomains";
}

/**
 * Tool names the Claude API accepts (letters, digits, _ and -, up to 64),
 * mapped to and from the server's own, which MCP allows more freedom.
 */
export class ToolNames {
  private toModel = new Map<string, string>();
  private toMcp = new Map<string, string>();

  add(name: string): string {
    const known = this.toModel.get(name);
    if (known) return known;
    const base = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "tool";
    let candidate = base;
    for (let i = 2; this.toMcp.has(candidate); i++) candidate = `${base.slice(0, 60 - String(i).length - 1)}_${i}`;
    this.toModel.set(name, candidate);
    this.toMcp.set(candidate, name);
    return candidate;
  }

  mcp(modelName: string): string | undefined {
    return this.toMcp.get(modelName);
  }
}

interface Schema {
  type?: unknown;
  properties?: Record<string, Schema>;
  required?: unknown;
  default?: unknown;
  enum?: unknown;
  examples?: unknown;
  const?: unknown;
}

/** A starting point for a tool's arguments: each required property, with its default, example or an empty value of its type. */
export function schemaSkeleton(schema: unknown): Record<string, unknown> {
  const s = (schema ?? {}) as Schema;
  const required = Array.isArray(s.required) ? s.required.filter((r): r is string => typeof r === "string") : [];
  const out: Record<string, unknown> = {};
  for (const key of required) out[key] = sample(s.properties?.[key] ?? {});
  return out;
}

function sample(s: Schema): unknown {
  if (s.const !== undefined) return s.const;
  if (s.default !== undefined) return s.default;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  switch (type) {
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object":
      return schemaSkeleton(s);
    default:
      return null;
  }
}

/**
 * The reply as it goes back into the conversation. When the model declined
 * partway and Anthropic's fallback model finished, the blocks the fallback
 * replaced (before the last fallback marker) don't go back.
 */
export function echoable<T extends { type: string }>(content: T[]): T[] {
  const last = content.map((b) => b.type).lastIndexOf("fallback");
  if (last < 0) return content;
  return content.filter((b, i) => i > last || !["thinking", "redacted_thinking", "tool_use"].includes(b.type));
}

interface ResultLike {
  content?: unknown;
  structuredContent?: unknown;
}

/** A tool's result as the model reads it: its text, a word for what isn't text, or its structured content when there's no text. */
export function resultText(result: ResultLike): string {
  const parts: string[] = [];
  for (const c of Array.isArray(result.content) ? (result.content as { type?: string; text?: string; uri?: string; mimeType?: string }[]) : []) {
    if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
    else if (c.type === "image") parts.push(`[An image${c.mimeType ? ` (${c.mimeType})` : ""}]`);
    else if (c.type === "audio") parts.push("[Audio]");
    else if (c.type === "resource_link" || c.type === "resource") parts.push(`[A resource${c.uri ? `: ${c.uri}` : ""}]`);
  }
  const text = parts.join("\n").trim();
  if (text) return text;
  return result.structuredContent === undefined ? "" : JSON.stringify(result.structuredContent);
}

/** One line for a JSON-RPC exchange in the traffic log. */
export function rpcLabel(method: string, params: unknown): string {
  const p = (params ?? {}) as { name?: unknown; uri?: unknown };
  if (method === "tools/call" && typeof p.name === "string") return `tools/call ${p.name}`;
  if (method === "resources/read" && typeof p.uri === "string") return `resources/read ${p.uri}`;
  return method;
}

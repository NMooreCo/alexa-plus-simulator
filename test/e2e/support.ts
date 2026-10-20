import { fileURLToPath } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { test as base, expect, type FrameLocator, type Page } from "@playwright/test";
import type { ProxyState } from "../../src/shared/contract.ts";
import { EXAMPLE } from "./addresses.ts";

export { expect };

/**
 * The browser tests' `test`: every page gets the speech fake
 * (fake-speech.js) and fails its test when it throws or logs an error the
 * test didn't expect.
 */
export const test = base.extend<{ consoleErrors: RegExp[] }>({
  /** Console errors a test expects (a refused request it makes on purpose, say), besides the 405 below. */
  consoleErrors: [[], { option: true }],
  page: async ({ page, consoleErrors }, use) => {
    await page.addInitScript({ path: fileURLToPath(new URL("./fake-speech.js", import.meta.url)) });
    const problems: string[] = [];
    page.on("pageerror", (error) => problems.push(`Uncaught: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      // A stateless server answers the MCP client's GET for an event stream with 405, as the spec allows, and the browser logs it.
      if (/status of 405/.test(text) && message.location().url.endsWith("/mcp")) return;
      if (consoleErrors.some((expected) => expected.test(text))) return;
      problems.push(`Console error: ${text}`);
    });
    await use(page);
    expect(problems, "errors the page logged").toEqual([]);
  },
});

/** Opens a simulator's page on a device, and waits until it has connected to its MCP server. */
export async function openSimulator(page: Page, url: string, device = "show-8"): Promise<void> {
  await page.goto(`${url}/?device=${device}`);
  await expect(page.getByRole("status")).toHaveText(/^Connected to /);
}

/** The MCP Apps screen on the device: the document in its sandboxed frame. */
export function screenOf(page: Page): FrameLocator {
  return page.locator("#app-host iframe").contentFrame();
}

/** Calls a tool from the Tools tab, as someone would by hand, and waits for its answer. */
export async function callTool(page: Page, name: string, args?: Record<string, unknown>): Promise<void> {
  await page.getByRole("tab", { name: "Tools" }).click();
  await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption(name);
  if (args) await page.getByRole("textbox", { name: "Arguments (JSON)" }).fill(JSON.stringify(args));
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await expect(page.locator("#tool-meta")).toHaveText(/^Done in \d+ ms$/);
}

export interface TrafficEntry {
  /** Who made the call when the page knows (page, you, screen), or the HTTP status when the proxy recorded it. */
  who: string;
  /** The JSON-RPC method, with the tool or resource. */
  what: string;
  /** The status and timing, and the budget warning when it was slow. */
  meta: string;
  slow: boolean;
}

/** The Traffic tab's log, newest first. */
export function trafficLog(page: Page): Promise<TrafficEntry[]> {
  return page.locator("#traffic-log > li").evaluateAll((items) =>
    items.map((li) => {
      const meta = li.querySelector(":scope > .meta");
      return {
        who: li.querySelector(".who")?.textContent ?? "",
        what: li.querySelector(".what")?.textContent ?? "",
        meta: meta?.textContent ?? "",
        slow: meta?.classList.contains("slow") ?? false,
      };
    }),
  );
}

/** What a simulator's proxy has seen this session, from its GET /state. */
export async function proxyState(stateUrl: string): Promise<ProxyState> {
  const response = await fetch(stateUrl);
  expect(response.ok, `GET ${stateUrl}`).toBe(true);
  return (await response.json()) as ProxyState;
}

export interface Task {
  id: number;
  text: string;
  done: boolean;
}

/**
 * Calls one of the example's tools directly, not through any simulator (someone else changing the list, or a look
 * at what it holds), and returns the list, which every one of its tools answers with.
 */
export async function callExample(name: string, args: Record<string, unknown> = {}): Promise<Task[]> {
  const client = new Client({ name: "alexa-plus-simulator-e2e", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(EXAMPLE)));
  try {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError ?? false, `${name} on the example`).toBe(false);
    return (result.structuredContent as { tasks: Task[] }).tasks;
  } finally {
    await client.close();
  }
}

/** A few letters that make a task's text this test's own, since the tests share the example's list. */
export function unique(): string {
  return Math.random().toString(36).slice(2, 7);
}

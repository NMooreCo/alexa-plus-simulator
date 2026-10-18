import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { startProxy } from "../src/proxy/index.ts";
import { readBody, sendWebResponse, toWebRequest } from "../src/proxy/web.ts";
import { Stream, until } from "./http-helpers.ts";

/**
 * The MCP SDK's own client and server (v2), with the proxy between them: real
 * Streamable HTTP traffic, with its session, protocol headers and event
 * streams, should pass through intact and be recorded on the way.
 */

const WIDGET = "<!doctype html><p>Sunny all day</p>";

async function startSdkServer(enableJsonResponse: boolean) {
  const mcp = new McpServer({ name: "weather", version: "2.0.0" }, { instructions: "Ask about the weather." });
  mcp.registerTool(
    "forecast",
    { description: "Tomorrow's forecast for a city.", inputSchema: z.object({ city: z.string() }), _meta: { ui: { resourceUri: "ui://forecast" } } },
    async ({ city }) => ({ content: [{ type: "text", text: `Sunny in ${city}.` }], structuredContent: { city, sky: "sunny" } }),
  );
  mcp.registerResource("forecast-card", "ui://forecast", { mimeType: "text/html;profile=mcp-app" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/html;profile=mcp-app", text: WIDGET }],
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse });
  await mcp.connect(transport);

  const server = createServer(async (request, response) => {
    const caller = new AbortController();
    response.on("close", () => {
      if (!response.writableFinished) caller.abort();
    });
    const body = await readBody(request);
    await sendWebResponse(response, await transport.handleRequest(toWebRequest(request, body, caller.signal)), {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    async close() {
      await mcp.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe("the MCP SDK's client and server, through the proxy", () => {
  for (const [replies, enableJsonResponse] of [
    ["event-stream", false],
    ["JSON", true],
  ] as const) {
    it(`carry a whole session with ${replies} replies, recorded on the way`, async () => {
      const upstream = await startSdkServer(enableJsonResponse);
      const proxy = await startProxy({ upstream: upstream.url, port: 0, clientPort: 0 });
      const events = await Stream.open(`${proxy.url}/events`);
      const client = new Client({ name: "simulator-test", version: "1.0.0" });
      // 127.0.0.1 rather than localhost, which can cost an IPv6 attempt first on Windows.
      const transport = new StreamableHTTPClientTransport(new URL(`${proxy.url.replace("localhost", "127.0.0.1")}/mcp`));
      try {
        await client.connect(transport);
        expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);

        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(["forecast"]);
        const result = await client.callTool({ name: "forecast", arguments: { city: "Denver" } });
        expect(result.structuredContent).toEqual({ city: "Denver", sky: "sunny" });
        const resource = await client.readResource({ uri: "ui://forecast" });
        expect(resource.contents[0]).toMatchObject({ uri: "ui://forecast", text: WIDGET });

        const state = proxy.state();
        expect(state).toMatchObject({
          initialized: true,
          sessionId: transport.sessionId,
          serverInfo: { name: "weather", version: "2.0.0" },
          instructions: "Ask about the weather.",
        });
        expect(state.tools.map((tool) => tool.name)).toEqual(["forecast"]);
        expect(state.calls).toMatchObject([{ tool: "forecast", arguments: { city: "Denver" }, succeeded: true }]);
        expect(state.resources).toEqual([{ uri: "ui://forecast", mimeType: "text/html;profile=mcp-app", contentLength: WIDGET.length }]);
        expect(state.errors).toEqual([]);
        expect(state.rpc.map((record) => [record.method, record.status])).toEqual([
          ["initialize", 200],
          ["notifications/initialized", 202],
          ["tools/list", 200],
          ["tools/call", 200],
          ["resources/read", 200],
        ]);
        expect(await events.next("widget-html")).toEqual({ uri: "ui://forecast", html: WIDGET });
        expect(await events.next("tool-called")).toMatchObject({ toolName: "forecast", response: { result: { structuredContent: { sky: "sunny" } } } });

        await transport.terminateSession();
        await until(() => !proxy.state().initialized, "the session to end");
      } finally {
        events.close();
        await client.close();
        await proxy.close();
        await upstream.close();
      }
    });
  }
});

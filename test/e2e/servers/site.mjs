// The browser tests' own site: pages that host the simulator as a library
// (alexa-plus-simulator/ui, built into dist/lib), as an add-on's demo page
// would, with the MCP endpoint on the page's own origin.
//
//   node test/e2e/servers/site.mjs [--port 6383] [--example http://127.0.0.1:6380/mcp]
//
//   /hosted.html      The library on /mcp, which this site passes through to the
//                     example: no simulator proxy, so the page records its own
//                     traffic and runs the readiness check in the browser.
//   /undeclared.html  The library on /undeclared/mcp, a small MCP server of this
//                     site's whose screen loads an image from an origin it
//                     doesn't declare in _meta.ui.csp.
//   /lib/...          The built library and its stylesheet.
//   /picture.png      The image that screen loads.
import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname } from "node:path";
import { parseArgs } from "node:util";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const { values } = parseArgs({ options: { port: { type: "string", default: "6383" }, example: { type: "string", default: "http://127.0.0.1:6380/mcp" } } });
const port = Number(values.port);
const origin = `http://127.0.0.1:${port}`;
const example = new URL(values.example);
const lib = new URL("../../../dist/lib/", import.meta.url);

const TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".map": "application/json" };
// One transparent pixel: a real image, so a policy that let it through would show it loading.
const PICTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

/** A page with the simulator in it, started with these options. */
function hostPage(title, options) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="icon" href="data:," />
    <link rel="stylesheet" href="/lib/style.css" />
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
      import { startSimulator } from "/lib/simulator.js";
      await startSimulator({ root: document.getElementById("app"), ...${JSON.stringify(options)} });
    </script>
  </body>
</html>
`;
}

const PAGES = {
  "/hosted.html": hostPage("Hosted simulator", { mcpUrl: "/mcp", modelUrl: null, check: "browser" }),
  "/undeclared.html": hostPage("Undeclared screen", { mcpUrl: "/undeclared/mcp", modelUrl: null, check: false }),
};

const PICTURE_SCREEN = "ui://picture/screen";

// The MCP Apps handshake done by hand (ask to start, then say it's ready), so the host shows the screen.
const pictureScreen = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Picture</title>
  </head>
  <body>
    <h1>A picture</h1>
    <img src="${origin}/picture.png" alt="A picture from this site" width="320" height="240" />
    <script>
      addEventListener("message", (event) => {
        const m = event.data;
        if (!m || m.jsonrpc !== "2.0") return;
        if (m.id === 1 && !m.method) parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
        else if (m.method === "ui/resource-teardown" || m.method === "ping") parent.postMessage({ jsonrpc: "2.0", id: m.id, result: {} }, "*");
      });
      parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { appInfo: { name: "picture", version: "0.1.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" } }, "*");
    </script>
  </body>
</html>
`;

function pictureServer() {
  const server = new McpServer({ name: "undeclared-picture", version: "0.1.0" });
  registerAppTool(
    server,
    "show_picture",
    {
      title: "Show a picture",
      description: "Show a picture on the screen.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
      _meta: { ui: { resourceUri: PICTURE_SCREEN } },
    },
    async () => ({ content: [{ type: "text", text: "Here's the picture." }], structuredContent: { shown: true } }),
  );
  // No _meta.ui.csp: the picture's origin isn't declared, so the host's policy should keep it out.
  registerAppResource(server, "Picture", PICTURE_SCREEN, { description: "A picture" }, async () => ({
    contents: [{ uri: PICTURE_SCREEN, mimeType: RESOURCE_MIME_TYPE, text: pictureScreen }],
  }));
  return server;
}

const pictures = createMcpHandler(() => pictureServer(), { onerror: (error) => console.error("mcp:", error.message) });

/** Answers a request with an MCP handler, from Node's request to a web Request and back. */
async function serveMcp(handler, request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && chunks.length > 0;
  const answer = await handler.fetch(new Request(new URL(request.url ?? "/", origin), { method: request.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }));
  response.writeHead(answer.status, Object.fromEntries(answer.headers));
  if (answer.body) for await (const chunk of answer.body) response.write(chunk);
  response.end();
}

/** Passes a request through to the example as it came, so the page talks to the example on its own origin. */
function forward(request, response) {
  const upstream = httpRequest(
    { host: example.hostname, port: example.port, method: request.method, path: example.pathname, headers: { ...request.headers, host: example.host } },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end(`The example didn't answer: ${error.message}`);
  });
  request.pipe(upstream);
}

async function serveLib(path, response) {
  const file = new URL(`.${path.slice("/lib".length)}`, lib);
  if (!file.href.startsWith(lib.href)) return send(response, 404, "text/plain", "Not found.");
  const body = await readFile(file).catch(() => undefined);
  if (!body) return send(response, 404, "text/plain", `Nothing at ${path}: run pnpm build first.`);
  send(response, 200, TYPES[extname(file.pathname)] ?? "application/octet-stream", body);
}

function send(response, status, type, body) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" }).end(body);
}

async function handle(request, response) {
  const path = new URL(request.url ?? "/", origin).pathname;
  if (path === "/mcp") return forward(request, response);
  if (path === "/undeclared/mcp") return serveMcp(pictures, request, response);
  if (Object.hasOwn(PAGES, path)) return send(response, 200, "text/html; charset=utf-8", PAGES[path]);
  if (path === "/picture.png") return send(response, 200, "image/png", PICTURE);
  if (path.startsWith("/lib/")) return serveLib(path, response);
  send(response, 404, "text/plain", "Not found.");
}

const server = createServer((request, response) => {
  handle(request, response).catch((error) => {
    if (!response.headersSent) send(response, 500, "text/plain", error instanceof Error ? error.message : String(error));
    else response.destroy();
  });
});
server.listen(port, "127.0.0.1", () => console.log(`The test site is at ${origin}`));

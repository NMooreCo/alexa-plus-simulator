// A small MCP server to try the simulator with: a shared to-do list, with an
// MCP Apps screen. It keeps the list in memory, so it starts over each run.
//
//   node examples/tasks/server.mjs [--port 6280] [--slow <ms>]
//
// --slow adds a delay to every request, to see the simulator flag calls over Alexa+'s 500 ms budget.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const SCREEN_URI = "ui://tasks/list";
const SCREEN = readFileSync(new URL("./screen.html", import.meta.url), "utf8");

/** The list, shared by every request (the server itself is stateless). */
function createList() {
  let nextId = 4;
  const tasks = [
    { id: 1, text: "Water the tomatoes", done: false },
    { id: 2, text: "Pick up the dry cleaning", done: false },
    { id: 3, text: "Call the vet about Friday", done: true },
  ];
  return {
    all: () => tasks.map((t) => ({ ...t })),
    add(text) {
      const task = { id: nextId++, text, done: false };
      tasks.push(task);
      return { ...task };
    },
    complete(id) {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;
      task.done = true;
      return { ...task };
    },
  };
}

function view(list, said) {
  const tasks = list.all();
  const open = tasks.filter((t) => !t.done);
  const summary = open.length ? `${open.length} open: ${open.map((t) => t.text).join("; ")}.` : "Nothing left to do.";
  return { content: [{ type: "text", text: said ? `${said} ${summary}` : summary }], structuredContent: { tasks } };
}

function buildServer(list) {
  const server = new McpServer(
    { name: "tasks-example", version: "0.1.0" },
    { instructions: "A household's shared to-do list. Show it when someone asks what's left to do; add or check off tasks when asked." },
  );
  const screen = { ui: { resourceUri: SCREEN_URI } };
  registerAppTool(
    server,
    "show_tasks",
    { title: "Show tasks", description: "Show the to-do list on the screen, with what's still open.", inputSchema: z.object({}), annotations: { readOnlyHint: true }, _meta: screen },
    async () => view(list),
  );
  registerAppTool(
    server,
    "add_task",
    {
      title: "Add a task",
      description: "Add a task to the to-do list.",
      inputSchema: z.object({ text: z.string().min(1).max(200).describe("What to do, like 'Buy dog food'") }),
      annotations: { readOnlyHint: false, destructiveHint: false },
      _meta: screen,
    },
    async ({ text }) => {
      const task = list.add(text.trim());
      return view(list, `Added "${task.text}".`);
    },
  );
  registerAppTool(
    server,
    "complete_task",
    {
      title: "Check off a task",
      description: "Check a task off the list by its id (from show_tasks).",
      inputSchema: z.object({ id: z.number().int().describe("The task's id") }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      _meta: screen,
    },
    async ({ id }) => {
      const task = list.complete(id);
      if (!task) return { content: [{ type: "text", text: `There's no task ${id}.` }], isError: true };
      return view(list, `Checked off "${task.text}".`);
    },
  );
  registerAppResource(server, "Tasks", SCREEN_URI, { description: "The to-do list" }, async () => ({
    contents: [{ uri: SCREEN_URI, mimeType: RESOURCE_MIME_TYPE, text: SCREEN, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } } }],
  }));
  return server;
}

async function toRequest(req, origin) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
  return new Request(new URL(req.url ?? "/", origin), { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
}

/** Starts the example on 127.0.0.1; port 0 picks a free one. Resolves with its /mcp URL and a close function. */
export async function startExample({ port = 6280, slowMs = 0 } = {}) {
  const list = createList();
  const handler = createMcpHandler(() => buildServer(list), { onerror: (err) => console.error("mcp:", err.message) });
  const server = createServer(async (req, res) => {
    try {
      if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "text/plain" }).end("Not found. The MCP endpoint is /mcp.");
        return;
      }
      const response = await handler.fetch(await toRequest(req, `http://${req.headers.host ?? "localhost"}`));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) for await (const chunk of response.body) res.write(chunk);
      res.end();
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(err instanceof Error ? err.message : String(err));
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (import.meta.url === new URL(`file:///${process.argv[1]?.replaceAll("\\", "/").replace(/^\//, "")}`).href) {
  const { values } = parseArgs({ options: { port: { type: "string" }, slow: { type: "string" } } });
  const running = await startExample({ port: Number(values.port ?? 6280), slowMs: Number(values.slow ?? 0) });
  console.log(`The tasks example is at ${running.url}`);
  console.log(`Try it: node dist/server/cli.js ${running.url}`);
}

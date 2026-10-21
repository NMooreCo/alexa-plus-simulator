# How it fits together

```
 your browser                          the CLI (127.0.0.1 only)                         elsewhere
 ┌──────────────────────────┐          ┌──────────────────────────────────┐
 │ the page (port 6274)     │  MCP     │ the proxy (port 6277)            │   MCP    ┌──────────────────┐
 │  simulated Echo          ├─────────►│  POST/GET/DELETE /mcp ───────────┼─────────►│ your MCP server  │
 │  MCP client (the SDK)    │          │  /events, /state, /health        │          └──────────────────┘
 │  MCP Apps host (screens) │◄─events──┤  records every exchange          │
 │  voice, tabs, extensions │          │                                  │
 │                          ├─turns───►│  /api/model ─────────────────────┼────────► a model (Claude, ...)
 │                          ├─check───►│  /api/check ── readiness check ──┼────────► your MCP server
 └──────────────────────────┘          └──────────────────────────────────┘
```

**The page** (`src/ui`) is the MCP client, as Alexa+ is. `simulator.ts` is the library (`startSimulator`): it connects the way Alexa+ says it does, lists the tools, runs the conversation's tool loop (asking the model route what to do next, calling the tools it picks, sending the results back), renders MCP Apps screens in sandboxed frames under the policy their resources declare, and speaks and listens with the browser's Web Speech API. `main.ts` is the CLI's own page around it. `lib.ts` holds the pure helpers (the screens' policy, tool names, argument skeletons).

**The proxy** (`src/proxy`) sits between the page and your server, shaped like Amazon's Local Inspector's: it forwards MCP, adds a token when you give one, records every exchange for `/state` and `/events`, and serves the page. It listens on 127.0.0.1 only and refuses other hosts and origins.

**The model route** (`src/model`) turns a conversation in the Messages API's shape into one model call and answers in the same shape. The page decides nothing about the model; the route holds the key.

**The readiness check** (`src/check`) talks to your server itself, with plain JSON-RPC over Streamable HTTP, so it controls exactly what's sent and can time each round trip. Every rule carries the published requirement it checks (`sources.ts`, quoted exactly from [alexa-requirements.md](alexa-requirements.md); a test holds them to it).

**The screen check** (`src/visual`) starts a proxy and the page, drives the page in a headless browser, shows each screen on each device, and measures what it sees. **The report** (`src/report`) writes it all as a page.

**The contract** (`src/shared/contract.ts`) is what the pieces agree on: the proxy's events and state, the devices, the model route's request, and the report.

## A turn

1. You say or type something. The page adds what the screen told it since your last turn, and lines from extensions (who's speaking, say).
2. The page POSTs the conversation and the server's tools to the model route.
3. The model answers with text, or with tool calls. For tool calls, the page calls each tool through the MCP client (and so through the proxy), shows the screen a tool names, and sends every result back together. Up to eight rounds.
4. The answer is captioned and spoken. If it ends in a question and you spoke, the page listens for the answer.

## Tests

- **Vitest** (`pnpm test`): unit and property tests (fast-check) for every piece; fake MCP servers for odd transports, hung servers and sign-in variants; the CLI end to end against the example server; the screen check in a headless browser when one is installed.
- **Playwright** (`pnpm test:e2e`): the page itself, driven in a browser.

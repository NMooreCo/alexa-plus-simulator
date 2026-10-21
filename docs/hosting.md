# Hosting the simulator in your own page

The CLI runs the simulator on your machine. You can also put it in a page your own server serves, as an add-on's public demo, say. [Corral for Alexa+](https://alexa-demo.corral.narralogy.ai/echo) does this, with one extension for what's its own.

Hosted this way there's no proxy: the page talks straight to your MCP endpoint and your model route, records its own traffic, and can run the readiness check from the visitor's browser.

## The page

```bash
npm install alexa-plus-simulator
```

```html
<!-- index.html -->
<div id="app"></div>
<script type="module" src="./main.ts"></script>
```

```ts
// main.ts
import { startSimulator } from "alexa-plus-simulator/ui";
import "alexa-plus-simulator/ui/style.css";

const sim = await startSimulator({
  root: document.getElementById("app")!,
  mcpUrl: "/mcp",
  modelUrl: "/api/model",
  modelLabel: "Claude",
  check: "browser",
  home: { tool: "show_today" },
  title: "My add-on",
  lede: "Ask about your orders.",
});
```

The package ships the page as one ES module with what it needs bundled in, so any bundler (or none, with an import map) works.

| Option | |
|---|---|
| `root` | Where it goes; the page's body by default |
| `mcpUrl` | Your MCP endpoint |
| `modelUrl` | Your model route (below); `null` leaves talking off |
| `modelLabel` | What the page calls the model |
| `modelTimeoutMs` | How long the page waits for your model route to answer a turn before saying it didn't; 75 seconds by default |
| `check` | `"browser"` for a Readiness tab that checks `mcpUrl` from the visitor's browser, a URL for a route that runs it, or `false` for none |
| `device`, `devices` | The device to start on, and which ones to offer, by id (`show-5`, `show-8`, `show-10`, `show-15`, `show-21`, `dot`) |
| `home` | A tool whose screen is up from the start |
| `suggestions` | Things to try, as text or `{ text, label, run }` |
| `title`, `lede`, `deviceNote` | The page's words |
| `compact`, `place` | Just the device and the talk bar, labeled, for a page showing several devices |
| `quietTools` | Tools whose successful calls stay out of the traffic log (a screen's polling) |
| `extensions` | See [extensions.md](extensions.md) |

`startSimulator` resolves with the running simulator (the same object extensions get), once it has connected.

## The model route

The page sends each turn as a POST of JSON in the Claude Messages API's shape, and expects a Messages API reply:

```jsonc
// request
{
  "messages": [{ "role": "user", "content": [{ "type": "text", "text": "What's on today?" }] }],
  "tools": [{ "name": "show_today", "description": "...", "input_schema": { "type": "object" } }],
  "context": {
    "instructions": "The MCP server's instructions from initialize",
    "now": "Monday, October 19, 2026 at 7:15 PM",
    "timeZone": "America/Denver",
    "device": "Echo Show 8",
    "screen": true
    // plus whatever extensions add with modelContext()
  }
}
// reply: a Messages API message
{ "id": "msg_...", "type": "message", "role": "assistant", "model": "...", "content": [/* text and tool_use blocks */], "stop_reason": "tool_use", "usage": { "input_tokens": 1075, "output_tokens": 28 } }
```

Pass reply blocks back exactly as they came, extra fields included: a Gemini reply's blocks carry a `thought_signature` that Gemini requires on the next turn (the page does this already, and so does any route built like the simulator's).

On failure, answer with an HTTP error and `{ "error": { "code": "...", "message": "..." } }`. The page explains `no_key` itself, and an extension's `modelFailed` hook can handle codes of your own (a demo passcode, say). Answer within `modelTimeoutMs`, too: past it, the page stops waiting and says the assistant didn't answer. The CLI's own route gives its provider 60 seconds a turn, then answers 504 with the code `timeout`, so its words arrive before the page's 75 seconds are up.

The route is where your model key lives, so keep it on your server, and think about who can reach it: a public demo should limit how often it answers and may want a passcode, since every turn costs money.

## Security

- The page never sees your model key or your MCP server's credentials; both stay on your server.
- Screens run in sandboxed frames under the policy their resource declares, as in the CLI.
- `check: "browser"` sends the check's requests from the visitor's browser to `mcpUrl`. On another origin, that needs CORS on your MCP endpoint; on the same origin, nothing.

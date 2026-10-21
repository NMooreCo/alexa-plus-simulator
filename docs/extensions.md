# Extending the simulator

An extension adds to the simulated Echo: a control in the panel, a voice of your own, who's speaking, a passcode, a scripted demo. It's a function that the simulator calls once, before it connects. It gets the running simulator and returns the hooks it wants.

```js
/** @param {import("alexa-plus-simulator/ui").Simulator} sim */
export default function myExtension(sim) {
  const button = document.createElement("button");
  button.textContent = "Ask about today";
  button.addEventListener("click", () => sim.ask("What's on today?"));
  sim.ui.footer.append(button);

  return {
    // Every MCP request carries this header.
    headers: (kind) => (kind === "mcp" ? { "x-demo-user": "sam" } : {}),
    // The assistant hears this before what the person says.
    beforeTurn: () => ["(Alexa recognized the voice: Sam.)"],
  };
}
```

## Two ways to use one

**With the CLI.** Give it the file, as many times as you have extensions:

```bash
npx alexa-plus-simulator https://your-server.example.com/mcp --extension ./my-extension.js
```

The file is an ES module whose default export is the extension. The CLI serves it to the page, so it has to stand alone (bundle it if it imports anything). [`examples/extensions/clock.js`](../examples/extensions/clock.js) is a small one: it lets you pretend it's another time of day.

**In your own page.** The simulator is a library too. Host it in a page your server serves, with your extensions, and it talks to your MCP endpoint and your model route directly:

```js
import { startSimulator } from "alexa-plus-simulator/ui";
import "alexa-plus-simulator/ui/style.css";
import myExtension from "./my-extension.js";

await startSimulator({
  root: document.getElementById("app"),
  mcpUrl: "/mcp",
  modelUrl: "/api/model",
  check: "browser",
  home: { tool: "show_today" },
  extensions: [myExtension],
});
```

The model route takes and answers the same shape as the CLI's `/api/model`: a Messages API request (`messages`, `tools`, and a `context` with the server's instructions, the time, the time zone and the device) and the Messages API's reply. Without a proxy, the page records its own MCP traffic; `check: "browser"` runs the readiness check from the visitor's browser.

[Corral for Alexa+](https://alexa-demo.corral.narralogy.ai/echo) is built this way: its hosted demo is this simulator with one extension that adds who's speaking, a demo passcode, Amazon Polly's voice, the household's own clock, alerts the device says on its own, and a scripted demo.

## Hooks

Every hook is optional. Where several extensions give one, headers, context and turn lines come from all of them, in the order the extensions were given; the voice, the clock and the screen refresh come from the first one that has them.

| Hook | What it does |
|---|---|
| `headers(kind)` | Headers for every request of a kind, `"mcp"` or `"model"`, read afresh for each one; with the CLI, its proxy passes the MCP ones on to your server |
| `connected()` | The MCP connection is up (on start, and again after Reconnect). Runs before the home screen shows |
| `reset()` | A new conversation started |
| `beforeTurn()` | Lines the person's turn starts with, before what they said |
| `modelContext()` | More for the model request's `context` |
| `modelFailed(failure, question)` | A model request failed. Return `true` when you handled it: the turn is taken back, and you can ask it again later with `sim.ask` |
| `speak(text, started, signal)` | Say it in your own voice. Call `started()` when sound begins, resolve when it's done, stop when `signal` aborts. Throw to fall back to the browser's voice |
| `now()` | The time the assistant hears and the idle clock shows |
| `timeZone()` | The time zone, when it isn't the browser's |
| `screenNote(text)` | What a screen told the assistant, as it should go into the next turn; `null` drops it |
| `refresh(screen)` | The call that shows the screen again for whoever's speaking now; `null` for none, `undefined` to leave it to the simulator |

## The simulator

| | |
|---|---|
| `sim.ask(text, via)` | Asks as if someone said it; `"voice"` listens for the answer to a question back |
| `sim.say(text, { light })` | Says something on its own (an alert), on the `"notify"` light, say. Resolves once it's said |
| `sim.note(text)` | A line the assistant hears before the person's next words, once |
| `sim.callTool(name, args, { quiet, actor })` | Calls a tool through the simulator's MCP client. `quiet` keeps a successful call out of the traffic log |
| `sim.show(name, args)` | Calls a tool and puts its screen up |
| `sim.refreshScreen()` | Shows the screen that's up again, fresh |
| `sim.newConversation()`, `sim.setDevice(id)`, `sim.setLight(light)`, `sim.caption(heard, said)`, `sim.log(who, text)` | What they say |
| `sim.busy`, `sim.light`, `sim.lastSaid`, `sim.screen`, `sim.device`, `sim.instructions`, `sim.tools()`, `sim.speaking()`, `sim.untilQuiet()` | Where things stand |
| `sim.ui.header`, `sim.ui.panel`, `sim.ui.footer` | Places in the panel for your own pieces |
| `sim.ui.screen` | Over the device's screen, in the screen's own pixels (it scales with the screen) |
| `sim.ui.device` | Over the whole device, unscaled: a card that asks for something |
| `sim.ui.suggestions(items)` | Replaces the suggestions; an item can be `{ text, label, run }` to do something of its own |
| `sim.root` | The simulator's root element, for anything else |

The full types are in [`src/ui/api.ts`](../src/ui/api.ts) and ship with the package.

# Troubleshooting

## Connecting

**"Couldn't connect to ..."** The page's MCP client couldn't initialize. Check that the server is running and that the URL is the MCP endpoint itself (often `/mcp`), then run `alexa-plus-simulator check <url>`: DL-01 says what came back. A server that only speaks the legacy HTTP+SSE transport fails there; Alexa+ needs Streamable HTTP.

**"http:// isn't allowed" at start.** The simulator only talks to `https://` servers, or `http://` on your own machine (`localhost`, `127.0.0.1`, `[::1]`), as Amazon's Local Inspector does. For a server on another machine, use HTTPS or a tunnel such as `cloudflared tunnel --url http://localhost:8787`.

**401 or 403.** The server wants sign-in. Sign in once with `alexa-plus-simulator link <url>`, which runs the account-linking flow and saves tokens, then use `--token-file` (it refreshes them as they expire). Or pass an access token you already have with `--token`, or the `MCP_TOKEN` environment variable, which keeps it out of your shell history. The check's AU rules look at your account-linking setup either way.

**"Lost the simulator's proxy."** The CLI stopped. Start it again and reload the page.

**A port is taken.** Pick others with `--server-port` and `--client-port`.

**A 405 for GET /mcp in the browser's console.** That's expected: a stateless server has no stream to open, and the client carries on without it.

## Screens

**A screen is blank or missing pieces.** Look in the Conversation log. Screens run under the Content Security Policy their resource declares, as the MCP Apps standard has a host do: nothing loads from the network unless the resource's `_meta.ui.csp` names its origin. The log says what was blocked and which list to add it to (`connectDomains` for fetches, `resourceDomains` for scripts, styles, images and fonts, `frameDomains` for frames).

**"tried eval, which its policy blocks."** A note, not a failure. Libraries such as zod test whether `eval` works and carry on without it. If your screen really needs `eval`, it needs a different approach: hosts generally block it.

**Storage or cookies don't work in a screen.** Screens run in a sandboxed frame with an opaque origin, so `localStorage` and cookies aren't there. Keep state on your server or in the tool results.

**A tap does nothing.** A screen's calls go through the host: send `tools/call` over the MCP Apps bridge (the `App` class in `@modelcontextprotocol/ext-apps` does this) rather than fetching your server directly. The Traffic tab shows what arrived.

## Talking

**"Talking needs an Anthropic API key."** Set `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL` for a gateway) before starting the simulator. Without one, the Tools tab still calls every tool.

**The microphone doesn't work.** Speech recognition needs Chrome or Edge, and the page has to be allowed to use the microphone. Typing works everywhere.

**Hands-free doesn't hear "Alexa".** Phones often hear it as "Alexis" or "Alexia", which also work. The note under the talk bar says what it heard without the wake word.

## The readiness check

**A rule says SKIP.** Its notes say why. The data layer's tool rules call only tools marked `readOnlyHint: true` that need no arguments, unless you give it sample calls with `--calls calls.json` (`[{ "tool": "get_forecast", "arguments": { "city": "Denver" } }]`); the sign-in rules run only for a server that refuses an unauthenticated request.

**`link` can't sign in.** The redirect it uses is `http://127.0.0.1:6278/callback` (`--callback-port` changes the port), so a client you made needs that redirect registered. Without `--client-id`, it registers a client for testing, which works only when your authorization server allows dynamic registration. Alexa+ itself uses a client you register with Amazon's redirect addresses.

**"No browser to render the screens in."** `--visual` drives a headless browser. Install Chrome or Edge, or run `npx playwright install chromium`, or name one with `--browser chrome|msedge|chromium`.

**Latency warnings on the first request only.** A cold start (a serverless platform waking up) is often the slowest round trip. Run the check again to see the warm numbers; Alexa+ will meet the cold ones too.

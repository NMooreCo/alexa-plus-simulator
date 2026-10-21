# Changelog

## 0.1.0 (2026-10-21)

The first release.

- **Models:** Anthropic (Claude), Amazon Bedrock (Amazon Nova and any model with tool use through Converse), Microsoft Foundry (Claude through Anthropic's Foundry client, other deployments through its OpenAI-compatible endpoint), Google Gemini and OpenAI (and servers that speak Chat Completions) stand in for Alexa+'s model, and the page is the same whichever one it is. Anthropic's was tried live; the others were tested against recorded responses in the shapes each provider documents. A turn the model doesn't answer within a minute is given up on, saying so.
- **The simulator:** a simulated Echo Show 5, 8, 10, 15 or 21, or an Echo Dot, as an MCP client that connects the way Alexa+ does; MCP Apps screens under the policy their resources declare, with blocked loads explained; talking by voice (with follow-up listening and hands-free) or typing; tabs for the conversation, live traffic against the 500 ms budget, calling tools by hand, the readiness report and the server.
- **The readiness check:** the data layer (DL-01 to DL-08), sign-in (AU-01 to AU-09) and the add-on package (PK-01 to PK-14), each rule quoting the published requirement it checks; `--calls` for tools that need arguments; `--header` on its requests as on the simulator's; `check` for CI with JSON and HTML reports and exit codes; `validate` for `addon.json`. A server that asks for sign-in, checked without a token, is CONDITIONAL, never READY, since its data layer went unchecked. Like the simulator, it talks to `https://` servers, or `http://` on your own machine.
- **Account linking:** `link` follows Alexa+'s account linking as Amazon documents it (root protected resource metadata, S256 PKCE, the resource parameter) and saves tokens that `--token-file` sends and refreshes (trying again later when the token endpoint is out of reach for a moment); tested against a stand-in authorization server.
- **The screen check:** `check --visual` renders every screen on the Echo Show 5, 8 and 15 in a headless browser, saves screenshots, and judges VR-01 to VR-04.
- **A local proxy** shaped like Amazon's Local Inspector's, for coding agents: `/mcp` (passing a request's own headers on, an extension's included, and following redirects only within your server's origin), `/events`, `/state`, `/health`.
- **Extensions and the library:** `--extension`, and `alexa-plus-simulator/ui` to host the simulator in your own page.
- **An example server** with a screen, to try it with.

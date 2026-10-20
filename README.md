# Alexa+ simulator

An open, unofficial simulator and readiness check for Alexa+ MCP add-ons. Point it at your MCP server, talk to it on a simulated Echo Show or Echo Dot, see your MCP Apps screens at both of Alexa's screen sizes, watch every request against Alexa+'s 500 ms budget, and check the server against Amazon's published requirements.

> **Unofficial.** Not affiliated with or endorsed by Amazon. Amazon's own tools for this (a web simulator and the Local Inspector) are open to select partners for now; this follows Amazon's published documentation so anyone can build and test an add-on. Passing these checks is a good sign, not a certification.

```bash
npx alexa-plus-simulator https://your-server.example.com/mcp
```

Then open http://localhost:6274. Set `ANTHROPIC_API_KEY` (or Amazon Bedrock or OpenAI credentials; see [Models](#models)) to talk to it; without any you can still call every tool by hand and run the readiness check.

## What it does

- **Simulates the device.** The page is an MCP client that connects the way Alexa+ says it does (protocol version `2025-03-26`, client `Alexa+ MCP Client`, `roots` capability), lists your tools and calls them. Pick an Echo Show 5, 8, 10, 15 or 21, or an Echo Dot with no screen at all.
- **Talks.** Claude stands in for Alexa+'s own model: it decides what to say and which of your tools to call, and the page speaks the answer. Talk with the microphone (Chrome or Edge), turn on hands-free and start with "Alexa", or type. When it asks you a question, it listens for the answer.
- **Shows your screens.** A tool with `_meta.ui.resourceUri` gets its MCP Apps screen on the device, sized for the Small (10" and below) or Large (11" and above) surface. Screens run under the Content Security Policy their resource declares in `_meta.ui.csp`, as the MCP Apps standard has a host do, and anything the policy blocks shows up in the log with the line to add.
- **Records the traffic.** Every JSON-RPC exchange, with its timing; anything at 500 ms or more is flagged.
- **Checks readiness.** The transport, protocol version, tools, latency, results, errors, screens and, for a server that needs sign-in, the account-linking setup, each tied to the published requirement it checks. From the page, or from the command line for CI:

```bash
npx alexa-plus-simulator check https://your-server.example.com/mcp --out readiness-report.json
```

It exits with 1 when something fails, so it can gate a pull request.

- **Checks your package.** `validate addon.json` checks an add-on package against the quickstart's schema reference: lengths, example phrases, HTTPS links, image sizes and formats.

## Usage

```
alexa-plus-simulator <mcp-url> [options]       Talk to your MCP server on a simulated Echo
alexa-plus-simulator check <mcp-url> [options] Check it against Alexa+'s published requirements
alexa-plus-simulator validate <addon.json>     Check an add-on package's addon.json
```

| Option | |
|---|---|
| `--token <token>` | A bearer token for a server that needs sign-in (or set `MCP_TOKEN`), sent on every request |
| `--header "Name: value"` | Another header on every request to the server (repeatable) |
| `--addon <addon.json>` | Your add-on package: its example phrases become suggestions, and the check includes it |
| `--extension <file.js>` | An extension for the page (repeatable); see [Extending it](#extending-it) |
| `--server-port <port>` | The proxy's port (default 6277) |
| `--client-port <port>` | The page's port (default 6274) |
| `--provider <name>` | Who stands in for Alexa+'s model: `anthropic`, `bedrock` or `openai` (default: the first with credentials, in that order); see [Models](#models) |
| `--model <id>` | The model standing in for Alexa+ (default `claude-opus-5-5` on Anthropic, `global.amazon.nova-2-lite-v1:0` on Bedrock, `gpt-6-sol` on OpenAI) |
| `--region <region>` | Bedrock's AWS Region (default `AWS_REGION`, `AWS_DEFAULT_REGION` or `us-east-1`) |
| `--no-fallbacks` | Leave Anthropic's refusal fallback off, for a gateway that doesn't pass it through |
| `--open` | Open the simulator in the browser |
| `--verbose` | Log every exchange |
| `--out <file>` | `check`: also write the report as JSON |
| `--json` | `check`, `validate`: print JSON instead of a summary |

A model's credentials in the environment turn on talking: `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL` for a gateway), `AWS_BEARER_TOKEN_BEDROCK` or `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for Bedrock, or `OPENAI_API_KEY` and `OPENAI_BASE_URL` for OpenAI or a server that speaks its API. They stay on your machine: the page asks the simulator's own server, which asks the provider.

## Models

A model stands in for Alexa+'s own: it reads the conversation, decides what to say and which of your tools to call, and the page makes the calls. Any of three providers can be that model, each through its own API; the page works the same with all of them.

| `--provider` | Credentials | Default model |
|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY`, and `ANTHROPIC_BASE_URL` for a gateway | `claude-opus-5-5` at low effort, with Anthropic's refusal fallback |
| `bedrock` | `AWS_BEARER_TOKEN_BEDROCK` (a Bedrock API key), or IAM credentials in `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN`, which sign each request | `global.amazon.nova-2-lite-v1:0`: Amazon Nova 2 Lite with its reasoning off, through the Converse API |
| `openai` | `OPENAI_API_KEY`, and `OPENAI_BASE_URL` for Azure OpenAI, Ollama, LM Studio, Groq or another server that speaks Chat Completions (a local one needs no key) | `gpt-6-sol` with reasoning off, through Chat Completions |

- Without `--provider`, the simulator uses the first of these it has credentials for, in that order, and its startup line and the page say which.
- `--model` picks another model from the same provider: any Bedrock model that uses tools through Converse (Claude, Llama, Mistral and others, by model id, inference profile or ARN), or any model a Chat Completions server has. `--region` picks Bedrock's Region; otherwise it's `AWS_REGION`, `AWS_DEFAULT_REGION` or `us-east-1`.
- Credentials come from the environment only, not from `~/.aws`. `aws configure export-credentials --format env` (or `--format powershell`) prints a profile's as variables to set.
- OpenAI's flagship, GPT-6 Astra, and GPT-6.1 Sol call tools only through OpenAI's Responses API, so they can't stand in here yet; GPT-6 Sol calls them through Chat Completions with its reasoning off.
- Bedrock and OpenAI were tested against recorded API responses, in the shapes each provider documents, not live calls, since no credentials were available.

## The readiness rules

Each rule quotes the requirement it checks, with a link, in the report itself. The check only ever calls tools marked `readOnlyHint: true` that need no arguments, plus a made-up tool name to see how errors come back.

| Rule | Checks |
|---|---|
| DL-01 Streamable HTTP | `initialize` as Alexa+ sends it succeeds (a server that only speaks the legacy HTTP+SSE transport fails) |
| DL-02 Protocol version | The server negotiates `2025-03-26`, the version Alexa+ asks for |
| DL-03 Tool definitions | Every tool has a name, a description and an object `inputSchema` |
| DL-04 Latency under 500 ms | `initialize`, listing, each screen and each read-only tool, timed; the median must be under 500 ms, and each slow request is named |
| DL-05 Tool results | A tool's result has text and `structuredContent`, as Amazon's documented result does |
| DL-06 Error handling | A call to a tool that doesn't exist gets a JSON-RPC error or `isError`, never a 5xx, a hang or HTML |
| DL-07 Repeated calls | The same read-only call twice returns the same result |
| DL-08 Screens | Each `_meta.ui.resourceUri` reads back as HTML (otherwise Alexa+ uses its data-only flow) |
| AU-01 to AU-08 | For a server that needs sign-in: 401 or 403 without a token, no `WWW-Authenticate` header, protected resource metadata at the root path, authorization server metadata, PKCE with S256, the authorization and token endpoints, refresh tokens, and HTTPS |
| PK-01 to PK-14 | `addon.json` (with `--addon`, or `validate`): the manifest version, countries, name and description lengths, example phrases, HTTPS policy links, icon, carousel and banner sizes, the MCP integration and its HTTPS endpoint, and image formats |

## Extending it

Extensions add to the simulated Echo: a control in the panel, your own voice, who's speaking, a passcode, a scripted demo. An extension is a function that gets the running simulator and returns the hooks it wants. Give one to the CLI with `--extension`, or host the simulator in your own page as a library (`alexa-plus-simulator/ui`) with as many as you like:

```js
import { startSimulator } from "alexa-plus-simulator/ui";
import "alexa-plus-simulator/ui/style.css";

await startSimulator({ mcpUrl: "/mcp", modelUrl: "/api/model", check: "browser", extensions: [myExtension] });
```

[docs/extensions.md](docs/extensions.md) has the hooks, the API and an example.

## For coding agents

The simulator runs a local proxy between the page and your server, shaped like the Local Inspector's, so an agent can drive and watch the same session:

| On the proxy (port 6277) | |
|---|---|
| `POST /mcp`, `GET /mcp`, `DELETE /mcp` | Forwarded to your server. Send `Accept: application/json` to get plain JSON even when the server answers with Server-Sent Events. |
| `GET /events` | Server-Sent Events: `connected`, `tools-discovered`, `resource-fetched`, `widget-html`, `tool-called`, `error`, and `rpc` for every exchange |
| `GET /health` | `{"status":"ok"}` once the server has been initialized |
| `GET /state` | Everything seen this session: tools, resources, calls, errors and recent exchanges |
| `POST /api/check` | The readiness report, as JSON |

Both ports listen on 127.0.0.1 only, refuse other hosts (against DNS rebinding) and allow only the page's own origin. Your server must be `https://`, or `http://` on localhost.

## How it differs from the real thing

- **The model is Claude, not Alexa's.** It follows your server's `instructions` and tool descriptions as a capable model would, with a short spoken style; Alexa+ may choose differently.
- **The voice is your browser's.** Recognition and speech come from the Web Speech API.
- **Amazon's full rubric isn't public.** The check covers what Amazon has published (quoted, with links, in [docs/alexa-requirements.md](docs/alexa-requirements.md)) and says so in every report. The verdicts are READY, CONDITIONAL and NOT_READY, so they can't be mistaken for Amazon's certification.
- **Sign-in is a token you supply.** The check reads your protected resource and authorization server metadata the way the account-linking guide describes, but it doesn't run Amazon's account-linking flow.
- **Screens render in your browser** at the documented sizes, not on Echo hardware.

## Try it without a server

```bash
pnpm install && pnpm build
pnpm example            # a to-do list MCP server with a screen, on port 6280
node dist/server/cli.js http://127.0.0.1:6280/mcp --open
```

`node examples/tasks/server.mjs --slow 700` makes every request slow, to see the budget warnings.

## Development

Node 22 or later and pnpm.

```bash
pnpm install
pnpm check   # build, typecheck and tests
```

## License

MIT

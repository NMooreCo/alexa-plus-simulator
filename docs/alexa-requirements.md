# What Alexa+ asks of an MCP add-on

Amazon's published requirements for Alexa+ MCP add-ons, quoted from its developer docs, for the readiness checks in this project. Every rule in `src/check` points at one of these. Amazon says its criteria are preliminary ("The following are preliminary evaluation criteria. Amazon will provide the final evaluation criteria before general availability"), so a passing report here is a good sign, not a certification.

Read on 2026-10-17.

## The Alexa+ client

[Alexa+ MCP Client and App Lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle)

- Alexa+'s documented `initialize` request:

  ```json
  {
    "jsonrpc": "2.0",
    "method": "initialize",
    "id": "4e3bdaee-0",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": { "roots": { "listChanged": true } },
      "clientInfo": { "name": "Alexa+ MCP Client", "version": "1.0.0" }
    }
  }
  ```

- A documented tool result carries both `structuredContent` and a text `content` block, and a screen in `_meta.ui`: `"resourceUri": "ui://hotel-search"`, `"invoking": "Searching hotels..."`, `"invoked": "Found hotels"`.
- "It communicates with the server using streamable HTTP and maintains historical interaction context."
- "Alexa+ renders your custom visuals for your MCP App UI as long as you have resourceUri defined in the tool response. If there's no UI customization detected through resourceUri definitions, Alexa+ uses the data-only flow and renders visuals for the data provided through the MCP server tool response."
- "If you update any MCP tools and resources, redeploy your add-on with alexa-ai deploy to make the updates available to customers."

## Technical requirements

[Create an MCP Add-on (quickstart)](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart), "MCP requirements for Alexa+"

- "Your MCP server must support Streamable HTTP. The MCP specification (2025-11-25) deprecated the standalone HTTP+SSE transport in favor of Streamable HTTP. If your MCP server currently uses the legacy SSE transport, you must migrate before connecting to Alexa+."
- "If you expect to provide visuals, follow the MCP Apps standard."
- "Your MCP server must be accessible via a remote URL. During local development, you can use a tunneling service (such as cloudflared) to expose your server."
- Performance: "Your MCP server must meet a round-trip query response latency of less than 500 ms."

## Authentication checklist

Same page, "Authentication checklist":

- Discovery
  - "Your MCP server returns 401 Unauthorized (without a WWW-Authenticate header) for unauthenticated requests."
  - "Your server hosts a Protected Resource Metadata (PRM) document at the well-known URI according to RFC 9728."
  - "Your auth server metadata is available at /.well-known/oauth-authorization-server."
  - "code_challenge_methods_supported must be present and must include S256. Account linking won't proceed without it."
- Authorization request: "Use OAuth 2.1 authorization code flow with PKCE (S256)." "Set the resource parameter to your MCP server's canonical URI." "Include scopes from scopes_supported in the PRM document. Omit scope if scopes_supported is undefined."
- Token request: "Include the resource parameter." "Include the PKCE code_verifier."
- Token usage: "Send the Bearer token in the Authorization header on every authenticated request." "Don't send the Bearer token in the query string."
- "Not Supported Yet": "Dynamic Client Registration (DCR)", "Client ID Metadata Documents (CIMD)", "OpenID Connect (OIDC)", "Step-Up Authorization.", "WWW-Authenticate header in 401 responses."

## Account linking

[Account Linking for MCP Add-ons](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking)

- "Host the following JSON document at this exact path on your MCP server: https://your-mcp-server.com/.well-known/oauth-protected-resource", with `"resource": "https://your-mcp-server.com/mcp"`, `"authorization_servers"` and `"scopes_supported"`.
- "Alexa reads this document automatically when you configure account linking."
- "Your token endpoint must return a refresh token alongside every access token. If no refresh token is issued, customers must re-link their account each time the access token expires."
- "Deployment is blocked if your authorization server doesn't support S256. Alexa checks code_challenge_methods_supported in your auth server metadata at deploy time."
- Resource parameter: "Alexa includes this as a resource parameter in both the authorization request and the token exchange request but not in the token refresh request."
- You are responsible for "Returning HTTP 401 or 403 when a tool is called without a valid token" and "Static client registration", since "Dynamic Client Registration (DCR) isn't supported".
- "Alexa caches auth metadata at deploy time and uses that cache at runtime."
- "Alexa has multiple redirect URIs ... Register all URIs in the list. At runtime, use exactly the value Alexa passes as redirect_uri", and don't hardcode it.
- Pre-flight checklist: "Authorization server is live and reachable over HTTPS", "PKCE S256 is enabled (code_challenge_methods_supported includes S256)", "Refresh tokens are issued alongside every access token", "Client ID and secret are created and noted securely", "MCP server is deployed and publicly accessible".

## Testing tools

[Test Your MCP Add-ons](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-test-add-ons) and [Local Inspector](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-local-inspector). Both are part of the MCP Toolkit, which "At this time ... [is] available to select partners only" ([home](https://developer.amazon.com/docs/alexaplus/add-ons/home)).

- In isolation: "Verify tool schemas by calling tools/list", "Call tools with valid and invalid inputs to test happy paths and error handling", "Test idempotency by repeating calls with the same parameters", "Export interaction traces for review".
- The Local Inspector "connects to your MCP server, calls your tools, and produces a readiness report against the certification checklist". Two modes: "Visual rendering: Renders your widget inside Alexa device frames, screenshots every device surface, and evaluates visual, accessibility, and UI quality rules" and "MCP data-layer: Inspects tool definitions, request/response payloads, errors, and latency for correctness and quality (no UI required)".
- Its proxy: `POST /mcp`, `GET /mcp`, `DELETE /mcp`, `GET /events`, `GET /health` (`{"status":"ok"}` after initialize, `{"status":"not-ready"}` before), `GET /state`; default ports 6277 (proxy) and 6274 (UI); "The proxy only accepts connections from localhost"; "Remote http:// (non-TLS) upstreams are rejected; only loopback http:// addresses are allowed for local dev servers."
- With `Accept: application/json` the proxy unwraps SSE-framed responses into plain JSON.
- Its events on `GET /events`: `connected`, `tools-discovered`, `resource-fetched`, `widget-html`, `tool-called`, `error`.
- Device surfaces: "Small: 10" and below", "Large: 11" and above". "Your widget must render correctly on both surfaces to meet the visual requirements for certification."
- Verdicts: "CERTIFIED: All evaluated rules pass across all device surfaces", "CONDITIONAL: Warnings exist but no hard failures", "NOT_CERTIFIED: One or more rules fail".

## Certification (preliminary)

[Certify and Publish Your MCP Add-ons](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-certify)

- "Complete the specific tasks customers request through named invocations, as defined by the tool names and server descriptions."
- "Have no high-severity defects that cause dead ends or that Alexa can't recover from, as these result in certification failure."
- "Support Alexa accessibility features, including VoiceView, Alexa Captions, Screen Magnifier, and Color Tools on Alexa multi-modal devices."
- "Display images that aren't pixelated or stretched on Alexa multi-modal devices."
- "Tool signatures and descriptions are locked after publication."
- "The complete certification rubric, self-review checklist, and exemplary case studies will be added in a future revision of this guide."

## The add-on package (`addon.json`)

Quickstart, "addon.json schema reference": `manifestVersion` "Always \"1.0\""; `storeListing.distributionCountries` ISO codes; `name.value` "≤30 characters"; `shortDescription` "≤123 characters"; `fullDescription` "≤4000 characters"; `examplePhrases` "3–4 items, each ≤200 characters"; `privacyPolicyUrl` and `termsOfUseUrl` "Valid HTTPS URL"; `mediaAssets.icons.light` "All 6 sizes required: 72x72, 64x64, 88x88, 126x126, 180x180, 241x241"; `mediaAssets.icons.dark` "Same 6 sizes if provided"; `mediaAssets.carouselImages` "At least 1 image (600x900), altText ≤250 chars"; `mediaAssets.bannerImages` "1200x600, altText ≤250 chars"; `integrations[].type` "\"MCP\" for MCP Toolkit add-ons"; `integrations[].config.endpoints.default.type` "\"HTTPS\""; "All image URIs must use HTTPS and be PNG, JPG, JPEG, or WEBP format."

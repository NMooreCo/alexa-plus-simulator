import type { RuleResult } from "../shared/contract.ts";

/**
 * The published requirements the rules check, quoted exactly as they appear in
 * docs/alexa-requirements.md (a test holds them to that), so every rule in a
 * report points at Amazon's own words rather than our reading of them.
 */

export type Source = RuleResult["source"];

const LIFECYCLE = {
  title: "Alexa+ MCP Client and App Lifecycle",
  url: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-client-lifecycle",
};
const QUICKSTART = {
  title: "Create an MCP Add-on (quickstart)",
  url: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-quickstart",
};
const ACCOUNT_LINKING = {
  title: "Account Linking for MCP Add-ons",
  url: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-account-linking",
};
const TESTING = {
  title: "Test Your MCP Add-ons",
  url: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-test-add-ons",
};
const CERTIFY = {
  title: "Certify and Publish Your MCP Add-ons",
  url: "https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-certify",
};

const quote = (page: { title: string; url: string }, text: string): Source => ({ ...page, quote: text });

export const SOURCES = {
  streamableHttp: quote(
    QUICKSTART,
    "Your MCP server must support Streamable HTTP. The MCP specification (2025-11-25) deprecated the standalone HTTP+SSE transport in favor of Streamable HTTP. If your MCP server currently uses the legacy SSE transport, you must migrate before connecting to Alexa+.",
  ),
  // A line of Alexa+'s documented initialize request, which is all Amazon says about the version.
  protocolVersion: quote(LIFECYCLE, `"protocolVersion": "2025-03-26"`),
  namedInvocations: quote(
    CERTIFY,
    "Complete the specific tasks customers request through named invocations, as defined by the tool names and server descriptions.",
  ),
  latency: quote(QUICKSTART, "Your MCP server must meet a round-trip query response latency of less than 500 ms."),
  dataOnlyFlow: quote(
    LIFECYCLE,
    "Alexa+ renders your custom visuals for your MCP App UI as long as you have resourceUri defined in the tool response. If there's no UI customization detected through resourceUri definitions, Alexa+ uses the data-only flow and renders visuals for the data provided through the MCP server tool response.",
  ),
  noDeadEnds: quote(
    CERTIFY,
    "Have no high-severity defects that cause dead ends or that Alexa can't recover from, as these result in certification failure.",
  ),
  idempotency: quote(TESTING, "Test idempotency by repeating calls with the same parameters"),

  refusesWithoutToken: quote(ACCOUNT_LINKING, "Returning HTTP 401 or 403 when a tool is called without a valid token"),
  noWwwAuthenticate: quote(
    QUICKSTART,
    "Your MCP server returns 401 Unauthorized (without a WWW-Authenticate header) for unauthenticated requests.",
  ),
  protectedResourceMetadata: quote(
    ACCOUNT_LINKING,
    "Host the following JSON document at this exact path on your MCP server: https://your-mcp-server.com/.well-known/oauth-protected-resource",
  ),
  authServerMetadata: quote(QUICKSTART, "Your auth server metadata is available at /.well-known/oauth-authorization-server."),
  s256: quote(
    QUICKSTART,
    "code_challenge_methods_supported must be present and must include S256. Account linking won't proceed without it.",
  ),
  authorizationCodeFlow: quote(QUICKSTART, "Use OAuth 2.1 authorization code flow with PKCE (S256)."),
  refreshTokens: quote(
    ACCOUNT_LINKING,
    "Your token endpoint must return a refresh token alongside every access token. If no refresh token is issued, customers must re-link their account each time the access token expires.",
  ),
  https: quote(ACCOUNT_LINKING, "Authorization server is live and reachable over HTTPS"),

  // The addon.json schema reference is a table, so these quote its cells.
  manifestVersion: quote(QUICKSTART, `Always "1.0"`),
  // The doc gives this cell unquoted; these are its words.
  distributionCountries: quote(QUICKSTART, "ISO codes"),
  nameLength: quote(QUICKSTART, "≤30 characters"),
  shortDescription: quote(QUICKSTART, "≤123 characters"),
  fullDescription: quote(QUICKSTART, "≤4000 characters"),
  examplePhrases: quote(QUICKSTART, "3–4 items, each ≤200 characters"),
  policyUrls: quote(QUICKSTART, "Valid HTTPS URL"),
  lightIcons: quote(QUICKSTART, "All 6 sizes required: 72x72, 64x64, 88x88, 126x126, 180x180, 241x241"),
  darkIcons: quote(QUICKSTART, "Same 6 sizes if provided"),
  carouselImages: quote(QUICKSTART, "At least 1 image (600x900), altText ≤250 chars"),
  bannerImages: quote(QUICKSTART, "1200x600, altText ≤250 chars"),
  integrationType: quote(QUICKSTART, `"MCP" for MCP Toolkit add-ons`),
  endpointType: quote(QUICKSTART, `"HTTPS"`),
  imageUris: quote(QUICKSTART, "All image URIs must use HTTPS and be PNG, JPG, JPEG, or WEBP format."),
} satisfies Record<string, Source>;

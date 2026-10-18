import type { RuleCategory, RuleResult, RuleStatus } from "../shared/contract.ts";
import { SOURCES, type Source } from "./sources.ts";

/** Every rule the check can report, in report order, each tied to the requirement it checks. */

export interface RuleDefinition {
  id: string;
  category: RuleCategory;
  title: string;
  source: Source;
}

const define = (id: string, category: RuleCategory, title: string, source: Source): RuleDefinition => ({
  id,
  category,
  title,
  source,
});

export const RULES = {
  streamableHttp: define("DL-01", "mcp-data", "Streamable HTTP", SOURCES.streamableHttp),
  protocolVersion: define("DL-02", "mcp-data", "Protocol version", SOURCES.protocolVersion),
  tools: define("DL-03", "mcp-data", "Tool definitions", SOURCES.namedInvocations),
  latency: define("DL-04", "mcp-data", "Latency under 500 ms", SOURCES.latency),
  toolResults: define("DL-05", "mcp-data", "Tool results", SOURCES.dataOnlyFlow),
  errors: define("DL-06", "mcp-data", "Error handling", SOURCES.noDeadEnds),
  idempotency: define("DL-07", "mcp-data", "Repeated calls", SOURCES.idempotency),
  screens: define("DL-08", "mcp-data", "Screens", SOURCES.dataOnlyFlow),

  refusal: define("AU-01", "auth", "Refuses unauthenticated requests", SOURCES.refusesWithoutToken),
  noChallengeHeader: define("AU-02", "auth", "No WWW-Authenticate header", SOURCES.noWwwAuthenticate),
  protectedResource: define("AU-03", "auth", "Protected resource metadata", SOURCES.protectedResourceMetadata),
  authServer: define("AU-04", "auth", "Authorization server metadata", SOURCES.authServerMetadata),
  pkce: define("AU-05", "auth", "PKCE with S256", SOURCES.s256),
  endpoints: define("AU-06", "auth", "Authorization and token endpoints", SOURCES.authorizationCodeFlow),
  refreshTokens: define("AU-07", "auth", "Refresh tokens", SOURCES.refreshTokens),
  https: define("AU-08", "auth", "HTTPS", SOURCES.https),

  manifestVersion: define("PK-01", "package", "Manifest version", SOURCES.manifestVersion),
  countries: define("PK-02", "package", "Distribution countries", SOURCES.distributionCountries),
  name: define("PK-03", "package", "Name length", SOURCES.nameLength),
  shortDescription: define("PK-04", "package", "Short description", SOURCES.shortDescription),
  fullDescription: define("PK-05", "package", "Full description", SOURCES.fullDescription),
  examplePhrases: define("PK-06", "package", "Example phrases", SOURCES.examplePhrases),
  policyUrls: define("PK-07", "package", "Privacy policy and terms of use", SOURCES.policyUrls),
  lightIcons: define("PK-08", "package", "Light icons", SOURCES.lightIcons),
  darkIcons: define("PK-09", "package", "Dark icons", SOURCES.darkIcons),
  carousel: define("PK-10", "package", "Carousel images", SOURCES.carouselImages),
  banners: define("PK-11", "package", "Banner images", SOURCES.bannerImages),
  integrationType: define("PK-12", "package", "Integration type", SOURCES.integrationType),
  endpoint: define("PK-13", "package", "HTTPS endpoint", SOURCES.endpointType),
  imageUris: define("PK-14", "package", "Image URIs", SOURCES.imageUris),
} satisfies Record<string, RuleDefinition>;

export function judge(rule: RuleDefinition, status: RuleStatus, notes: string): RuleResult {
  return { id: rule.id, category: rule.category, title: rule.title, status, notes, source: rule.source };
}

/** "a; b; c; and 2 more", so a note stays one readable line however much went wrong. */
export function listOf(items: string[], max = 4): string {
  if (items.length <= max) return items.length > 1 ? `${items.slice(0, -1).join("; ")}; ${items.at(-1)}` : (items[0] ?? "");
  return `${items.slice(0, max).join("; ")}; and ${items.length - max} more`;
}

/** Notes open with a plain word, so field and tool names keep their exact case wherever they fall. */
export function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

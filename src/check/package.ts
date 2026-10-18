import type { RuleResult } from "../shared/contract.ts";
import { clip, isObject, type JsonObject } from "./rpc.ts";
import { RULES, judge, listOf, sentence, type RuleDefinition } from "./rules.ts";

/**
 * The package rules (PK-xx): addon.json against the quickstart's schema
 * reference. Amazon's example nests each store listing under
 * storeListing.locales["en-US"]; a listing right on storeListing, or locale
 * keys right under it, are read too, and every locale found is checked.
 */

const LIGHT_ICON_SIZES = ["72x72", "64x64", "88x88", "126x126", "180x180", "241x241"];
const CAROUSEL_SIZE = "600x900";
const BANNER_SIZE = "1200x600";
const ALT_TEXT_MAX = 250;
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp"];
const LISTING_FIELDS = ["name", "shortDescription", "fullDescription", "examplePhrases", "privacyAndCompliance", "mediaAssets"];
const LOCALE_KEY = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

interface Listing {
  /** For notes: the locale, like "en-US", when there's more than one or it's named. */
  label: string;
  fields: JsonObject;
}

/** Characters as people count them in a short string: code points, so an accented letter is one. */
function length(text: string): number {
  return [...text].length;
}

/** A value as JSON for a note, even one JSON can't hold, which a caller passing objects could. */
function show(value: unknown, max: number): string {
  return clip(JSON.stringify(value) ?? String(value), max);
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function listingsOf(addon: JsonObject): Listing[] {
  const store = addon.storeListing;
  if (!isObject(store)) return [];
  const found: Listing[] = [];
  const locales = store.locales;
  if (isObject(locales)) {
    for (const [locale, fields] of Object.entries(locales)) if (isObject(fields)) found.push({ label: locale, fields });
  } else if (Array.isArray(locales)) {
    locales.forEach((fields, i) => {
      if (!isObject(fields)) return;
      const named = typeof fields.locale === "string" ? fields.locale : `locales[${i}]`;
      found.push({ label: named, fields });
    });
  }
  for (const [key, fields] of Object.entries(store)) {
    if (key !== "locales" && LOCALE_KEY.test(key) && isObject(fields)) found.push({ label: key, fields });
  }
  if (!found.length && LISTING_FIELDS.some((field) => field in store)) found.push({ label: "storeListing", fields: store });
  return found;
}

/** "WxH" from "72x72", "72 X 72" or { width: 72, height: 72 }. */
function sizeOf(image: JsonObject): string | undefined {
  const size = image.size;
  if (typeof size === "string") return size.replace(/\s+/g, "").toLowerCase().replace("×", "x");
  if (isObject(size) && typeof size.width === "number" && typeof size.height === "number") return `${size.width}x${size.height}`;
  return undefined;
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  // The listing's name is { value, spokenForm }; other text fields may be written the same way.
  if (isObject(value) && typeof value.value === "string") return value.value;
  return undefined;
}

function mediaOf(listing: Listing): JsonObject | undefined {
  return isObject(listing.fields.mediaAssets) ? listing.fields.mediaAssets : undefined;
}

function iconsOf(listing: Listing, shade: "light" | "dark"): unknown {
  const icons = mediaOf(listing)?.icons;
  return isObject(icons) ? icons[shade] : undefined;
}

/**
 * Runs a per-listing check over every listing, saying which locale a note is
 * about when there's more than one, and turns them into one result.
 */
function perListing(
  rule: RuleDefinition,
  listings: Listing[],
  check: (listing: Listing) => { problems?: string[]; warnings?: string[]; found?: string },
): RuleResult {
  if (!listings.length) return judge(rule, "FAIL", "No store listing found (storeListing.locales).");
  const prefix = (listing: Listing, text: string) => (listings.length > 1 ? `in ${listing.label}, ${text}` : text);
  const problems: string[] = [];
  const warnings: string[] = [];
  const found: string[] = [];
  for (const listing of listings) {
    const outcome = check(listing);
    problems.push(...(outcome.problems ?? []).map((p) => prefix(listing, p)));
    warnings.push(...(outcome.warnings ?? []).map((w) => prefix(listing, w)));
    if (outcome.found) found.push(prefix(listing, outcome.found));
  }
  if (problems.length) return judge(rule, "FAIL", `${sentence(listOf(problems))}.${warnings.length ? ` Also, ${listOf(warnings)}.` : ""}`);
  if (warnings.length) return judge(rule, "WARN", `${sentence(listOf(warnings))}.`);
  return judge(rule, "PASS", `${sentence(listOf(found))}.`);
}

function maxLength(field: string, max: number) {
  return (listing: Listing) => {
    const text = textOf(listing.fields[field]);
    if (text === undefined || !text.trim()) return { problems: [`the ${field} is missing`] };
    const n = length(text);
    if (n > max) return { problems: [`the ${field} is ${n} characters, over ${max}`] };
    return { found: `the ${field} is ${n} characters` };
  };
}

function iconSizes(icons: unknown, shade: string): { problems?: string[]; found?: string } {
  if (!Array.isArray(icons)) return { problems: [`there are no ${shade} icons (mediaAssets.icons.${shade})`] };
  const sizes = new Set(icons.filter(isObject).map(sizeOf));
  const missing = LIGHT_ICON_SIZES.filter((size) => !sizes.has(size));
  if (missing.length) return { problems: [`the ${shade} icons are missing ${missing.join(", ")}`] };
  return { found: `all 6 ${shade} icon sizes are there` };
}

function imageSet(images: unknown, kind: string, size: string): { problems?: string[]; warnings?: string[]; found?: string } {
  if (!Array.isArray(images)) return { problems: [`the ${kind}s aren't a list`] };
  const problems: string[] = [];
  const warnings: string[] = [];
  images.forEach((image, i) => {
    const which = `${kind} ${i + 1}`;
    if (!isObject(image)) {
      problems.push(`${which} isn't an object`);
      return;
    }
    const declared = sizeOf(image);
    if (declared === undefined) problems.push(`${which} has no size`);
    else if (declared !== size) problems.push(`${which} is ${declared}, not ${size}`);
    const alt = image.altText;
    if (alt === undefined || (typeof alt === "string" && !alt.trim())) warnings.push(`${which} has no altText`);
    else if (typeof alt !== "string") problems.push(`${which}'s altText isn't text`);
    else if (length(alt) > ALT_TEXT_MAX) problems.push(`${which}'s altText is ${length(alt)} characters, over ${ALT_TEXT_MAX}`);
  });
  const found = `${images.length === 1 ? `there's 1 ${kind}` : `there are ${images.length} ${kind}s`}, ${size}, with altText`;
  return { problems, warnings, found };
}

/** Every image the package names, labeled for notes. */
function imagesOf(listings: Listing[]): { label: string; uri: unknown }[] {
  const images: { label: string; uri: unknown }[] = [];
  for (const listing of listings) {
    const where = listings.length > 1 ? ` in ${listing.label}` : "";
    for (const shade of ["light", "dark"] as const) {
      const icons = iconsOf(listing, shade);
      if (!Array.isArray(icons)) continue;
      icons.forEach((icon, i) => {
        if (isObject(icon)) images.push({ label: `${shade} icon ${sizeOf(icon) ?? i + 1}${where}`, uri: icon.uri });
      });
    }
    const media = mediaOf(listing);
    for (const [field, kind] of [
      ["carouselImages", "carousel image"],
      ["bannerImages", "banner image"],
    ] as const) {
      const list = media?.[field];
      if (!Array.isArray(list)) continue;
      list.forEach((image, i) => {
        if (isObject(image)) images.push({ label: `${kind} ${i + 1}${where}`, uri: image.uri });
      });
    }
  }
  return images;
}

/** The rules for an add-on package's addon.json, from the quickstart's schema reference. */
export function validatePackage(addonJson: unknown): RuleResult[] {
  const isAddon = isObject(addonJson);
  const addon: JsonObject = isAddon ? addonJson : {};
  const listings = listingsOf(addon);
  const rules: RuleResult[] = [];

  const version = addon.manifestVersion;
  rules.push(
    !isAddon
      ? judge(RULES.manifestVersion, "FAIL", "addon.json isn't a JSON object.")
      : version === "1.0"
        ? judge(RULES.manifestVersion, "PASS", `The manifestVersion is "1.0".`)
        : judge(
            RULES.manifestVersion,
            "FAIL",
            version === undefined ? `The manifestVersion is missing; it's always "1.0".` : `The manifestVersion is ${show(version, 40)}; it's always "1.0".`,
          ),
  );

  const store = isObject(addon.storeListing) ? addon.storeListing : undefined;
  const countries = store?.distributionCountries;
  if (!Array.isArray(countries) || !countries.length) {
    rules.push(judge(RULES.countries, "FAIL", "The storeListing.distributionCountries list is missing or empty."));
  } else {
    // Alexa manifests use two-letter ISO 3166 codes, as Amazon's example does ("US").
    const bad = countries.filter((c) => typeof c !== "string" || !/^[A-Z]{2}$/.test(c));
    rules.push(
      bad.length
        ? judge(RULES.countries, "FAIL", `These aren't two-letter ISO country codes: ${listOf(bad.map((c) => show(c, 20)))}.`)
        : judge(RULES.countries, "PASS", `The add-on is distributed in ${countries.join(", ")}.`),
    );
  }

  rules.push(perListing(RULES.name, listings, (listing) => {
    const name = textOf(listing.fields.name);
    if (name === undefined || !name.trim()) return { problems: ["the name (name.value) is missing"] };
    const n = length(name);
    if (n > 30) return { problems: [`the name "${clip(name, 40)}" is ${n} characters, over 30`] };
    return { found: `the name "${name}" is ${n} characters` };
  }));
  rules.push(perListing(RULES.shortDescription, listings, maxLength("shortDescription", 123)));
  rules.push(perListing(RULES.fullDescription, listings, maxLength("fullDescription", 4000)));

  rules.push(perListing(RULES.examplePhrases, listings, (listing) => {
    const phrases = listing.fields.examplePhrases;
    if (!Array.isArray(phrases)) return { problems: ["the examplePhrases list is missing"] };
    const problems: string[] = [];
    if (phrases.length < 3 || phrases.length > 4) problems.push(`there are ${phrases.length} example phrases, not 3 or 4`);
    phrases.forEach((phrase, i) => {
      const text = textOf(phrase);
      if (text === undefined || !text.trim()) problems.push(`phrase ${i + 1} is empty`);
      else if (length(text) > 200) problems.push(`phrase ${i + 1} is ${length(text)} characters, over 200`);
    });
    const longest = Math.max(0, ...phrases.map((p) => length(textOf(p) ?? "")));
    return problems.length ? { problems } : { found: `there are ${phrases.length} example phrases, the longest ${longest} characters` };
  }));

  rules.push(perListing(RULES.policyUrls, listings, (listing) => {
    // Amazon's example keeps these under privacyAndCompliance; a listing with them inline is read too.
    const holder = isObject(listing.fields.privacyAndCompliance) ? listing.fields.privacyAndCompliance : listing.fields;
    const problems: string[] = [];
    for (const field of ["privacyPolicyUrl", "termsOfUseUrl"]) {
      const value = holder[field];
      if (value === undefined || value === "") problems.push(`the ${field} is missing`);
      else if (!isHttpsUrl(value)) problems.push(`the ${field} ${clip(String(value), 60)} isn't an HTTPS URL`);
    }
    return problems.length ? { problems } : { found: "the privacyPolicyUrl and termsOfUseUrl are HTTPS URLs" };
  }));

  rules.push(perListing(RULES.lightIcons, listings, (listing) => iconSizes(iconsOf(listing, "light"), "light")));

  const withDark = listings.filter((listing) => {
    const dark = iconsOf(listing, "dark");
    return dark !== undefined && !(Array.isArray(dark) && dark.length === 0);
  });
  rules.push(
    withDark.length
      ? perListing(RULES.darkIcons, withDark, (listing) => iconSizes(iconsOf(listing, "dark"), "dark"))
      : judge(RULES.darkIcons, "SKIP", "No dark icons, which are optional."),
  );

  rules.push(perListing(RULES.carousel, listings, (listing) => {
    const images = mediaOf(listing)?.carouselImages;
    if (!Array.isArray(images) || !images.length) return { problems: [`there are no carousel images; at least one ${CAROUSEL_SIZE} image is required`] };
    return imageSet(images, "carousel image", CAROUSEL_SIZE);
  }));

  const withBanners = listings.filter((listing) => {
    const banners = mediaOf(listing)?.bannerImages;
    return banners !== undefined && !(Array.isArray(banners) && banners.length === 0);
  });
  rules.push(
    withBanners.length
      ? perListing(RULES.banners, withBanners, (listing) => imageSet(mediaOf(listing)?.bannerImages, "banner image", BANNER_SIZE))
      : judge(RULES.banners, "SKIP", "No banner images, which are optional."),
  );

  const integrations = Array.isArray(addon.integrations) ? addon.integrations : [];
  if (!integrations.length) {
    const note = `No integrations; an MCP add-on has one with type "MCP".`;
    rules.push(judge(RULES.integrationType, "FAIL", note), judge(RULES.endpoint, "FAIL", note));
  } else {
    const types: string[] = [];
    const endpointProblems: string[] = [];
    const endpoints: string[] = [];
    integrations.forEach((integration, i) => {
      const which = `integrations[${i}]`;
      const type = isObject(integration) ? integration.type : undefined;
      if (type !== "MCP") types.push(`the type of ${which} is ${type === undefined ? "missing" : show(type, 30)}, not "MCP"`);
      const config = isObject(integration) && isObject(integration.config) ? integration.config : undefined;
      const endpoint = config && isObject(config.endpoints) && isObject(config.endpoints.default) ? config.endpoints.default : undefined;
      if (!endpoint) {
        endpointProblems.push(`the entry ${which} has no config.endpoints.default`);
        return;
      }
      if (endpoint.type !== "HTTPS") {
        endpointProblems.push(`the endpoint type of ${which} is ${endpoint.type === undefined ? "missing" : show(endpoint.type, 30)}, not "HTTPS"`);
      }
      // The type says HTTPS, so a uri that isn't https:// contradicts it.
      if (endpoint.uri === undefined || endpoint.uri === "") endpointProblems.push(`the endpoint of ${which} has no uri`);
      else if (!isHttpsUrl(endpoint.uri)) endpointProblems.push(`the endpoint uri of ${which}, ${clip(String(endpoint.uri), 60)}, isn't an HTTPS URL`);
      else endpoints.push(String(endpoint.uri));
    });
    rules.push(
      types.length
        ? judge(RULES.integrationType, "FAIL", `${sentence(listOf(types))}.`)
        : judge(RULES.integrationType, "PASS", `${integrations.length === 1 ? "The integration's" : "Every integration's"} type is "MCP".`),
    );
    rules.push(
      endpointProblems.length
        ? judge(RULES.endpoint, "FAIL", `${sentence(listOf(endpointProblems))}.`)
        : judge(RULES.endpoint, "PASS", `The endpoint is HTTPS: ${listOf(endpoints)}.`),
    );
  }

  const images = imagesOf(listings);
  if (!images.length) {
    rules.push(judge(RULES.imageUris, "SKIP", "No image URIs to check."));
  } else {
    const problems: string[] = [];
    const unsure: string[] = [];
    for (const { label, uri } of images) {
      if (typeof uri !== "string" || !uri) {
        problems.push(`${label} has no uri`);
        continue;
      }
      if (!isHttpsUrl(uri)) {
        problems.push(`${label} isn't HTTPS (${clip(uri, 60)})`);
        continue;
      }
      const file = new URL(uri).pathname.split("/").pop() ?? "";
      const dot = file.lastIndexOf(".");
      const extension = dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
      if (!extension) unsure.push(`${label} (${clip(uri, 60)})`);
      else if (!IMAGE_EXTENSIONS.includes(extension)) problems.push(`${label} is .${extension}`);
    }
    if (problems.length) rules.push(judge(RULES.imageUris, "FAIL", `${sentence(listOf(problems))}.`));
    else if (unsure.length) {
      rules.push(judge(RULES.imageUris, "WARN", `The format can't be told from the file name of ${listOf(unsure)}; it must be PNG, JPG, JPEG or WEBP.`));
    } else {
      const count = images.length === 1 ? "The image URI is" : `All ${images.length} image URIs are`;
      rules.push(judge(RULES.imageUris, "PASS", `${count} HTTPS and PNG, JPG, JPEG or WEBP.`));
    }
  }

  return rules;
}

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RuleResult, RuleStatus } from "../src/shared/contract.ts";
import { validatePackage } from "../src/check/index.ts";

// The fixture is shaped like the example addon.json in Amazon's quickstart, with our own values.
// Untyped, since each case breaks it in a different way that a schema type would refuse.
type Loose = any;
const example = (): Loose => JSON.parse(readFileSync(new URL("./fixtures/addon.json", import.meta.url), "utf8"));
const enUs = (addon: Loose): Loose => addon.storeListing.locales["en-US"];

function variant(change: (addon: Loose, listing: Loose) => void): Loose {
  const addon = example();
  change(addon, enUs(addon));
  return addon;
}

function rule(rules: RuleResult[], id: string): RuleResult {
  const found = rules.find((r) => r.id === id);
  if (!found) throw new Error(`No ${id}`);
  return found;
}

const statuses = (rules: RuleResult[]) => Object.fromEntries(rules.map((r) => [r.id, r.status]));

const EXAMPLE_STATUSES = {
  "PK-01": "PASS",
  "PK-02": "PASS",
  "PK-03": "PASS",
  "PK-04": "PASS",
  "PK-05": "PASS",
  "PK-06": "PASS",
  "PK-07": "PASS",
  "PK-08": "PASS",
  // The example leaves dark icons and banners empty, and both are optional.
  "PK-09": "SKIP",
  "PK-10": "PASS",
  "PK-11": "SKIP",
  "PK-12": "PASS",
  "PK-13": "PASS",
  "PK-14": "PASS",
};

describe("validatePackage", () => {
  it("passes the example the README points to, every rule of it", () => {
    const shipped = JSON.parse(readFileSync(new URL("../examples/addon.json", import.meta.url), "utf8")) as unknown;
    const rules = validatePackage(shipped);
    expect(rules.filter((r) => r.status !== "PASS").map((r) => `${r.id} ${r.status}: ${r.notes}`)).toEqual([]);
    expect(rules).toHaveLength(14);
  });

  it("passes Amazon's example shape", () => {
    const rules = validatePackage(example());
    expect(statuses(rules)).toEqual(EXAMPLE_STATUSES);
    expect(rules.every((r) => r.category === "package" && r.source.quote && r.source.url.startsWith("https://developer.amazon.com/"))).toBe(true);
    expect(rule(rules, "PK-03").notes).toBe(`The name "Trail Weather" is 13 characters.`);
    expect(rule(rules, "PK-14").notes).toBe("All 7 image URIs are HTTPS and PNG, JPG, JPEG or WEBP.");
  });

  it.each<[string, string, RuleStatus, (addon: Loose, listing: Loose) => void, string?]>([
    ["manifestVersion 2.0", "PK-01", "FAIL", (a) => (a.manifestVersion = "2.0"), `manifestVersion is "2.0"`],
    ["manifestVersion as a number", "PK-01", "FAIL", (a) => (a.manifestVersion = 1), "manifestVersion is 1;"],
    ["no manifestVersion", "PK-01", "FAIL", (a) => delete a.manifestVersion, "missing"],
    ["no distribution countries", "PK-02", "FAIL", (a) => (a.storeListing.distributionCountries = []), "missing or empty"],
    ["a three-letter country code", "PK-02", "FAIL", (a) => (a.storeListing.distributionCountries = ["USA"]), `"USA"`],
    ["a 31-character name", "PK-03", "FAIL", (_, l) => (l.name.value = "x".repeat(31)), "31 characters, over 30"],
    ["a 30-character name", "PK-03", "PASS", (_, l) => (l.name.value = "x".repeat(30))],
    ["no name", "PK-03", "FAIL", (_, l) => delete l.name, "The name (name.value) is missing"],
    ["a 124-character short description", "PK-04", "FAIL", (_, l) => (l.shortDescription = "x".repeat(124)), "124 characters, over 123"],
    ["a 123-character short description", "PK-04", "PASS", (_, l) => (l.shortDescription = "x".repeat(123))],
    ["a 4001-character full description", "PK-05", "FAIL", (_, l) => (l.fullDescription = "x".repeat(4001)), "over 4000"],
    ["no full description", "PK-05", "FAIL", (_, l) => delete l.fullDescription, "fullDescription is missing"],
    ["two example phrases", "PK-06", "FAIL", (_, l) => (l.examplePhrases = l.examplePhrases.slice(0, 2)), "2 example phrases, not 3 or 4"],
    ["five example phrases", "PK-06", "FAIL", (_, l) => l.examplePhrases.push("Alexa, ask a", "Alexa, ask b"), "5 example phrases"],
    ["a 201-character phrase", "PK-06", "FAIL", (_, l) => (l.examplePhrases[1] = "x".repeat(201)), "Phrase 2 is 201 characters, over 200"],
    ["an http privacy policy", "PK-07", "FAIL", (_, l) => (l.privacyAndCompliance.privacyPolicyUrl = "http://example.com/privacy"), "isn't an HTTPS URL"],
    ["no terms of use", "PK-07", "FAIL", (_, l) => delete l.privacyAndCompliance.termsOfUseUrl, "termsOfUseUrl is missing"],
    ["a light icon size missing", "PK-08", "FAIL", (_, l) => l.mediaAssets.icons.light.pop(), "light icons are missing 241x241"],
    ["no light icons", "PK-08", "FAIL", (_, l) => delete l.mediaAssets.icons.light, "no light icons"],
    ["dark icons with a size missing", "PK-09", "FAIL", (_, l) => (l.mediaAssets.icons.dark = l.mediaAssets.icons.light.slice(1)), "dark icons are missing 72x72"],
    ["all six dark icons", "PK-09", "PASS", (_, l) => (l.mediaAssets.icons.dark = l.mediaAssets.icons.light)],
    ["no carousel images", "PK-10", "FAIL", (_, l) => (l.mediaAssets.carouselImages = []), "at least one 600x900"],
    ["a sideways carousel image", "PK-10", "FAIL", (_, l) => (l.mediaAssets.carouselImages[0].size = "900x600"), "Carousel image 1 is 900x600, not 600x900"],
    ["a 251-character altText", "PK-10", "FAIL", (_, l) => (l.mediaAssets.carouselImages[0].altText = "x".repeat(251)), "251 characters, over 250"],
    ["a carousel image without altText", "PK-10", "WARN", (_, l) => delete l.mediaAssets.carouselImages[0].altText, "no altText"],
    ["a banner the right size", "PK-11", "PASS", (_, l) => (l.mediaAssets.bannerImages = [{ uri: "https://cdn.example.com/b.webp", altText: "Banner", size: "1200x600" }])],
    ["a banner the wrong size", "PK-11", "FAIL", (_, l) => (l.mediaAssets.bannerImages = [{ uri: "https://cdn.example.com/b.webp", altText: "Banner", size: "600x1200" }]), "600x1200, not 1200x600"],
    ["a skill integration", "PK-12", "FAIL", (a) => (a.integrations[0].type = "SKILL"), `"SKILL", not "MCP"`],
    ["no integrations", "PK-12", "FAIL", (a) => delete a.integrations, "No integrations"],
    ["an HTTP endpoint type", "PK-13", "FAIL", (a) => (a.integrations[0].config.endpoints.default.type = "HTTP"), `"HTTP", not "HTTPS"`],
    ["an http endpoint uri", "PK-13", "FAIL", (a) => (a.integrations[0].config.endpoints.default.uri = "http://mcp.example.com"), "isn't an HTTPS URL"],
    ["no endpoint uri", "PK-13", "FAIL", (a) => delete a.integrations[0].config.endpoints.default.uri, "has no uri"],
    ["an http image", "PK-14", "FAIL", (_, l) => (l.mediaAssets.carouselImages[0].uri = "http://cdn.example.com/1.png"), "Carousel image 1 isn't HTTPS"],
    ["a GIF icon", "PK-14", "FAIL", (_, l) => (l.mediaAssets.icons.light[0].uri = "https://cdn.example.com/72.gif"), "Light icon 72x72 is .gif"],
    ["an image URI with no extension", "PK-14", "WARN", (_, l) => (l.mediaAssets.carouselImages[0].uri = "https://cdn.example.com/img/123"), "can't be told"],
    ["an uppercase JPEG with a query", "PK-14", "PASS", (_, l) => (l.mediaAssets.carouselImages[0].uri = "https://cdn.example.com/1.JPEG?v=2")],
  ])("%s: %s is %s", (_, id, status, change, note) => {
    const found = rule(validatePackage(variant(change)), id);
    expect(found.status).toBe(status);
    if (note) expect(found.notes).toContain(note);
  });

  it("reads a listing written right on storeListing", () => {
    const addon = example();
    const listing = enUs(addon);
    addon.storeListing = { distributionCountries: ["US"], ...listing };
    expect(statuses(validatePackage(addon))).toEqual(EXAMPLE_STATUSES);
  });

  it("checks every locale, naming the one that's wrong", () => {
    const addon = example();
    const german = structuredClone(enUs(addon));
    german.name.value = "Wettervorhersage fuer Wanderwege und Gipfel";
    addon.storeListing.locales["de-DE"] = german;
    const name = rule(validatePackage(addon), "PK-03");
    expect(name.status).toBe("FAIL");
    expect(name.notes).toMatch(/^In de-DE, the name "Wettervorhersage/);
    expect(name.notes).not.toContain("en-US");
  });

  it("fails a file that isn't a JSON object, rule by rule", () => {
    for (const input of [null, "addon", [], 42]) {
      const rules = validatePackage(input);
      expect(rules.map((r) => r.id)).toEqual(Object.keys(EXAMPLE_STATUSES));
      expect(rule(rules, "PK-01").notes).toBe("addon.json isn't a JSON object.");
      expect(rules.some((r) => r.status === "PASS")).toBe(false);
    }
  });

  it("describes values JSON can't hold instead of throwing, for callers passing objects", () => {
    const addon = variant((a) => (a.storeListing.distributionCountries = [undefined, () => "US"]));
    expect(rule(validatePackage(addon), "PK-02")).toMatchObject({ status: "FAIL", notes: expect.stringContaining("undefined") });
  });

  it("counts a name's characters as people do, whatever the script", () => {
    const letters = fc.constantFrom("a", "é", "日", "🙂", "ß", "Ω");
    fc.assert(
      fc.property(fc.array(letters, { minLength: 1, maxLength: 60 }), (chars) => {
        const status = rule(validatePackage(variant((_, l) => (l.name.value = chars.join("")))), "PK-03").status;
        return status === (chars.length <= 30 ? "PASS" : "FAIL");
      }),
    );
  });

  it("wants three or four example phrases, each 200 characters or fewer", () => {
    const phrase = fc.integer({ min: 1, max: 230 }).map((n) => "x".repeat(n));
    fc.assert(
      fc.property(fc.array(phrase, { maxLength: 7 }), (phrases) => {
        const status = rule(validatePackage(variant((_, l) => (l.examplePhrases = phrases))), "PK-06").status;
        const ok = phrases.length >= 3 && phrases.length <= 4 && phrases.every((p) => p.length <= 200);
        return status === (ok ? "PASS" : "FAIL");
      }),
    );
  });
});

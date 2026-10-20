import { readdirSync, readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DISCLAIMER, type RuleCategory, type RuleResult, type RuleStatus } from "../src/shared/contract.ts";
import { RULES, VERSION, buildReport, formatReport, verdictOf } from "../src/check/index.ts";

const STATUSES: RuleStatus[] = ["FAIL", "WARN", "PASS", "SKIP"];

const ruleArb: fc.Arbitrary<RuleResult> = fc.record({
  id: fc.stringMatching(/^(DL|AU|PK)-\d\d$/),
  category: fc.constantFrom<RuleCategory>("mcp-data", "auth", "package"),
  title: fc.string({ minLength: 1, maxLength: 30 }).map((s) => s.replace(/[\r\n]/g, " ")),
  status: fc.constantFrom(...STATUSES),
  notes: fc.string({ maxLength: 80 }).map((s) => s.replace(/[\r\n]/g, " ")),
  source: fc.constant({ title: "t", url: "https://example.com", quote: "q" }),
});
const rulesArb = fc.array(ruleArb, { maxLength: 30 });

describe("the verdict", () => {
  it("is READY exactly when every rule passes or is skipped, and NOT_READY exactly when one fails", () => {
    fc.assert(
      fc.property(rulesArb, (rules) => {
        const verdict = verdictOf(rules);
        expect(verdict === "READY").toBe(rules.every((r) => r.status === "PASS" || r.status === "SKIP"));
        expect(verdict === "NOT_READY").toBe(rules.some((r) => r.status === "FAIL"));
        expect(verdict === "CONDITIONAL").toBe(!rules.some((r) => r.status === "FAIL") && rules.some((r) => r.status === "WARN"));
      }),
    );
  });

  it("doesn't depend on rule order, and a skip never changes it", () => {
    const shuffledArb = rulesArb.chain((rules) =>
      fc.tuple(fc.constant(rules), fc.shuffledSubarray(rules, { minLength: rules.length, maxLength: rules.length })),
    );
    fc.assert(
      fc.property(shuffledArb, ruleArb, ([rules, shuffled], extra) => {
        expect(verdictOf(shuffled)).toBe(verdictOf(rules));
        expect(verdictOf([...rules, { ...extra, status: "SKIP" }])).toBe(verdictOf(rules));
        expect(verdictOf([...rules, { ...extra, status: "FAIL" }])).toBe("NOT_READY");
      }),
    );
  });
});

describe("buildReport", () => {
  it("counts every rule once and carries the verdict, the disclaimer and the tool's name", () => {
    fc.assert(
      fc.property(rulesArb, (rules) => {
        const report = buildReport("https://addon.example.com/mcp", rules, { checkedAt: new Date(0) });
        expect(report.passCount + report.failCount + report.warnCount + report.skipCount).toBe(rules.length);
        expect(report.failCount).toBe(rules.filter((r) => r.status === "FAIL").length);
        expect(report.warnCount).toBe(rules.filter((r) => r.status === "WARN").length);
        expect(report.verdict).toBe(verdictOf(rules));
        expect(report).toMatchObject({ tool: "alexa-plus-simulator", version: VERSION, disclaimer: DISCLAIMER, checkedAt: "1970-01-01T00:00:00.000Z" });
      }),
    );
  });
});

describe("formatReport", () => {
  it("prints the verdict, then one line per rule, failures first, then the disclaimer", () => {
    fc.assert(
      fc.property(rulesArb, (rules) => {
        const report = buildReport("https://addon.example.com/mcp", rules);
        const lines = formatReport(report).split("\n");
        expect(lines[0]).toMatch(new RegExp(`^${report.verdict}: https://addon.example.com/mcp \\(${report.failCount} failed, `));
        expect(lines.at(-1)).toBe(DISCLAIMER);
        const ruleLines = lines.slice(2, -2);
        expect(ruleLines).toHaveLength(rules.length);
        const order = ruleLines.map((line) => STATUSES.indexOf(line.slice(0, 4) as RuleStatus));
        expect(order).toEqual([...order].sort((a, b) => a - b));
        // Within a status, rules keep the order they were checked in.
        for (const status of STATUSES) {
          const printed = ruleLines.filter((line) => line.startsWith(status)).map((line) => line.slice(6).trimStart());
          const expected = rules.filter((r) => r.status === status).map((r) => `${r.id.padEnd(5)}  ${r.title}: ${r.notes}`.trimStart());
          expect(printed).toEqual(expected);
        }
      }),
    );
  });

  it("reads like this", () => {
    const rule = (id: string, status: RuleStatus, notes: string): RuleResult => ({
      id,
      category: "mcp-data",
      title: `Rule ${id}`,
      status,
      notes,
      source: { title: "t", url: "https://example.com", quote: "q" },
    });
    const report = buildReport("https://addon.example.com/mcp", [
      rule("DL-01", "PASS", "Fine."),
      rule("DL-04", "WARN", "Slow-ish."),
      rule("DL-06", "FAIL", "Broken."),
      rule("DL-08", "SKIP", "No screens."),
    ]);
    expect(formatReport(report)).toBe(
      [
        "NOT_READY: https://addon.example.com/mcp (1 failed, 1 warning, 1 passed, 1 skipped)",
        "",
        "FAIL  DL-06  Rule DL-06: Broken.",
        "WARN  DL-04  Rule DL-04: Slow-ish.",
        "PASS  DL-01  Rule DL-01: Fine.",
        "SKIP  DL-08  Rule DL-08: No screens.",
        "",
        DISCLAIMER,
      ].join("\n"),
    );
  });
});

describe("the rules' sources", () => {
  // The doc writes quotation marks inside quotes as \", which Markdown shows as ".
  const doc = readFileSync(new URL("../docs/alexa-requirements.md", import.meta.url), "utf8").replaceAll('\\"', '"');
  const rules = Object.values(RULES);

  it.each(rules.map((rule) => [rule.id, rule] as const))("%s quotes Amazon's words exactly as the doc has them", (_, rule) => {
    expect(doc).toContain(rule.source.quote);
    expect(doc).toContain(`[${rule.source.title}](${rule.source.url})`);
  });

  it("has unique ids, in order, whose prefixes match their categories", () => {
    const ids = rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const prefixes: Record<string, RuleCategory> = { DL: "mcp-data", AU: "auth", PK: "package" };
    for (const rule of rules) expect(prefixes[rule.id.slice(0, 2)]).toBe(rule.category);
    for (const prefix of Object.keys(prefixes)) {
      const numbers = ids.filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(3)));
      expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    }
  });
});

describe("the house style", () => {
  // Built from its code point so this file doesn't contain the character it looks for.
  const EM_DASH = String.fromCharCode(0x2014);

  it("has no em dashes in the check, link, their tests or their fixtures", () => {
    const files = [
      ...readdirSync(new URL("../src/check/", import.meta.url)).map((f) => new URL(`../src/check/${f}`, import.meta.url)),
      ...readdirSync(new URL("../src/link/", import.meta.url)).map((f) => new URL(`../src/link/${f}`, import.meta.url)),
      ...readdirSync(new URL("./", import.meta.url))
        .filter((f) => f.startsWith("check") || f.startsWith("link") || f === "fakes.ts" || f === "fake-auth.ts")
        .map((f) => new URL(`./${f}`, import.meta.url)),
      new URL("./fixtures/addon.json", import.meta.url),
    ];
    for (const file of files) expect(readFileSync(file, "utf8"), file.pathname).not.toContain(EM_DASH);
  });
});

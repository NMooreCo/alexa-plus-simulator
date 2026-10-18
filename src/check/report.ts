import { DISCLAIMER, type ReadinessReport, type RuleResult, type RuleStatus, VERSION, type Verdict } from "../shared/contract.ts";

export { VERSION };

/** Like the Local Inspector's verdicts: any failure fails, warnings make it conditional, skips don't count. */
export function verdictOf(rules: RuleResult[]): Verdict {
  if (rules.some((rule) => rule.status === "FAIL")) return "NOT_READY";
  if (rules.some((rule) => rule.status === "WARN")) return "CONDITIONAL";
  return "READY";
}

export function buildReport(
  serverUrl: string,
  rules: RuleResult[],
  options: { version?: string; checkedAt?: Date } = {},
): ReadinessReport {
  const count = (status: RuleStatus) => rules.filter((rule) => rule.status === status).length;
  return {
    tool: "alexa-plus-simulator",
    version: options.version ?? VERSION,
    serverUrl,
    checkedAt: (options.checkedAt ?? new Date()).toISOString(),
    verdict: verdictOf(rules),
    passCount: count("PASS"),
    failCount: count("FAIL"),
    warnCount: count("WARN"),
    skipCount: count("SKIP"),
    rules,
    disclaimer: DISCLAIMER,
  };
}

const ORDER: RuleStatus[] = ["FAIL", "WARN", "PASS", "SKIP"];

/** A terminal summary: the verdict, then one line per rule with what needs fixing first. */
export function formatReport(report: ReadinessReport): string {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const counts = [
    `${report.failCount} failed`,
    plural(report.warnCount, "warning"),
    `${report.passCount} passed`,
    `${report.skipCount} skipped`,
  ].join(", ");
  const lines = [`${report.verdict}: ${report.serverUrl} (${counts})`, ""];
  // Array.prototype.sort is stable, so rules keep their order within a status.
  const rules = [...report.rules].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const width = Math.max(5, ...rules.map((rule) => rule.id.length));
  for (const rule of rules) lines.push(`${rule.status.padEnd(4)}  ${rule.id.padEnd(width)}  ${rule.title}: ${rule.notes}`);
  lines.push("", report.disclaimer);
  return lines.join("\n");
}

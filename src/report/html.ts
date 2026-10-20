import { dirname, relative, sep } from "node:path";
import { DEVICES, type ReadinessReport, type RuleCategory } from "../shared/contract.ts";

/**
 * The readiness report as one HTML page to keep or share: the verdict, every
 * rule with the requirement it checks, and the screenshots (check --html).
 * Self-contained but for the screenshots, which it links relative to itself.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CATEGORIES: [RuleCategory, string][] = [
  ["mcp-data", "Data layer"],
  ["auth", "Sign-in"],
  ["visual", "Screens"],
  ["package", "Package"],
];
const ORDER = { FAIL: 0, WARN: 1, PASS: 2, SKIP: 3 } as const;

/** The page, for writing at `htmlPath` (screenshots are linked relative to it). */
export function htmlReport(report: ReadinessReport, htmlPath: string): string {
  const base = dirname(htmlPath);
  const link = (path: string) => relative(base, path).split(sep).map(encodeURIComponent).join("/");
  const deviceName = (id: string) => DEVICES.find((d) => d.id === id)?.name ?? id;

  const sections = CATEGORIES.map(([category, title]) => {
    const rules = report.rules.filter((r) => r.category === category).sort((a, b) => ORDER[a.status] - ORDER[b.status]);
    if (!rules.length) return "";
    const items = rules
      .map(
        (r) => `<li>
  <span class="status ${r.status.toLowerCase()}">${r.status}</span> <span class="id">${esc(r.id)}</span> <strong>${esc(r.title)}</strong>
  <p>${esc(r.notes)}</p>
  <details><summary>Amazon's requirement</summary><blockquote>${esc(r.source.quote)}</blockquote><a href="${esc(r.source.url)}">${esc(r.source.title)}</a></details>
</li>`,
      )
      .join("\n");
    return `<section><h2>${title}</h2><ul class="rules">${items}</ul></section>`;
  }).join("\n");

  const shots = report.artifacts?.filter((a) => a.kind === "screenshot") ?? [];
  const byScreen = new Map<string, typeof shots>();
  for (const s of shots) byScreen.set(s.uri, [...(byScreen.get(s.uri) ?? []), s]);
  const gallery = byScreen.size
    ? `<section><h2>Screenshots</h2>${[...byScreen.entries()]
        .map(
          ([uri, list]) => `<h3>${esc(list[0]!.tool)} <code>${esc(uri)}</code></h3>
<div class="shots">${list.map((s) => `<figure><a href="${esc(link(s.path))}"><img src="${esc(link(s.path))}" alt="${esc(`${s.tool} on the ${deviceName(s.device)}`)}" loading="lazy"></a><figcaption>${esc(deviceName(s.device))}</figcaption></figure>`).join("")}</div>`,
        )
        .join("\n")}</section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alexa+ readiness: ${esc(report.serverUrl)}</title>
<style>
:root { --bg: #f6f8f9; --panel: #fff; --ink: #172026; --muted: #5d6870; --line: #d7dde1; --pass: #1e8a4c; --warn: #a86400; --fail: #c23b2b; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #0e1113; --panel: #161a1d; --ink: #edf0f2; --muted: #9aa3aa; --line: #2b3237; --pass: #6fcf97; --warn: #f2b65a; --fail: #f2786a; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { margin: 0 0 4px; font-size: 24px; }
h2 { margin: 28px 0 8px; font-size: 18px; }
h3 { margin: 18px 0 8px; font-size: 15px; }
code { font: 13px ui-monospace, Consolas, monospace; color: var(--muted); overflow-wrap: anywhere; }
.meta, .disclaimer { color: var(--muted); }
.verdict { display: inline-block; margin: 12px 0 4px; font-size: 22px; font-weight: 700; }
.verdict.ready { color: var(--pass); } .verdict.conditional { color: var(--warn); } .verdict.not_ready { color: var(--fail); }
.rules { list-style: none; margin: 0; padding: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
.rules li { padding: 10px 14px; border-bottom: 1px solid var(--line); }
.rules li:last-child { border-bottom: 0; }
.rules p { margin: 4px 0; }
.status { display: inline-block; min-width: 44px; font-size: 12px; font-weight: 700; }
.status.pass { color: var(--pass); } .status.warn { color: var(--warn); } .status.fail { color: var(--fail); } .status.skip { color: var(--muted); }
.id { color: var(--muted); font-size: 12px; margin-right: 4px; }
blockquote { margin: 6px 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted); }
summary { cursor: pointer; color: var(--muted); font-size: 13px; }
a { color: inherit; }
.shots { display: flex; flex-wrap: wrap; gap: 14px; align-items: flex-start; }
figure { margin: 0; width: min(340px, 100%); }
figure img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: 8px; background: #000; }
figcaption { margin-top: 4px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>Alexa+ readiness</h1>
<p class="meta"><code>${esc(report.serverUrl)}</code> · checked ${esc(new Date(report.checkedAt).toUTCString())} · alexa-plus-simulator ${esc(report.version)}</p>
<div class="verdict ${report.verdict.toLowerCase()}">${esc(report.verdict.replace("_", " "))}</div>
<p class="meta">${report.passCount} passed, ${report.warnCount} warnings, ${report.failCount} failed, ${report.skipCount} skipped</p>
<p class="disclaimer">${esc(report.disclaimer)}</p>
${sections}
${gallery}
</main>
</body>
</html>
`;
}

import { readFile } from "node:fs/promises";
import type { ReadinessReport } from "../../src/shared/contract.ts";
import { EXAMPLE, SIMULATOR } from "./addresses.ts";
import { expect, openSimulator, test } from "./support.ts";

test("the Readiness tab checks the example, finds it READY, and saves the report", async ({ page }) => {
  await openSimulator(page, SIMULATOR.page);
  await page.getByRole("tab", { name: "Readiness" }).click();
  await page.getByRole("button", { name: "Run the readiness check" }).click();

  const verdict = page.locator(".verdict");
  await expect(verdict.locator("strong")).toHaveText("READY");
  await expect(verdict.locator(".meta")).toHaveText(/^\d+ passed, 0 warnings, 0 failed, \d+ skipped$/);
  const protocol = page.locator(".rules li").filter({ hasText: "DL-02" });
  await expect(protocol.locator(".status-chip")).toHaveText("PASS");
  await expect(protocol).toContainText("2025-03-26");
  await expect(page.getByRole("button", { name: "Run the readiness check again" })).toBeEnabled();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save readiness-report.json" }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe("readiness-report.json");
  const report = JSON.parse(await readFile(await saved.path(), "utf8")) as ReadinessReport;
  expect(report).toMatchObject({ tool: "alexa-plus-simulator", serverUrl: EXAMPLE, verdict: "READY", failCount: 0, warnCount: 0 });
  expect(report.rules.map((r) => r.id)).toEqual(expect.arrayContaining(["DL-01", "DL-02", "DL-04", "DL-08"]));
});

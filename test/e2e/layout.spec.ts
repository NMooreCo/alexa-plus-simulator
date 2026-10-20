import type { Page } from "@playwright/test";
import { SIMULATOR } from "./addresses.ts";
import { callTool, expect, openSimulator, screenOf, test } from "./support.ts";

/** How far the page scrolls sideways: 0 when everything fits the width. */
function sidewaysScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test.describe("at a phone's width", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test("the page has no horizontal scroll, with the widest screen up and on every tab", async ({ page }) => {
    await openSimulator(page, SIMULATOR.page, "show-15");
    await callTool(page, "show_tasks");
    await expect(screenOf(page).getByRole("heading", { name: "Tasks" })).toBeVisible();
    expect(await sidewaysScroll(page)).toBe(0);

    for (const tab of ["Conversation", "Traffic", "Tools", "Readiness", "Server"]) {
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
      expect(await sidewaysScroll(page), `the ${tab} tab`).toBe(0);
    }
    // An exchange opened up, with its long lines of JSON.
    await page.getByRole("tab", { name: /^Traffic/ }).click();
    await page.locator("#traffic-log > li").first().getByText("Request and response").click();
    expect(await sidewaysScroll(page), "an open exchange").toBe(0);
  });
});

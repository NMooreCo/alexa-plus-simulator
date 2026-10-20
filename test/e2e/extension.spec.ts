import { PLAIN_SIMULATOR } from "./addresses.ts";
import { expect, openSimulator, test } from "./support.ts";

test("an extension from --extension (examples/extensions/clock.js) changes the idle clock", async ({ page }) => {
  // A fixed morning in the tests' time zone, so the clock reads the same whenever the tests run.
  await page.clock.install({ time: new Date("2026-10-20T09:00:00-06:00") });
  await openSimulator(page, PLAIN_SIMULATOR.page);
  const clock = page.locator("#idle-clock");
  await expect(clock).toHaveText("9:00 AM");

  // The extension's control, in the panel's footer.
  await page.getByLabel("Pretend it's").fill("18:30");
  const latest = page.locator("#talk-log > li").first();
  await expect(latest.locator(".who")).toHaveText("page");
  await expect(latest.locator(".what")).toHaveText("The assistant now hears it's 18:30.");

  // The idle clock reads the time every 15 seconds.
  await page.clock.fastForward(15_000);
  await expect(clock).toHaveText("6:30 PM");
});

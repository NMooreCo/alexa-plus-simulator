import type { Locator } from "@playwright/test";
import { SIMULATOR } from "./addresses.ts";
import { callExample, callTool, expect, openSimulator, screenOf, test, unique } from "./support.ts";

/** The screen's size in CSS pixels, as the screen itself lays out (before the page scales it to fit). */
function sizeOf(frame: Locator) {
  return frame.evaluate((f: HTMLIFrameElement) => `${f.clientWidth} x ${f.clientHeight}`);
}

test("the screen theme reaches the screen", async ({ page }) => {
  await openSimulator(page, SIMULATOR.page);
  await callTool(page, "show_tasks");
  const screen = screenOf(page).locator("html");
  await expect(screen).toHaveAttribute("data-theme", "dark");
  await page.getByRole("combobox", { name: "Screen theme" }).selectOption("light");
  await expect(screen).toHaveAttribute("data-theme", "light");
});

test("switching devices resizes the screen, the Dot has none, and a Show brings the last screen back fresh", async ({ page }) => {
  await openSimulator(page, SIMULATOR.page);
  await callTool(page, "show_tasks");
  await expect(screenOf(page).getByRole("heading", { name: "Tasks" })).toBeVisible();
  const device = page.getByRole("combobox", { name: "Device", exact: true });
  const frame = page.locator("#app-host iframe");
  const surface = page.locator("#surface");

  await device.selectOption("show-5");
  await expect(surface).toHaveText('Small surface (10" and below), 960 x 480');
  await expect.poll(() => sizeOf(frame)).toBe("960 x 480");

  await device.selectOption("show-15");
  await expect(surface).toHaveText('Large surface (11" and above), 1920 x 1080');
  await expect.poll(() => sizeOf(frame)).toBe("1920 x 1080");

  await device.selectOption("dot");
  await expect(surface).toHaveText("Voice only");
  await expect(frame).toHaveCount(0);
  await expect(page.locator("#screen")).toBeHidden();

  // While it's a Dot, the list changes somewhere else.
  const task = `Return the library books ${unique()}`;
  await callExample("add_task", { text: task });

  await device.selectOption("show-8");
  await expect(surface).toHaveText('Small surface (10" and below), 1280 x 800');
  await expect(screenOf(page).getByText(task)).toBeVisible();
  expect(await sizeOf(frame)).toBe("1280 x 800");
});

import { SITE } from "./addresses.ts";
import { callTool, expect, screenOf, test, trafficLog } from "./support.ts";

// Pages of the tests' own site (servers/site.mjs) that host the simulator as a library, with no CLI and no proxy.

test("hosted in a page of its own, the library records its own traffic and runs the readiness check in the browser", async ({ page }) => {
  await page.goto(`${SITE}/hosted.html`);
  await expect(page.getByRole("status")).toHaveText("Connected to tasks-example 0.1.0: 3 tools, 1 screen.");
  await callTool(page, "show_tasks");
  await expect(screenOf(page).getByRole("heading", { name: "Tasks" })).toBeVisible();

  await page.getByRole("tab", { name: /^Traffic/ }).click();
  await expect(page.locator("#budget-note")).toHaveText("Every MCP request this page makes. Alexa+ asks for a round trip under 500 ms.");
  // The page knows who made each request: the page connecting and reading the screen, you from the Tools tab.
  await expect
    .poll(async () => (await trafficLog(page)).map((e) => `${e.who}: ${e.what}`).sort())
    .toEqual(["page: initialize", "page: notifications/initialized", "page: resources/read ui://tasks/list", "page: tools/list", "you: tools/call show_tasks"]);
  for (const entry of await trafficLog(page)) expect(entry.meta).toMatch(/^20[02] · \d+ ms/);

  await page.getByRole("tab", { name: "Readiness" }).click();
  await expect(page.locator("#check-about")).toContainText("from your browser");
  await page.getByRole("button", { name: "Run the readiness check" }).click();
  await expect(page.locator(".verdict strong")).toHaveText("READY");
  await expect(page.locator(".verdict .meta")).toHaveText(/^\d+ passed, 0 warnings, 0 failed, \d+ skipped$/);
});

test.describe("a screen that loads something it didn't declare", () => {
  // The browser logs what the screen's policy blocked too, worded differently from one version to the next.
  test.use({ consoleErrors: [/Content Security Policy directive: "img-src /] });

  test("gets a plain error in the log, and the image stays out", async ({ page }) => {
    await page.goto(`${SITE}/undeclared.html`);
    await expect(page.getByRole("status")).toHaveText("Connected to undeclared-picture 0.1.0: 1 tool, 1 screen.");
    await callTool(page, "show_picture");
    await expect(screenOf(page).getByRole("heading", { name: "A picture" })).toBeVisible();

    await page.getByRole("tab", { name: "Conversation" }).click();
    const error = page.locator("#talk-log > li.bad");
    await expect(error).toHaveCount(1);
    await expect(error.locator(".who")).toHaveText("error");
    await expect(error.locator(".what")).toHaveText(
      `The screen tried to load ${SITE}/picture.png (img-src) without declaring it. Add its origin to _meta.ui.csp.resourceDomains on the resource.`,
    );
    expect(await screenOf(page).getByRole("img").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(0);
  });
});

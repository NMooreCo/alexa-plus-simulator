import { rpcLabel } from "../../src/ui/lib.ts";
import { SIMULATOR, SLOW_SIMULATOR } from "./addresses.ts";
import { callTool, expect, openSimulator, proxyState, screenOf, test, trafficLog } from "./support.ts";

test("Traffic lists every exchange through the proxy, each with its request and response", async ({ page }) => {
  // The tests run one at a time, so what the proxy saw from here on is this page's.
  const since = Date.now();
  await openSimulator(page, SIMULATOR.page);
  await callTool(page, "show_tasks");
  await expect(screenOf(page).getByRole("heading", { name: "Tasks" })).toBeVisible();

  const seen = (await proxyState(SIMULATOR.state)).rpc.filter((r) => r.ts >= since);
  const labels = seen.map((r) => rpcLabel(r.method, r.params)).reverse();
  expect(labels).toEqual(expect.arrayContaining(["initialize", "notifications/initialized", "tools/list", "tools/call show_tasks", "resources/read ui://tasks/list"]));

  await page.getByRole("tab", { name: /^Traffic/ }).click();
  // Newest first, every one of them.
  await expect.poll(async () => (await trafficLog(page)).slice(0, labels.length).map((e) => e.what)).toEqual(labels);
  for (const entry of (await trafficLog(page)).slice(0, labels.length)) expect(entry.meta).toMatch(/^\d+ ms/);

  const call = page.locator("#traffic-log > li").filter({ has: page.locator(".what", { hasText: /^tools\/call show_tasks$/ }) }).first();
  await call.getByText("Request and response").click();
  const exchange = call.locator("pre");
  await expect(exchange).toContainText('"method": "tools/call"');
  await expect(exchange).toContainText('"name": "show_tasks"');
  await expect(exchange).toContainText('"structuredContent"');
  await expect(exchange).toContainText('"Pick up the dry cleaning"');
});

test("Traffic flags a slow server's calls against Alexa+'s 500 ms budget", async ({ page }) => {
  await openSimulator(page, SLOW_SIMULATOR.page);
  await page.getByRole("tab", { name: /^Traffic/ }).click();

  await expect.poll(async () => (await trafficLog(page)).map((e) => e.what)).toEqual(expect.arrayContaining(["initialize", "tools/list"]));
  const log = await trafficLog(page);
  for (const entry of log) {
    expect(entry.slow, `${entry.what} is flagged`).toBe(true);
    expect(entry.meta).toMatch(/^\d+ ms \(Alexa\+ asks for under 500 ms\)$/);
    expect(Number.parseInt(entry.meta, 10)).toBeGreaterThanOrEqual(500);
  }
  await expect(page.locator("#traffic-count")).toHaveAttribute("data-tone", "bad");
  await expect(page.locator("#budget-note")).toHaveText(`${log.length} of ${log.length} requests took 500 ms or more. Alexa+ asks for a round trip under 500 ms.`);
});

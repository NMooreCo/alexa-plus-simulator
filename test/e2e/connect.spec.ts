import { EXAMPLE, SIMULATOR } from "./addresses.ts";
import { expect, openSimulator, test, trafficLog } from "./support.ts";

test("connects the way Alexa+ does, and the Server tab names the server, not the proxy", async ({ page }) => {
  await openSimulator(page, SIMULATOR.page);
  await expect(page.getByRole("status")).toHaveText("Connected to tasks-example 0.1.0: 3 tools, 1 screen.");

  // The initialize it sent: Alexa+'s protocol version, client and capabilities.
  await page.getByRole("tab", { name: /^Traffic/ }).click();
  await expect.poll(async () => (await trafficLog(page)).map((e) => e.what)).toContain("initialize");
  const initialize = page.locator("#traffic-log > li").filter({ has: page.locator(".what", { hasText: /^initialize$/ }) }).first();
  await initialize.getByText("Request and response").click();
  const exchange = initialize.locator("pre");
  await expect(exchange).toContainText('"protocolVersion": "2025-03-26"');
  await expect(exchange).toContainText('"name": "Alexa+ MCP Client"');
  await expect(exchange).toContainText('"roots"');

  await page.getByRole("tab", { name: "Server" }).click();
  const facts = await page.locator("#server-facts").evaluate((list) =>
    Object.fromEntries([...list.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent])),
  );
  expect(facts).toEqual({
    Server: "tasks-example 0.1.0",
    Protocol: "2025-03-26 (what Alexa+ asks for)",
    Endpoint: EXAMPLE,
    Proxy: SIMULATOR.proxy,
  });
  await expect(page.locator("#server-instructions")).toHaveText(/^A household's shared to-do list\./);
});

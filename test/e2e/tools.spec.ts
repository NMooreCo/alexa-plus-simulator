import { SIMULATOR } from "./addresses.ts";
import { callExample, callTool, expect, openSimulator, proxyState, screenOf, test, unique } from "./support.ts";

test("the Tools tab fills in a tool's arguments from its schema, calls it, and puts its screen up", async ({ page }) => {
  const task = `Buy dog food ${unique()}`;
  await openSimulator(page, SIMULATOR.page);
  await page.getByRole("tab", { name: "Tools" }).click();
  await page.getByRole("combobox", { name: "Tool", exact: true }).selectOption("add_task");
  await expect(page.locator("#tool-about")).toContainText("Add a task to the to-do list.");
  // The schema's one required property, ready to fill in.
  const args = page.getByRole("textbox", { name: "Arguments (JSON)" });
  await expect(args).toHaveValue('{\n  "text": ""\n}');

  await args.fill(JSON.stringify({ text: task }));
  await page.getByRole("button", { name: "Call", exact: true }).click();
  await expect(page.locator("#tool-meta")).toHaveText(/^Done in \d+ ms$/);
  await expect(page.locator("#tool-result")).toContainText(`Added \\"${task}\\".`);
  await expect(page.locator("#tool-result")).toContainText('"structuredContent"');
  await expect(screenOf(page).getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect(screenOf(page).getByText(task)).toBeVisible();
});

test("a tap on the screen calls the server through the host, and the assistant hears what the screen did", async ({ page }) => {
  const task = `Feed the chickens ${unique()}`;
  await openSimulator(page, SIMULATOR.page);
  await callTool(page, "add_task", { text: task });

  const screen = screenOf(page);
  await screen.getByRole("button", { name: `Check off ${task}` }).click();
  await expect(screen.getByRole("button", { name: `${task}, done` })).toBeDisabled();

  // The screen has no network of its own (its policy allows none), so its call went through the page's MCP client
  // and the proxy, and reached the example.
  const done = (await callExample("show_tasks")).find((t) => t.text === task);
  expect(done).toMatchObject({ done: true });
  await expect
    .poll(async () => (await proxyState(SIMULATOR.state)).calls)
    .toContainEqual(expect.objectContaining({ tool: "complete_task", arguments: { id: done!.id }, succeeded: true }));

  await page.getByRole("tab", { name: "Conversation" }).click();
  const latest = page.locator("#talk-log > li").first();
  await expect(latest.locator(".who")).toHaveText("screen");
  await expect(latest.locator(".what")).toHaveText(`told the assistant: Checked off "${task}" on the screen.`);
});

import type { Page } from "@playwright/test";
import { PLAIN_SIMULATOR, SIMULATOR } from "./addresses.ts";
import { callTool, expect, openSimulator, screenOf, test } from "./support.ts";

const QUESTION = "What's left on my list?";
// What the stand-in for the Claude API says once it has the list (servers/fake-anthropic.mjs).
const ANSWER = "That's your list. Want me to check one off?";

/** What the speech fake (fake-speech.js) has said, and how many times listening started. */
function speech(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { e2eSaid: string[]; e2eListens: number };
    return { said: [...w.e2eSaid], listens: w.e2eListens };
  });
}

/** The Conversation log, oldest first, as "who: what" lines. */
async function conversation(page: Page): Promise<string[]> {
  const lines = await page.locator("#talk-log > li").evaluateAll((items) =>
    items.map((li) => `${li.querySelector(".who")?.textContent}: ${li.querySelector(".what")?.textContent}`),
  );
  return lines.reverse();
}

const TURN = [`you: ${QUESTION}`, "claude: chose tools", "assistant: calls show_tasks {}", "claude: answered", `alexa: ${ANSWER}`];

test("typed, the assistant calls the server's tool, its screen comes up, and the answer is said and captioned", async ({ page }) => {
  await openSimulator(page, SIMULATOR.page);
  await expect(page.locator("#model-note")).toHaveText(/^Claude \(claude-[\w.-]+\) stands in for Alexa\+'s own model/);
  await page.getByLabel("What you'd say").fill(QUESTION);
  await page.getByRole("button", { name: "Ask", exact: true }).click();

  await expect.poll(() => conversation(page)).toEqual(TURN);
  // The caption first: it goes away after ten seconds or so.
  await expect(page.locator("#caption")).toBeVisible();
  await expect(page.locator("#heard")).toHaveText(`"${QUESTION}"`);
  await expect(page.locator("#said")).toHaveText(ANSWER);
  // The model, its time and the tokens it reported (the stand-in answers as whichever model it was asked for).
  await expect(page.locator("#talk-log > li").filter({ hasText: "chose tools" }).locator(".meta")).toHaveText(/^claude-[\w.-]+ · \d+ ms · 120 in \(0 cached\), 12 out$/);
  await expect(screenOf(page).getByRole("heading", { name: "Tasks" })).toBeVisible();

  // Said aloud, then quiet: typed, its question back doesn't open the microphone.
  await expect.poll(async () => (await speech(page)).said).toEqual([ANSWER]);
  await expect(page.locator("#lightbar")).toHaveAttribute("data-state", "idle");
  expect((await speech(page)).listens).toBe(0);
  await expect(page.getByRole("button", { name: "Talk", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("asked by voice, a question back listens for the answer", async ({ page }) => {
  await openSimulator(page, SIMULATOR.page);
  await page.getByRole("button", { name: "Talk", exact: true }).click();
  await expect(page.getByRole("button", { name: "Listening", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.evaluate((words) => (window as unknown as { e2eHear(words: string): void }).e2eHear(words), QUESTION);

  await expect.poll(() => conversation(page)).toEqual(TURN);
  await expect.poll(async () => (await speech(page)).said).toEqual([ANSWER]);
  // Once the question is said, it listens again, as an Echo's follow-up mode does.
  await expect(page.locator("#lightbar")).toHaveAttribute("data-state", "listening");
  await expect(page.getByRole("button", { name: "Listening", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await speech(page)).listens).toBe(2);
});

test.describe("without a key", () => {
  // The model route refuses the turn with 503, and the browser logs the refused request.
  test.use({ consoleErrors: [/status of 503/] });

  test("talking says how to turn it on, and the Tools tab still works", async ({ page }) => {
    await openSimulator(page, PLAIN_SIMULATOR.page);
    await expect(page.locator("#model-note")).toHaveText(/talking is off.*Tools tab/);
    await page.getByLabel("What you'd say").fill(QUESTION);
    await page.getByRole("button", { name: "Ask", exact: true }).click();

    // It turns to the Tools tab, which needs no key.
    await expect(page.getByRole("tab", { name: "Tools" })).toHaveAttribute("aria-selected", "true");
    await callTool(page, "show_tasks");
    await expect(screenOf(page).getByRole("heading", { name: "Tasks" })).toBeVisible();

    // What to set to talk (the simulator runs as Anthropic's, without its key), and that the Tools tab needs none.
    await page.getByRole("tab", { name: "Conversation" }).click();
    expect(await conversation(page)).toEqual([`you: ${QUESTION}`, expect.stringMatching(/^error: .*\bANTHROPIC_API_KEY\b.*\bThe Tools tab calls tools without one\.$/)]);
    await expect(page.locator("#lightbar")).toHaveAttribute("data-state", "idle");
    expect((await speech(page)).said).toEqual([]);
  });
});

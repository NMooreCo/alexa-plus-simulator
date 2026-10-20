import { defineConfig } from "@playwright/test";
import { EXAMPLE, MODEL, PORTS, SITE, SLOW_EXAMPLE } from "./test/e2e/addresses.ts";

/**
 * The browser tests: the simulator's page in Chromium against the example
 * server, through the built CLI (pnpm test:e2e builds first). Playwright's own
 * Chromium by default; PW_CHANNEL=msedge or chrome uses an installed browser
 * instead, with nothing to download.
 */

/** The built CLI on an MCP server, on fixed ports, with any more arguments. */
function cli(upstream: string, pagePort: number, proxyPort: number, ...more: string[]): string {
  return ["node dist/server/cli.js", upstream, "--client-port", pagePort, "--server-port", proxyPort, ...more].join(" ");
}

const page = (port: number) => `http://127.0.0.1:${port}/`;

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "*.spec.ts",
  // One test at a time: they share the example's to-do list, and the readiness check calls the same tool twice
  // expecting the same answer, which a test adding a task alongside it would change.
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The HTML report keeps each failure's trace and screenshot; CI uploads it when something fails.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    browserName: "chromium",
    channel: process.env.PW_CHANNEL || undefined,
    // Wide enough that the page shows an Echo Show 8's screen (1280 x 800) at full size, not scaled down to fit.
    viewport: { width: 1900, height: 1100 },
    // A control that never shows fails its test in seconds, not at the test's timeout.
    actionTimeout: 15_000,
    // Times on the page read the same wherever the tests run; the clock test counts on it.
    timezoneId: "America/Denver",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    { name: "example", command: `node examples/tasks/server.mjs --port ${PORTS.example}`, port: PORTS.example },
    { name: "slow example", command: `node examples/tasks/server.mjs --port ${PORTS.slowExample} --slow 600`, port: PORTS.slowExample },
    { name: "fake Anthropic", command: `node test/e2e/servers/fake-anthropic.mjs --port ${PORTS.model}`, port: PORTS.model },
    { name: "site", command: `node test/e2e/servers/site.mjs --port ${PORTS.site} --example ${EXAMPLE}`, url: `${SITE}/hosted.html` },
    {
      // The simulator most tests use: talking works, through the stand-in for the Claude API.
      name: "simulator",
      command: cli(EXAMPLE, PORTS.page, PORTS.proxy, "--provider", "anthropic"),
      url: page(PORTS.page),
      env: { ANTHROPIC_API_KEY: "test", ANTHROPIC_BASE_URL: MODEL },
    },
    {
      // No model, whatever credentials the shell running the tests has (Anthropic named, without its key), and an
      // extension from the command line.
      name: "plain simulator",
      command: cli(EXAMPLE, PORTS.plainPage, PORTS.plainProxy, "--provider", "anthropic", "--extension", "examples/extensions/clock.js"),
      url: page(PORTS.plainPage),
      env: { ANTHROPIC_API_KEY: "" },
    },
    {
      // On the slow example, where every request is over the budget; no model either.
      name: "slow simulator",
      command: cli(SLOW_EXAMPLE, PORTS.slowPage, PORTS.slowProxy, "--provider", "anthropic"),
      url: page(PORTS.slowPage),
      env: { ANTHROPIC_API_KEY: "" },
    },
  ],
});

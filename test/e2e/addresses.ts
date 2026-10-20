/**
 * Where the browser tests' servers listen, for playwright.config.ts to start
 * them and the tests to reach them. The ports are fixed so a failure is easy
 * to poke at by hand, and they stay clear of the simulator's own defaults
 * (6274, 6277) and the example's (6280), so the tests can run while you use
 * the simulator. Each can be moved with an environment variable when
 * something else holds it.
 */

function port(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${name}=${value} isn't a port.`);
  return n;
}

export const PORTS = {
  /** The tasks example (examples/tasks/server.mjs). */
  example: port("E2E_EXAMPLE_PORT", 6380),
  /** The tasks example again, with --slow 600: every request over Alexa+'s 500 ms budget. */
  slowExample: port("E2E_SLOW_EXAMPLE_PORT", 6381),
  /** The stand-in for the Claude API (servers/fake-anthropic.mjs). */
  model: port("E2E_MODEL_PORT", 6382),
  /** Pages that host the simulator as a library (servers/site.mjs). */
  site: port("E2E_SITE_PORT", 6383),
  /** The simulator (the built CLI) on the example, talking through the stand-in. */
  page: port("E2E_PAGE_PORT", 6374),
  proxy: port("E2E_PROXY_PORT", 6377),
  /** The simulator without a key, with the clock extension. */
  plainPage: port("E2E_PLAIN_PAGE_PORT", 6375),
  plainProxy: port("E2E_PLAIN_PROXY_PORT", 6378),
  /** The simulator on the slow example. */
  slowPage: port("E2E_SLOW_PAGE_PORT", 6376),
  slowProxy: port("E2E_SLOW_PROXY_PORT", 6379),
};

/** The MCP servers, as the CLI is given them. */
export const EXAMPLE = `http://127.0.0.1:${PORTS.example}/mcp`;
export const SLOW_EXAMPLE = `http://127.0.0.1:${PORTS.slowExample}/mcp`;

/** ANTHROPIC_BASE_URL for the simulator that talks. */
export const MODEL = `http://127.0.0.1:${PORTS.model}`;

export const SITE = `http://127.0.0.1:${PORTS.site}`;

function simulator(pagePort: number, proxyPort: number) {
  return {
    /** The page, as the CLI prints it. */
    page: `http://localhost:${pagePort}`,
    /** The proxy, as the page knows it. */
    proxy: `http://localhost:${proxyPort}`,
    /** The proxy's record of the session, for the tests themselves (127.0.0.1 skips the IPv6 attempt "localhost" can cost). */
    state: `http://127.0.0.1:${proxyPort}/state`,
  };
}

export const SIMULATOR = simulator(PORTS.page, PORTS.proxy);
export const PLAIN_SIMULATOR = simulator(PORTS.plainPage, PORTS.plainProxy);
export const SLOW_SIMULATOR = simulator(PORTS.slowPage, PORTS.slowProxy);

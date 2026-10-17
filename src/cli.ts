import { parseArgs } from "node:util";
import { DEFAULT_CLIENT_PORT, DEFAULT_SERVER_PORT } from "./shared/contract.ts";

/**
 * alexa-plus-simulator <url> [--server-port 6277] [--client-port 6274] [--token <token>] [--verbose]
 * alexa-plus-simulator check <url> [--token <token>] [--out readiness-report.json]
 * alexa-plus-simulator validate <addon.json>
 */

const USAGE = `Usage:
  alexa-plus-simulator <mcp-url> [--server-port ${DEFAULT_SERVER_PORT}] [--client-port ${DEFAULT_CLIENT_PORT}] [--token <token>] [--verbose]
  alexa-plus-simulator check <mcp-url> [--token <token>] [--out readiness-report.json]
  alexa-plus-simulator validate <addon.json>`;

export async function main(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
  });
  if (!positionals.length) {
    console.log(USAGE);
    return 1;
  }
  console.log("Not built yet.");
  return 1;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1]?.endsWith("cli.js")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

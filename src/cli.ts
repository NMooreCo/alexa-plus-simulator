import { main } from "./run.ts";

// The bin: always runs, however it was reached (npx, a global install's symlink, or node directly).
process.exitCode = await main(process.argv.slice(2));

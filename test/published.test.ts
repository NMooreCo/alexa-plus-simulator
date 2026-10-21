import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The package as npm would publish it (pnpm check builds dist first), used
 * the way the README and the hosting guide show, from a project of someone
 * else's: TypeScript 7 (this repository's) with only the package's own types.
 */

const root = fileURLToPath(new URL("..", import.meta.url));

/** Packs the package into a folder of its own and unpacks it there, as an install would, returning where it is. */
function packed(): string {
  const dir = mkdtempSync(join(tmpdir(), "alexa-sim-packed-"));
  // The package manager running the tests (pnpm, from pnpm check), or npm.
  const runner = process.env.npm_execpath;
  const args = ["pack", "--pack-destination", dir];
  if (runner && /\.c?js$/.test(runner)) execFileSync(process.execPath, [runner, ...args], { cwd: root, stdio: "pipe" });
  else execFileSync("npm", args, { cwd: root, stdio: "pipe", shell: process.platform === "win32" });
  const tarball = readdirSync(dir).find((file) => file.endsWith(".tgz"))!;
  // A path relative to the folder, so every tar reads it as a file, whatever its drive letter.
  execFileSync("tar", ["-xzf", tarball], { cwd: dir, stdio: "pipe" });
  return join(dir, "package");
}

describe("the published package", () => {
  it("typechecks in a TypeScript project as the README uses it: the library, and its stylesheet imported for its effect", { timeout: 120_000 }, () => {
    const project = mkdtempSync(join(tmpdir(), "alexa-sim-consumer-"));
    cpSync(packed(), join(project, "node_modules", "alexa-plus-simulator"), { recursive: true });
    writeFileSync(
      join(project, "main.ts"),
      [
        'import { startSimulator } from "alexa-plus-simulator/ui";',
        'import "alexa-plus-simulator/ui/style.css";',
        "",
        'await startSimulator({ mcpUrl: "/mcp", modelUrl: "/api/model", check: "browser", extensions: [] });',
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2023",
          lib: ["ES2023", "DOM"],
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          // No vite/client, which would declare every .css import; and side-effect imports checked, as TypeScript 6 and 7 do by default.
          types: [],
          noUncheckedSideEffectImports: true,
        },
        files: ["main.ts"],
      }),
    );
    const tsc = spawnSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", project], { encoding: "utf8" });
    expect(`${tsc.stdout}${tsc.stderr}`.trim()).toBe("");
    expect(tsc.status).toBe(0);
  });
});

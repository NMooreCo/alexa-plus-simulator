// Writes THIRD-PARTY-NOTICES.md: the license of every package bundled into dist (the page, the CLI and the library),
// found by building each one in memory and reading the modules that went in. Run it after changing dependencies:
//   pnpm notices
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const configs = ["vite.config.ts", "vite.server.config.ts", "vite.lib.config.ts"];
// The configs' paths are relative to the project.
process.chdir(root);

/** The package directory a bundled module came from, or null for this project's own files. */
function packageDir(id) {
  const path = id.split("?")[0].replaceAll("\\", "/");
  const at = path.lastIndexOf("/node_modules/");
  if (at < 0 || id.startsWith("\0")) return null;
  const rest = path.slice(at + "/node_modules/".length).split("/");
  const name = rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  return path.slice(0, at + "/node_modules/".length) + name;
}

const dirs = new Set();
for (const configFile of configs) {
  await build({
    configFile: join(root, configFile),
    logLevel: "silent",
    build: { write: false },
    plugins: [
      {
        name: "list-bundled-packages",
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle)) {
            const ids = chunk.moduleIds ?? Object.keys(chunk.modules ?? {});
            for (const id of ids) {
              const dir = packageDir(id);
              if (dir) dirs.add(dir);
            }
          }
        },
      },
    ],
  });
}

const packages = [...dirs]
  .map((dir) => {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    return { name: pkg.name, version: pkg.version, license: pkg.license ?? "see its package", text: file ? readFileSync(join(dir, file), "utf8").trim() : null };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const missing = packages.filter((p) => !p.text).map((p) => p.name);
if (missing.length) throw new Error(`No license file found for ${missing.join(", ")}`);

const out = [
  "# Third-party notices",
  "",
  "The published package bundles code from these packages into `dist`. Each one's license follows.",
  "",
  ...packages.map((p) => `- ${p.name} ${p.version} (${p.license})`),
  "",
  ...packages.flatMap((p) => [`## ${p.name} ${p.version}`, "", "```", p.text, "```", ""]),
].join("\n");
writeFileSync(join(root, "THIRD-PARTY-NOTICES.md"), out);
console.log(`Wrote THIRD-PARTY-NOTICES.md: ${packages.length} packages (${packages.map((p) => p.name).join(", ")})`);

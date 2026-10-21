import { copyFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";

// The simulator's page as a library (alexa-plus-simulator/ui), built into dist/lib with what it needs bundled in,
// so a page that hosts it needs nothing else; its stylesheet goes alongside (alexa-plus-simulator/ui/style.css).

// Types for the stylesheet, which package.json's "types" condition points TypeScript at: without them, a project that
// checks side-effect imports (TypeScript 6 and later, by default) and doesn't have Vite's client types refuses the import.
const STYLE_TYPES = ["// The simulator's stylesheet, imported for its effect: there's nothing in it to import by name.", "export {};", ""].join("\n");

export default defineConfig({
  build: {
    lib: { entry: "src/ui/simulator.ts", formats: ["es"], fileName: () => "simulator.js" },
    outDir: "dist/lib",
    emptyOutDir: true,
    copyPublicDir: false,
  },
  plugins: [
    {
      name: "copy-style",
      closeBundle() {
        copyFileSync("src/ui/style.css", "dist/lib/style.css");
        writeFileSync("dist/lib/style.css.d.ts", STYLE_TYPES);
      },
    },
  ],
});

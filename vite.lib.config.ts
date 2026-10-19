import { copyFileSync } from "node:fs";
import { defineConfig } from "vite";

// The simulator's page as a library (alexa-plus-simulator/ui), built into dist/lib with what it needs bundled in,
// so a page that hosts it needs nothing else; its stylesheet goes alongside (alexa-plus-simulator/ui/style.css).
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
      },
    },
  ],
});

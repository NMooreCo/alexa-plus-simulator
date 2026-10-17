import { defineConfig } from "vite";

// The simulator's page, built into dist/ui, which the CLI serves on the client port.
export default defineConfig({
  root: "src/ui",
  base: "./",
  build: {
    outDir: "../../dist/ui",
    emptyOutDir: true,
  },
});

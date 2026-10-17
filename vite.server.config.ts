import { defineConfig } from "vite";

// The CLI (proxy, model route, readiness check), built for Node into dist/server; its dependencies stay in node_modules.
export default defineConfig({
  build: {
    ssr: "src/cli.ts",
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node22",
    rollupOptions: {
      output: { entryFileNames: "cli.js", banner: "#!/usr/bin/env node" },
    },
  },
});

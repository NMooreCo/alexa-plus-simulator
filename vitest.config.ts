import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The browser tests are Playwright's (pnpm test:e2e), whatever their files are called.
    exclude: [...configDefaults.exclude, "test/e2e/**"],
    environment: "node",
    testTimeout: 15000,
  },
});

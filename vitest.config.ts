import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.bench.ts", "src/httpapi/web/**"],
      reportsDirectory: "coverage",
      reporter: ["text", "html", "json-summary", "json"],
    },
  },
});

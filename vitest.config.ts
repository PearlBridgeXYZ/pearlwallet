import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // Fast Pearl RPC pacing/backoff for mocked-fetch tests (see file).
    setupFiles: ["tests/setup-fast-rpc.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  define: {
    __BUILD_GIT_SHA__: JSON.stringify("test"),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test drives a mocked transport. A test that reaches the network
    // is a bug in the test, not a flake to retry.
    testTimeout: 10_000,
  },
});

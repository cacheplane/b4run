import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "code-fixer",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts", "test/**/*.live.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})

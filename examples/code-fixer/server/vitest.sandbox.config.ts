import { defineConfig } from "vitest/config"
export default defineConfig({
  test: {
    name: "code-fixer-docker",
    include: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
})

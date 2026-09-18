import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "software-factory",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
  },
})

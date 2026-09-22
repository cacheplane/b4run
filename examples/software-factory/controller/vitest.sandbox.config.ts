import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "software-factory-controller-docker",
    include: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
})

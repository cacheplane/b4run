import { defineConfig } from "vitest/config"

/**
 * The opt-in lane against a real scratch repository (rung 4 spec §14): never in CI, skipped
 * unless FACTORY_TEST_GITHUB_SCRATCH and the app's credentials are set.
 */
export default defineConfig({
  test: {
    name: "software-factory-controller-github",
    include: ["test/**/*.github.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    env: { FACTORY_CONFIG: "none" },
  },
})

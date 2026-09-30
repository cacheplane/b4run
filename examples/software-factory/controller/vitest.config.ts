import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "software-factory-controller",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    setupFiles: ["test/setup-images.ts"],
    // No test, and no CLI a test spawns (it inherits this environment), reads the committed
    // factory.config.ts: the builder-handoff tests spawn the CLI without FACTORY_STATE_DIR on
    // purpose, and the config would fill it with the developer's live .factory. A test that
    // wants a config names its own.
    env: { FACTORY_CONFIG: "none" },
  },
})

import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "software-factory-controller-docker",
    include: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    globalSetup: ["test/lane-images.global.ts"],
    setupFiles: ["test/setup-lane-images.ts"],
    // No test, and no CLI a test spawns (it inherits this environment), reads the committed
    // factory.config.ts: the builder-handoff tests spawn the CLI without FACTORY_STATE_DIR on
    // purpose, and the config would fill it with the developer's live .factory. A test that
    // wants a config names its own.
    env: { FACTORY_CONFIG: "none" },
  },
})

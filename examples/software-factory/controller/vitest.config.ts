import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "software-factory-controller",
    include: ["test/**/*.test.ts"],
    // The Docker lanes run under vitest.sandbox.config.ts, the opt-in GitHub scratch lane under
    // vitest.github.config.ts: neither belongs in the unit run.
    exclude: ["test/**/*.integration.test.ts", "test/**/*.github.test.ts"],
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

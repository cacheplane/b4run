import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every suite is keyless and in-process. The one that runs the agent
    // (test/workspace-guard.test.ts) points OPENAI_BASE_URL at its own model
    // mock and sets its own timeout; each test file runs in its own process,
    // so that never reaches another file.
  },
})

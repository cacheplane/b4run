import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: resolve(rootDir, "../.."),
  resolve: {
    alias: {
      "@b4run/cli/runtime": resolve(rootDir, "../../packages/cli/src/runtime-exports.ts"),
      "@b4run/core/internal/compiler": resolve(
        rootDir,
        "../../packages/core/src/compiler/index.ts",
      ),
      // Subpath alias must precede the bare-package alias (same ordering rule
      // as @b4run/sdk/testing below).
      "@b4run/core/node": resolve(rootDir, "../../packages/core/src/node.ts"),
      "@b4run/core": resolve(rootDir, "../../packages/core/src/index.ts"),
      "@b4run/langchain": resolve(rootDir, "../../packages/langchain/src/index.ts"),
      "@b4run/langgraph": resolve(rootDir, "../../packages/langgraph/src/index.ts"),
      "@b4run/sdk/pure": resolve(rootDir, "../../packages/sdk/src/pure/index.ts"),
      "@b4run/sdk/testing": resolve(rootDir, "../../packages/sdk/src/testing/index.ts"),
      "@b4run/sdk": resolve(rootDir, "../../packages/sdk/src/index.ts"),
      "@b4run/testing": resolve(rootDir, "../../packages/testing/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    // These suites each spin up real dev servers (pnpm install + tsc + bound
    // ports + SQLite files). Running the files in parallel on a constrained CI
    // runner causes server-boot timeouts and port/disk contention. Serialize
    // them — integration parity is the goal here, not raw speed.
    fileParallelism: false,
    globalSetup: ["test/harness/registry-global-setup.ts"],
    hookTimeout: 180_000,
    include: [
      "test/runtime/run-runtime-contract.test.ts",
      "test/runtime/run-agent-protocol.test.ts",
      "test/runtime/run-tool-scope.test.ts",
      "test/runtime/run-sandbox-wiring.test.ts",
      "test/runtime/b4-testing/agent-behavior.test.ts",
    ],
    testTimeout: 240_000,
  },
})

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@b4run/core/internal/compiler": resolve(rootDir, "../core/src/compiler/index.ts"),
      "@b4run/core/node": resolve(rootDir, "../core/src/node.ts"),
      "@b4run/core": resolve(rootDir, "../core/src/index.ts"),
      "@b4run/langchain": resolve(rootDir, "../langchain/src/index.ts"),
      "@b4run/langgraph": resolve(rootDir, "../langgraph/src/index.ts"),
      // Subpath aliases MUST precede the bare package alias — vitest matches
      // string aliases by prefix in declaration order, so a leading
      // "@b4run/memory" entry would swallow "@b4run/memory/namespace".
      "@b4run/memory/namespace": resolve(rootDir, "../memory/src/namespace.ts"),
      "@b4run/memory/reconcile": resolve(rootDir, "../memory/src/reconcile.ts"),
      "@b4run/memory": resolve(rootDir, "../memory/src/index.ts"),
      "@b4run/sandbox/testing": resolve(rootDir, "../sandbox/src/testing/index.ts"),
      "@b4run/sdk/pure": resolve(rootDir, "../sdk/src/pure/index.ts"),
      "@b4run/sdk/testing": resolve(rootDir, "../sdk/src/testing/index.ts"),
      "@b4run/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@b4run/langchain": resolve(rootDir, "src/index.ts"),
      // Subpath aliases MUST precede the bare package alias — vitest matches
      // string aliases by prefix in declaration order.
      "@b4run/sdk/pure": resolve(rootDir, "../sdk/src/pure/index.ts"),
      "@b4run/sdk/testing": resolve(rootDir, "../sdk/src/testing/index.ts"),
      "@b4run/sdk": resolve(rootDir, "../sdk/src/index.ts"),
      "@b4run/workspace/node": resolve(rootDir, "../workspace/src/node.ts"),
      "@b4run/workspace": resolve(rootDir, "../workspace/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})

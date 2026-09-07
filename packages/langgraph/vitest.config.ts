import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

const rootDir = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      "@b4run/langgraph": resolve(rootDir, "src/index.ts"),
      "@b4run/langgraph/define-entry": resolve(rootDir, "src/define-entry.ts"),
      "@b4run/langgraph/route-module": resolve(rootDir, "src/route-module.ts"),
      // Subpath aliases MUST precede the bare package alias — vitest matches
      // string aliases by prefix in declaration order.
      "@b4run/sdk/pure": resolve(rootDir, "../sdk/src/pure/index.ts"),
      "@b4run/sdk": resolve(rootDir, "../sdk/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
})

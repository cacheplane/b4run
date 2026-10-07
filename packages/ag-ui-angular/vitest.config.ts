import angular from "@analogjs/vite-plugin-angular"
import { defineConfig } from "vitest/config"

const source = (path: string): string => new URL(path, import.meta.url).pathname

export default defineConfig({
  plugins: [angular({ tsconfig: "tsconfig.spec.json" })],
  resolve: {
    // The entry points import each other by package name (ng-packagr builds
    // them that way); the tests run them from source, one copy of each.
    alias: [
      { find: /^@b4run\/ag-ui-angular$/, replacement: source("./src/index.ts") },
      { find: /^@b4run\/ag-ui-angular\/events$/, replacement: source("./events/src/index.ts") },
      {
        find: /^@b4run\/ag-ui-angular\/copilotkit$/,
        replacement: source("./copilotkit/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
})

import angular from "@analogjs/vite-plugin-angular"
import { defineConfig } from "vitest/config"

const source = (path: string): string => new URL(path, import.meta.url).pathname

/**
 * The Angular kit's tests (`test/angular`), apart from the rest of the package:
 * they need Angular's compiler (the Analog plugin, on `tsconfig.angular.spec.json`)
 * and run in jsdom, while `vitest.config.ts` runs everything else.
 */
export default defineConfig({
  plugins: [angular({ tsconfig: "tsconfig.angular.spec.json" })],
  resolve: {
    // The Angular sources import the framework-free core by package name (the
    // built package resolves it to itself); the tests run it from source.
    alias: [
      { find: /^@b4run\/ag-ui\/view$/, replacement: source("./src/view/index.ts") },
      { find: /^@b4run\/ag-ui$/, replacement: source("./src/index.ts") },
    ],
  },
  test: {
    name: "@b4run/ag-ui (angular)",
    environment: "jsdom",
    include: ["test/angular/**/*.test.ts"],
    setupFiles: ["test/angular/setup.ts"],
  },
})

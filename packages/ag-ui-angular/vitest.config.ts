import angular from "@analogjs/vite-plugin-angular"
import { defineConfig } from "vitest/config"

export default defineConfig({
  plugins: [angular({ tsconfig: "tsconfig.spec.json" })],
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
})

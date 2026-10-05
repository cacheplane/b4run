import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

// The deploy-entry suite boots main.mjs against `b4 build` output, so it runs on
// its own (`npm run test:deploy`) and stays out of the keyless unit suite.
export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    environment: "node",
    include: ["deploy/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
})

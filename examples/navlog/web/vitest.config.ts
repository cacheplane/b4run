import { defineConfig } from "vitest/config"
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: { name: "navlog-web", environment: "node", include: ["app/**/*.test.{ts,tsx}"] },
})

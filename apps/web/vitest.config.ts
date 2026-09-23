import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const webRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  // `next.config.ts` keeps JSX in `preserve` for Next to compile; tests render
  // components themselves, so they need the automatic runtime.
  //
  // `jsxDev: false` because `sitemap.test.ts` stubs NODE_ENV=production and
  // re-imports the page graph: React's production `jsx-dev-runtime` exports
  // `jsxDEV = void 0`, so the `jsxDEV()` calls esbuild emits in dev mode throw
  // for any module-level JSX in that graph. Emitting `jsx`/`jsxs` from
  // `react/jsx-runtime` works because those exist in both builds.
  esbuild: { jsx: "automatic", jsxDev: false },
  resolve: {
    alias: { "server-only": "next/dist/compiled/server-only/empty" },
  },
  test: {
    name: "web",
    environment: "node",
    env: { B4_WEB_CONTENT_ROOT: resolve(webRoot, "content") },
    include: ["app/**/*.test.{ts,tsx}"],
  },
})

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compile } from "@mdx-js/mdx"
import { defineConfig, type Plugin } from "vitest/config"

// Pages import `content/*.mdx` as components; Next compiles those through
// `@next/mdx`, so tests need the same step. Element mapping is not applied.
const mdx: Plugin = {
  name: "web-mdx",
  enforce: "pre",
  async transform(code, id) {
    if (!id.endsWith(".mdx")) return null
    const file = await compile({ value: code, path: id })
    return { code: String(file), map: null }
  },
}

const webRoot = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [mdx],
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
    setupFiles: ["./vitest.setup.ts"],
  },
})

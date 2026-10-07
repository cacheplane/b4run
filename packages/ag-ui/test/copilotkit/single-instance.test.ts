import { existsSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

/**
 * A workspace app links `@b4run/ag-ui` to this package, so the connector's
 * `@copilotkit/*` imports resolve through THIS package's `node_modules`. When
 * pnpm gives the app a different peer variant of a CopilotKit package (a
 * different `zod` peer was enough), the bundle carries two copies and the
 * connector's `useAgent`/`useInterrupt` read a React context the app's
 * `<CopilotKit>` never provides. The apps pin `zod` to this package's version so
 * the variants match; this test keeps them matched.
 *
 * That is also why `zod` stays a regular dependency of `@b4run/ag-ui` although
 * no source file imports it: `@ag-ui/core` declares `zod` as an (optional)
 * peer and its `@ag-ui/core/schemas` validators, which `./client` imports, need
 * it at runtime, and pinning this version is what keeps the apps on one
 * CopilotKit copy.
 */
const packageRoot = fileURLToPath(new URL("../..", import.meta.url))
const repoRoot = join(packageRoot, "..", "..")
const consumers = ["examples/chat/web", "examples/navlog/web"] as const
const shared = ["@copilotkit/react-core", "@copilotkit/runtime", "react", "react-dom"] as const

const installed = (root: string, name: string): string | undefined => {
  const path = join(root, "node_modules", name)
  return existsSync(path) ? realpathSync(path) : undefined
}

describe("workspace apps share this package's CopilotKit copies", () => {
  for (const consumer of consumers) {
    const appRoot = join(repoRoot, consumer)
    const linked = installed(appRoot, "@b4run/ag-ui") === realpathSync(packageRoot)

    test.skipIf(!linked)(`${consumer} resolves the same copies as @b4run/ag-ui`, () => {
      for (const name of shared) {
        expect({ name, path: installed(appRoot, name) }).toEqual({
          name,
          path: installed(packageRoot, name),
        })
      }
    })
  }
})

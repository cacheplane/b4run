import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { loadEvals } from "../src/lib/runtime/load-evals.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..")

async function makeApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-evals-"))
  await writeFile(join(root, "package.json"), "{}\n")
  await writeFile(join(root, "b4.config.ts"), "export default {}\n")

  // Make `@b4run/evals` resolvable from the temp app by symlinking the
  // workspace package into the app's node_modules.
  await mkdir(join(root, "node_modules", "@b4run"), { recursive: true })
  await symlink(
    join(repoRoot, "packages", "evals"),
    join(root, "node_modules", "@b4run", "evals"),
    "dir",
  )

  const routeDir = join(root, "src", "app", "chat")
  await mkdir(join(routeDir, "evals"), { recursive: true })
  await writeFile(join(routeDir, "index.ts"), "export const agent = { invoke: async () => ({}) }\n")
  await writeFile(
    join(routeDir, "evals", "smoke.eval.ts"),
    [
      'import { defineEval, contains } from "@b4run/evals"',
      'export default defineEval({ name: "smoke", dataset: [{ input: "hi" }], scorers: [contains("hi")] })',
    ].join("\n"),
  )
  return root
}

describe("loadEvals", () => {
  it("discovers *.eval.ts, resolves the co-located route, and returns the definition", async () => {
    const root = await makeApp()
    const evals = await loadEvals({ cwd: root })
    expect(evals).toHaveLength(1)
    expect(evals[0]!.definition.name).toBe("smoke")
    expect(evals[0]!.route).toBe("/chat#agent")
    expect(evals[0]!.appRoot).toBe(root)
    expect(evals[0]!.baseDir).toBe(join(root, "src", "app", "chat", "evals"))
  })
})

import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../src")
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : []
  })

/**
 * `lib/operator/` is the operator's tooling (`up` spawns the workers by app root, `run` drives
 * the CLI); the controller APP (routes, middleware, the Factory) must never reach it, or the
 * controller would again know where its workers live.
 */
describe("the controller app does not import the operator's tooling", () => {
  it("only cli.ts and lib/operator/ import lib/operator/", () => {
    const importers = sources(SRC)
      .filter((file) => /from\s+["'][./]*(?:lib\/)?operator\//.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1))
      .filter((file) => !file.startsWith("lib/operator/"))
    expect(importers).toEqual(["cli.ts"])
  })
})

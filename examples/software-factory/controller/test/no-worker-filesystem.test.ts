import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const SRC = fileURLToPath(new URL("../src", import.meta.url))
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : []
  })
}

/**
 * The controller reaches a worker by URL and token only. No source file may open a worker's
 * installation store or read its managed volumes directly: that would put the controller back
 * on the worker's host, filesystem and Docker daemon. Comments count: one that still describes
 * reading a worker's store is stale, and is reworded rather than this test weakened. The
 * retired app-root variables are pinned by `config.test.ts`, not here.
 */
describe("the controller has no path to a worker's filesystem", () => {
  for (const pattern of [
    // The framework's managed-workspace read surface, however it is reached.
    /withManagedWorkspaceReader|openManagedWorkspaceReader/,
    /\bopenWorkspaceReader\b/,
    // A worker's installation store, statically or dynamically imported.
    /from\s+["']@b4run\/sqlite-storage["']/,
    /import\(\s*["']@b4run\/sqlite-storage["']\s*\)/,
    /openWorkspaceInstallation/,
    /\.b4\/workspaces/,
    // `@b4run/cli/workspace` is imported for `readThreadWorkspace` alone.
    /import\(\s*["']@b4run\/cli\/workspace["']\s*\)/,
  ])
    it(`no source matches ${pattern}`, () => {
      const hits = sources(SRC).filter((file) => pattern.test(readFileSync(file, "utf8")))
      expect(hits).toEqual([])
    })

  it("imports only readThreadWorkspace and its error from @b4run/cli/workspace", () => {
    const imported = sources(SRC).flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@b4run\/cli\/workspace["']/g,
        ),
      ].flatMap((match) =>
        (match[1] as string)
          .split(",")
          .map((name) => name.replace(/^\s*type\s+/, "").trim())
          .filter(Boolean),
      ),
    )
    expect(new Set(imported)).toEqual(new Set(["readThreadWorkspace", "ThreadWorkspaceReadError"]))
  })

  // target:measure's sessions are the verifier's shape on the controller's own daemon, over a
  // target's image and a fresh capture: never a worker's session.
  it("uses @b4run/sandbox only to build its own verifier's and measurement's sessions", () => {
    const users = sources(SRC)
      .filter((file) => /["']@b4run\/sandbox["']/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1))
      .sort()
    expect(users).toEqual(["lib/targets/measure/session.ts", "lib/verification/docker-verifier.ts"])
    for (const user of users)
      expect(readFileSync(join(SRC, user), "utf8")).not.toMatch(
        /software-factory-(builder|drafter)/,
      )
  })

  it("runs measurement sessions under their own scope, by a single image id", () => {
    const session = readFileSync(join(SRC, "lib/targets/measure/session.ts"), "utf8")
    expect(session).toMatch(
      /dockerSandbox\(\{\s*scope: "software-factory-measure",\s*image: options\.imageId\s*\}\)/,
    )
    expect(session).not.toMatch(/\bimages:/)
  })

  it("would catch a dynamic import of the installation store (the patterns bind)", () => {
    const probe = 'const s = await import("@b4run/sqlite-storage")'
    expect(/import\(\s*["']@b4run\/sqlite-storage["']\s*\)/.test(probe)).toBe(true)
    expect(/\bopenWorkspaceReader\b/.test("provider.workspaces.openWorkspaceReader(x)")).toBe(true)
  })
})

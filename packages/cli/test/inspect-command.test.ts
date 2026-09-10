import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resolveInspectorServer, runInspectCommand } from "../src/commands/inspect.js"

describe("resolveInspectorServer", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("returns null when @b4run/inspector is not installed", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "b4-inspect-"))
    dirs.push(appRoot)
    expect(resolveInspectorServer(appRoot)).toBeNull()
  })

  it("resolves the standalone server path from the package's b4Inspector field", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "b4-inspect-"))
    dirs.push(appRoot)
    const pkgDir = join(appRoot, "node_modules", "@b4run", "inspector")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@b4run/inspector",
        b4Inspector: { server: ".next/standalone/packages/inspector/server.js" },
      }),
    )
    expect(resolveInspectorServer(appRoot)).toBe(
      join(pkgDir, ".next/standalone/packages/inspector/server.js"),
    )
  })

  it("returns null when the package's package.json is malformed", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "b4-inspect-"))
    dirs.push(appRoot)
    const pkgDir = join(appRoot, "node_modules", "@b4run", "inspector")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "package.json"), "{ not json !!!")
    expect(resolveInspectorServer(appRoot)).toBeNull()
  })

  it("resolves through a hoisted parent node_modules when appRoot is a subdirectory", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "b4-inspect-"))
    dirs.push(workspaceRoot)
    const appRoot = join(workspaceRoot, "apps", "web")
    mkdirSync(appRoot, { recursive: true })
    const pkgDir = join(workspaceRoot, "node_modules", "@b4run", "inspector")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@b4run/inspector",
        b4Inspector: { server: ".next/standalone/packages/inspector/server.js" },
      }),
    )
    expect(resolveInspectorServer(appRoot)).toBe(
      join(pkgDir, ".next/standalone/packages/inspector/server.js"),
    )
  })

  it("returns null when the package lacks the b4Inspector field", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "b4-inspect-"))
    dirs.push(appRoot)
    const pkgDir = join(appRoot, "node_modules", "@b4run", "inspector")
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@b4run/inspector" }))
    expect(resolveInspectorServer(appRoot)).toBeNull()
  })
})

describe("runInspectCommand", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it("prints the install hint and returns when the package is absent", async () => {
    const appRoot = mkdtempSync(join(tmpdir(), "b4-inspect-"))
    dirs.push(appRoot)

    const lines: string[] = []
    await runInspectCommand({ cwd: appRoot }, { stdout: (m) => lines.push(m), stderr: () => {} })

    const output = lines.join("")
    expect(output).toContain("not installed")
    expect(output).toContain("npm i -D @b4run/inspector")
    expect(output).toContain("b4 inspect")
  })
})

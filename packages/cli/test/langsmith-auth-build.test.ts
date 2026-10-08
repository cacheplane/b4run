import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRoutes } from "@b4run/core/node"
import { afterEach, describe, expect, it } from "vitest"

import { buildTargets } from "../src/lib/build/targets/index.js"

// ---------------------------------------------------------------------------
// The langsmith target compiles src/auth.ts to `langgraph.json` `auth.path`,
// and an `ownedThreads` policy to its handlers. Everything it cannot carry is
// refused before an artifact is written.
// ---------------------------------------------------------------------------

const cliPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sdkPackageRoot = resolve(cliPackageRoot, "..", "sdk")
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

const AUTH = [
  'import { defineAuth, reject } from "@b4run/sdk"',
  "export default defineAuth({",
  "  authenticate: ({ headers }) => (headers.authorization ? { id: headers.authorization } : reject(401)),",
  "})",
  "",
].join("\n")

async function fixtureApp(files: Readonly<Record<string, string>>): Promise<string> {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "b4-langsmith-auth-")))
  cleanup.push(() => rm(appRoot, { force: true, recursive: true }))
  const appFiles: Record<string, string> = {
    "b4.config.ts": "export default {}\n",
    "package.json": '{ "name": "langsmith-auth-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": "export const graph = async () => ({ ok: true })\n",
    ...files,
  }
  for (const [relativePath, source] of Object.entries(appFiles)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  await mkdir(join(appRoot, "node_modules", "@b4run"), { recursive: true })
  await symlink(sdkPackageRoot, join(appRoot, "node_modules", "@b4run", "sdk"), "dir")
  await symlink(
    join(cliPackageRoot, "..", "testing", "node_modules", "zod"),
    join(appRoot, "node_modules", "zod"),
    "dir",
  )
  return appRoot
}

async function emit(appRoot: string, stderr: string[] = []) {
  const buildDir = join(appRoot, ".b4", "build")
  await mkdir(buildDir, { recursive: true })
  const manifest = await discoverRoutes({ appRoot })
  await buildTargets.langsmith?.emit({
    appRoot,
    buildDir,
    io: { stderr: (line: string) => stderr.push(line), stdout: () => {} },
    manifest,
  } as never)
  return buildDir
}

describe("langsmith target with src/auth.ts", () => {
  it("emits the auth adapter and points langgraph.json at it, with Studio's bypass off", async () => {
    const appRoot = await fixtureApp({ "src/auth.ts": AUTH })
    const buildDir = await emit(appRoot)
    const adapter = await readFile(join(buildDir, "auth.ts"), "utf8")
    expect(adapter).toContain('import { Auth, HTTPException } from "@langchain/langgraph-sdk/auth"')
    expect(adapter).toContain('import app from "../../src/auth.js"')
    expect(adapter).toContain("createLangSmithAuth({ Auth, HTTPException, auth: app })")
    const config = JSON.parse(await readFile(join(buildDir, "langgraph.json"), "utf8"))
    expect(config.auth).toEqual({ path: "./.b4/build/auth.ts:auth", disable_studio_auth: true })
  }, 60_000)

  it("compiles an ownedThreads policy, and warns that adminsRead cannot be expressed", async () => {
    const appRoot = await fixtureApp({
      "src/auth.ts": AUTH,
      "src/thread-access.ts":
        'import { ownedThreads } from "@b4run/sdk"\nexport default ownedThreads({ adminsRead: () => false })\n',
    })
    const stderr: string[] = []
    const buildDir = await emit(appRoot, stderr)
    const adapter = await readFile(join(buildDir, "auth.ts"), "utf8")
    expect(adapter).toContain('import threadAccess from "../../src/thread-access.js"')
    expect(adapter).toContain("auth: app, threadAccess")
    expect(stderr.join("\n")).toMatch(/adminsRead/)
  }, 60_000)

  it("refuses a hand-written thread policy", async () => {
    const appRoot = await fixtureApp({
      "src/auth.ts": AUTH,
      "src/thread-access.ts": 'export default { fallback: () => ({ decision: "allow" }) }\n',
    })
    await expect(emit(appRoot)).rejects.toMatchObject({ code: "B4_E1005" })
    await expect(emit(appRoot)).rejects.toThrow(/ownedThreads/)
  }, 60_000)

  it("refuses an auth file that compares a secret from an x-* header", async () => {
    const appRoot = await fixtureApp({
      "src/auth.ts": [
        'import { timingSafeEqual } from "node:crypto"',
        'import { defineAuth } from "@b4run/sdk"',
        "export default defineAuth({",
        '  authenticate: ({ headers }) => (timingSafeEqual(Buffer.from(headers["x-internal-token"] ?? ""), Buffer.from("s")) ? { id: "u" } : undefined),',
        "})",
        "",
      ].join("\n"),
    })
    await expect(emit(appRoot)).rejects.toThrow(/x-\*/)
  }, 60_000)

  it("refuses per-caller memory, which needs invoke-time namespaces", async () => {
    const appRoot = await fixtureApp({
      "src/auth.ts": AUTH,
      "src/app/hello/memory.ts": [
        'import { defineMemory } from "@b4run/sdk"',
        'import { z } from "zod"',
        'export default defineMemory({ kind: "semantic", scope: ["route", "user"], schema: z.object({ note: z.string() }) })',
        "",
      ].join("\n"),
    })
    await expect(emit(appRoot)).rejects.toThrow(/scopes memory by user/)
  }, 60_000)

  it("warns that middleware is not deployed", async () => {
    const appRoot = await fixtureApp({
      "src/auth.ts": AUTH,
      "src/middleware.ts": 'export default () => ({ action: "continue" })\n',
    })
    const stderr: string[] = []
    await emit(appRoot, stderr)
    expect(stderr.join("\n")).toMatch(/src\/middleware\.ts is not deployed/)
  }, 60_000)
})

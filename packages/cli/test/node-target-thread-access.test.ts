import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { discoverRoutes } from "@b4run/core/node"
import { afterEach, describe, expect, it } from "vitest"

import { runBuildCommand } from "../src/commands/build.ts"
import { runCheckCommand } from "../src/commands/check.ts"
import {
  collectRouteStaticDiscovery,
  emitModulesFile,
  type RouteStaticDiscovery,
} from "../src/lib/build/targets/modules-emitter.ts"

// ---------------------------------------------------------------------------
// The node target's thread access policy, proven against the EMITTED program.
//
// `b4 build` → `node .b4/build/server.mjs`, unmodified, in a child process —
// the exact shape the generated Dockerfile runs. A child rather than an
// in-process import because the entry point is the artifact under test: the
// defect this suite pins was a `server.mjs` that never told the runtime a
// policy existed, beside a `modules.mjs` that never carried it, so the boot
// fell back to a disk probe that answers "no policy" for a missing file and
// served every thread endpoint open.
// ---------------------------------------------------------------------------

const cliPackageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const DENY_ALL_POLICY = 'export default { fallback: () => ({ decision: "deny" }) }\n'

/** A policy that, like a real one, needs a runtime secret to even load. */
const SECRET_POLICY =
  "if (!process.env.B4_TEST_POLICY_SECRET) {\n" +
  '  throw new Error("B4_TEST_POLICY_SECRET is required to load the thread access policy")\n' +
  "}\n" +
  DENY_ALL_POLICY

const OPEN_LINE = "B4.run: no thread access policy (all thread endpoints are open)"

async function fixtureApp(files: Readonly<Record<string, string>> = {}): Promise<string> {
  // realpath: the macOS tmpdir sits behind a /var → /private/var symlink.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "b4-node-thread-access-")))
  cleanup.push(() =>
    rm(appRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    }),
  )
  const appFiles: Record<string, string> = {
    // langsmith (a default target) refuses a policy outright; this suite is
    // about the target that is supposed to carry one.
    "b4.config.ts": 'export default { build: { targets: ["node"] } }\n',
    "package.json": '{ "name": "node-thread-access-fixture", "type": "module" }\n',
    "src/app/hello/index.ts": "export const graph = async () => ({ ok: true })\n",
    ...files,
  }
  for (const [relativePath, source] of Object.entries(appFiles)) {
    const filePath = join(appRoot, relativePath)
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, source, "utf8")
  }
  // server.mjs and modules.mjs import `@b4run/cli` by package name.
  await mkdir(join(appRoot, "node_modules", "@b4run"), { recursive: true })
  await symlink(cliPackageRoot, join(appRoot, "node_modules", "@b4run", "cli"), "dir")
  return appRoot
}

async function build(appRoot: string): Promise<void> {
  await runBuildCommand({ clean: true, cwd: appRoot }, { stderr: () => {}, stdout: () => {} })
}

async function freePort(): Promise<number> {
  return await new Promise((settle, fail) => {
    const server = createServer()
    server.once("error", fail)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === "object") settle(address.port)
        else fail(new Error("no port"))
      })
    })
  })
}

type Boot =
  | {
      readonly kind: "listening"
      readonly origin: string
      readonly output: () => string
    }
  | {
      readonly kind: "exited"
      readonly code: number | null
      readonly output: string
    }

/**
 * Run `node .b4/build/server.mjs` and wait until it either answers `/healthz`
 * or exits. Both are outcomes the tests assert on: a server that refuses to
 * boot is the fail-closed result.
 */
async function startBuiltServer(
  appRoot: string,
  env: Readonly<Record<string, string>> = {},
): Promise<Boot> {
  const port = await freePort()
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") childEnv[key] = value
  }
  delete childEnv.B4_TEST_POLICY_SECRET
  Object.assign(childEnv, env, { HOST: "127.0.0.1", PORT: String(port) })

  const child: ChildProcess = spawn(process.execPath, [join(appRoot, ".b4/build/server.mjs")], {
    cwd: appRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  child.stdout?.on("data", (chunk: unknown) => {
    output += String(chunk)
  })
  child.stderr?.on("data", (chunk: unknown) => {
    output += String(chunk)
  })
  let exitCode: number | null | undefined
  const exited = new Promise<void>((done) => {
    child.once("exit", (code) => {
      exitCode = code
      done()
    })
  })
  cleanup.push(async () => {
    if (exitCode !== undefined) return
    child.kill("SIGKILL")
    await exited
  })

  const origin = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (exitCode !== undefined) {
      // Let the pipes drain so the refusal's message is in `output`.
      await new Promise((done) => setTimeout(done, 50))
      return { code: exitCode, kind: "exited", output }
    }
    try {
      const response = await fetch(`${origin}/healthz`)
      if (response.ok) return { kind: "listening", origin, output: () => output }
    } catch {
      // not listening yet
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  throw new Error(`built server neither listened nor exited within 60s. Output:\n${output}`)
}

async function createThread(origin: string): Promise<Response> {
  return await fetch(`${origin}/threads`, {
    body: JSON.stringify({ metadata: {} }),
    headers: { "content-type": "application/json" },
    method: "POST",
  })
}

describe("node target — thread access policy", () => {
  it("carries the policy in the build: the emitted server gates thread endpoints", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": DENY_ALL_POLICY,
    })
    await build(appRoot)

    const modules = await readFile(join(appRoot, ".b4/build/modules.mjs"), "utf8")
    expect(modules).toContain('import * as threadAccessModule from "../../src/thread-access.ts"')
    expect(modules).toContain("threadAccess: normalizeThreadAccessModule(threadAccessModule),")
    const server = await readFile(join(appRoot, ".b4/build/server.mjs"), "utf8")
    expect(server).toContain("threadAccessExpected: true")

    const boot = await startBuiltServer(appRoot)
    expect(boot.kind, boot.kind === "exited" ? boot.output : "").toBe("listening")
    if (boot.kind !== "listening") return
    expect((await createThread(boot.origin)).status).toBe(403)
    expect(boot.output()).not.toContain(OPEN_LINE)
  }, 120_000)

  it("refuses to boot, rather than serving open, when the policy file is gone after the build", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": DENY_ALL_POLICY,
    })
    await build(appRoot)
    await rm(join(appRoot, "src/thread-access.ts"))

    const boot = await startBuiltServer(appRoot)
    if (boot.kind === "listening") {
      const status = (await createThread(boot.origin)).status
      throw new Error(
        `the built server booted without its policy (POST /threads → ${status}). Output:\n${boot.output()}`,
      )
    }
    expect(boot.code).not.toBe(0)
    expect(boot.output).toMatch(/thread-access/)
    expect(boot.output).not.toContain(OPEN_LINE)
  }, 120_000)

  it("refuses to boot a stale manifest that predates the policy", async () => {
    const appRoot = await fixtureApp({
      "src/thread-access.ts": DENY_ALL_POLICY,
    })
    await build(appRoot)
    // A modules.mjs generated before the app grew its policy, shipped beside
    // the newer server.mjs — and the policy file absent at boot, so no disk
    // probe can paper over the mismatch.
    const manifest = await discoverRoutes({ appRoot })
    const discoveries: RouteStaticDiscovery[] = []
    for (const route of manifest.routes) {
      discoveries.push(await collectRouteStaticDiscovery({ appRoot, route }))
    }
    const buildDir = join(appRoot, ".b4/build")
    await writeFile(
      join(buildDir, "modules.mjs"),
      emitModulesFile({ appRoot, buildDir, discoveries }),
      "utf8",
    )
    await rm(join(appRoot, "src/thread-access.ts"))

    const boot = await startBuiltServer(appRoot)
    if (boot.kind === "listening") {
      const status = (await createThread(boot.origin)).status
      throw new Error(
        `the built server booted a stale manifest open (POST /threads → ${status}). Output:\n${boot.output()}`,
      )
    }
    expect(boot.code).not.toBe(0)
    expect(boot.output).toMatch(/b4 build/)
    expect(boot.output).not.toContain(OPEN_LINE)
  }, 120_000)

  it("builds without evaluating the policy, and refuses startup when the policy cannot load", async () => {
    const appRoot = await fixtureApp({ "src/thread-access.ts": SECRET_POLICY })
    // No B4_TEST_POLICY_SECRET in this process: a build must not need runtime secrets.
    expect(process.env.B4_TEST_POLICY_SECRET).toBeUndefined()
    await build(appRoot)

    const refused = await startBuiltServer(appRoot)
    if (refused.kind === "listening") {
      throw new Error(`booted with a policy that failed to load. Output:\n${refused.output()}`)
    }
    expect(refused.code).not.toBe(0)
    expect(refused.output).toContain("B4_TEST_POLICY_SECRET is required")

    const boot = await startBuiltServer(appRoot, {
      B4_TEST_POLICY_SECRET: "set",
    })
    expect(boot.kind, boot.kind === "exited" ? boot.output : "").toBe("listening")
    if (boot.kind !== "listening") return
    expect((await createThread(boot.origin)).status).toBe(403)
  }, 120_000)

  it("still builds and boots an app with no policy — open, and says so", async () => {
    const appRoot = await fixtureApp()
    await build(appRoot)

    const modules = await readFile(join(appRoot, ".b4/build/modules.mjs"), "utf8")
    expect(modules).not.toContain("threadAccess")
    const server = await readFile(join(appRoot, ".b4/build/server.mjs"), "utf8")
    expect(server).not.toContain("threadAccessExpected")

    const boot = await startBuiltServer(appRoot)
    expect(boot.kind, boot.kind === "exited" ? boot.output : "").toBe("listening")
    if (boot.kind !== "listening") return
    expect((await createThread(boot.origin)).status).toBe(200)
    expect(boot.output()).toContain(OPEN_LINE)
  }, 120_000)

  it("b4 check after a build imports the policy, and says so when it throws at import", async () => {
    // The manifest check loads modules.mjs, which now imports the policy with
    // the routes and middleware — so a policy that needs a runtime secret at
    // import fails `b4 check` without it. The message must name that cause
    // instead of only blaming a stale build a rebuild would not fix.
    const appRoot = await fixtureApp({ "src/thread-access.ts": SECRET_POLICY })
    await build(appRoot)

    const error = await runCheckCommand({ cwd: appRoot }, { stderr: () => {}, stdout: () => {} })
      .then(() => undefined)
      .catch((caught: unknown) => caught)
    expect(String(error)).toContain("B4_TEST_POLICY_SECRET is required")
    expect(String(error)).toMatch(/imports the app's modules/)
    expect(String(error)).toMatch(/environment variable/)
  }, 120_000)
})

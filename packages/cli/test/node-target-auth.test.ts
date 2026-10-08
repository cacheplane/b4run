import { type ChildProcess, spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

import { runBuildCommand } from "../src/commands/build.ts"

// ---------------------------------------------------------------------------
// The node target's src/auth.ts, proven against the EMITTED program — the same
// harness as node-target-thread-access.test.ts.
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

const sdkPackageRoot = resolve(cliPackageRoot, "..", "sdk")

/** An auth file that rejects every request without the right token. */
const TOKEN_AUTH = [
  'import { defineAuth, reject } from "@b4run/sdk"',
  "export default defineAuth({",
  "  authenticate: ({ headers }) =>",
  '    headers.authorization === "Bearer ok" ? { id: "u-1" } : reject(401, { error: "unauthorized" }),',
  "})",
  "",
].join("\n")

async function fixtureApp(files: Readonly<Record<string, string>> = {}): Promise<string> {
  // realpath: the macOS tmpdir sits behind a /var → /private/var symlink.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "b4-node-auth-")))
  cleanup.push(() =>
    rm(appRoot, {
      force: true,
      maxRetries: 5,
      recursive: true,
      retryDelay: 100,
    }),
  )
  const appFiles: Record<string, string> = {
    // This suite is about the node target; langsmith-auth-build.test.ts
    // covers the langsmith compile.
    "b4.config.ts": 'export default { build: { targets: ["node"] } }\n',
    "package.json": '{ "name": "node-auth-fixture", "type": "module" }\n',
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
  await symlink(sdkPackageRoot, join(appRoot, "node_modules", "@b4run", "sdk"), "dir")
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

async function runWait(origin: string, authorization?: string): Promise<Response> {
  return await fetch(`${origin}/threads/t-1/runs/wait`, {
    body: JSON.stringify({ input: {}, route: "/hello#graph" }),
    headers: {
      "content-type": "application/json",
      ...(authorization ? { authorization } : {}),
    },
    method: "POST",
  })
}

describe("node target — src/auth.ts", () => {
  it("carries the auth file in the build: the emitted server authenticates every request", async () => {
    const appRoot = await fixtureApp({ "src/auth.ts": TOKEN_AUTH })
    await build(appRoot)

    const modules = await readFile(join(appRoot, ".b4/build/modules.mjs"), "utf8")
    expect(modules).toContain('import * as authModule from "../../src/auth.ts"')
    expect(modules).toContain("auth: normalizeAuthModule(authModule),")
    const server = await readFile(join(appRoot, ".b4/build/server.mjs"), "utf8")
    expect(server).toContain("authExpected: true")

    const boot = await startBuiltServer(appRoot)
    expect(boot.kind, boot.kind === "exited" ? boot.output : "").toBe("listening")
    if (boot.kind !== "listening") return
    const refused = await runWait(boot.origin)
    expect(refused.status).toBe(401)
    expect(await refused.json()).toEqual({ error: "unauthorized" })
    expect((await runWait(boot.origin, "Bearer ok")).status).toBe(200)
  }, 120_000)

  it("refuses to boot, rather than serving anonymous, when the build's manifest lost its auth entry", async () => {
    const appRoot = await fixtureApp({ "src/auth.ts": TOKEN_AUTH })
    await build(appRoot)
    // A manifest from a build that predates the auth file, beside a newer entry point.
    const modulesPath = join(appRoot, ".b4/build/modules.mjs")
    const modules = await readFile(modulesPath, "utf8")
    await writeFile(
      modulesPath,
      modules.replace("  auth: normalizeAuthModule(authModule),\n", ""),
      "utf8",
    )
    const boot = await startBuiltServer(appRoot)
    expect(boot.kind).toBe("exited")
    if (boot.kind !== "exited") return
    expect(boot.code).not.toBe(0)
    expect(boot.output).toContain("carries no auth entry")
  }, 120_000)

  it("refuses to boot the built server when src/auth.ts does not default-export defineAuth", async () => {
    const appRoot = await fixtureApp({
      "src/auth.ts": "export function principalOf() { return undefined }\n",
    })
    await build(appRoot)
    const boot = await startBuiltServer(appRoot)
    expect(boot.kind).toBe("exited")
    if (boot.kind !== "exited") return
    expect(boot.output).toContain("B4_E3005")
  }, 120_000)
})

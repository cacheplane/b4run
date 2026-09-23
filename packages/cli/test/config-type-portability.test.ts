import { spawn } from "node:child_process"
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { afterEach, expect, test } from "vitest"

// `export default config({})` in b4.config.ts infers its type from
// `config()`'s return type, `B4Config`. Under pnpm's isolated layout an app
// depends only on `@b4run/cli` — `@b4run/core` sits in `.pnpm/` and is not
// resolvable from the app — so declaration emit must be able to name
// `B4Config` through `@b4run/cli` itself, or tsc reports TS2883 ("cannot be
// named without a reference to 'B4Config' from '.pnpm/@b4run+core...'").
//
// This test reproduces that layout in a temp app outside the repo (so no
// hoisted `node_modules` above it). TypeScript follows symlinks to real paths,
// and it only reports TS2883 when the real path of `@b4run/core` is itself
// inside a `node_modules` the app cannot reach. So the built declarations of
// `@b4run/cli` and `@b4run/core` are copied into a `.pnpm` store, the app's
// `node_modules/@b4run/cli` links into it, and `@b4run/core` is a sibling link
// visible only from the cli package, as pnpm arranges them.

const cliPackageRoot = resolve(import.meta.dirname, "..")
const corePackageRoot = resolve(cliPackageRoot, "../core")
const repoRoot = resolve(cliPackageRoot, "../..")
const typescriptCliPath = resolve(repoRoot, "node_modules/typescript/bin/tsc")
const nodeTypesRoot = resolve(cliPackageRoot, "node_modules/@types")
const compilerTimeoutMs = 30_000
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function createFile(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, content, "utf8")
}

test("b4.config.ts using config() typechecks when only @b4run/cli is resolvable", {
  timeout: compilerTimeoutMs + 5_000,
}, async () => {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-config-type-portability-"))
  tempDirs.push(appRoot)

  await installPnpmStyleLayout(appRoot)

  await Promise.all([
    createFile(join(appRoot, "package.json"), '{"type":"module"}\n'),
    createFile(
      join(appRoot, "b4.config.ts"),
      'import { config } from "@b4run/cli"\n\nexport default config({})\n',
    ),
    // The type is also nameable directly, for apps that annotate instead.
    createFile(
      join(appRoot, "annotated.config.ts"),
      [
        'import type { B4Config } from "@b4run/cli"',
        "",
        'const annotated: B4Config = { appDir: "src/app" }',
        "",
        "export default annotated",
        "",
      ].join("\n"),
    ),
    createFile(
      join(appRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            declaration: true,
            exactOptionalPropertyTypes: true,
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2022",
            typeRoots: [nodeTypesRoot],
            types: ["node"],
          },
          files: ["b4.config.ts", "annotated.config.ts"],
        },
        null,
        2,
      )}\n`,
    ),
  ])

  const result = await runCompiler(join(appRoot, "tsconfig.json"), appRoot)
  expect(
    result.exitCode,
    [`tsc exited with ${result.exitCode}`, `stdout:\n${result.stdout}`, `stderr:\n${result.stderr}`]
      .filter(Boolean)
      .join("\n"),
  ).toBe(0)
})

/** Copy a package's manifest and built declarations (no `node_modules`). */
async function copyPackageDeclarations(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true })
  await cp(join(from, "package.json"), join(to, "package.json"))
  await cp(join(from, "dist"), join(to, "dist"), {
    filter: (source) => !source.endsWith(".js") && !source.endsWith(".map"),
    recursive: true,
  })
}

async function linkDir(target: string, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await symlink(target, path, "dir")
}

async function installPnpmStyleLayout(appRoot: string): Promise<void> {
  const store = join(appRoot, "node_modules", ".pnpm")
  const cliStoreModules = join(store, "@b4run+cli", "node_modules")
  const coreStoreModules = join(store, "@b4run+core", "node_modules")
  const cliInStore = join(cliStoreModules, "@b4run", "cli")
  const coreInStore = join(coreStoreModules, "@b4run", "core")

  await copyPackageDeclarations(cliPackageRoot, cliInStore)
  await copyPackageDeclarations(corePackageRoot, coreInStore)
  // core's own dependencies (sdk, zod, ...) resolve from its package dir.
  await linkDir(join(corePackageRoot, "node_modules"), join(coreInStore, "node_modules"))

  // The cli's dependencies are its siblings in the store: each links to the
  // workspace install, except @b4run/core, which links to the store copy.
  const cliModules = join(cliPackageRoot, "node_modules")
  for (const entry of await readdir(cliModules)) {
    if (entry.startsWith(".")) continue
    const names = entry.startsWith("@")
      ? (await readdir(join(cliModules, entry))).map((name) => `${entry}/${name}`)
      : [entry]
    for (const name of names) {
      if (name === "@b4run/core") continue
      await linkDir(join(cliModules, name), join(cliStoreModules, name))
    }
  }
  await linkDir(coreInStore, join(cliStoreModules, "@b4run", "core"))

  // The app depends on @b4run/cli only.
  await linkDir(cliInStore, join(appRoot, "node_modules", "@b4run", "cli"))
}

async function runCompiler(
  tsconfigPath: string,
  cwd: string,
): Promise<{
  readonly exitCode: number | null
  readonly stderr: string
  readonly stdout: string
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [typescriptCliPath, "-p", tsconfigPath], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, compilerTimeoutMs)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      rejectPromise(error)
    })
    child.once("close", (exitCode) => {
      clearTimeout(timeout)
      if (timedOut) {
        rejectPromise(
          new Error(
            `tsc timed out after ${compilerTimeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        )
        return
      }
      resolvePromise({ exitCode, stderr, stdout })
    })
  })
}

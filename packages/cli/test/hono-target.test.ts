import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { discoverRoutes } from "@b4run/core/node"
import { afterEach, describe, expect, test } from "vitest"

import { runBuildCommand } from "../src/commands/build.js"
import { runCheckCommand } from "../src/commands/check.js"
import { buildTargets, DEFAULT_BUILD_TARGETS } from "../src/lib/build/targets/index.js"
import { emitWebRuntimeArtifacts } from "../src/lib/build/targets/web-runtime.js"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import {
  CLI_FETCH_STUB,
  driveEmittedStores,
  EMPTY_RUNTIME_ENV_STUB,
  FAILING_READY_STORAGE_STUB,
  HONO_STUB,
  NAMING_STORAGE_STUB,
  NO_PROXY_RUNTIME_ENV_STUB,
  writeCliFetchStub,
  writeStubPackage,
} from "./helpers/emitted-stores.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, maxRetries: 5, recursive: true })),
  )
})

async function createFixtureApp(files: Readonly<Record<string, string>> = {}) {
  // realpath: macOS puts the tmpdir behind /var → /private/var, and the module
  // loader reports real paths — keep every path on the resolved side so the
  // namespace assertions line up.
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), "b4-cli-hono-target-")))
  tempDirs.push(appRoot)

  const appFiles: Record<string, string> = {
    "b4.config.ts": 'export default { build: { targets: ["hono"] } }\n',
    // Declares every package the emitted entry imports, so the default fixture
    // builds with a genuinely silent stderr — the dependency notice is exercised
    // by the cases that deliberately drop them.
    "package.json": `${JSON.stringify({
      dependencies: {
        "@b4run/cli": "workspace:*",
        "@b4run/postgres-storage": "workspace:*",
        "@neondatabase/serverless": "^1.1.0",
        hono: "^4.12.28",
      },
      name: "hono-fixture",
    })}\n`,
    "src/app/chat/index.ts": `import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer questions.",
})
`,
    ...files,
  }

  await Promise.all(
    Object.entries(appFiles).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )

  return appRoot
}

async function runBuild(appRoot: string) {
  const stdout: string[] = []
  const stderr: string[] = []
  await runBuildCommand(
    { clean: true, cwd: appRoot },
    {
      stderr: (message) => stderr.push(message),
      stdout: (message) => stdout.push(message),
    },
  )
  // `b4 build` reports every emitted artifact as "  wrote <path>" — the only
  // channel the command exposes its artifact list on.
  const artifactPaths = stdout
    .filter((line) => line.startsWith("  wrote "))
    .map((line) => line.slice("  wrote ".length).trim())
  return { artifactPaths, artifacts: artifactPaths.map((path) => basename(path)), stderr, stdout }
}

const buildDir = (appRoot: string) => join(appRoot, ".b4", "build")
const buildFile = (appRoot: string, name: string) => join(buildDir(appRoot), name)
const readBuildFile = (appRoot: string, name: string) => readFile(buildFile(appRoot, name), "utf8")

/**
 * Decode the B4Config `app.mjs` inlines. It is emitted as
 * `JSON.parse("<json>")` rather than an object literal, so a quoted
 * `"__proto__"` config key cannot perform a prototype assignment.
 */
function inlinedConfig(entry: string): unknown {
  const match = /^const config = JSON\.parse\((".*")\)$/m.exec(entry)
  if (!match?.[1]) throw new Error(`no inlined config in:\n${entry}`)
  return JSON.parse(JSON.parse(match[1]) as string)
}

describe("b4 build — hono target", () => {
  test("emits the four edge artifacts", async () => {
    const appRoot = await createFixtureApp()

    const { artifacts, stderr } = await runBuild(appRoot)

    expect(stderr.join("")).toBe("")
    expect(artifacts).toEqual(
      expect.arrayContaining(["modules.edge.mjs", "stores.mjs", "app.mjs", "wrangler.toml"]),
    )
    for (const name of ["modules.edge.mjs", "stores.mjs", "app.mjs"]) {
      expect(existsSync(buildFile(appRoot, name))).toBe(true)
    }
    expect((await readdir(join(appRoot, ".b4", "build"))).sort()).toEqual([
      "app.mjs",
      "modules.edge.mjs",
      "stores.mjs",
    ])
    expect(existsSync(join(appRoot, ".vercel", "output"))).toBe(false)
    // wrangler.toml is the user's to keep, so it lands at the app root.
    expect(existsSync(join(appRoot, "wrangler.toml"))).toBe(true)
    // The hono target is edge-only: no node/langsmith artifacts alongside it.
    expect(existsSync(buildFile(appRoot, "server.mjs"))).toBe(false)
    expect(existsSync(buildFile(appRoot, "langgraph.json"))).toBe(false)
  })

  test("is opt-in: registered but not a default target", () => {
    expect(Object.keys(buildTargets)).toContain("hono")
    expect(DEFAULT_BUILD_TARGETS).not.toContain("hono")
  })

  test("does not create a staged runtime directory when route state cannot render statically", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/state.ts": `export default {
  parse: () => ({ startedAt: new Date(0) }),
}
`,
    })
    const manifest = await discoverRoutes({ appRoot })
    const outputDir = join(appRoot, ".vercel", ".b4-vercel-test", "runtime")

    await expect(
      emitWebRuntimeArtifacts(
        {
          appRoot,
          buildDir: join(appRoot, ".b4", "build"),
          manifest,
        },
        { outputDir, targetName: "vercel" },
      ),
    ).rejects.toThrow(/state field "startedAt".*cannot be inlined as JSON/s)
    expect(existsSync(outputDir)).toBe(false)
  })

  test("shared emitter generates Vercel-labelled runtime files relative to its staging directory", async () => {
    const appRoot = await createFixtureApp()
    const manifest = await discoverRoutes({ appRoot })
    const outputDir = join(appRoot, ".vercel", ".b4-vercel-test", "runtime")

    const runtime = await emitWebRuntimeArtifacts(
      {
        appRoot,
        buildDir: join(appRoot, ".b4", "build"),
        manifest,
      },
      { outputDir, targetName: "vercel" },
    )

    expect(runtime.artifacts).toEqual([
      join(outputDir, "modules.edge.mjs"),
      join(outputDir, "stores.mjs"),
      join(outputDir, "app.mjs"),
    ])
    for (const artifact of runtime.artifacts) expect(existsSync(artifact)).toBe(true)

    const modules = await readFile(runtime.modulesPath, "utf8")
    const stores = await readFile(runtime.storesPath, "utf8")
    const entry = await readFile(runtime.appPath, "utf8")
    for (const source of [modules, stores, entry]) {
      expect(source).toContain("Generated by b4 build (vercel target)")
    }
    expect(modules).toContain('from "../../../src/app/chat/index.ts"')
    expect(modules).not.toContain('from "../../src/app/chat/index.ts"')
    expect(modules).toContain("The Vercel deployment bundle does not use runtime filesystem")
    expect(modules).not.toContain("on an edge runtime")
    expect(stores).toMatch(/vercel target: DATABASE_URL.*Vercel project.*environment/s)
    expect(stores).not.toMatch(/Wrangler|wrangler secret|\[vars\]|worker's env/)
    expect(entry).toContain("Vercel project environment")
    expect(entry).not.toContain("set bindings with wrangler")
    expect(entry).not.toContain("no Workers env")
  })

  test("shared emitter names the Vercel deployment bundle in provider config errors", async () => {
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["vercel"] },
  summarization: { model: "some-proxy-model" },
}
`,
    })
    const manifest = await discoverRoutes({ appRoot })
    const outputDir = join(appRoot, ".vercel", ".b4-vercel-test", "runtime")

    const error = await emitWebRuntimeArtifacts(
      {
        appRoot,
        buildDir: join(appRoot, ".b4", "build"),
        manifest,
      },
      { outputDir, targetName: "vercel" },
    ).catch((caught: unknown) => caught)

    expect(String(error)).toContain("vercel target")
    expect(String(error)).toContain("Vercel deployment bundle")
    expect(String(error)).not.toContain("edge bundle")
    expect(existsSync(outputDir)).toBe(false)
  })

  test("known target name passes b4 check", async () => {
    const appRoot = await createFixtureApp()
    await expect(
      runCheckCommand({ cwd: appRoot }, { stderr: () => {}, stdout: () => {} }),
    ).resolves.toBeUndefined()
  })

  test("preserves an existing wrangler.toml", async () => {
    const appRoot = await createFixtureApp({ "wrangler.toml": "# mine\n" })

    const { stderr } = await runBuild(appRoot)

    expect(await readFile(join(appRoot, "wrangler.toml"), "utf8")).toBe("# mine\n")
    expect(stderr.join("")).toContain("wrangler.toml")
  })

  test("a rebuild recognizes its own wrangler.toml", async () => {
    const appRoot = await createFixtureApp()

    const first = await runBuild(appRoot)
    const scaffold = await readFile(join(appRoot, "wrangler.toml"), "utf8")
    const second = await runBuild(appRoot)

    // The marker is written AND read back. Without the read-back a rebuild
    // treats its own output as a stranger's: a spurious ⚠, a redundant copy in
    // .b4/build/, and — quietest — the reported artifact silently moving from
    // the app root to the build dir, so the file the operator deploys stops
    // being the one the build named.
    expect(second.stderr.join("")).toBe("")
    expect(existsSync(buildFile(appRoot, "wrangler.toml"))).toBe(false)
    // Reported paths are relative to cwd; what matters is that the wrangler.toml
    // the build names is still the app-root one, not a build-dir duplicate.
    expect(second.artifactPaths).toEqual(first.artifactPaths)
    expect(
      second.artifactPaths.some((path) => path.endsWith(join(".b4", "build", "wrangler.toml"))),
    ).toBe(false)
    // Never overwritten, marker or not: a wrangler.toml accretes bindings.
    expect(await readFile(join(appRoot, "wrangler.toml"), "utf8")).toBe(scaffold)
  })

  test("worker name starts with a letter, as Cloudflare requires", async () => {
    const appRoot = await createFixtureApp({
      "package.json": '{ "name": "123-app" }\n',
    })

    await runBuild(appRoot)

    // `123-app` sanitizes to a name wrangler rejects outright at deploy time.
    expect(await readFile(join(appRoot, "wrangler.toml"), "utf8")).toContain('name = "app"')
  })

  test("wrangler.toml scaffold carries no nodejs_compat flag", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    const wrangler = await readFile(join(appRoot, "wrangler.toml"), "utf8")
    // Spike-verified 2026-08-07: a bare name/main/compatibility_date boots the
    // handler. Adding the flag "for safety" would mask a regression in the
    // node-purge work this epic shipped.
    expect(wrangler).not.toContain("nodejs_compat")
    expect(wrangler).toContain('name = "hono-fixture"')
    expect(wrangler).toContain('main = ".b4/build/app.mjs"')
    expect(wrangler).toMatch(/^compatibility_date = "\d{4}-\d{2}-\d{2}"$/m)
  })

  test("builds stores per request, never at module scope", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    const entry = await readBuildFile(appRoot, "app.mjs")
    // A module-scope pool hangs half of all requests on workerd (spike,
    // 2026-08-07). The generated entry must pass requestStores, not instances.
    expect(entry).toContain("requestStores")
    expect(entry).not.toMatch(/^const pool = /m)

    const stores = await readBuildFile(appRoot, "stores.mjs")
    expect(stores).toContain("export async function createRequestStores")
    expect(stores).not.toMatch(/^const pool = /m)
    // The factory's whole point: a pool per invocation, closed on dispose.
    expect(stores).toContain("dispose")
    // `process` does not exist on workerd without nodejs_compat — every knob
    // must come off the per-request env binding.
    expect(stores).not.toContain("process.env")
    // `@neondatabase/serverless` vendors pg-pool AND the `events` polyfill, so
    // an idle client's failure re-emits as a pool 'error' and the shim throws
    // when nothing is listening — an uncaught exception out of a socket event,
    // not a rejected query. Per-request lifetime does not remove the exposure:
    // a client is idle between every pair of store queries, and pg-pool's idle
    // listener survives `end()`. Pinned because it is invisible until it fires.
    expect(stores).toMatch(/pool\.on\(\s*["']error["']/)
  })

  test("migrates once per isolate, not once per request", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    const stores = await readBuildFile(appRoot, "stores.mjs")
    // Per-request stores memoize migrations on the INSTANCE, so without this
    // flag every request pays three migration transactions — each taking
    // pg_advisory_xact_lock, which also serializes concurrent requests.
    expect(stores).toMatch(/^const migrated = new Set\(\)$/m)
    expect(stores).toContain("assumeMigrated")
    // That the flag is only set AFTER the migration succeeded is not asserted
    // here: a text assertion on generated code is what let the ordering rot
    // undetected (an `indexOf("ready()")` that matched the doc comment ABOVE
    // the code, so moving the assignment before the await stayed green). It is
    // covered by running the emitted file instead — see "a failed cold start
    // leaves the next request to retry the migration".
  })

  test("names the missing binding instead of building a pool with no connection string", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    expect(await readBuildFile(appRoot, "stores.mjs")).toContain("DATABASE_URL is not set")
    // A refused or unreachable database used to reach the log as
    // "[object ErrorEvent]" with no host (#689): the factory names the store
    // kind and the credential-free target, and renders the cause chain.
    const stores = await readBuildFile(appRoot, "stores.mjs")
    expect(stores).toContain("postgres store initialisation failed against")
    expect(stores).toContain("describeConnectionTarget(databaseUrl)")
    expect(stores).toContain("formatErrorChain(error)")
    expect(stores).not.toContain("String(error)")
    // The other half: a Request that never passed through the catch-all has no
    // env bound, and `?? {}` turned that into the same silent empty pool.
    expect(await readBuildFile(appRoot, "app.mjs")).toContain("no Workers env is bound")
  })

  test("app.mjs uses the same opaque appRoot namespace the manifest bakes in", async () => {
    const appRoot = await createFixtureApp()

    await runBuild(appRoot)

    const modules = await readBuildFile(appRoot, "modules.edge.mjs")
    const entry = await readBuildFile(appRoot, "app.mjs")
    const namespace = `/${basename(appRoot)}`
    expect(modules).toContain(`const appRoot = ${JSON.stringify(namespace)}`)
    expect(entry).toContain(JSON.stringify(namespace))
    // No build-machine paths in either file.
    expect(modules).not.toContain(appRoot)
    expect(entry).not.toContain(appRoot)
    expect(entry).not.toContain("node:")
    expect(modules).not.toContain("node:")
  })

  test("inlines the config minus its non-serializable fields", async () => {
    // No store handle here: a configured store is now a BUILD ERROR (see
    // "fails the build on a config-supplied store…"), because stripping it
    // silently is what let the emitted Postgres store take its place unasked.
    // Functions are still stripped — they have no such replacement.
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  memory: { enabled: true, writes: "auto" },
  summarization: { enabled: true, maxTokens: 4096, tokenCounter: (text) => text.length },
}
`,
    })

    await runBuild(appRoot)

    const entry = await readBuildFile(appRoot, "app.mjs")
    expect(inlinedConfig(entry)).toEqual({
      build: { targets: ["hono"] },
      memory: { enabled: true, writes: "auto" },
      summarization: { enabled: true, maxTokens: 4096 },
    })
    expect(entry).not.toContain("tokenCounter")
  })

  test("emits a static importer for the providers the routes actually use", async () => {
    const appRoot = await createFixtureApp({
      "src/app/claude/index.ts": `import { agent } from "@b4run/sdk"

export default agent({
  model: "claude-sonnet-4-5",
  systemPrompt: "Answer questions.",
})
`,
    })

    await runBuild(appRoot)

    const entry = await readBuildFile(appRoot, "app.mjs")
    // Static specifiers: a bundler cannot follow `import(variable)`, so the
    // map is what puts the provider packages in the edge bundle at all.
    expect(entry).toContain('import("@langchain/openai")')
    expect(entry).toContain('import("@langchain/anthropic")')
    expect(entry).not.toContain('import("@langchain/mistralai")')
    expect(entry).toContain("seedModelImporter")
  })

  test("includes the summarization model's provider, which no route declares", async () => {
    // `defaultSummarize` calls resolveProvider + createChatModel on its own, so
    // an openai-only route set with an anthropic summarization model used to
    // build green and fail at runtime on a package that was never bundled.
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  summarization: { enabled: true, model: "claude-sonnet-4-5" },
}
`,
    })

    await runBuild(appRoot)

    const entry = await readBuildFile(appRoot, "app.mjs")
    expect(entry).toContain('import("@langchain/openai")')
    expect(entry).toContain('import("@langchain/anthropic")')
  })

  test("fails the build when a route cannot be loaded, rather than narrowing the map", async () => {
    const appRoot = await createFixtureApp({
      "src/app/broken/index.ts":
        'import { nope } from "./missing-module.js"\nexport default nope\n',
    })

    const message = String(await runBuild(appRoot).catch((e: unknown) => e))

    // A skipped route contributes no provider, and the runtime's fallback then
    // advises "rebuild with `b4 build`" — which reproduces the same gap.
    expect(message).toMatch(/broken/)
    expect(existsSync(buildFile(appRoot, "app.mjs"))).toBe(false)
  })

  test("fails the build when an agent's provider cannot be determined", async () => {
    const appRoot = await createFixtureApp({
      "src/app/proxy/index.ts": `import { agent } from "@b4run/sdk"

export default agent({
  model: "some-proxy-model",
  systemPrompt: "Answer questions.",
})
`,
    })

    const message = String(await runBuild(appRoot).catch((e: unknown) => e))

    expect(message).toContain("provider")
    expect(message).toContain("proxy")
  })
})

/**
 * The edge serves an honest SUBSET of B4.run. Everything below asserts the build
 * says so BY NAME — the feature and the config key or file that introduced it —
 * instead of emitting artifacts that fail at request time in production.
 */
describe("hono target — edge capability gating", () => {
  const runCheck = async (appRoot: string) => {
    const stdout: string[] = []
    await runCheckCommand({ cwd: appRoot }, { stderr: () => {}, stdout: (m) => stdout.push(m) })
    return stdout.join("")
  }

  test("fails the build when a sandbox is configured", async () => {
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  sandbox: { provider: { name: "docker" } },
}
`,
    })

    await expect(runBuild(appRoot)).rejects.toThrow(/"hono".*sandbox.*`sandbox`/is)
  })

  test("fails the build when the app has a workspace directory", async () => {
    const appRoot = await createFixtureApp({ "workspace/notes.md": "# notes\n" })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toMatch(/workspace/)
    // Named by the path that introduced it, relative to the app root.
    expect(String(error)).toContain("workspace/")
    expect(String(error)).toMatch(/runBash|readFile/)
  })

  test("builds a route that ships skills, plan.md and memory.md, and bundles their bodies", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/memory.md": "Prefer short answers.\n",
      "src/app/chat/plan.md": "- [ ] Restate the question\n",
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nDo research.\n",
    })

    // `b4 check` applies the same (now permissive) gate — asserted BEFORE the
    // build, because afterwards check's stale-manifest pass tries to IMPORT the
    // emitted modules.edge.mjs and this fixture has no node_modules for its
    // `@b4run/cli/fetch` import to resolve through. A throw fails the test.
    await runCheck(appRoot)

    const { artifacts } = await runBuild(appRoot)

    expect(artifacts).toContain("modules.edge.mjs")
    const modules = await readBuildFile(appRoot, "modules.edge.mjs")
    expect(modules).toContain("markerFiles: Object.fromEntries([")
    expect(modules).toContain('"/src/app/chat/skills/research/SKILL.md"')
    expect(modules).toContain("Do research.")
    expect(modules).toContain('skills: ["research"]')
    expect(modules).toContain('"/src/app/chat/plan.md"')
    expect(modules).toContain('"/src/app/chat/memory.md"')
    expect(modules).toContain("Prefer short answers.")
  })

  test("fails the build, before writing artifacts, when a SKILL.md exceeds 32 KiB", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/skills/big/SKILL.md": `---\ndescription: Big.\n---\n${"x".repeat(32 * 1024)}`,
    })

    // `b4 check` applies the same limit, asserted BEFORE the build so the
    // fixture's `.b4/build` is still empty (check's stale-manifest pass would
    // otherwise import an emitted modules.edge.mjs this fixture cannot resolve).
    const checkError = await runCheck(appRoot).catch((e: unknown) => e)
    expect(String(checkError)).toContain("src/app/chat/skills/big/SKILL.md")
    expect((checkError as { code?: string }).code).toBe("B4_E1005")

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toContain("src/app/chat/skills/big/SKILL.md")
    expect(String(error)).toContain("32768-byte limit for SKILL.md")
    expect((error as { code?: string }).code).toBe("B4_E1005")

    // A half-built .b4/build looks deployable. Nothing may reach disk.
    for (const name of ["modules.edge.mjs", "stores.mjs", "app.mjs", "wrangler.toml"]) {
      expect(existsSync(buildFile(appRoot, name))).toBe(false)
    }
    expect(existsSync(join(appRoot, "wrangler.toml"))).toBe(false)
  })

  test.each(["hono", "vercel"])(
    "preflights %s marker limits before earlier node artifacts",
    async (target) => {
      const appRoot = await createFixtureApp({
        "b4.config.ts": `export default { build: { targets: ["node", "${target}"] } }\n`,
        "src/app/chat/memory.md": "x".repeat(32 * 1024 + 1),
      })
      const error = await runBuild(appRoot).catch((e: unknown) => e)
      expect((error as { code?: string }).code).toBe("B4_E1005")
      expect(existsSync(join(appRoot, ".b4"))).toBe(false)
      expect(existsSync(join(appRoot, ".vercel"))).toBe(false)
    },
  )

  test("preflights UTF-8 expansion before cleaning prior build artifacts", async () => {
    const appRoot = await createFixtureApp({
      "b4.config.ts": 'export default { build: { targets: ["node", "hono"] } }\n',
      "src/app/chat/memory.md": "",
      ".b4/build/prior.mjs": "prior build\n",
    })
    await writeFile(join(appRoot, "src/app/chat/memory.md"), Buffer.alloc(12 * 1024, 0xff))
    const error = await runBuild(appRoot).catch((e: unknown) => e)
    expect((error as { code?: string }).code).toBe("B4_E1005")
    expect(String(error)).toContain("UTF-8 re-encoding")
    expect(await readdir(join(appRoot, ".b4/build"))).toEqual(["prior.mjs"])
    expect(await readBuildFile(appRoot, "prior.mjs")).toBe("prior build\n")
  })

  test("names every oversized marker file across all routes in one failed build", async () => {
    const oversized = `---\ndescription: Big.\n---\n${"x".repeat(32 * 1024 + 1)}`
    const appRoot = await createFixtureApp({
      "src/app/chat/skills/big/SKILL.md": oversized,
      "src/app/support/index.ts": `import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "Answer questions.",
})
`,
      "src/app/support/skills/big/SKILL.md": oversized,
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    // One rejection, both offenders — a user fixing this app sees every file at
    // once instead of one route per build.
    expect(String(error)).toContain("src/app/chat/skills/big/SKILL.md")
    expect(String(error)).toContain("src/app/support/skills/big/SKILL.md")
    expect((error as { code?: string }).code).toBe("B4_E1005")

    for (const name of ["modules.edge.mjs", "stores.mjs", "app.mjs", "wrangler.toml"]) {
      expect(existsSync(buildFile(appRoot, name))).toBe(false)
    }
    expect(existsSync(join(appRoot, "wrangler.toml"))).toBe(false)
  })

  test("still fails the build for the workspace directory even when skills are present", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nDo research.\n",
      "workspace/.gitkeep": "",
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toContain("workspace/")
    expect(String(error)).not.toMatch(/skills would vanish/)
  })

  test("fails the build when a route has long-term memory", async () => {
    const appRoot = await createFixtureApp({
      "src/app/chat/memory.ts": `import { defineMemory } from "@b4run/sdk"
import { z } from "zod"

export default defineMemory({ schema: z.object({ fact: z.string() }) })
`,
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toMatch(/memory/)
    // The file that introduced it AND the config key that cannot fix it.
    expect(String(error)).toContain(join("src", "app", "chat", "memory.ts"))
    expect(String(error)).toContain("memory.store")
  })

  test("fails the build when filesystem/exec backends are configured", async () => {
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  backends: { exec: { runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } },
}
`,
    })

    const error = await runBuild(appRoot).catch((e: unknown) => e)

    expect(String(error)).toContain("backends.exec")
  })

  test("reports every unsupported feature at once, not just the first", async () => {
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  sandbox: { provider: { name: "docker" } },
}
`,
      "src/app/chat/memory.ts": `import { defineMemory } from "@b4run/sdk"
import { z } from "zod"

export default defineMemory({ schema: z.object({ fact: z.string() }) })
`,
      // Skills are served on the edge now (their bodies are bundled), so this
      // directory must contribute NOTHING to the report — it is here to prove
      // that, alongside the three features that do still fail.
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nGo.\n",
      "workspace/notes.md": "# notes\n",
    })

    const message = String(await runBuild(appRoot).catch((e: unknown) => e))

    // Fixing three build failures one build at a time is a bad experience.
    expect(message).toContain("`sandbox`")
    expect(message).toContain("workspace/")
    expect(message).toContain("memory.store")
    expect(message).not.toContain(join("src", "app", "chat", "skills"))
  })

  test("fails BEFORE emitting anything", async () => {
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  sandbox: { provider: { name: "docker" } },
}
`,
    })

    await expect(runBuild(appRoot)).rejects.toThrow()

    // A half-built .b4/build looks deployable. Nothing may reach disk.
    for (const name of ["modules.edge.mjs", "stores.mjs", "app.mjs", "wrangler.toml"]) {
      expect(existsSync(buildFile(appRoot, name))).toBe(false)
    }
    expect(existsSync(join(appRoot, "wrangler.toml"))).toBe(false)
  })

  test("does not fire for the node target", async () => {
    // Every gated feature at once — and none of it is the node target's
    // problem, so this app must keep building exactly as it does today.
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["node"] },
  sandbox: { provider: { name: "docker" } },
}
`,
      "src/app/chat/memory.ts": `import { defineMemory } from "@b4run/sdk"
import { z } from "zod"

export default defineMemory({ schema: z.object({ fact: z.string() }) })
`,
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nGo.\n",
      "workspace/notes.md": "# notes\n",
    })

    const { artifacts } = await runBuild(appRoot)

    expect(artifacts).toEqual(expect.arrayContaining(["server.mjs"]))
    expect(existsSync(buildFile(appRoot, "app.mjs"))).toBe(false)
  })

  test("b4 check mirrors the gating when hono is a configured target", async () => {
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  sandbox: { provider: { name: "docker" } },
}
`,
      // Present to prove `b4 check` mirrors the build's PERMISSIVE handling of
      // skills too: it must name the two real violations and not this directory.
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nGo.\n",
      "workspace/notes.md": "# notes\n",
    })

    const error = await runCheck(appRoot).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    const message = String(error)
    expect(message).toContain("`sandbox`")
    expect(message).toContain("workspace/")
    expect(message).not.toContain(join("src", "app", "chat", "skills"))
  })

  test("b4 check gates `toolOutput`, whose keys survive the build boundary intact", async () => {
    // The one gated feature whose config is plain JSON, so it inlines into the
    // bundle cleanly and then does nothing — the edge has no filesystem to
    // spill oversized tool output to. Gated at BUILD time as well as at request
    // time deliberately: without this the build went green and the deployed
    // worker was the thing that rejected the app.
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  toolOutput: { offloadThresholdChars: 20000 },
}
`,
    })

    const error = await runCheck(appRoot).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain("`toolOutput`")
    expect(String(error)).toContain("tool-output offloading")
  })

  test("b4 check mirrors the store-handle gating, not just the loud features", async () => {
    // The silent-divergence class — and the one `b4 check` was NOT asserted
    // for. With only sandbox/workspace/skills covered here, narrowing the config
    // handed to `assertEdgeCapabilities` to `{ backends, sandbox }` left every
    // test in the repo green; tsc could not object either, because every
    // B4Config field is optional, so a `Pick` that omits the store keys still
    // satisfies the gate's parameter type.
    for (const [key, source] of [
      ["threadsStore", "threadsStore: { listThreads: async () => [] },"],
      ["checkpointer", "checkpointer: { getTuple: async () => undefined },"],
      ["permissions.store", "permissions: { store: { load: async () => {} } },"],
      ["memory.store", "memory: { store: { recall: async () => [] } },"],
    ] as const) {
      const appRoot = await createFixtureApp({
        "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  ${source}
}
`,
      })

      const error = await runCheck(appRoot).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(Error)
      expect(String(error)).toContain(`\`${key}\``)
    }
  })

  test("b4 check mirrors the backend and route-memory gating", async () => {
    // The other two classes the build path covered alone. `backends.*` and an
    // agent route's `memory.ts` are read from different places — the config and
    // the manifest — so neither stands in for the other.
    const appRoot = await createFixtureApp({
      "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  backends: { exec: { runCommand: async () => ({ stdout: "", stderr: "", exitCode: 0 }) } },
}
`,
      "src/app/chat/memory.ts": `import { defineMemory } from "@b4run/sdk"
import { z } from "zod"

export default defineMemory({ schema: z.object({ fact: z.string() }) })
`,
    })

    const error = await runCheck(appRoot).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Error)
    const message = String(error)
    expect(message).toContain("backends.exec")
    expect(message).toContain(join("src", "app", "chat", "memory.ts"))
  })

  test("b4 check leaves a node-target app alone", async () => {
    const appRoot = await createFixtureApp({
      "b4.config.ts": 'export default { build: { targets: ["node"] } }\n',
      "src/app/chat/skills/research/SKILL.md": "---\ndescription: Research.\n---\n\nGo.\n",
      "workspace/notes.md": "# notes\n",
    })

    await expect(runCheck(appRoot)).resolves.toBeTypeOf("string")
  })

  test("names the runtime packages the emitted entry imports but the app lacks", async () => {
    const appRoot = await createFixtureApp({
      "package.json": '{ "name": "hono-fixture", "dependencies": { "@b4run/cli": "*" } }\n',
    })

    // stderr, matching the node target's own runtime-dependency ⚠. stdout is the
    // artifact report a caller parses; a warning about a deploy that will fail
    // to resolve an import does not belong in it.
    const { stderr, stdout } = await runBuild(appRoot)

    const notice = stderr.join("")
    expect(notice).toContain("@b4run/postgres-storage")
    expect(notice).toContain("@neondatabase/serverless")
    expect(notice).toContain("hono")
    expect(notice).toContain("dependencies")
    expect(stdout.join("")).not.toContain("@neondatabase/serverless")
  })

  test("says nothing when the app already depends on them", async () => {
    const appRoot = await createFixtureApp()

    const { stderr } = await runBuild(appRoot)

    expect(stderr.join("")).not.toContain("@neondatabase/serverless")
  })

  test("counts a devDependency as declared — wrangler bundles from the source tree", async () => {
    // Unlike the node image's `npm ci --omit=dev`, `wrangler deploy` resolves
    // from the tree it bundles, so a devDependency is genuinely there. Naming
    // one as missing would be a false alarm.
    const appRoot = await createFixtureApp({
      "package.json": `${JSON.stringify({
        dependencies: { "@b4run/cli": "*" },
        devDependencies: {
          "@b4run/postgres-storage": "*",
          "@neondatabase/serverless": "*",
          hono: "*",
        },
        name: "hono-fixture",
      })}\n`,
    })

    const { stderr } = await runBuild(appRoot)

    expect(stderr.join("")).toBe("")
  })

  test("fails the build on a config-supplied store instead of silently swapping it", async () => {
    for (const [key, source] of [
      ["threadsStore", "threadsStore: { listThreads: async () => [] },"],
      ["checkpointer", "checkpointer: { getTuple: async () => undefined },"],
      ["permissions.store", "permissions: { store: { load: async () => {} } },"],
      ["memory.store", "memory: { store: { recall: async () => [] } },"],
    ] as const) {
      const appRoot = await createFixtureApp({
        "b4.config.ts": `export default {
  build: { targets: ["hono"] },
  ${source}
}
`,
      })

      const message = String(await runBuild(appRoot).catch((e: unknown) => e))

      // The silent-divergence class: the handle is stripped by the serializer
      // and the emitted Postgres store takes its place with nothing said.
      expect(message).toContain(`\`${key}\``)
      expect(existsSync(buildFile(appRoot, "app.mjs"))).toBe(false)
    }
  })
})

describe("hono target — per-request env binding", () => {
  /**
   * The contract `app.mjs` leans on: the runtime hands `requestStores` the very
   * Request object it was called with, so a WeakMap keyed on `c.req.raw` is a
   * sound carrier for a per-invocation `env`. Pinned here because the generated
   * entry is otherwise driven against a stub of this factory.
   */
  test("createRuntimeFetchHandler passes requestStores the identical Request", async () => {
    const seen: Request[] = []
    const handler = await createRuntimeFetchHandler({
      appRoot: "/ns",
      modules: { routes: [] },
      requestStores: (request) => {
        seen.push(request)
        return {}
      },
    })
    // `/readyz`: the one probe that DOES build stores. `/healthz` is liveness
    // and never calls the factory (#688).
    const first = new Request("http://x/readyz")
    const second = new Request("http://x/readyz")
    await handler.fetch(first)
    await handler.fetch(second)
    await handler.close()

    expect(seen[0]).toBe(first)
    expect(seen[1]).toBe(second)
  })

  test("two requests with different env reach different databases", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // Drive the REAL emitted app.mjs, replacing only its module boundaries:
    // the manifest (data), the store factory (the thing under observation),
    // hono, and @b4run/cli/fetch. Node resolves the bare specifiers from the
    // stub packages below, which is why this runs in a child process rather
    // than through vitest's resolver.
    await writeFile(buildFile(appRoot, "modules.edge.mjs"), "export default { routes: [] }\n")
    await writeFile(
      buildFile(appRoot, "stores.mjs"),
      `export const seen = []
export function createRequestStores(env) {
  seen.push(env?.DATABASE_URL)
  return { dispose: async () => {} }
}
`,
    )
    await writeStubPackage(appRoot, "hono", HONO_STUB)
    await writeCliFetchStub(appRoot, CLI_FETCH_STUB)

    const observed = await driveEmittedApp(appRoot, [
      "postgres://one/db",
      "postgres://two/db",
      "postgres://three/db",
    ])

    // The naive sketch closes `requestStores` over the FIRST request's c.env,
    // so every later request reaches the first request's database. Three
    // requests, because the failure is invisible with one.
    expect(observed).toEqual(["postgres://one/db", "postgres://two/db", "postgres://three/db"])
  })

  test("seeds B4.run's runtime-env fallback once per isolate, from the first env", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    await writeFile(buildFile(appRoot, "modules.edge.mjs"), "export default { routes: [] }\n")
    await writeFile(
      buildFile(appRoot, "stores.mjs"),
      `export function createRequestStores() {
  return { dispose: async () => {} }
}
`,
    )
    await writeStubPackage(appRoot, "hono", HONO_STUB)
    await writeCliFetchStub(appRoot, CLI_FETCH_STUB)

    const seeded = await driveEmittedApp(
      appRoot,
      ["postgres://one/db", "postgres://two/db", "postgres://three/db"],
      {
        expression: "seededEnvs",
        imports: 'import { seededEnvs } from "@b4run/cli/fetch"',
      },
    )

    // ONCE, and with the first request's env — the counterpart of the WeakMap
    // above, not a copy of it. `seedRuntimeEnv` installs PROCESS-GLOBAL state,
    // so re-seeding it per request would let a request that is mid-await
    // observe another request's configuration. Three requests with different
    // envs is what tells "seeded once" apart from "seeded every time with the
    // same value" — the latter passes any single-request test.
    expect(seeded).toEqual([{ DATABASE_URL: "postgres://one/db" }])
  })

  test("keeps non-string bindings out of the process-global env map", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    await writeFile(buildFile(appRoot, "modules.edge.mjs"), "export default { routes: [] }\n")
    await writeFile(
      buildFile(appRoot, "stores.mjs"),
      `export function createRequestStores() {
  return { dispose: async () => {} }
}
`,
    )
    await writeStubPackage(appRoot, "hono", HONO_STUB)
    await writeCliFetchStub(appRoot, CLI_FETCH_STUB)

    // Only Workers hands the fetch handler a bindings object. `@hono/node-server`
    // — which the round-trip test boots this same entry under — passes
    // `{ incoming, outgoing }`, i.e. live Node request/response handles.
    const seeded = await driveEmittedApp(appRoot, ["postgres://one/db"], {
      envExpression: "{ DATABASE_URL: databaseUrl, incoming: new Map(), PORT: '3000' }",
      expression: "seededEnvs",
      imports: 'import { seededEnvs } from "@b4run/cli/fetch"',
    })

    expect(seeded).toEqual([{ DATABASE_URL: "postgres://one/db", PORT: "3000" }])
  })
})

describe("hono target — bindings on a host that has none", () => {
  test("falls back to the runtime env when the host passes no bindings", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // Three hosts, in the three shapes a fetch handler's second argument
    // actually takes: a Workers bindings object; `@hono/node-server`'s
    // `{ incoming, outgoing }` (Node handles, no bindings in them at all);
    // and nothing.
    const observed = await driveEmittedStores(appRoot, buildDir(appRoot), [
      { DATABASE_URL: "postgres://from-binding/db" },
      { incoming: {}, outgoing: {} },
      undefined,
    ])

    // The binding wins where there is one. Where there is not — which is EVERY
    // non-Workers host, and is why `serve({ fetch: app.fetch })` used to build
    // a pool with `connectionString: undefined` — the same value is read
    // through `readRuntimeEnv`, which prefers the process environment. That is
    // what makes the emitted entry's Workers/Vercel/Bun claim true rather than
    // aspirational, and it reintroduces no `process` global to do it.
    //
    // The proxy knob takes the same route, so a Node host can reach a local
    // wsproxy without inventing a bindings object to carry it — and it lands on
    // the connection this pool opens, which is the only place it may land.
    expect(observed).toEqual([
      {
        connectionString: "postgres://from-binding/db",
        useSecureWebSocket: false,
        wsProxy: "proxy:8080/v1?address=b4-pg:5432",
      },
      {
        connectionString: "postgres://from-runtime-env/db",
        useSecureWebSocket: false,
        wsProxy: "proxy:8080/v1?address=b4-pg:5432",
      },
      {
        connectionString: "postgres://from-runtime-env/db",
        useSecureWebSocket: false,
        wsProxy: "proxy:8080/v1?address=b4-pg:5432",
      },
    ])
  })

  test("every per-request pool gets an 'error' listener before it is used", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // `@neondatabase/serverless` vendors pg-pool, whose idle-client handler
    // re-emits the failure on the POOL, and vendors the `events` polyfill,
    // whose `emit` THROWS on an 'error' with no listener — exactly as Node's
    // does. So an idle WebSocket dropped by Neon autosuspend, a proxy, or a
    // blip raises an uncaught exception out of a socket event that no query
    // promise is awaiting, rather than rejecting a query.
    //
    // Per-request lifetime does not shrink the window: a client sits idle
    // between every pair of queries the three stores make, and pg-pool neither
    // detaches the idle listener in `_remove` nor gates the pool-level re-emit
    // on `ending`, so it can still fire after `dispose()`.
    //
    // Asserted by RUNNING the emitted file rather than grepping it, for the
    // reason recorded on the `assumeMigrated` test: a text match on generated
    // code can be satisfied by a doc comment.
    const observed = await driveEmittedStores(appRoot, buildDir(appRoot), [{}, {}], {
      report: "poolHandlers()",
      reportImports: `import { poolHandlers } from "@neondatabase/serverless"`,
    })

    // One pool per request, each carrying its own listener — not one pool that
    // happened to be listened to once.
    expect(observed).toEqual([["error"], ["error"]])
  })

  test("parses BYTEA without the deprecated Buffer constructor and delegates every other type", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    const observed = await driveEmittedStores(appRoot, buildDir(appRoot), [{}, {}], {
      report: "poolTypeParserReport()",
      reportImports: 'import { poolTypeParserReport } from "@neondatabase/serverless"',
    })

    expect(observed).toEqual({
      binaryBytea: "default:17:binary:raw",
      bytea: [0, 1, 255],
      byteaConstructor: "Uint8Array",
      defaultTypeParserCalls: [
        [17, "binary"],
        [23, "text"],
      ],
      distinctPoolTypeObjects: true,
      integer: "default:23:text:42",
      invalidBytea: ["rejected", "rejected", "rejected"],
    })
  })

  test("a request without the proxy binding still connects with TLS", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // The wsproxy switches turn TLS OFF. Written to the driver's process-wide
    // `neonConfig` — which is what this used to do, with no `else` — one request
    // carrying B4_PG_WS_PROXY would leave every LATER request in the isolate
    // talking plaintext through the previous request's proxy. That binding ships
    // in every generated stores.mjs, so setting it by accident (or by copying
    // the CI lane's config) would silently drop TLS to a production database.
    const observed = await driveEmittedStores(
      appRoot,
      buildDir(appRoot),
      [{ B4_PG_WS_PROXY: "proxy:8080" }, {}],
      {
        cliStub: NO_PROXY_RUNTIME_ENV_STUB,
      },
    )

    expect(observed).toEqual([
      {
        connectionString: "postgres://from-runtime-env/db",
        useSecureWebSocket: false,
        wsProxy: "proxy:8080/v1?address=b4-pg:5432",
      },
      // The second request asked for no proxy, so it gets the secure defaults —
      // it cannot inherit a decision the first request made.
      {
        connectionString: "postgres://from-runtime-env/db",
        useSecureWebSocket: true,
        wsProxy: null,
      },
    ])
  })

  test("B4_PG_WS_PROXY accepts a ws:// or wss:// prefix and rejects any other scheme", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // The driver wants a bare host:port and prefixes the scheme itself, so a
    // value written the way a URL is usually written (`ws://…`) used to fail
    // deep inside it with a message naming neither the variable nor the
    // format. Both spellings now reach the driver as the same address; `wss://`
    // keeps TLS on; anything else is refused up front, by name.
    const observed = await driveEmittedStores(
      appRoot,
      buildDir(appRoot),
      [
        { B4_PG_WS_PROXY: "ws://proxy:8080" },
        { B4_PG_WS_PROXY: "wss://proxy.example.com:443" },
        { B4_PG_WS_PROXY: "http://proxy:8080" },
      ],
      {
        cliStub: NO_PROXY_RUNTIME_ENV_STUB,
        report: "{ connections: poolConnections(), requestErrors }",
        tolerateRequestFailures: true,
      },
    )

    expect(observed).toEqual({
      connections: [
        {
          connectionString: "postgres://from-runtime-env/db",
          useSecureWebSocket: false,
          wsProxy: "proxy:8080/v1?address=b4-pg:5432",
        },
        {
          connectionString: "postgres://from-runtime-env/db",
          useSecureWebSocket: true,
          wsProxy: "proxy.example.com:443/v1?address=b4-pg:5432",
        },
      ],
      requestErrors: [
        expect.stringMatching(
          /B4_PG_WS_PROXY must be host:port, optionally prefixed with ws:\/\/ or wss:\/\/.*"http:\/\/proxy:8080"/,
        ),
      ],
    })
  })

  test("a failed cold start leaves the next request to retry the migration", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // The invariant `migrated` exists for: it is set only AFTER the migration
    // actually succeeded. Set it before the await and a failed cold start
    // convinces every later request in the isolate that the schema is there —
    // which it is not, so every request fails on a missing table instead.
    //
    // Three `ready()` calls per cold-start pass (threads, permissions,
    // checkpointer), so a retried pass is six and a skipped one is three.
    const observed = await driveEmittedStores(appRoot, buildDir(appRoot), [{}, {}], {
      report: "{ readyCalls: readyCalls.length, requestErrors }",
      reportImports: 'import { readyCalls } from "@b4run/postgres-storage"',
      storageStub: FAILING_READY_STORAGE_STUB,
      tolerateRequestFailures: true,
    })

    expect(observed).toEqual({ readyCalls: 6, requestErrors: ["cold start failed"] })
  })

  test("namespaces each request's stores from B4_PG_SCHEMA and B4_PG_TABLE_PREFIX", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // Four requests in one isolate: the unconfigured default, a literal schema,
    // a `$VERCEL_ENV` reference with a prefix, and the default again.
    const observed = await driveEmittedStores(
      appRoot,
      buildDir(appRoot),
      [
        {},
        { B4_PG_SCHEMA: "preview" },
        { B4_PG_SCHEMA: "$VERCEL_ENV", B4_PG_TABLE_PREFIX: "app", VERCEL_ENV: "production" },
        {},
      ],
      {
        report: "{ namings, readyCalls }",
        reportImports: 'import { namings, readyCalls } from "@b4run/postgres-storage"',
        storageStub: NAMING_STORAGE_STUB,
      },
    )

    const trio = (schema: string, tablePrefix: string, assumeMigrated: boolean) =>
      ["checkpointer", "permissions", "threads"].map((kind) => ({
        assumeMigrated,
        kind,
        schema,
        tablePrefix,
      }))
    expect(observed).toEqual({
      namings: [
        // Nothing set: the package defaults, so an existing deployment keeps
        // its `public.b4_*` tables.
        ...trio("public", "b4", false),
        ...trio("preview", "b4", false),
        // `$NAME` resolves through the same per-request binding lookup as
        // DATABASE_URL — one setting, a different schema per Vercel environment.
        ...trio("production", "app", false),
        // The isolate has migrated `public.b4` already, so this pass is skipped
        // for it — and only for it.
        ...trio("public", "b4", true),
      ],
      readyCalls: [
        "checkpointer:public.b4",
        "permissions:public.b4",
        "threads:public.b4",
        "checkpointer:preview.b4",
        "permissions:preview.b4",
        "threads:preview.b4",
        "checkpointer:production.app",
        "permissions:production.app",
        "threads:production.app",
      ],
    })
  })

  test("a naming reference resolves through the runtime env when the host passes no bindings", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // The Vercel case: `process.env` carries both the reference and the
    // variable it names, and the fetch handler's second argument carries nothing.
    const observed = await driveEmittedStores(
      appRoot,
      buildDir(appRoot),
      [{ incoming: {}, outgoing: {} }],
      {
        cliStub: `export function readRuntimeEnv(name) {
  return {
    B4_PG_SCHEMA: "$VERCEL_ENV",
    DATABASE_URL: "postgres://from-runtime-env/db",
    VERCEL_ENV: "preview",
  }[name]
}
export const describeConnectionTarget = (url) => url
export const formatErrorChain = (error) => String(error?.message ?? error)
`,
        report: "namings.map((n) => n.schema + '.' + n.tablePrefix)",
        reportImports: 'import { namings } from "@b4run/postgres-storage"',
        storageStub: NAMING_STORAGE_STUB,
      },
    )

    expect(observed).toEqual(["preview.b4", "preview.b4", "preview.b4"])
  })

  test("a bad naming binding fails the request by name instead of falling back to public", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // A mistyped setting silently writing into the shared default schema is
    // the exact failure the binding exists to prevent, so each of these throws
    // — before any store is built or any pool opened.
    const observed = await driveEmittedStores(
      appRoot,
      buildDir(appRoot),
      [
        { B4_PG_SCHEMA: "Preview" },
        { B4_PG_SCHEMA: "$B4_ENV" },
        { B4_PG_TABLE_PREFIX: "$VERCEL_ENV", VERCEL_ENV: "pre-view" },
        { B4_PG_TABLE_PREFIX: "b4; DROP TABLE x" },
        // `$` names nothing. Looking it up would report "references , which is
        // not set" and send the operator hunting for a variable with no name.
        { B4_PG_SCHEMA: "$" },
        // What a wrangler.toml typo produces: the name is bound, but to a KV or
        // Durable Object namespace rather than a var. Calling a string method on
        // it would throw a TypeError naming no binding at all.
        { B4_PG_SCHEMA: { getWithMetadata: () => {} } },
      ],
      {
        report: "{ namings, pools: pools.length, requestErrors }",
        reportImports:
          'import { namings } from "@b4run/postgres-storage"\nimport { pools } from "@neondatabase/serverless"',
        storageStub: NAMING_STORAGE_STUB,
        tolerateRequestFailures: true,
      },
    )

    expect(observed).toEqual({
      namings: [],
      pools: 0,
      requestErrors: [
        'hono target: B4_PG_SCHEMA must resolve to a lowercase SQL identifier (/^[a-z_][a-z0-9_]*$/), got "Preview".',
        'hono target: B4_PG_SCHEMA is "$B4_ENV", which references B4_ENV, and that variable is not set to a non-empty string here. Set B4_PG_SCHEMA to a literal identifier, or to $NAME for a variable this deployment sets.',
        'hono target: B4_PG_TABLE_PREFIX must resolve to a lowercase SQL identifier (/^[a-z_][a-z0-9_]*$/), got "pre-view" from $VERCEL_ENV.',
        'hono target: B4_PG_TABLE_PREFIX must resolve to a lowercase SQL identifier (/^[a-z_][a-z0-9_]*$/), got "b4; DROP TABLE x".',
        'hono target: B4_PG_SCHEMA is "$", which references an empty variable name. Set B4_PG_SCHEMA to a literal identifier, or to $NAME for a variable this deployment sets.',
        "hono target: B4_PG_SCHEMA must be a string, got object. On Workers, check that it is a vars entry or a secret rather than another kind of binding.",
      ],
    })
  })

  test("a second database in one isolate still gets its own cold-start migration", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // The isolate-level memo skips a migration pass already known to have run.
    // Keyed on the schema and prefix ALONE, request 2 below would be told that
    // a virgin database had been migrated — because request 1 migrated a
    // DIFFERENT database under the same `public.b4` — and every query against
    // it would then fail with `undefined_table` for the life of the isolate.
    //
    // This is not a hypothetical host: the generated entry binds env PER
    // REQUEST specifically so a later request can reach a different database,
    // and the fallback test above drives exactly that.
    const observed = await driveEmittedStores(
      appRoot,
      buildDir(appRoot),
      [
        { DATABASE_URL: "postgres://one/db" },
        { DATABASE_URL: "postgres://two/db" },
        { DATABASE_URL: "postgres://one/db" },
      ],
      {
        report: "namings.map((n) => n.assumeMigrated)",
        reportImports: 'import { namings } from "@b4run/postgres-storage"',
        storageStub: NAMING_STORAGE_STUB,
      },
    )

    // Three stores per request. The second database migrates on its own; the
    // return to the first one is the pass that may be skipped.
    expect(observed).toEqual([false, false, false, false, false, false, true, true, true])
  })

  test("still names the missing binding when neither source has it", async () => {
    const appRoot = await createFixtureApp()
    await runBuild(appRoot)

    // Same stubs, but a `readRuntimeEnv` that knows nothing — the genuinely
    // unconfigured deploy. The fallback must not turn a named error into a
    // driver-level connection failure with no hint of which binding is missing.
    await expect(
      driveEmittedStores(appRoot, buildDir(appRoot), [{}], { cliStub: EMPTY_RUNTIME_ENV_STUB }),
    ).rejects.toThrow(/DATABASE_URL is not set/)
  })
})
/**
 * Import the emitted `app.mjs` in a plain Node child process and drive one
 * request per supplied `DATABASE_URL`, returning what the store factory saw.
 *
 * `report` names what to print instead: the emitted entry has two observables
 * that live in different modules (the store factory's per-request env, and the
 * `@b4run/cli/fetch` stub's seeding journal), and both are read out of the
 * child's own module instances rather than reconstructed from stdout chatter.
 */
async function driveEmittedApp(
  appRoot: string,
  databaseUrls: readonly string[],
  report: {
    /** How each request's Workers `env` is built from `databaseUrl`. */
    readonly envExpression?: string
    readonly expression: string
    readonly imports: string
  } = { expression: "seen", imports: 'import { seen } from "./stores.mjs"' },
): Promise<unknown> {
  const driverPath = buildFile(appRoot, "drive.test.mjs")
  await writeFile(
    driverPath,
    `import app from "./app.mjs"
${report.imports}

for (const databaseUrl of ${JSON.stringify(databaseUrls)}) {
  // /readyz builds the request's stores; /healthz is liveness and never does.
  await app.fetch(new Request("http://x/readyz"), ${report.envExpression ?? "{ DATABASE_URL: databaseUrl }"})
}
console.log(JSON.stringify(${report.expression}))
`,
  )
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const { stdout } = await promisify(execFile)(process.execPath, [driverPath], {
    cwd: appRoot,
  })
  return JSON.parse(stdout.trim()) as unknown
}

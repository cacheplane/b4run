import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { seedB4Config } from "@b4run/core"
import { THREAD_ACCESS_METADATA_KEY } from "@b4run/sdk"
import { afterEach, expect, it } from "vitest"
import { runBuildCommand } from "../src/commands/build.ts"
import {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "../src/lib/dev/runtime-fetch-handler.ts"
import { loadStaticModules } from "../src/lib/runtime/static-modules.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const roots: string[] = []
const handlers: RuntimeFetchHandler[] = []
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-managed-runtime-"))
  roots.push(appRoot)
  const files = {
    "package.json": '{"type":"module"}',
    "b4.config.ts": "export default {}",
    "workspace/.keep": "",
    "source/main.txt": "initial",
    "src/app/inspect/index.ts": "export const workflow=async (input,ctx)=>ctx.tools.inspect(input)",
    "src/app/inspect/tools/inspect.ts": `export default async function inspect(input:{edit?:string;path?:string},ctx){if(input.edit)await ctx.fs.writeFile('main.txt',input.edit);return {id:ctx.workspace.id,source:new TextDecoder().decode(await ctx.workspace.readInitialFile(input.path??'main.txt')),current:await ctx.fs.readFile('main.txt')}}`,
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(appRoot, path, ".."), { recursive: true })
    await writeFile(join(appRoot, path), text)
  }
  const physical = managedProviderFixture()
  const config = {
    sandbox: {
      provider: physical.provider,
      workspace: { source: { directory: "source", include: ["main.txt"] } },
    },
  }
  async function boot() {
    const handler = await createRuntimeFetchHandler({ appRoot, config })
    handlers.push(handler)
    return handler
  }
  return { appRoot, config, boot, ...physical }
}
async function run(handler: RuntimeFetchHandler, id: string, input = {}) {
  const response = await handler.fetch(
    new Request(`http://localhost/threads/${id}/runs/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ route: "/inspect#workflow", input }),
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}
it("uses normal runtime tools with persisted provenance across restart and isolates threads", async () => {
  const { boot } = await fixture()
  const first = await boot()
  const edited = await run(first, "one", { edit: "edited" })
  expect(edited.status).toBe(200)
  expect(edited.body).toMatchObject({ source: "initial", current: "edited" })
  const second = await run(first, "two")
  expect(second.body).toMatchObject({ source: "initial", current: "initial" })
  expect(second.body.id).not.toBe(edited.body.id)
  await first.close()
  const restarted = await boot()
  const retained = await run(restarted, "one")
  expect(retained.body).toEqual(edited.body)
  const deleted = await restarted.fetch(
    new Request("http://localhost/threads/one", { method: "DELETE" }),
  )
  expect(deleted.status).toBe(204)
  const retry = await run(restarted, "one")
  expect(retry.status).not.toBe(200)
})
it("rejects a second runtime owner and keeps initial-source reads within the permission boundary", async () => {
  const { boot } = await fixture()
  const handler = await boot()
  await expect(boot()).rejects.toThrow(/locked|busy/i)
  const result = await run(handler, "one", { path: "../outside" })
  expect(result.status).not.toBe(200)
})
it("releases installation ownership when later boot validation fails", async () => {
  const { appRoot, config, boot } = await fixture()
  await expect(
    createRuntimeFetchHandler({
      appRoot,
      config: { ...config, server: { cors: { origins: ["*"], credentials: true } } },
    }),
  ).rejects.toThrow()
  await expect(boot()).resolves.toBeDefined()
})
it("allows shutdown cleanup to retry after a provider release failure", async () => {
  const { boot, provider } = await fixture()
  const handler = await boot()
  await run(handler, "one")
  const release = provider.workspaces!.release
  provider.workspaces!.release = async () => {
    throw new Error("release uncertain")
  }
  await expect(handler.close()).rejects.toThrow("release uncertain")
  expect(handler.state.closed).toBe(false)
  provider.workspaces!.release = release
  await handler.close()
  expect(handler.state.closed).toBe(true)
  await expect(boot()).resolves.toBeDefined()
})
it("captures development changes only for new associations", async () => {
  const { boot, appRoot } = await fixture()
  const handler = await boot()
  const first = await run(handler, "one")
  await writeFile(join(appRoot, "source/main.txt"), "new initial")
  expect((await run(handler, "two")).body.source).toBe("new initial")
  expect((await run(handler, "one")).body).toEqual(first.body)
})

it("boots the emitted Node manifest after original workspace source is removed", async () => {
  const { appRoot, config } = await fixture()
  await mkdir(join(appRoot, "node_modules/@b4run"), { recursive: true })
  await symlink(new URL("..", import.meta.url), join(appRoot, "node_modules/@b4run/cli"), "dir")
  seedB4Config(appRoot, { ...config, build: { targets: ["node"] } })
  await runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} })
  const workspace = JSON.parse(await readFile(join(appRoot, ".b4/build/workspace.json"), "utf8"))
  await rm(join(appRoot, "source"), { recursive: true })
  const modules = await loadStaticModules(pathToFileURL(join(appRoot, ".b4/build/modules.mjs")))
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config,
    modules: { ...modules, workspace },
  })
  handlers.push(handler)
  expect((await run(handler, "built")).body).toMatchObject({
    source: "initial",
    current: "initial",
  })
  await handler.close()
  await expect(
    createRuntimeFetchHandler({ appRoot, config, modules: { ...modules, workspace: null } }),
  ).rejects.toThrow()
})

it("resumes interrupted physical deletion and metadata cleanup at startup", async () => {
  const { boot, workspaces, records } = await fixture()
  const first = await boot()
  await run(first, "one")
  const destroy = workspaces.destroy
  workspaces.destroy = async () => {
    throw new Error("provider unavailable")
  }
  const deletion = await first.fetch(
    new Request("http://localhost/threads/one", { method: "DELETE" }),
  )
  expect(deletion.status).toBe(500)
  await first.close()
  expect(records.size).toBe(1)
  workspaces.destroy = destroy
  const restarted = await boot()
  expect(records.size).toBe(0)
  expect((await restarted.fetch(new Request("http://localhost/threads/one"))).status).toBe(404)
  expect((await run(restarted, "one")).status).not.toBe(200)
})

// `POST /threads` never accepts a caller-supplied id — the store generates
// one (see sqlite-storage's `newThreadId`) — so a test that needs metadata
// attached to a thread before its first run must create the thread this way
// and use the id the server hands back, rather than a chosen literal.
async function createThread(
  handler: RuntimeFetchHandler,
  metadata: Record<string, unknown>,
): Promise<string> {
  const response = await handler.fetch(
    new Request("http://localhost/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metadata }),
    }),
  )
  expect(response.status).toBe(200)
  const body = (await response.json()) as { thread_id: string }
  return body.thread_id
}

it("resolves each thread's workspace from its own metadata, once, and keeps it across restart", async () => {
  const { appRoot } = await fixture()
  // Each candidate source lives in its OWN directory: `source-capture`'s
  // exact-inventory check requires the walked directory's file set to equal
  // `include` precisely, so alpha and beta cannot share a directory with each
  // other (or with the base fixture's `source/main.txt`).
  await mkdir(join(appRoot, "source-alpha"), { recursive: true })
  await mkdir(join(appRoot, "source-beta"), { recursive: true })
  await writeFile(join(appRoot, "source-alpha/alpha.txt"), "alpha")
  await writeFile(join(appRoot, "source-beta/beta.txt"), "beta")
  const seen: string[] = []
  const physical = managedProviderFixture()
  const config = {
    sandbox: {
      provider: physical.provider,
      workspace: async (thread: { threadId: string; metadata: Record<string, unknown> }) => {
        seen.push(thread.threadId)
        const isBeta = thread.metadata.task === "beta"
        const file = isBeta ? "beta.txt" : "alpha.txt"
        return {
          source: {
            directory: isBeta ? "source-beta" : "source-alpha",
            include: [file],
            files: [{ path: "main.txt", text: file }],
          },
        }
      },
    },
  }
  const boot = async () => {
    const handler = await createRuntimeFetchHandler({ appRoot, config })
    handlers.push(handler)
    return handler
  }
  const first = await boot()
  const a = await createThread(first, { task: "alpha" })
  const b = await createThread(first, { task: "beta" })
  expect((await run(first, a)).body).toMatchObject({ source: "alpha.txt", current: "alpha.txt" })
  expect((await run(first, b)).body).toMatchObject({ source: "beta.txt", current: "beta.txt" })
  // Pin the captured DIRECTORY itself, not only the `main.txt` overlay: read
  // the real captured file by name, whose content is its own physical
  // content ("alpha"/"beta") rather than the filename `files` stamped into
  // `main.txt`. This proves each thread's admitted workspace is rooted in
  // its own resolved source directory, not merely that `main.txt` differs.
  expect((await run(first, a, { path: "alpha.txt" })).body).toMatchObject({ source: "alpha" })
  expect((await run(first, b, { path: "beta.txt" })).body).toMatchObject({ source: "beta" })
  await run(first, a)
  expect(seen).toEqual([a, b])
  await first.close()
  const restarted = await boot()
  expect((await run(restarted, b)).body).toMatchObject({ source: "beta.txt" })
  // The already-admitted thread `a` keeps its own workspace across restart
  // too, and the resolver is not re-invoked for it (only its physical
  // record is reattached).
  expect((await run(restarted, a)).body).toMatchObject({ source: "alpha.txt" })
  expect(seen).toEqual([a, b])
})

it("passes the stored metadata with the reserved key stripped, and empty metadata for a run without a prior thread", async () => {
  const { appRoot } = await fixture()
  const seen: Record<string, unknown>[] = []
  const physical = managedProviderFixture()
  const config = {
    sandbox: {
      provider: physical.provider,
      workspace: async (thread: { threadId: string; metadata: Record<string, unknown> }) => {
        seen.push(thread.metadata)
        return { source: { directory: "source", include: ["main.txt"] } }
      },
    },
  }
  const handler = await createRuntimeFetchHandler({ appRoot, config })
  handlers.push(handler)
  const withId = await createThread(handler, {
    task: "x",
    [THREAD_ACCESS_METADATA_KEY]: { forged: true },
  })
  await run(handler, withId)
  await run(handler, "without")
  expect(seen[0]).toMatchObject({ task: "x" })
  expect(seen[0]).not.toHaveProperty(THREAD_ACCESS_METADATA_KEY)
  // The "without" thread has no prior `POST /threads` call, so it is created
  // fresh by `runs/wait` with no client metadata. The runtime stamps the
  // route onto that thread's metadata BEFORE workspace admission resolves for
  // it, so the resolver sees that stamp rather than an empty object.
  expect(seen[1]).toEqual({ route: "/inspect#workflow" })
})

it("builds a resolver app to a resolver artifact and resolves per thread from the built manifest", async () => {
  const { appRoot } = await fixture()
  await mkdir(join(appRoot, "source-beta"), { recursive: true })
  await writeFile(join(appRoot, "source-beta/beta.txt"), "beta")
  await mkdir(join(appRoot, "node_modules/@b4run"), { recursive: true })
  await symlink(new URL("..", import.meta.url), join(appRoot, "node_modules/@b4run/cli"), "dir")
  const seen: string[] = []
  const physical = managedProviderFixture()
  const config = {
    build: { targets: ["node"] as const },
    sandbox: {
      provider: physical.provider,
      workspace: async (thread: { threadId: string; metadata: Record<string, unknown> }) => {
        seen.push(thread.threadId)
        return thread.metadata.task === "beta"
          ? {
              source: {
                directory: "source-beta",
                include: ["beta.txt"],
                files: [{ path: "main.txt", text: "beta-overlay" }],
              },
            }
          : { source: { directory: "source", include: ["main.txt"] } }
      },
    },
  }
  seedB4Config(appRoot, config)
  await runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} })
  const workspace = JSON.parse(await readFile(join(appRoot, ".b4/build/workspace.json"), "utf8"))
  expect(workspace).toEqual({ version: 2, kind: "resolver" })
  const modules = await loadStaticModules(pathToFileURL(join(appRoot, ".b4/build/modules.mjs")))
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config,
    modules: { ...modules, workspace },
  })
  handlers.push(handler)
  const beta = await createThread(handler, { task: "beta" })
  const plain = await createThread(handler, {})
  expect((await run(handler, beta)).body).toMatchObject({
    source: "beta-overlay",
    current: "beta-overlay",
  })
  expect((await run(handler, beta, { path: "beta.txt" })).body).toMatchObject({ source: "beta" })
  expect((await run(handler, plain)).body).toMatchObject({ source: "initial", current: "initial" })
  expect(seen).toEqual([beta, plain])
  await handler.close()
})

it("refuses to boot a resolver app from a stale static artifact", async () => {
  const { appRoot, config: staticConfig } = await fixture()
  await mkdir(join(appRoot, "node_modules/@b4run"), { recursive: true })
  await symlink(new URL("..", import.meta.url), join(appRoot, "node_modules/@b4run/cli"), "dir")
  seedB4Config(appRoot, { ...staticConfig, build: { targets: ["node"] } })
  await runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} })
  const workspace = JSON.parse(await readFile(join(appRoot, ".b4/build/workspace.json"), "utf8"))
  expect(workspace.version).toBe(1)
  const modules = await loadStaticModules(pathToFileURL(join(appRoot, ".b4/build/modules.mjs")))
  const physical = managedProviderFixture()
  const resolverConfig = {
    sandbox: {
      provider: physical.provider,
      workspace: async () => ({ source: { directory: "source", include: ["main.txt"] } }),
    },
  }
  await expect(
    createRuntimeFetchHandler({
      appRoot,
      config: resolverConfig,
      modules: { ...modules, workspace },
    }),
  ).rejects.toThrow(/rebuild/i)
})

it("refuses to boot a static app from a stale resolver artifact", async () => {
  const { appRoot, config: staticConfig } = await fixture()
  await mkdir(join(appRoot, "node_modules/@b4run"), { recursive: true })
  await symlink(new URL("..", import.meta.url), join(appRoot, "node_modules/@b4run/cli"), "dir")
  const physical = managedProviderFixture()
  const resolverConfig = {
    build: { targets: ["node"] as const },
    sandbox: {
      provider: physical.provider,
      workspace: async () => ({ source: { directory: "source", include: ["main.txt"] } }),
    },
  }
  seedB4Config(appRoot, resolverConfig)
  await runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} })
  const workspace = JSON.parse(await readFile(join(appRoot, ".b4/build/workspace.json"), "utf8"))
  expect(workspace).toEqual({ version: 2, kind: "resolver" })
  const modules = await loadStaticModules(pathToFileURL(join(appRoot, ".b4/build/modules.mjs")))
  await expect(
    createRuntimeFetchHandler({
      appRoot,
      config: staticConfig,
      modules: { ...modules, workspace },
    }),
  ).rejects.toThrow(/rebuild/i)
})

it("fails b4 build on a misspelt sandbox key even with no workspace or thread", async () => {
  const { appRoot } = await fixture()
  const physical = managedProviderFixture()
  seedB4Config(appRoot, {
    build: { targets: ["node"] },
    sandbox: { provider: physical.provider, thred: async () => ({}) },
  } as never)
  await expect(
    runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} }),
  ).rejects.toThrow(/sandbox.thred is not a sandbox option/)
})

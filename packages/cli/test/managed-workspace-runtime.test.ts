import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { seedB4Config } from "@b4run/core"
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

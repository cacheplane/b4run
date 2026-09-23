import { type ChildProcess, fork } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dockerSandbox } from "@b4run/sandbox"
import { expect, it } from "vitest"
import { cleanupWorkspaces } from "../src/lib/runtime/cleanup-workspaces.ts"
import { managedTestImage } from "./fixtures/managed-test-image.ts"

it.skipIf(process.env.B4_TEST_DOCKER !== "1")(
  "recovers a real HTTP runtime and Docker edits after SIGKILL",
  async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-runtime-kill-")),
      scope = `runtime-${randomUUID()}`,
      image = managedTestImage()
    const children: ChildProcess[] = []
    async function boot() {
      const child = fork(
        new URL("./fixtures/managed-runtime-worker.ts", import.meta.url),
        [appRoot, scope, image],
        { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
      )
      children.push(child)
      let output = ""
      child.stdout?.on("data", (chunk) => {
        output += String(chunk)
      })
      child.stderr?.on("data", (chunk) => {
        output += String(chunk)
      })
      const url = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Boot timed out: ${output}`)), 20000)
        child.once("message", (message) => {
          clearTimeout(timeout)
          resolve((message as { url: string }).url)
        })
        child.once("exit", (code) => {
          clearTimeout(timeout)
          reject(new Error(`Boot exited ${code}: ${output}`))
        })
      })
      return { child, url }
    }
    async function kill(child: ChildProcess) {
      if (child.exitCode !== null || child.signalCode !== null) return
      const closed = once(child, "exit")
      child.kill("SIGKILL")
      await closed
    }
    async function run(url: string, input = {}) {
      const response = await fetch(`${url}/threads/one/runs/wait`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: "/inspect#workflow", input }),
      })
      const body = await response.json()
      expect(response.status, JSON.stringify(body)).toBe(200)
      return body
    }
    try {
      for (const [path, source] of Object.entries({
        "package.json": '{"type":"module"}',
        "b4.config.ts": "export default {}",
        "workspace/.keep": "",
        "source/file.txt": "original",
        "src/app/inspect/index.ts":
          "export const workflow=async (input,ctx)=>ctx.tools.inspect(input)",
        "src/app/inspect/tools/inspect.ts":
          "export default async function inspect(input:{edit?:string},ctx){if(input.edit)await ctx.fs.writeFile('file.txt',input.edit);return {id:ctx.workspace.id,initial:new TextDecoder().decode(await ctx.workspace.readInitialFile('file.txt')),current:await ctx.fs.readFile('file.txt')}}",
      })) {
        await mkdir(join(appRoot, path, ".."), { recursive: true })
        await writeFile(join(appRoot, path), source)
      }
      const first = await boot()
      const edited = await run(first.url, { edit: "survives" })
      expect(edited).toMatchObject({ initial: "original", current: "survives" })
      await kill(first.child)
      const second = await boot()
      expect(await run(second.url)).toEqual(edited)
      expect((await fetch(`${second.url}/threads/one`, { method: "DELETE" })).status).toBe(204)
      await kill(second.child)
    } finally {
      for (const child of children) await kill(child)
      await cleanupWorkspaces({
        appRoot,
        provider: dockerSandbox({ scope, image }),
      })
      await rm(appRoot, { recursive: true, force: true })
    }
  },
  60000,
)

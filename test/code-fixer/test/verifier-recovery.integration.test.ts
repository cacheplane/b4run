import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { cleanupEvaluation } from "../evaluation/cleanup.ts"
import { isolatedApp } from "../evaluation/isolated-app.ts"
import { runChild } from "../evaluation/run-attempt.ts"

it("recovers the separate verifier installation after its worker is killed", async () => {
  const appRoot = await isolatedApp()
  const marker = join(appRoot, "verifier-started.txt")
  const childPath = join(appRoot, "killed-verifier.ts")
  const stateRoot = join(appRoot, ".b4/code-fixer/verifiers", randomUUID())
  await writeFile(
    childPath,
    `
import { writeFile } from "node:fs/promises"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { projectWorkspace, sandboxImage, sandboxPolicy } from "./src/project/workspace.js"
await withWorkspace({ appRoot: ${JSON.stringify(appRoot)}, stateRoot: ${JSON.stringify(stateRoot)}, provider: dockerSandbox({scope:"code-fixer-verifiers",image:sandboxImage}), workspace:projectWorkspace("cli-flags"),policy:sandboxPolicy }, async (handle) => {
 const result=await handle.exec.runCommand({command:"hostname"},{workspaceRoot:handle.workspaceRoot,signal:new AbortController().signal})
 await writeFile(${JSON.stringify(marker)},result.stdout.trim())
 await new Promise(resolve=>setTimeout(resolve,600000))
})
`,
  )
  let cleaned = false
  try {
    const result = await runChild(process.execPath, ["--import", "tsx", childPath], {}, 15_000)
    expect(result.status).toBe("timed-out")
    const container = (await readFile(marker, "utf8")).trim()
    expect(container).toMatch(/^[a-f0-9]{12}$/)
    expect(spawnSync("docker", ["inspect", container]).status).toBe(0)
    await cleanupEvaluation(appRoot)
    expect(spawnSync("docker", ["inspect", container]).status).not.toBe(0)
    // Recovery is safe to retry after resources were already removed.
    await cleanupEvaluation(appRoot)
    cleaned = true
  } finally {
    if (!cleaned) await cleanupEvaluation(appRoot)
    await rm(appRoot, { recursive: true, force: true })
  }
}, 120_000)

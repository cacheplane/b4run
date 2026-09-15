import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { type CapturedWorkspaceDefinition, inspectWorkspace } from "@b4run/workspace"
import { z } from "zod"
import { projectDirectory, projectManifest } from "../project/catalog.js"
import { appRoot, projectWorkspace, sandboxImage, sandboxPolicy } from "../project/workspace.js"
import { collectChanges } from "./patch.js"

export { sandboxImage, sandboxPolicy } from "../project/workspace.js"

export async function verifyChanges(
  id: string,
  changes: Record<string, string>,
  signal: AbortSignal,
  initial?: { workspace: CapturedWorkspaceDefinition; image: string; workspaceId: string },
) {
  const manifest = projectManifest(id)
  for (const path of Object.keys(changes)) {
    if (!manifest.allowedSourcePaths.includes(path))
      throw new Error(`Disallowed patch path: ${path}`)
  }
  const checks = checksSchema.parse(
    JSON.parse(await readFile(join(projectDirectory, "checks.json"), "utf8")),
  )
  return withWorkspace(
    {
      appRoot,
      stateRoot: join(appRoot, ".b4/code-fixer/verifiers", initial?.workspaceId ?? randomUUID()),
      provider: dockerSandbox({
        scope: "code-fixer-verifiers",
        image: initial?.image ?? sandboxImage,
      }),
      workspace: initial?.workspace ?? projectWorkspace(id),
      policy: sandboxPolicy,
      signal,
    },
    async (handle) => {
      const snapshot = async () =>
        (
          await inspectWorkspace(handle, {
            signal,
            maxEntries: 1000,
            maxFileBytes: 2 * 1024 * 1024,
            maxTotalBytes: 2 * 1024 * 1024,
            excludeRootDirectories: [".git"],
            expectedRootSymlinks: { node_modules: `/opt/fixtures/${id}/node_modules` },
          })
        ).files
      const ctx = { workspaceRoot: handle.workspaceRoot, signal }
      for (const [path, content] of Object.entries(changes))
        await handle.filesystem.writeFile(`${handle.workspaceRoot}/${path}`, content, ctx)
      const visibleBaseline = await snapshot()
      const visible = await runChecks(handle, checks.visible, signal)
      collectChanges(visibleBaseline, await snapshot(), [])
      // Checks are installed only in this verifier, after visible execution.
      for (const name of await readdir(join(projectDirectory, "checks"))) {
        await handle.filesystem.writeFile(
          `${handle.workspaceRoot}/checks/${name}`,
          await readFile(join(projectDirectory, "checks", name), "utf8"),
          ctx,
        )
      }
      const independentBaseline = await snapshot()
      const independent = await runChecks(handle, checks.independent, signal)
      collectChanges(independentBaseline, await snapshot(), [])
      return { passed: visible.passed && independent.passed, visible, independent }
    },
  )
}

// Assertion names are host-owned completion policy for the selected sample.
const suiteSchema = z.object({
  file: z.string().regex(/^(?:test|checks)\/[a-zA-Z0-9_-]+\.test\.ts$/),
  assertions: z.array(z.string().min(1)).min(1),
})
const checksSchema = z.object({ visible: suiteSchema, independent: suiteSchema })

async function runChecks(
  handle: import("@b4run/workspace").SandboxHandle,
  suite: z.infer<typeof suiteSchema>,
  signal: AbortSignal,
) {
  const { file, assertions: expected } = suite
  // The parent runner uses only built-ins. Submitted code runs in a child;
  // its stdout is a test:stdout event and cannot forge a test:pass receipt.
  const program = `
const {run} = require('node:test');
(async () => {
 const events = []; let output = '';
 for await (const event of run({files:[${JSON.stringify(file)}], execArgv:['--import','tsx'], concurrency:1})) {
  if (['test:pass','test:fail'].includes(event.type)) events.push({type:event.type,name:event.data.name,skip:!!event.data.skip,todo:!!event.data.todo,...(event.data.details?.error ? {error:String(event.data.details.error.message ?? event.data.details.error)} : {})});
  if (['test:stdout','test:stderr'].includes(event.type)) output += event.data.message;
 }
 process.stdout.write(JSON.stringify({events,output}));
})().catch(error => { console.error(error); process.exitCode=1 });`
  const result = await handle.exec.runCommand(
    {
      command: `/usr/local/bin/node --import tsx <<'B4_VERIFIER_PROGRAM'\n${program}\nB4_VERIFIER_PROGRAM`,
    },
    { workspaceRoot: handle.workspaceRoot, signal },
  )
  const receipt = JSON.parse(result.stdout) as {
    events: { type: string; name: string; skip: boolean; todo: boolean; error?: string }[]
    output: string
  }
  const passed =
    result.exitCode === 0 &&
    expected.length > 0 &&
    receipt.events.length === expected.length &&
    receipt.events.every((event) => event.type === "test:pass" && !event.skip && !event.todo) &&
    expected.every((name) => receipt.events.filter((event) => event.name === name).length === 1)
  return { ...result, passed, receipt }
}

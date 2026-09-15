import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { fixtureManifest, fixturesRoot } from "../fixtures/catalog.js"
import { appRoot, fixtureWorkspace, sandboxImage, sandboxPolicy } from "../fixtures/workspace.js"
import { collectChanges, snapshot } from "./patch.js"

export { sandboxImage, sandboxPolicy } from "../fixtures/workspace.js"

export async function verifyChanges(
  id: string,
  changes: Record<string, string>,
  signal: AbortSignal,
  initial?: { workspace: CapturedWorkspaceDefinition; image: string; workspaceId: string },
) {
  const manifest = fixtureManifest(id)
  for (const path of Object.keys(changes)) {
    if (!manifest.allowedSourcePaths.includes(path))
      throw new Error(`Disallowed patch path: ${path}`)
  }
  return withWorkspace(
    {
      appRoot,
      stateRoot: join(appRoot, ".b4/code-fixer/verifiers", initial?.workspaceId ?? randomUUID()),
      provider: dockerSandbox({
        scope: "code-fixer-verifiers",
        image: initial?.image ?? sandboxImage,
      }),
      workspace: initial?.workspace ?? fixtureWorkspace(id),
      policy: sandboxPolicy,
      signal,
    },
    async (handle) => {
      const ctx = { workspaceRoot: handle.workspaceRoot, signal }
      for (const [path, content] of Object.entries(changes))
        await handle.filesystem.writeFile(`${handle.workspaceRoot}/${path}`, content, ctx)
      const visibleBaseline = await snapshot(handle, signal)
      const visible = await runChecks(handle, id, "visible", signal)
      collectChanges(visibleBaseline, await snapshot(handle, signal), [])
      // Checks are installed only in this verifier, after visible execution.
      for (const name of await readdir(join(fixturesRoot, id, "checks"))) {
        await handle.filesystem.writeFile(
          `${handle.workspaceRoot}/checks/${name}`,
          await readFile(join(fixturesRoot, id, "checks", name), "utf8"),
          ctx,
        )
      }
      const independentBaseline = await snapshot(handle, signal)
      const independent = await runChecks(handle, id, "independent", signal)
      collectChanges(independentBaseline, await snapshot(handle, signal), [])
      return { passed: visible.passed && independent.passed, visible, independent }
    },
  )
}

// Authored fixture assertions, not file-level runner success, define completion.
const expectedChecks: Record<string, { visible: string[]; independent: string[] }> = {
  "cli-flags": {
    visible: ["documented dry-run flag reaches the handler"],
    independent: [
      "forwards cap and memory-level cwd",
      "rejects unknown and incomplete arguments",
      "dry-run preserves memory state and creates no files",
    ],
  },
  "nullable-inputs": {
    visible: ["a nullable TypeScript tool accepts null at runtime"],
    independent: [
      "preserves null alternatives, required fields, and nested inputs",
      "preserves existing non-nullable and array behavior",
    ],
  },
}

async function runChecks(
  handle: import("@b4run/workspace").SandboxHandle,
  id: string,
  suite: "visible" | "independent",
  signal: AbortSignal,
) {
  const file =
    suite === "visible"
      ? `test/${id === "cli-flags" ? "cli" : "nullable"}.test.ts`
      : "checks/independent.test.ts"
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
  const expected = expectedChecks[id]?.[suite] ?? []
  const passed =
    result.exitCode === 0 &&
    expected.length > 0 &&
    receipt.events.length === expected.length &&
    receipt.events.every((event) => event.type === "test:pass" && !event.skip && !event.todo) &&
    expected.every((name) => receipt.events.filter((event) => event.name === name).length === 1)
  return { ...result, passed, receipt }
}

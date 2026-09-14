import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { SandboxHandle } from "@b4run/workspace"
import { fixturesRoot, loadManifest } from "./fixture-catalog.js"

export async function seedFixture(
  id: string,
  handle: SandboxHandle,
  signal: AbortSignal,
): Promise<void> {
  const manifest = await loadManifest(id)
  const ctx = { workspaceRoot: handle.workspaceRoot, signal }
  for (const path of [...manifest.allowedSourcePaths, ...manifest.immutablePaths]) {
    await handle.filesystem.writeFile(
      `${handle.workspaceRoot}/${path}`,
      await readFile(join(fixturesRoot, id, "project", path), "utf8"),
      ctx,
    )
  }
  await handle.filesystem.writeFile(
    `${handle.workspaceRoot}/TASK.md`,
    await readFile(join(fixturesRoot, id, "task.md"), "utf8"),
    ctx,
  )
  await handle.filesystem.writeFile(`${handle.workspaceRoot}/.gitignore`, "node_modules/\n", ctx)
  const setup = await handle.exec.runCommand(
    {
      command: `ln -s /opt/fixtures/${manifest.id}/node_modules node_modules && git init -q && git add . && git -c user.name='B4 fixture' -c user.email='fixture@example.invalid' -c commit.gpgsign=false commit -qm baseline`,
    },
    ctx,
  )
  if (setup.exitCode !== 0) throw new Error(`Sandbox seeding failed: ${setup.stderr}`)
}

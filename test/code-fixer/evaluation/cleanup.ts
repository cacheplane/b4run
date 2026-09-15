import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { cleanupWorkspaces } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { sandboxImage } from "../../../examples/code-fixer/server/src/project/workspace.js"

/** Recover only installations inside this evaluation's private app directory. */
export async function cleanupEvaluation(appRoot: string): Promise<void> {
  const failures: unknown[] = []
  const verifiers = join(appRoot, ".b4/code-fixer/verifiers")
  let entries: Dirent<string>[] = []
  try {
    entries = await readdir(verifiers, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error)
  }
  for (const entry of entries) {
    try {
      // Workspace IDs are library-issued UUIDs; never traverse arbitrary entries.
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name))
        throw new Error("Unexpected verifier state directory")
      await cleanupWorkspaces({
        appRoot: join(verifiers, entry.name),
        provider: dockerSandbox({ scope: "code-fixer-verifiers", image: sandboxImage }),
      })
    } catch (error) {
      failures.push(error)
    }
  }
  try {
    await cleanupWorkspaces({
      appRoot,
      provider: dockerSandbox({ scope: "code-fixer-local", image: sandboxImage }),
    })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) throw new AggregateError(failures, "Evaluation workspace cleanup failed")
}

import { openWorkspaceInstallation } from "@b4run/sqlite-storage"
import type { SandboxProvider } from "@b4run/workspace"

/** Remove every managed workspace in a dedicated, inactive app installation.
 * Acquires exclusive installation ownership; interrupted cleanup resumes on retry.
 * Deletion remains journaled until runtime boot also cleans thread/checkpoint metadata.
 */
export async function cleanupWorkspaces(options: {
  readonly appRoot: string
  readonly provider: SandboxProvider
}): Promise<void> {
  const provider = options.provider.workspaces
  if (!provider) throw new Error("Provider does not support managed workspaces")
  const installation = openWorkspaceInstallation(options.appRoot)
  try {
    for (const entry of installation.associations.list()) {
      if (entry.state === "deleted") continue
      if (entry.intent.installationId !== installation.installationId)
        throw new Error("Workspace installation identity mismatch")
      const deleting = installation.associations.beginDelete(entry.intent.threadId)
      if (!deleting || deleting.state !== "deleting")
        throw new Error("Workspace deletion state changed")
      await provider.destroy(
        {
          intent: deleting.intent,
          ...(deleting.ready ? { reference: deleting.ready.reference } : {}),
        },
        new AbortController().signal,
      )
      // Keep deleting until runtime startup has also removed thread/checkpoint metadata.
    }
  } finally {
    installation.close()
  }
}

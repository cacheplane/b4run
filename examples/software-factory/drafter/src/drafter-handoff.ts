import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"

/**
 * A work order's id is a catalog id: a plain name, no slash, no leading dot. Copied from the
 * controller's `isCatalogId` (`controller/src/lib/targets/catalog.ts`) rather than imported:
 * the drafter is the untrusted side and shares no source with the code that judges what it
 * writes.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * What one drafter thread is told to serve, carried in its metadata under `factoryDrafter`:
 * the reference of the wide read-only capture of the repository at the work order's pin,
 * captured by the controller and uploaded to this drafter before the thread was created.
 * Deliberately a SECOND copy of the controller's schema rather than an import, and the
 * controller's own test asserts the two schema texts are identical.
 *
 * No `baseline`: the drafter's capture has none (there is no `.git` to diff against), so a
 * handoff naming one, or an unknown key, is refused at parse time.
 */
export const DrafterHandoffSchema = z
  .object({
    version: z.literal(2),
    workOrderId: z.string().regex(CATALOG_ID),
    workspace: z
      .object({
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        environmentLinks: z.array(
          z.object({ path: z.string().min(1), target: z.string().min(1) }).strict(),
        ),
      })
      .strict(),
  })
  .strict()
export type DrafterHandoff = z.infer<typeof DrafterHandoffSchema>

/**
 * Refuse, by name, a variable an older drafter read: `FACTORY_DRAFTER_MANIFEST_DIR` was where
 * the controller wrote each intake's manifest. An operator still setting it must not believe
 * it does anything.
 */
export function refuseRetiredVariables(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FACTORY_DRAFTER_MANIFEST_DIR !== undefined)
    throw new Error(
      "FACTORY_DRAFTER_MANIFEST_DIR is retired: the controller stages each intake's workspace over the Agent Protocol. Unset it",
    )
}

/**
 * The one fact a drafter thread is keyed by. Thread metadata is client input: nothing in it is
 * trusted beyond this one key being a catalog-id string.
 */
export function workOrderIdOf(metadata: Readonly<Record<string, unknown>>): string {
  const id = metadata.factoryWorkOrderId
  if (typeof id !== "string" || !CATALOG_ID.test(id))
    throw new Error(
      "thread metadata factoryWorkOrderId must be a catalog id: a plain name with no slash and no leading dot",
    )
  return id
}

/**
 * The work order's handoff, from the thread's metadata. Only the controller can create a
 * thread (src/thread-access.ts), so this key is as controller-authored as the manifest file
 * was; it is still parsed strictly.
 */
export function drafterHandoffOf(metadata: Readonly<Record<string, unknown>>): DrafterHandoff {
  const workOrderId = workOrderIdOf(metadata)
  const raw = Object.hasOwn(metadata, "factoryDrafter") ? metadata.factoryDrafter : undefined
  if (raw === undefined)
    throw new Error(
      "thread metadata factoryDrafter is required: the controller creates an intake thread with its work order's handoff",
    )
  let handoff: DrafterHandoff
  try {
    handoff = DrafterHandoffSchema.parse(raw)
  } catch (error) {
    throw new Error(
      `thread metadata factoryDrafter is invalid: ${error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (handoff.workOrderId !== workOrderId)
    throw new Error(
      `thread metadata factoryDrafter names work order ${handoff.workOrderId}, not ${workOrderId}`,
    )
  return handoff
}

/**
 * The staged workspace, only when it is the one the handoff names (digest and links), and
 * never one with a baseline. A thread created with another workspace, or with none, is refused
 * at admission, by name.
 */
export function stagedDrafterWorkspace(
  staged: CapturedWorkspaceDefinition | undefined,
  handoff: DrafterHandoff,
): CapturedWorkspaceDefinition {
  if (staged === undefined)
    throw new Error(
      `work order ${handoff.workOrderId}'s intake thread was created without a staged workspace`,
    )
  // The drafter's capture has no `.git` to diff against; a baseline would be a different workspace.
  if (staged.baseline !== undefined) throw new Error("a drafter workspace carries no baseline")
  const named = JSON.stringify([
    handoff.workspace.sourceDigest,
    [...handoff.workspace.environmentLinks]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((link) => ({ path: link.path, target: link.target })),
  ])
  const got = JSON.stringify([
    staged.source.digest,
    staged.environmentLinks.map((link) => ({ path: link.path, target: link.target })),
  ])
  if (got !== named)
    throw new Error(
      `the staged workspace ${got} is not the one work order ${handoff.workOrderId} names (${named})`,
    )
  return verifyCapturedWorkspaceDefinition(staged)
}

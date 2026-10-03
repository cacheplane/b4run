import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"
import { stagedReferenceOf } from "./builder-handoff.js"
import { captureDirectory } from "./targets/archive.js"
import { ensurePin, isCatalogId } from "./targets/catalog.js"
import { stageWideCapture } from "./targets/wide-capture.js"

/**
 * A work order's id is a catalog id: a plain directory name, no slash, no leading dot,
 * nothing a path could smuggle. Spelled out here rather than imported from `catalog.ts`
 * because the schema below refers to it by name and the schema text is kept identical to
 * the drafter's copy; the test that pins the schema text pins this regex's source too.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * What one drafter thread serves, besides the files themselves: the reference of the wide
 * read-only capture of the repository at the work order's pin, carried in the thread's
 * metadata under `factoryDrafter`. The drafter imports no controller code: it checks that the
 * workspace it was handed is the one named here, and serves it. The workspace is captured
 * HERE, so the drafter never sees the repository, only the bytes the controller decided it
 * should read, uploaded to it before the thread is created.
 *
 * Deliberately a SECOND copy of the drafter's schema (`drafter/src/drafter-handoff.ts`)
 * rather than an import, kept identical by test (`test/drafter-handoff.test.ts`): the
 * drafter is the untrusted side and shares no source with the code that judges what it
 * writes.
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

export interface CaptureDrafterHandoffOptions {
  readonly workOrderId: string
  /** The full commit sha the wide capture is taken at. */
  readonly pin: string
  readonly repositoryRoot: string
  /**
   * The capture root the staging directory lives under: the controller's `FACTORY_STATE_DIR`,
   * never its app root, which `b4 dev` watches (see `CaptureTargetOptions.captureRoot`).
   */
  readonly captureRoot: string
  readonly signal?: AbortSignal
}

export interface CapturedDrafterHandoff {
  readonly handoff: DrafterHandoff
  /** The captured workspace: its `source` is what `intake` uploads to the drafter. */
  readonly workspace: CapturedWorkspaceDefinition
}

/**
 * Stage the wide capture at `pin`, capture it with the framework's own capture, and return it
 * with its handoff. Nothing is written: `intake` uploads the source (on this repository some
 * 20 MiB) and creates the thread with the handoff. The staging directory is per call
 * (`captureDirectory(workOrderId, "drafter", instance)`) and removed once the capture has read
 * the bytes into the definition, on failure too. `ensurePin` runs first so a shallow checkout
 * fetches the pin before the listing.
 *
 * `ensurePin` (which may fetch) and the staging are synchronous and not cancellable by
 * `signal`; the signal is checked before them and honoured by the capture after them.
 */
export async function captureDrafterHandoff(
  options: CaptureDrafterHandoffOptions,
): Promise<CapturedDrafterHandoff> {
  const { workOrderId, pin, repositoryRoot, captureRoot, signal } = options
  if (!isCatalogId(workOrderId))
    throw new Error(`drafter handoff workOrderId must be a catalog id, got ${workOrderId}`)
  signal?.throwIfAborted()
  ensurePin(repositoryRoot, workOrderId, pin, { label: `Work order ${workOrderId}'s draft` })
  const instanceDir = captureDirectory(workOrderId, "drafter", randomUUID())
  let workspace: CapturedWorkspaceDefinition
  try {
    const definition = stageWideCapture(repositoryRoot, pin, instanceDir, { captureRoot })
    workspace = await captureWorkspaceDefinition(captureRoot, definition, {
      ...(signal !== undefined ? { signal } : {}),
    })
  } finally {
    rmSync(join(captureRoot, instanceDir), { recursive: true, force: true })
  }
  // Parsed, not merely typed: the controller checks what it sends against the SAME schema the
  // drafter will apply to it, so a handoff the drafter would refuse cannot be produced here.
  const handoff = DrafterHandoffSchema.parse({
    version: 2,
    workOrderId,
    workspace: stagedReferenceOf(workspace),
  })
  return { handoff, workspace }
}

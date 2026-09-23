import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"
import { appRoot as defaultAppRoot, ensurePin, isCatalogId } from "./targets/catalog.js"
import { stageWideCapture } from "./targets/wide-capture.js"

/**
 * A work order's id is a catalog id: a plain directory name, no slash, no leading dot,
 * nothing a path could smuggle. Spelled out here (rather than imported) because it is part
 * of the schema text kept identical to the drafter's copy below.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Everything one drafter thread serves, as data: the wide read-only capture of the
 * repository at the work order's pin. The drafter imports no controller code: it verifies
 * this file and serves it. The workspace is captured HERE, so the drafter never sees the
 * repository, only the bytes the controller decided it should read.
 *
 * Deliberately a SECOND copy of the drafter's schema (`drafter/src/drafter-manifest.ts`)
 * rather than an import, kept identical by test (`test/drafter-manifest.test.ts`): the
 * drafter is the untrusted side and shares no source with the code that judges what it
 * writes.
 */
export const DrafterManifestSchema = z
  .object({
    version: z.literal(1),
    workOrderId: z.string().regex(CATALOG_ID),
    workspace: z
      .object({
        version: z.literal(1),
        source: z
          .object({
            version: z.literal(1),
            digest: z.string().regex(/^[a-f0-9]{64}$/),
            files: z.array(
              z
                .object({
                  path: z.string().min(1),
                  base64: z.string(),
                  executable: z.boolean(),
                })
                .strict(),
            ),
          })
          .strict(),
        environmentLinks: z.array(
          z.object({ path: z.string().min(1), target: z.string().min(1) }).strict(),
        ),
      })
      .strict(),
  })
  .strict()
export type DrafterManifest = z.infer<typeof DrafterManifestSchema>

export interface WriteDrafterManifestOptions {
  readonly workOrderId: string
  /** The full commit sha the wide capture is taken at. */
  readonly pin: string
  readonly repositoryRoot: string
  /** Where the manifest is written: the drafter's `FACTORY_DRAFTER_MANIFEST_DIR`. */
  readonly dir: string
  /** The app root the staging directory lives under; the controller's own by default. */
  readonly appRoot?: string
  readonly signal?: AbortSignal
}

export interface WrittenDrafterManifest {
  readonly path: string
  /** The captured source's digest: what the drafter thread's workspace intent will carry. */
  readonly sourceDigest: string
}

/**
 * Stage the wide capture at `pin`, capture it with the framework's own capture, and write
 * `<dir>/<workOrderId>.json`. The staging directory is per call
 * (`.factory/captures/drafter/<workOrderId>.<instance>`, the naming `captureDirectory`
 * uses) and removed once the capture has read the bytes into the definition, on failure
 * too: nothing of the repository is left under the controller beside the manifest itself.
 * `ensurePin` runs first so a shallow checkout fetches the pin before the listing.
 */
export async function writeDrafterManifest(
  options: WriteDrafterManifestOptions,
): Promise<WrittenDrafterManifest> {
  const { workOrderId, pin, repositoryRoot, dir } = options
  if (!isCatalogId(workOrderId))
    throw new Error(`drafter manifest workOrderId must be a catalog id, got ${workOrderId}`)
  const appRoot = options.appRoot ?? defaultAppRoot
  ensurePin(repositoryRoot, "drafter", pin)
  const instance = randomUUID()
  const instanceDir = `.factory/captures/drafter/${workOrderId}.${instance}`
  let workspace: Awaited<ReturnType<typeof captureWorkspaceDefinition>>
  try {
    const definition = stageWideCapture(repositoryRoot, pin, instanceDir, { appRoot })
    workspace = await captureWorkspaceDefinition(appRoot, definition, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  } finally {
    rmSync(join(appRoot, instanceDir), { recursive: true, force: true })
  }
  // Parsed, not merely typed: the controller validates what it writes against the SAME
  // schema the drafter will apply to it, so a manifest the drafter would refuse cannot be
  // produced here in the first place.
  const manifest: DrafterManifest = DrafterManifestSchema.parse({
    version: 1,
    workOrderId,
    workspace,
  })
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${workOrderId}.json`)
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return { path, sourceDigest: manifest.workspace.source.digest }
}

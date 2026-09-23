import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"

/**
 * A work order's id is a catalog id: a plain directory name, no slash, no leading dot,
 * nothing a path could smuggle. `loadDrafterManifest` joins it under a directory, and this
 * rule is what keeps it under one. Copied from the controller's `isCatalogId`
 * (`controller/src/lib/targets/catalog.ts`) rather than imported: the drafter is the untrusted
 * side and shares no source with the code that judges what it writes.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * What one drafter thread is told to serve: the wide read-only capture of the repository at
 * the work order's pin, already captured by the controller. Deliberately a SECOND copy of the
 * controller's schema rather than an import, and the controller's own test asserts the two
 * schema texts are identical.
 *
 * `workspace` models exactly what `verifyCapturedWorkspaceDefinition` consumes, key by key
 * and `.strict()` throughout, rather than as `unknown`: a manifest carrying a `baseline`
 * (the drafter's capture has none: there is no `.git` to diff against) or an unknown key is
 * refused at parse time, before the framework's verifier sees it.
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

/**
 * The directory the controller writes manifests into, one `<workOrderId>.json` per work
 * order. Read at boot so a misconfigured process refuses to start; the directory itself may
 * be empty or absent at that point, because refusal is per thread, at resolve time.
 */
export function drafterManifestDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.FACTORY_DRAFTER_MANIFEST_DIR
  if (!dir)
    throw new Error(
      "FACTORY_DRAFTER_MANIFEST_DIR is required: the directory the controller writes drafter manifests into",
    )
  return resolve(dir)
}

/**
 * The one fact a drafter thread is created with. Thread metadata is client input: nothing in
 * it is trusted beyond this one key being a catalog-id string.
 */
export function workOrderIdOf(metadata: Readonly<Record<string, unknown>>): string {
  const id = metadata.factoryWorkOrderId
  if (typeof id !== "string" || !CATALOG_ID.test(id))
    throw new Error(
      "thread metadata factoryWorkOrderId must be a catalog id: a plain name with no slash and no leading dot",
    )
  return id
}

export async function loadDrafterManifest(
  dir: string,
  workOrderId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<DrafterManifest> {
  // Re-checked here so the join is safe whatever the caller validated.
  if (!CATALOG_ID.test(workOrderId))
    throw new Error(`drafter manifest workOrderId must be a catalog id, got ${workOrderId}`)
  const path = join(dir, `${workOrderId}.json`)
  let text: string
  try {
    text = await readFile(path, { encoding: "utf8", ...options })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`no drafter manifest for ${workOrderId} in ${dir}`, { cause: error })
    throw error
  }
  let manifest: DrafterManifest
  try {
    manifest = DrafterManifestSchema.parse(JSON.parse(text))
  } catch (error) {
    throw new Error(
      `drafter manifest ${path} is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  if (manifest.workOrderId !== workOrderId)
    throw new Error(
      `drafter manifest ${path} names workOrderId ${manifest.workOrderId}, not ${workOrderId}`,
    )
  return manifest
}

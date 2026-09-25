import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"

/**
 * A work order's id and a target's id are catalog ids: a plain directory name, no slash, no
 * leading dot, nothing a path could smuggle. `loadBuilderManifest` joins a work order id under
 * a directory, and this rule is what keeps it under one. Copied from the controller's
 * `isCatalogId` rather than imported: the builder is the untrusted side and shares no source
 * with the code that judges what it leaves behind.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * An image the factory prepared: `b4-factory-<target>:<pin[:12]>-<dockerfile[:12]>`, the tag
 * `imageTag` writes and the verifier runs. The builder's provider allows no other image, so a
 * manifest can choose among the factory's own images and nothing else.
 */
const FACTORY_IMAGE = /^b4-factory-[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{12}-[0-9a-f]{12}$/

/**
 * The builder's one input per thread, as data. Deliberately a SECOND copy of the controller's
 * schema rather than an import: the two packages share no source, and the controller's own
 * `builder-manifest.test.ts` asserts the two schema texts are identical.
 *
 * The MANIFEST is per work order: the controller writes `<dir>/<workOrderId>.json` before it
 * creates the thread, and the builder's `sandbox.thread` resolver hands its workspace, image,
 * policy and permissions to the framework, which records them at the thread's first admission.
 * One builder process serves every target at every pin.
 */
/**
 * One work order's builder thread, whole: the workspace the controller captured (the target's
 * pinned subtree with the task's defect applied), and what the retired per-process target file
 * carried: the image the task is verified in, the pin it was prepared at, the sandbox policy
 * and the permission allow-list. The builder hands the target block to the framework as the
 * thread's sandbox, recorded at the thread's first admission. No prompt: the task's prompt is
 * the run's user message, which the controller sends with the run.
 *
 * Strict throughout, and narrower than the framework: a key this schema does not model is a
 * refusal at admission, never a silent drop to a broader default (a misspelled `netwrok` would
 * otherwise leave the thread under the app's network rather than the one the controller
 * wrote). The network is `deny` only (the builder app denies it too, and a thread may not open
 * what its app denies), with no `allowlist` or `denylist`; the image must be one the factory
 * prepared; a pattern that is empty or only whitespace, which names nothing, is refused.
 */
export const BuilderManifestSchema = z
  .object({
    version: z.literal(2),
    workOrderId: z.string().regex(CATALOG_ID),
    taskId: z.string().regex(CATALOG_ID),
    targetId: z.string().regex(CATALOG_ID),
    target: z
      .object({
        image: z.string().regex(FACTORY_IMAGE),
        /** The commit that image was prepared at. */
        pin: z.string().regex(/^[a-f0-9]{40}$/),
        policy: z
          .object({
            network: z.object({ mode: z.literal("deny") }).strict(),
            env: z.record(z.string(), z.string()),
            resources: z
              .object({
                memoryMb: z.number().int().positive(),
                cpus: z.number().positive(),
                timeoutMs: z.number().int().positive(),
              })
              .strict(),
          })
          .strict(),
        /** Keyed by tool name, so the key set is open; the values are always patterns naming something. */
        permissions: z.record(z.string(), z.array(z.string().regex(/\S/))),
      })
      .strict(),
    /**
     * Not modelled key by key, unlike the drafter's: a builder workspace carries
     * `baseline: "git"` and environment links (the drafter's has neither), and the
     * framework's `verifyCapturedWorkspaceDefinition` already parses the whole definition
     * with a strict shape (unknown keys refused) and checks every byte against the digest.
     * A second model here could only drift from that one.
     */
    workspace: z.unknown(),
  })
  .strict()
export type BuilderManifest = z.infer<typeof BuilderManifestSchema>

/** Whether `reference` is an image the factory prepared: the builder's `dockerSandbox({ images })`. */
export const isFactoryImage = (reference: string): boolean => FACTORY_IMAGE.test(reference)

const describe = (error: unknown) =>
  error instanceof z.ZodError
    ? z.prettifyError(error)
    : error instanceof Error
      ? error.message
      : String(error)

/**
 * The directory the controller writes manifests into, one `<workOrderId>.json` per work
 * order. Read at boot so a misconfigured process refuses to start; the directory itself may
 * be empty or absent at that point, because refusal is per thread, at resolve time.
 */
export function builderManifestDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.FACTORY_BUILDER_MANIFEST_DIR
  if (!dir)
    throw new Error(
      "FACTORY_BUILDER_MANIFEST_DIR is required: the directory the controller writes builder manifests into",
    )
  return resolve(dir)
}

/**
 * The one fact a builder thread is created with. Thread metadata is client input: nothing in
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

/**
 * `<dir>/<workOrderId>.json`, parsed. Any target's: the builder serves every target, and the
 * manifest itself names the image, policy and permissions its task was captured for.
 */
export async function loadBuilderManifest(
  dir: string,
  workOrderId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<BuilderManifest> {
  // Re-checked here so the join is safe whatever the caller validated.
  if (!CATALOG_ID.test(workOrderId))
    throw new Error(`builder manifest workOrderId must be a catalog id, got ${workOrderId}`)
  const path = join(dir, `${workOrderId}.json`)
  let text: string
  try {
    text = await readFile(path, { encoding: "utf8", ...options })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`no builder manifest for ${workOrderId} in ${dir}`, { cause: error })
    throw error
  }
  let manifest: BuilderManifest
  try {
    manifest = BuilderManifestSchema.parse(JSON.parse(text))
  } catch (error) {
    throw new Error(`builder manifest ${path} is invalid: ${describe(error)}`, { cause: error })
  }
  if (manifest.workOrderId !== workOrderId)
    throw new Error(
      `builder manifest ${path} names workOrderId ${manifest.workOrderId}, not ${workOrderId}`,
    )
  return manifest
}

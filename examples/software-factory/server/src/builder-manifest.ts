import { readFileSync } from "node:fs"
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
 * The builder's two inputs, as data. Deliberately a SECOND copy of the controller's schemas
 * rather than an import: the two packages share no source, and the controller's own
 * `builder-manifest.test.ts` asserts the two schema texts are identical.
 *
 * The TARGET file is per process: the provider (scope and image), the sandbox policy and the
 * permissions are one per app in the framework, so one builder process serves one target and
 * reads them once, at boot. The MANIFEST is per work order: the only thing a thread can vary
 * is its workspace, and the controller writes `<dir>/<workOrderId>.json` before it creates the
 * thread.
 */
export const BuilderTargetSchema = z
  .object({
    version: z.literal(1),
    target: z
      .object({
        id: z.string().regex(CATALOG_ID),
        /** The two options `dockerSandbox` receives, and the whole of the provider's identity. */
        scope: z.string().min(1),
        image: z.string().min(1),
        /** The commit that image was prepared at; the controller compares each task's pin with it. */
        pin: z.string().regex(/^[a-f0-9]{40}$/),
        /**
         * The sandbox policy, modelled key by key and `.strict()` throughout rather than as an
         * opaque record. A misspelled `netwrok` or `modee` would otherwise parse, drop out of
         * the spread into `b4.config.ts`, and leave the builder running under the provider's
         * DEFAULT network instead of the denial the controller intended: a fail-open on a
         * typo. Strict parsing makes that a startup error instead.
         *
         * `network` is a discriminated union of the one key the controller emits, so a policy
         * carrying an `allowlist` or a `denylist` is refused rather than quietly honoured:
         * widening what the builder may be told costs an edit to both copies of this schema.
         * The framework's own `SandboxPolicy` is wider on purpose; this is the subset one
         * untrusted builder is allowed to be configured with.
         */
        policy: z
          .object({
            network: z.discriminatedUnion("mode", [
              z.object({ mode: z.literal("deny") }).strict(),
              z.object({ mode: z.literal("allow") }).strict(),
            ]),
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
        /** Keyed by tool name, so the key set is open; the values are always patterns. */
        permissions: z.record(z.string(), z.array(z.string())),
      })
      .strict(),
  })
  .strict()
export type BuilderTarget = z.infer<typeof BuilderTargetSchema>

/**
 * One work order's workspace: the target's pinned subtree with the task's defect applied,
 * captured by the controller. No prompt: the task's prompt is the run's user message, which
 * the controller sends with the run. `targetId` is what lets a builder refuse a work order
 * routed to the wrong process; `workspace` is left to `verifyCapturedWorkspaceDefinition`,
 * which checks it byte for byte against its own digest.
 */
export const BuilderManifestSchema = z
  .object({
    version: z.literal(1),
    workOrderId: z.string().regex(CATALOG_ID),
    taskId: z.string().regex(CATALOG_ID),
    targetId: z.string().regex(CATALOG_ID),
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

const describe = (error: unknown) =>
  error instanceof z.ZodError
    ? z.prettifyError(error)
    : error instanceof Error
      ? error.message
      : String(error)

/**
 * The target this builder process serves, from `FACTORY_BUILDER_TARGET`. Read once, at boot:
 * the provider, the policy and the permissions it carries cannot vary per thread.
 */
export function loadBuilderTarget(env: NodeJS.ProcessEnv = process.env): BuilderTarget {
  const path = env.FACTORY_BUILDER_TARGET
  if (!path)
    throw new Error(
      "FACTORY_BUILDER_TARGET is required: the controller writes it with `factory builder-target`",
    )
  try {
    return BuilderTargetSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    throw new Error(`builder target ${path} is invalid: ${describe(error)}`, { cause: error })
  }
}

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
 * `<dir>/<workOrderId>.json`, parsed, for a builder serving `targetId`. A manifest for another
 * target is refused: the work order was routed to the wrong builder process, whose image,
 * policy and permissions are not the ones its task was captured for.
 */
export async function loadBuilderManifest(
  dir: string,
  workOrderId: string,
  targetId: string,
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
  if (manifest.targetId !== targetId)
    throw new Error(
      `builder manifest ${path} is for target ${manifest.targetId}, but this builder serves ${targetId}`,
    )
  return manifest
}

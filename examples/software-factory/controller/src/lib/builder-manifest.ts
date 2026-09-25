import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"
import { writeFileAtomic } from "./storage/atomic-file.js"
import { captureDirectory } from "./targets/archive.js"
import { imageTag, isCatalogId, type Task } from "./targets/catalog.js"
import { builderPermissions } from "./targets/permissions.js"
import { targetSandboxPolicy, targetWorkspace } from "./targets/workspace.js"

/**
 * A work order's id and a target's id are catalog ids: a plain directory name, no slash, no
 * leading dot, nothing a path could smuggle. Spelled out here rather than imported from
 * `catalog.ts` because the schemas below refer to it by name and their text is kept identical
 * to the builder's copy; the test that pins the schema text pins this regex's source too.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * An image the factory prepared: `b4-factory-<target>:<pin[:12]>-<dockerfile[:12]>`, the tag
 * `imageTag` writes and the verifier runs. The builder's provider allows no other image, so a
 * manifest can choose among the factory's own images and nothing else.
 */
const FACTORY_IMAGE = /^b4-factory-[A-Za-z0-9][A-Za-z0-9._-]*:[0-9a-f]{12}-[0-9a-f]{12}$/

/**
 * Everything the builder app's `b4.config.ts` needs for one thread, as data, in one file per
 * work order: the builder's only input. The builder imports no controller code: it verifies the
 * file and serves it. The workspace is captured HERE, so the builder never sees the target
 * archive or the task catalog, only the bytes the controller decided it should start from.
 *
 * `dispatch` writes the manifest into the builder's manifest directory before it creates the
 * thread. Deliberately a SECOND copy of the builder's schema (`server/src/builder-manifest.ts`)
 * rather than an import, kept identical by test (`test/builder-manifest.test.ts`).
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

/** Where the manifest for `workOrderId` lives under `dir`: the name the builder's resolver reads. */
function builderManifestPath(dir: string, workOrderId: string): string {
  if (!CATALOG_ID.test(workOrderId))
    throw new Error(`builder manifest workOrderId must be a catalog id, got ${workOrderId}`)
  return join(dir, `${workOrderId}.json`)
}

interface WriteBuilderManifestOptions {
  /** The file name and the id the builder's resolver is asked for; the task's id by default. */
  readonly workOrderId?: string
  /**
   * The capture root the staging directory lives under: the controller's `FACTORY_STATE_DIR`,
   * never its app root, which `b4 dev` watches (see `CaptureTargetOptions.captureRoot`).
   */
  readonly captureRoot: string
  readonly signal?: AbortSignal
}

export interface WrittenBuilderManifest {
  readonly path: string
  /** The captured source's digest: what the builder thread's workspace intent will carry. */
  readonly sourceDigest: string
}

/**
 * Capture `task`'s workspace (the target's pinned subtree with the task's defect applied) and
 * write `<dir>/<workOrderId>.json`. The staging directory is per call
 * (`captureDirectory(taskId, "builder", instance)`) and removed once the capture has read the
 * bytes into the definition, on failure too: two work orders of one task dispatched at once
 * must never share (and so tamper with each other's) archive directory.
 *
 * Written compact: it is machine-read only, and lives until the builder thread's first run
 * admits it (`dispatch` removes it once the row leaves the build states).
 */
export async function writeBuilderManifest(
  task: Task,
  dir: string,
  options: WriteBuilderManifestOptions,
): Promise<WrittenBuilderManifest> {
  const workOrderId = options.workOrderId ?? task.id
  if (!isCatalogId(workOrderId))
    throw new Error(`builder manifest workOrderId must be a catalog id, got ${workOrderId}`)
  options.signal?.throwIfAborted()
  const { captureRoot } = options
  const instance = randomUUID()
  let workspace: Awaited<ReturnType<typeof captureWorkspaceDefinition>>
  try {
    const definition = targetWorkspace(task, "builder", { instance, captureRoot })
    workspace = await captureWorkspaceDefinition(captureRoot, definition, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  } finally {
    rmSync(join(captureRoot, captureDirectory(task.id, "builder", instance)), {
      recursive: true,
      force: true,
    })
  }
  const manifest: BuilderManifest = BuilderManifestSchema.parse({
    version: 2,
    workOrderId,
    taskId: task.id,
    targetId: task.target.id,
    target: {
      image: imageTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    },
    workspace,
  })
  await mkdir(dir, { recursive: true })
  const path = builderManifestPath(dir, workOrderId)
  await writeFileAtomic(path, `${JSON.stringify(manifest)}\n`)
  return { path, sourceDigest: workspace.source.digest }
}

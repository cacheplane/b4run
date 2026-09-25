import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { join } from "node:path"
import type { CapturedWorkspaceDefinition, StagedWorkspaceReference } from "@b4run/workspace"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"
import { captureDirectory } from "./targets/archive.js"
import { isCatalogId, type TaskRecipe } from "./targets/catalog.js"
import { recipeTag } from "./targets/images.js"
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
 * A tag in the factory's shape: `b4-factory-<target>:<pin[:12]>-<dockerfile[:12]>`, the tag
 * `imageTag` writes and the verifier runs, with the target and the pin prefix captured. The
 * builder's provider allows no other shape, and the handoff schema requires the captured
 * target and pin prefix to be the handoff's own `targetId` and `pin`. That bounds a handoff
 * to an image present on the daemon under a tag naming its own target and pin; it does not
 * prove the image is the one `target:prepare` built (anyone who can tag an image on the
 * daemon can already run anything as root there).
 */
const FACTORY_IMAGE = /^b4-factory-([A-Za-z0-9][A-Za-z0-9._-]*):([0-9a-f]{12})-[0-9a-f]{12}$/

/**
 * Everything the builder app's `b4.config.ts` needs for one thread besides its files, as data:
 * the builder's only input, carried in the thread's metadata under `factoryBuilder`. The
 * builder imports no controller code: it parses the handoff, checks that the workspace it was
 * handed is the one named here, and serves it. The workspace is captured HERE, so the builder
 * never sees the target archive or the task catalog, only the bytes the controller decided it
 * should start from, uploaded to it before the thread is created.
 *
 * Deliberately a SECOND copy of the builder's schema (`server/src/builder-handoff.ts`)
 * rather than an import, kept identical by test (`test/builder-handoff.test.ts`).
 */
/**
 * One work order's builder thread, whole: the reference its workspace is staged under (the
 * target's pinned subtree with the task's defect applied, captured by the controller), and
 * what the retired per-process target file carried: the image the task is verified in, the pin
 * it was prepared at, the sandbox policy and the permission allow-list. No prompt: the task's
 * prompt is the run's user message, which the controller sends with the run.
 *
 * Strict throughout, and narrower than the framework: a key this schema does not model is a
 * refusal at admission, never a silent drop to a broader default (a misspelled `netwrok` would
 * otherwise leave the thread under the app's network rather than the one the controller
 * wrote). The network is `deny` only (the builder app denies it too, and a thread may not open
 * what its app denies), with no `allowlist` or `denylist`; the image must be one the factory
 * prepared; a pattern that is empty or only whitespace, which names nothing, is refused.
 */
export const BuilderHandoffSchema = z
  .object({
    version: z.literal(3),
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
     * The reference the thread is created with (`POST /threads` `workspace`): the source's
     * digest, and the links and baseline, which the digest does not cover. The builder serves
     * the staged workspace only when all three are these (`stagedBuilderWorkspace`).
     */
    workspace: z
      .object({
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        environmentLinks: z.array(
          z.object({ path: z.string().min(1), target: z.string().min(1) }).strict(),
        ),
        baseline: z.literal("git").optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((handoff, ctx) => {
    // The tag's target and pin segments must be this handoff's own: a work order may not
    // run in another target's image, or in its own target's image at another pin.
    const [, target, pin] = FACTORY_IMAGE.exec(handoff.target.image) ?? []
    if (target !== handoff.targetId || pin !== handoff.target.pin.slice(0, 12))
      ctx.addIssue({
        code: "custom",
        path: ["target", "image"],
        message: `image ${handoff.target.image} is not target ${handoff.targetId} at pin ${handoff.target.pin}: a factory tag names b4-factory-${handoff.targetId}:${handoff.target.pin.slice(0, 12)}-<dockerfile>`,
      })
  })
export type BuilderHandoff = z.infer<typeof BuilderHandoffSchema>

/** Whether `reference` is an image the factory prepared: the builder's `dockerSandbox({ images })`. */
export const isFactoryImage = (reference: string): boolean => FACTORY_IMAGE.test(reference)

/** What `POST /threads` names: the links and baseline, which the source digest does not cover. */
export function stagedReferenceOf(
  workspace: CapturedWorkspaceDefinition,
): StagedWorkspaceReference {
  return {
    sourceDigest: workspace.source.digest,
    environmentLinks: workspace.environmentLinks.map((link) => ({
      path: link.path,
      target: link.target,
    })),
    ...(workspace.baseline !== undefined ? { baseline: workspace.baseline } : {}),
  }
}

export interface CaptureBuilderHandoffOptions {
  /** The id the builder's resolver checks the handoff against; the task's id by default. */
  readonly workOrderId?: string
  /**
   * The capture root the staging directory lives under: the controller's `FACTORY_STATE_DIR`,
   * never its app root, which `b4 dev` watches (see `CaptureTargetOptions.captureRoot`).
   */
  readonly captureRoot: string
  readonly signal?: AbortSignal
  /**
   * The image tag the handoff names: the work order's bound tag (`image_bound`). This host's
   * recipe tag for the task when absent (`recipeTag`), which is what `factory builder-handoff`
   * writes for a lane with no controller.
   */
  readonly tag?: string
}

export interface CapturedBuilderHandoff {
  readonly handoff: BuilderHandoff
  /** The captured workspace: its `source` is what `dispatch` uploads to the builder. */
  readonly workspace: CapturedWorkspaceDefinition
}

/**
 * Capture `task`'s workspace (the target's pinned subtree with the task's defect applied) and
 * its handoff. Nothing is written: `dispatch` uploads the source and creates the thread with
 * the handoff. The staging directory is per call (`captureDirectory(taskId, "builder",
 * instance)`) and removed once the capture has read the bytes into the definition, on failure
 * too: two work orders of one task dispatched at once must never share (and so tamper with
 * each other's) archive directory.
 */
export async function captureBuilderHandoff(
  task: TaskRecipe,
  options: CaptureBuilderHandoffOptions,
): Promise<CapturedBuilderHandoff> {
  const workOrderId = options.workOrderId ?? task.id
  if (!isCatalogId(workOrderId))
    throw new Error(`builder handoff workOrderId must be a catalog id, got ${workOrderId}`)
  options.signal?.throwIfAborted()
  const { captureRoot } = options
  const instance = randomUUID()
  let workspace: CapturedWorkspaceDefinition
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
  // Parsed, not merely typed: the controller checks what it sends against the SAME schema the
  // builder will apply to it, so a handoff the builder would refuse cannot be produced here.
  const handoff = BuilderHandoffSchema.parse({
    version: 3,
    workOrderId,
    taskId: task.id,
    targetId: task.target.id,
    workspace: stagedReferenceOf(workspace),
    target: {
      image: options.tag ?? recipeTag(task.target),
      pin: task.target.pin,
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    },
  })
  return { handoff, workspace }
}

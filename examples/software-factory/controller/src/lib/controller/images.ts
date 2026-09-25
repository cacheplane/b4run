import { z } from "zod"
import type { FactoryEvent } from "../domain/work-order.js"
import {
  commitSha,
  configuredImages,
  ImageSchema,
  ImagesUnconfiguredError,
  type TargetRecipe,
} from "../targets/catalog.js"
import { type EnsuredImage, ImagePrepareError, type ImageRegistry } from "../targets/images.js"
import type { ControllerContext } from "./context.js"

/**
 * The image a work order runs in, as journalled (`image_bound`): the target, the pin, the
 * registry key and tag, and the image object whose `localId` the builder and the verifier
 * must run. The LAST binding is the binding: intake rebinds on every attempt.
 */
export const BoundImageSchema = z
  .object({
    targetId: z.string().min(1),
    pin: commitSha,
    key: z.string().regex(/^[a-f0-9]{64}$/),
    tag: z.string().min(1),
    image: ImageSchema,
  })
  .strict()
export type BoundImage = z.infer<typeof BoundImageSchema>

export function boundImageOf(events: readonly FactoryEvent[]): BoundImage | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as FactoryEvent
    if (event.type === "image_bound") return BoundImageSchema.parse(event.payload)
  }
  return undefined
}

/**
 * The `image_changed` payload when `bound` names another target or pin than the task being
 * graded, else null: an image bound for one target is never evidence about another's task.
 */
export function bindingMoved(
  bound: BoundImage,
  target: { readonly id: string; readonly pin: string },
  phase: string,
): Record<string, unknown> | null {
  if (bound.targetId === target.id && bound.pin === target.pin) return null
  return {
    reason: "target_moved",
    bound: { targetId: bound.targetId, pin: bound.pin },
    task: { targetId: target.id, pin: target.pin },
    phase,
  }
}

/** The registry the factory builds through: the one `loadTarget` reads, never a second one. */
export function requireImages(): ImageRegistry {
  const registry = configuredImages()
  if (registry === undefined) throw new ImagesUnconfiguredError()
  return registry
}

export type WorkOrderImage =
  | { readonly ok: true; readonly bound: BoundImage }
  | { readonly ok: false; readonly kind: "failed" | "changed" | "aborted"; readonly reason: string }

export interface PrepareWorkOrderImageOptions {
  /**
   * Intake: every attempt builds (or re-verifies) and binds what it proves its oracle in.
   * Dispatch: a work order already bound keeps its binding while the daemon holds that image
   * (D5), and only an unbound one prepares and binds.
   */
  readonly rebind: boolean
}

/**
 * The image work order `id` runs in. Bound already (and not rebinding): the bound image, if
 * the daemon still holds it, else `image_changed`. Otherwise `recipe`'s image (a target at the
 * work order's pin): the registry's recorded image re-verified on the daemon, or a build of it,
 * sharing any build of the same recipe in flight; journalled (`image_prepare_started` with its
 * wait bound, `image_prepared`, `image_prepare_failed`, `image_prepare_aborted`,
 * `image_missing`), its log stored as evidence, the work order's budget paused while a build
 * runs for it, and the result bound (`image_bound`).
 */
export async function prepareWorkOrderImage(
  ctx: ControllerContext,
  id: string,
  recipe: TargetRecipe,
  signal: AbortSignal,
  options: PrepareWorkOrderImageOptions,
): Promise<WorkOrderImage> {
  if (!options.rebind) {
    const bound = boundImageOf(ctx.store.events(id))
    if (bound !== undefined) {
      if (await requireImages().present(bound.image.localId, signal)) return { ok: true, bound }
      ctx.recordEvent(id, "image_changed", {
        bound: bound.image.localId,
        boundKey: bound.key,
        reason: "gone",
      })
      return {
        ok: false,
        kind: "changed",
        reason: `work order ${id} is bound to image ${bound.image.localId} (target ${bound.targetId} at ${bound.pin}), the one an earlier phase ran in, and this host no longer holds it: running and verifying in a rebuild would bind two environments. Cancel it and create a new work order`,
      }
    }
  }
  const need = { targetId: recipe.id, pin: recipe.pin }
  // Paused only when a build starts or is joined for this work order: re-verifying a recorded
  // image takes milliseconds and is the work order's own time.
  let paused = false
  let ensured: EnsuredImage
  try {
    ensured = await requireImages().ensure(recipe, {
      signal,
      onMissing: ({ key, localId }) =>
        ctx.recordEvent(id, "image_missing", { ...need, key, localId }),
      onBuild: ({ key, shared, deadlineMs }) => {
        ctx.recordEvent(id, "image_prepare_started", { ...need, key, shared, deadlineMs })
        paused = ctx.pauseBudget(id, "image_prepare")
      },
    })
  } catch (error) {
    if (signal.aborted) {
      ctx.recordEvent(id, "image_prepare_aborted", { ...need, reason: String(signal.reason) })
      return { ok: false, kind: "aborted", reason: "the image build was abandoned" }
    }
    const log = error instanceof ImagePrepareError ? error.log : ""
    const logDigest = log === "" ? null : (await ctx.artifacts.put(log)).digest
    const message = error instanceof Error ? error.message : String(error)
    ctx.recordEvent(id, "image_prepare_failed", {
      ...need,
      ...(error instanceof ImagePrepareError && error.key !== "" ? { key: error.key } : {}),
      error: message,
      logDigest,
    })
    return {
      ok: false,
      kind: "failed",
      reason: `the image of target ${recipe.id} at ${recipe.pin} could not be built: ${message}${logDigest === null ? "" : ` (build log: artifact ${logDigest})`}`,
    }
  } finally {
    if (paused) ctx.resumeBudget(id, "image_prepare")
  }
  if (ensured.build !== undefined) {
    const log = ensured.build.log === "" ? "(no output)\n" : ensured.build.log
    ctx.recordEvent(id, "image_prepared", {
      ...need,
      key: ensured.key,
      tag: ensured.tag,
      localId: ensured.image.localId,
      shared: ensured.build.shared,
      ms: ensured.build.ms,
      logDigest: (await ctx.artifacts.put(log)).digest,
    })
  }
  const bound: BoundImage = { ...need, key: ensured.key, tag: ensured.tag, image: ensured.image }
  ctx.recordEvent(id, "image_bound", { ...bound })
  return { ok: true, bound }
}

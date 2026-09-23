import { existsSync, rmSync } from "node:fs"
import type { ControllerContext } from "./context.js"

/** The two workers the controller writes per-work-order manifests for. */
export type ManifestRole = "drafter" | "builder"

/**
 * Remove the manifest the journal says this work order's `role` manifest was last written to
 * (`<role>_manifest_written.path`). The journal, not the worker map, is the authority: the
 * map can have changed since the write (a worker entry removed, a directory reconfigured),
 * and recomputing the path from it would miss the file, or throw and say nothing. The
 * resolver reads a manifest once, when the thread's first run is admitted, so it is dead
 * weight from then on. A removal that fails is journalled (`<role>_manifest_remove_failed`)
 * and never fails the command that asked for it: the manifest is not evidence, and a stale
 * one costs disk, not correctness. Nothing to remove (never written, or already gone) is not
 * journalled: the line says a file was removed, and it was not.
 */
export function removeJournalledManifest(
  ctx: ControllerContext,
  id: string,
  role: ManifestRole,
): void {
  let path: string | undefined
  try {
    const written = ctx.store
      .events(id)
      .filter((event) => event.type === `${role}_manifest_written`)
      .at(-1)?.payload.path
    path = typeof written === "string" ? written : undefined
    if (path === undefined || !existsSync(path)) return
    rmSync(path, { force: true })
    ctx.recordEvent(id, `${role}_manifest_removed`, { path })
  } catch (error) {
    ctx.recordEvent(id, `${role}_manifest_remove_failed`, {
      ...(path !== undefined ? { path } : {}),
      error: String(error),
    })
  }
}

/**
 * The same removal, for a command that wrote the manifest and then failed to hand it to a
 * thread (thread creation failed, or the row moved while the thread was being made). The
 * file is `<dir>/<id>.json` whoever wrote it, so a concurrent command under another key (a
 * second dispatch, an intake after a reject) may own it by now: it is removed only while the
 * row holds no thread, or holds `ownThreadId`, and kept (journalled) otherwise.
 */
export function removeOwnManifest(
  ctx: ControllerContext,
  id: string,
  role: ManifestRole,
  ownThreadId: string | null,
): void {
  const holder = ctx.mustGet(id).workerThreadId
  if (holder !== null && holder !== ownThreadId) {
    ctx.recordEvent(id, `${role}_manifest_kept`, { threadId: holder })
    return
  }
  removeJournalledManifest(ctx, id, role)
}

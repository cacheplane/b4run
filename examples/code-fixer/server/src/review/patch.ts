import { createTwoFilesPatch, FILE_HEADERS_ONLY } from "diff"

export class PatchRejectedError extends Error {
  override name = "PatchRejectedError"
}

export function collectChanges(
  baseline: Record<string, string>,
  target: Record<string, string>,
  allowed: readonly string[],
): Record<string, string> {
  if (JSON.stringify(Object.keys(baseline).sort()) !== JSON.stringify(Object.keys(target).sort()))
    throw new PatchRejectedError(
      `Changed file inventory: added ${Object.keys(target)
        .filter((p) => !Object.hasOwn(baseline, p))
        .join(", ")}; removed ${Object.keys(baseline)
        .filter((p) => !Object.hasOwn(target, p))
        .join(", ")}`,
    )
  const changes: Record<string, string> = {}
  let bytes = 0
  for (const [path, value] of Object.entries(target)) {
    if (value === baseline[path]) continue
    if (!allowed.includes(path)) throw new PatchRejectedError(`Immutable file changed: ${path}`)
    bytes += Buffer.byteLength(value)
    if (bytes > 1024 * 1024) throw new PatchRejectedError("Patch exceeds 1 MiB")
    changes[path] = value
  }
  return changes
}

/** Contextual unified diff built from validated source bytes. */
export function renderReviewDiff(
  baseline: Record<string, string>,
  changes: Record<string, string>,
): string {
  return Object.keys(changes)
    .sort()
    .map((path) => {
      const before = baseline[path]
      const after = changes[path]
      if (before === undefined || after === undefined)
        throw new PatchRejectedError("Missing review source")
      const patch = createTwoFilesPatch(
        `a/${path}`,
        `b/${path}`,
        before,
        after,
        undefined,
        undefined,
        {
          context: 3,
          timeout: 1000,
          headerOptions: FILE_HEADERS_ONLY,
        },
      )
      if (patch === undefined) throw new PatchRejectedError("Review diff exceeded its time limit")
      return patch
    })
    .join("")
}

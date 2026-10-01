import { z } from "zod"

/** Every `/`-separated segment is non-empty and neither `.` nor `..`. */
export function hasCanonicalSegments(segments: readonly string[]): boolean {
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
}

/**
 * C0 and C1 controls and the line and paragraph separators. A path is shown to people (a
 * drafter names its check file, and `factory review` prints it as a title), and one carrying a
 * terminal escape or a line break could erase lines or fake a title; no real path needs one.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the controls is the point
export const PATH_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u

/**
 * A relative, forward-slash path with one spelling: no leading slash, no trailing slash,
 * no `.`/`..`/empty segment, no backslash and no control character. Downstream code compares
 * paths by string equality, so two spellings of the same path would silently fail that
 * comparison.
 */
export const relativePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.endsWith("/") &&
      !p.includes("\\") &&
      !PATH_CONTROL.test(p) &&
      hasCanonicalSegments(p.split("/")),
    {
      message:
        "must be a relative forward-slash path with one spelling, no trailing slash and no control characters",
    },
  )

/** A repository directory: the root (`.`) or one canonical relative path. */
export const rootOrRelativePath = z.union([z.literal("."), relativePath])

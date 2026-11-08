import type { LessonSource } from "./lesson-types"
export function validateSource(text: string, source: LessonSource): string[] {
  if (
    !/^[a-f0-9]{40}$/.test(source.revision) ||
    !source.path.startsWith("examples/navlog/") ||
    source.path.split("/").some((part) => part === ".." || part.startsWith("."))
  )
    throw new Error("Invalid source metadata")
  if (new TextEncoder().encode(text).length > 256_000) throw new Error("Source is too large")
  const lines = text.split("\n")
  for (const range of source.ranges)
    if (
      !Number.isInteger(range.start) ||
      !Number.isInteger(range.end) ||
      range.start < 1 ||
      range.end < range.start ||
      range.end > lines.length
    )
      throw new Error("Invalid source range")
  return lines
}

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { parseCapture } from "../../../lib/turn-inspector/capture-schema"
import { INSPECTOR_LESSONS } from "../../../lib/turn-inspector/lessons"
import { validateSource } from "../../../lib/turn-inspector/source"

const asset = (digest: string, extension: string) => {
  const bytes = readFileSync(
    new URL(`../../../public/docs-recordings/${digest}.${extension}`, import.meta.url),
  )
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest)
  return bytes.toString("utf8")
}
test("every public lesson references a live verified capture and pinned source assets", () => {
  expect(new Set(INSPECTOR_LESSONS.map((l) => l.id)).size).toBe(INSPECTOR_LESSONS.length)
  for (const lesson of INSPECTOR_LESSONS) {
    const capture = parseCapture(asset(lesson.digest, "json"))
    expect(capture.provenance).toBe("live")
    expect(capture.id).toBe(lesson.id)
    expect(capture.revisions).toEqual(lesson.revisions)
    expect(capture.moments.map((m) => m.id)).toEqual(lesson.moments)
    expect(lesson.appBuild?.binaryDigest).toMatch(/^[a-f0-9]{64}$/)
    const transcript = lesson.transcript.match(/^\/docs-recordings\/([a-f0-9]{64})\.txt$/)
    expect(transcript).not.toBeNull()
    asset(transcript?.[1] ?? "", "txt")
    for (const source of lesson.sources) {
      expect(source.revision).toBe(lesson.revisions.example)
      validateSource(asset(source.digest, "txt"), source)
    }
  }
})

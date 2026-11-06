import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import { type Publication, publish } from "../../../../../scripts/docs-captures/publish"
import fixture from "./__fixtures__/synthetic-capture.json"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "capture-publish-"))
  dirs.push(dir)
  const capture = JSON.stringify({ ...fixture, provenance: "live" })
  const sha = (s: string) => createHash("sha256").update(s).digest("hex")
  writeFileSync(join(dir, "capture.json"), capture)
  writeFileSync(join(dir, "transcript.txt"), "Reviewed test transcript")
  const manifest: Publication = {
    captureFile: "capture.json",
    transcriptFile: "transcript.txt",
    sourceFiles: [],
    review: {
      reviewer: "Test",
      reviewedAt: "2026-11-06T00:00:00Z",
      notes: "Fixture only",
      dependencies: "Fixture",
    },
    lesson: {
      id: fixture.id,
      title: "Test",
      appBuild: {
        flavor: "beta",
        version: "test",
        binaryDigest: "d".repeat(64),
        sourceRevision: null,
      },
      digest: sha(capture),
      revisions: fixture.revisions,
      lessonHref: "/docs/app/conversations",
      transcript: `/docs-recordings/${sha("Reviewed test transcript")}.txt`,
      moments: fixture.moments.map((m) => m.id),
      sources: [],
    },
  }
  return { dir, manifest, sha }
}
test("dry run validates without writing; publication refuses altered existing bytes", () => {
  const { dir, manifest } = setup()
  const output = join(dir, "out")
  expect(publish(manifest, dir, output)).toHaveLength(2)
  expect(() => readFileSync(join(output, `${manifest.lesson.digest}.json`))).toThrow()
  publish(manifest, dir, output, false)
  writeFileSync(join(output, `${manifest.lesson.digest}.json`), "altered")
  expect(() => publish(manifest, dir, output, false)).toThrow(/replace/)
})
test("rejects synthetic captures and unreviewed manifests", () => {
  const { dir, manifest, sha } = setup()
  manifest.review.notes = ""
  expect(() => publish(manifest, dir, join(dir, "out"))).toThrow(/review/)
  manifest.review.notes = "Reviewed"
  const bytes = JSON.stringify(fixture)
  writeFileSync(join(dir, "capture.json"), bytes)
  manifest.lesson.digest = sha(bytes)
  expect(() => publish(manifest, dir, join(dir, "out"))).toThrow(/Synthetic/)
})

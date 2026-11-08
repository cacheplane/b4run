import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseCapture } from "../../apps/web/lib/turn-inspector/capture-schema"
import type { InspectorLesson } from "../../apps/web/lib/turn-inspector/lesson-types"
import { stateAt } from "../../apps/web/lib/turn-inspector/replay"
import { validateSource } from "../../apps/web/lib/turn-inspector/source"
import { assertSafeText, assertSafeValues } from "./sanitize"
export interface Publication {
  lesson: InspectorLesson
  captureFile: string
  transcriptFile: string
  sourceFiles: string[]
  review: { reviewer: string; reviewedAt: string; notes: string; dependencies: string }
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
export function preparePublication(manifest: Publication, base: string) {
  if (
    !manifest.review?.reviewer?.trim() ||
    !manifest.review.notes?.trim() ||
    !manifest.review.dependencies?.trim() ||
    !Number.isFinite(Date.parse(manifest.review.reviewedAt))
  )
    throw new Error("Documented manual review and dependency provenance are required")
  const lesson = manifest.lesson
  if (
    !lesson.appBuild ||
    !/^[a-f0-9]{64}$/.test(lesson.appBuild.binaryDigest) ||
    !lesson.appBuild.version ||
    (lesson.appBuild.sourceRevision !== null &&
      !/^[a-f0-9]{40}$/.test(lesson.appBuild.sourceRevision))
  )
    throw new Error("Exact app build provenance is required")
  if (
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(lesson.id) ||
    !/^\/docs\/app\/[a-z0-9-]+$/.test(lesson.lessonHref)
  )
    throw new Error("Invalid lesson metadata")
  const bytes = readFileSync(resolve(base, manifest.captureFile))
  if (digest(bytes) !== lesson.digest) throw new Error("Capture digest mismatch")
  const capture = parseCapture(bytes.toString("utf8"))
  if (capture.provenance !== "live") throw new Error("Synthetic captures cannot be published")
  if (
    capture.id !== lesson.id ||
    Object.entries(lesson.revisions).some(
      ([key, value]) => capture.revisions[key as keyof typeof capture.revisions] !== value,
    )
  )
    throw new Error("Capture metadata mismatch")
  if (
    lesson.moments.length !== capture.moments.length ||
    lesson.moments.some((id) => !capture.moments.some((m) => m.id === id))
  )
    throw new Error("Moment manifest mismatch")
  const end = stateAt(capture, capture.events.length - 1)
  if (
    end.turns.some((turn) => turn.status !== "terminal") ||
    end.requests.some((request) => request.state === "pending")
  )
    throw new Error("Capture is not settled")
  assertSafeValues(capture)
  const assets = [{ name: `${lesson.digest}.json`, bytes }]
  const transcript = readFileSync(resolve(base, manifest.transcriptFile))
  assertSafeText(transcript.toString("utf8"))
  if (lesson.transcript !== `/docs-recordings/${digest(transcript)}.txt`)
    throw new Error("Transcript digest mismatch")
  assets.push({ name: `${digest(transcript)}.txt`, bytes: transcript })
  if (manifest.sourceFiles.length !== lesson.sources.length)
    throw new Error("Source allowlist mismatch")
  for (const [index, source] of lesson.sources.entries()) {
    const file = manifest.sourceFiles[index]
    if (!file) throw new Error("Missing source file")
    const bytes = readFileSync(resolve(base, file))
    if (digest(bytes) !== source.digest || source.revision !== lesson.revisions.example)
      throw new Error("Source revision or digest mismatch")
    const text = bytes.toString("utf8")
    validateSource(text, source)
    assertSafeText(text)
    if (source.ranges.some((r) => !lesson.moments.includes(r.moment)))
      throw new Error("Unknown source moment")
    assets.push({ name: `${source.digest}.txt`, bytes })
  }
  return assets
}
export function publish(manifest: Publication, base: string, destination: string, dryRun = true) {
  const assets = preparePublication(manifest, base)
  // Validate the entire set before writing anything. Immutable assets may be reused.
  for (const asset of assets) {
    const path = resolve(destination, asset.name)
    if (existsSync(path) && !readFileSync(path).equals(asset.bytes))
      throw new Error("Refusing to replace existing asset bytes")
  }
  if (!dryRun) {
    mkdirSync(destination, { recursive: true })
    for (const asset of assets) {
      const path = resolve(destination, asset.name)
      if (!existsSync(path)) writeFileSync(path, asset.bytes, { flag: "wx" })
    }
  }
  return assets.map((a) => ({ name: a.name, bytes: a.bytes.length }))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    i = args.indexOf("--manifest"),
    file = args[i + 1]
  if (i < 0 || !file)
    throw new Error("Usage: publish.ts --manifest <private-review.json> [--dry-run]")
  const manifest = JSON.parse(readFileSync(file, "utf8")) as Publication
  console.log(
    JSON.stringify(
      publish(
        manifest,
        dirname(resolve(file)),
        resolve("apps/web/public/docs-recordings"),
        args.includes("--dry-run"),
      ),
      null,
      2,
    ),
  )
}

import { readFile, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

import {
  probeFile,
  VIDEO_BYTE_LIMIT,
  validatePoster,
  validateVideoFile,
} from "../demo/check-media.mjs"

const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../../..")
const ARTIFACTS = "docs/brand/demo-rag/artifacts"

/**
 * The RAG take's media contract: one clip, `rag-loop`, as H.264 MP4 and VP9
 * WebM at exactly 1440x810 and 30 fps, 45–75 s, each at most 12,000,000
 * bytes, with a 1440x810 WebP poster. The navlog checker's own validators do
 * the checking (`../demo/check-media.mjs`).
 */
export const RAG_CLIP = Object.freeze({
  name: "rag-loop",
  minimumDuration: 45,
  maximumDuration: 75,
})

/** The output files of a run. */
export function ragOutputPaths(runRoot) {
  const output = join(runRoot, "output")
  return {
    mp4: join(output, `${RAG_CLIP.name}.mp4`),
    webm: join(output, `${RAG_CLIP.name}.webm`),
    poster: join(output, `${RAG_CLIP.name}-poster.webp`),
  }
}

/** Every contract failure for the run's files, as sentences; empty when they pass. */
export async function checkRagMedia(
  runRoot,
  { probe = probeFile, size = (path) => stat(path).then((s) => s.size) } = {},
) {
  const paths = ragOutputPaths(runRoot)
  const load = async (path) => {
    try {
      return { probe: await probe(path), size: await size(path) }
    } catch {
      return undefined
    }
  }
  const [mp4, webm, poster] = await Promise.all([
    load(paths.mp4),
    load(paths.webm),
    load(paths.poster),
  ])
  return [
    ...validateVideoFile({
      logicalPath: paths.mp4,
      file: mp4,
      clip: RAG_CLIP,
      expectedCodec: "h264",
      byteLimit: VIDEO_BYTE_LIMIT,
    }),
    ...validateVideoFile({
      logicalPath: paths.webm,
      file: webm,
      clip: RAG_CLIP,
      expectedCodec: "vp9",
      byteLimit: VIDEO_BYTE_LIMIT,
    }),
    ...validatePoster(paths.poster, poster),
  ]
}

/** The latest run's root, from `artifacts/latest.json`, which the capture writes after a passing check. */
export async function latestRunRoot(repoRoot = DEFAULT_REPO_ROOT) {
  const pointer = JSON.parse(await readFile(join(repoRoot, ARTIFACTS, "latest.json"), "utf8"))
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(pointer?.runId ?? "")) {
    throw new Error("artifacts/latest.json has an invalid run id")
  }
  return join(repoRoot, ARTIFACTS, "runs", pointer.runId)
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const runId = process.argv.slice(2).find((arg) => arg !== "--")
  const runRoot =
    runId === undefined ? await latestRunRoot() : join(DEFAULT_REPO_ROOT, ARTIFACTS, "runs", runId)
  const failures = await checkRagMedia(runRoot)
  if (failures.length > 0) {
    console.error(failures.join("\n"))
    process.exitCode = 1
  } else {
    console.log(`RAG take media pass: ${runRoot}`)
  }
}

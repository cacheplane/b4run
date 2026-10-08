import { execFile as nodeExecFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access as nodeAccess, readFile as nodeReadFile, stat as nodeStat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

import sharp from "sharp"

const execFile = promisify(nodeExecFile)
const DEFAULT_REPO_ROOT = resolve(import.meta.dirname, "../../..")
const VIDEO_BYTE_LIMIT = 2_000_000
const ANIMATION_BYTE_LIMIT = 4_000_000
const ANIMATION_WIDTH = 960
const ANIMATION_HEIGHT = 540
const ANIMATION_MAXIMUM_FPS = 15.5
const README_ANIMATION_PATH = "docs/brand/product-loop.webp"
const MEDIA_SCHEMA_VERSION = 1

export const MEDIA_CAPTIONS = Object.freeze({
  "product-loop":
    "Write the navlog agent's route, test it offline with npm test, run it in the B4.run Workbench, then reload it and see the same thread restored.",
})

export const MEDIA_CONTRACTS = Object.freeze(
  [{ name: "product-loop", minimumDuration: 12, maximumDuration: 18 }].map((contract) =>
    Object.freeze({
      ...contract,
      mp4: `docs/brand/demo/artifacts/output/${contract.name}.mp4`,
      webm: `docs/brand/demo/artifacts/output/${contract.name}.webm`,
      poster: `apps/web/public/demo/${contract.name}-poster.webp`,
      animation: README_ANIMATION_PATH,
    }),
  ),
)

function requireExactPath(actualPath, expectedPath, description) {
  if (typeof actualPath !== "string" || resolve(actualPath) !== resolve(expectedPath)) {
    throw new Error(`${description} must be inside the expected run output root at ${expectedPath}`)
  }
}

function validateLatestPointerLayout({ repoRoot, pointer }) {
  if (pointer?.schemaVersion !== MEDIA_SCHEMA_VERSION) {
    throw new Error(`unsupported latest-media schema ${pointer?.schemaVersion ?? "missing"}`)
  }
  if (typeof pointer.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(pointer.runId)) {
    throw new Error("latest-media pointer has an invalid run ID")
  }
  const runRoot = join(resolve(repoRoot), "docs/brand/demo/artifacts/runs", pointer.runId)
  const manifestPath = join(runRoot, "media-manifest.json")
  requireExactPath(pointer.manifestPath, manifestPath, "manifest path")
  return { runRoot, manifestPath }
}

export function validateMediaManifestLayout({ repoRoot, pointer, manifest }) {
  const { runRoot, manifestPath } = validateLatestPointerLayout({
    repoRoot,
    pointer,
  })
  if (manifest?.schemaVersion !== MEDIA_SCHEMA_VERSION) {
    throw new Error(`unsupported media manifest schema ${manifest?.schemaVersion ?? "missing"}`)
  }
  if (pointer.runId !== manifest.runId) {
    throw new Error("pointer and manifest run IDs differ")
  }
  const outputRoot = join(runRoot, "output")
  requireExactPath(manifest.outputRoot, outputRoot, "manifest output root")
  const publicationRoot = join(runRoot, "publication")
  for (const { name } of MEDIA_CONTRACTS) {
    const clip = manifest.clips?.[name]
    requireExactPath(clip?.mp4, join(outputRoot, `${name}.mp4`), `${name}.mp4`)
    requireExactPath(clip?.webm, join(outputRoot, `${name}.webm`), `${name}.webm`)
    requireExactPath(clip?.poster, join(publicationRoot, `${name}-poster.webp`), `${name} poster`)
    if (!/^[a-f0-9]{64}$/u.test(manifest.assetHashes?.posters?.[name] ?? "")) {
      throw new Error(`${name} poster hash is missing or invalid`)
    }
  }
  requireExactPath(
    manifest.animation,
    join(publicationRoot, "product-loop.webp"),
    "README animation",
  )
  if (!/^[a-f0-9]{64}$/u.test(manifest.assetHashes?.animation ?? "")) {
    throw new Error("README animation hash is missing or invalid")
  }
  return { runRoot, manifestPath, outputRoot, publicationRoot }
}

function videoStream(probe) {
  return probe?.streams?.find((stream) => stream.codec_type === "video")
}

function frameRate(value) {
  if (typeof value !== "string") return Number.NaN
  const [numerator, denominator] = value.split("/").map(Number)
  return denominator === 0 ? Number.NaN : numerator / denominator
}

function duration(probe) {
  const value = Number(probe?.format?.duration ?? videoStream(probe)?.duration)
  return Number.isFinite(value) ? value : Number.NaN
}

function validateVideoFile({ logicalPath, file, clip, expectedCodec, byteLimit }) {
  const failures = []
  if (file === undefined) {
    failures.push(`${logicalPath} is missing`)
    return failures
  }
  const stream = videoStream(file.probe)
  if (stream === undefined) {
    failures.push(`${logicalPath} has no video stream`)
    return failures
  }
  if (stream.width !== 1440 || stream.height !== 810) {
    failures.push(
      `${logicalPath} must be exactly 1440x810 (16:9); received ${stream.width ?? "unknown"}x${stream.height ?? "unknown"}`,
    )
  }
  const measuredFrameRate = frameRate(stream.avg_frame_rate)
  if (Math.abs(measuredFrameRate - 30) > 0.001) {
    failures.push(`${logicalPath} must be exactly 30 fps`)
  }
  if (stream.codec_name !== expectedCodec) {
    const codecLabel = expectedCodec === "h264" ? "H.264" : expectedCodec.toUpperCase()
    failures.push(`${logicalPath} must use ${codecLabel}`)
  }
  const measuredDuration = duration(file.probe)
  if (
    !Number.isFinite(measuredDuration) ||
    measuredDuration < clip.minimumDuration ||
    measuredDuration > clip.maximumDuration
  ) {
    failures.push(
      `${clip.name} must be ${clip.minimumDuration}-${clip.maximumDuration} seconds; ${logicalPath} is ${Number.isFinite(measuredDuration) ? measuredDuration : "unknown"}`,
    )
  }
  if (!Number.isSafeInteger(file.size) || file.size > byteLimit) {
    failures.push(`${logicalPath} must be at most ${byteLimit.toLocaleString("en-US")} bytes`)
  }
  return failures
}

/**
 * The README animation is an animated WebP, which ffprobe cannot read, so it
 * is validated from sharp's animated metadata. Identical consecutive frames
 * are merged by the encoder, which lowers the frame count and makes per-frame
 * delays uneven: only an upper bound on the effective frame rate is enforced.
 */
export function validateAnimation(logicalPath, file) {
  if (file === undefined) return [`${logicalPath} is missing`]
  const clip = MEDIA_CONTRACTS[0]
  const metadata = file.animation
  const failures = []
  if (metadata?.format !== "webp") {
    failures.push(`${logicalPath} must use animated WebP`)
  }
  const pages = metadata?.pages
  if (!Number.isSafeInteger(pages) || pages < 2) {
    failures.push(`${logicalPath} must be animated (more than one frame)`)
  }
  if (metadata?.width !== ANIMATION_WIDTH || metadata?.pageHeight !== ANIMATION_HEIGHT) {
    failures.push(
      `${logicalPath} must be exactly ${ANIMATION_WIDTH}x${ANIMATION_HEIGHT}; received ${metadata?.width ?? "unknown"}x${metadata?.pageHeight ?? "unknown"}`,
    )
  }
  if (metadata?.loop !== 0) {
    failures.push(`${logicalPath} must loop forever`)
  }
  const delays = metadata?.delay
  const measuredDuration =
    Array.isArray(delays) && delays.length > 0 && delays.every((delay) => Number.isFinite(delay))
      ? delays.reduce((total, delay) => total + delay, 0) / 1_000
      : Number.NaN
  if (
    !Number.isFinite(measuredDuration) ||
    measuredDuration < clip.minimumDuration ||
    measuredDuration > clip.maximumDuration
  ) {
    failures.push(
      `${clip.name} must be ${clip.minimumDuration}-${clip.maximumDuration} seconds; ${logicalPath} is ${Number.isFinite(measuredDuration) ? measuredDuration : "unknown"}`,
    )
  }
  if (
    Number.isSafeInteger(pages) &&
    Number.isFinite(measuredDuration) &&
    measuredDuration > 0 &&
    pages / measuredDuration > ANIMATION_MAXIMUM_FPS
  ) {
    failures.push(
      `${logicalPath} must be at most 15 fps; received ${(pages / measuredDuration).toFixed(2)} fps`,
    )
  }
  if (!Number.isSafeInteger(file.size) || file.size > ANIMATION_BYTE_LIMIT) {
    failures.push(
      `${logicalPath} must be at most ${ANIMATION_BYTE_LIMIT.toLocaleString("en-US")} bytes`,
    )
  }
  return failures
}

function captionClaimsScaffolding(caption) {
  return /\bscaffold(?:ed|ing|s)?\b/iu.test(caption)
}

function validatePoster(logicalPath, file) {
  if (file === undefined) return [`poster is missing: ${logicalPath}`]
  const failures = []
  const stream = videoStream(file.probe)
  if (stream?.codec_name !== "webp") {
    failures.push(`${logicalPath} must use WebP`)
  }
  if (stream?.width !== 1440 || stream?.height !== 810) {
    failures.push(`${logicalPath} must be exactly 1440x810`)
  }
  return failures
}

export async function validateLocalMediaContract({ files, captions }) {
  if (!(files instanceof Map)) throw new TypeError("files must be a Map")
  if (captions === null || typeof captions !== "object") {
    throw new TypeError("captions must be an object")
  }
  const failures = []
  for (const contract of MEDIA_CONTRACTS) {
    failures.push(
      ...validateVideoFile({
        logicalPath: contract.mp4,
        file: files.get(contract.mp4),
        clip: contract,
        expectedCodec: "h264",
        byteLimit: VIDEO_BYTE_LIMIT,
      }),
      ...validateVideoFile({
        logicalPath: contract.webm,
        file: files.get(contract.webm),
        clip: contract,
        expectedCodec: "vp9",
        byteLimit: VIDEO_BYTE_LIMIT,
      }),
    )
    failures.push(...validatePoster(contract.poster, files.get(contract.poster)))
    const caption = captions[contract.name]
    if (typeof caption !== "string" || caption.trim() === "") {
      failures.push(`${contract.name} caption is missing`)
    } else if (captionClaimsScaffolding(caption)) {
      failures.push(`${contract.name} caption must not claim scaffolding appears in the footage`)
    }
  }
  const flagship = MEDIA_CONTRACTS[0]
  failures.push(...validateAnimation(flagship.animation, files.get(flagship.animation)))
  const transcript = files.get("docs/brand/demo/transcript.md")
  if (
    transcript === undefined ||
    typeof transcript.text !== "string" ||
    transcript.text.trim() === ""
  ) {
    failures.push("media transcript is missing or empty")
  }
  return failures
}

export async function probeFile(path, { signal, exec = execFile } = {}) {
  signal?.throwIfAborted()
  try {
    const { stdout } = await exec(
      "ffprobe",
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
      { ...(signal !== undefined ? { signal } : {}) },
    )
    signal?.throwIfAborted()
    return JSON.parse(stdout)
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    throw error
  }
}

export async function readAnimationMetadata(path) {
  const { format, width, pageHeight, pages, delay, loop } = await sharp(path, {
    animated: true,
    limitInputPixels: false,
  }).metadata()
  return { format, width, pageHeight, pages, delay, loop }
}

async function hashFile(path, readFile = nodeReadFile) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}

async function readLatestManifest(repoRoot, readFile = nodeReadFile) {
  const pointerPath = join(repoRoot, "docs/brand/demo/artifacts/latest-media.json")
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"))
  if (typeof pointer.manifestPath !== "string") {
    throw new Error(`${pointerPath} does not name a media manifest`)
  }
  validateLatestPointerLayout({ repoRoot, pointer })
  const manifest = JSON.parse(await readFile(pointer.manifestPath, "utf8"))
  validateMediaManifestLayout({ repoRoot, pointer, manifest })
  return { pointer, manifest }
}

async function collectMediaFiles(
  repoRoot,
  manifest,
  {
    published,
    stat = nodeStat,
    access = nodeAccess,
    probe = probeFile,
    readAnimation = readAnimationMetadata,
    readFile = nodeReadFile,
    hash = (path) => hashFile(path, readFile),
    signal,
  } = {},
) {
  const files = new Map()
  for (const contract of MEDIA_CONTRACTS) {
    const clip = manifest.clips?.[contract.name]
    for (const [kind, logicalPath] of [
      ["mp4", contract.mp4],
      ["webm", contract.webm],
    ]) {
      const actualPath = clip?.[kind]
      if (typeof actualPath !== "string") continue
      const info = await stat(actualPath)
      files.set(logicalPath, {
        size: info.size,
        probe: await probe(actualPath, { signal }),
        sha256: await hash(actualPath),
      })
    }
    const posterPath = published ? join(repoRoot, contract.poster) : clip?.poster
    try {
      await access(posterPath)
      files.set(contract.poster, {
        size: (await stat(posterPath)).size,
        probe: await probe(posterPath, { signal }),
      })
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }
  const animationPath = published ? join(repoRoot, README_ANIMATION_PATH) : manifest.animation
  try {
    const info = await stat(animationPath)
    signal?.throwIfAborted()
    files.set(README_ANIMATION_PATH, {
      size: info.size,
      animation: await readAnimation(animationPath),
    })
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  const transcriptPath = join(repoRoot, "docs/brand/demo/transcript.md")
  try {
    files.set("docs/brand/demo/transcript.md", {
      size: (await stat(transcriptPath)).size,
      text: await readFile(transcriptPath, "utf8"),
    })
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
  return files
}

export async function validateStagedMediaManifest({
  repoRoot,
  manifest,
  manifestPath,
  stat = nodeStat,
  access = nodeAccess,
  probe = probeFile,
  readAnimation = readAnimationMetadata,
  readFile = nodeReadFile,
  hash = (path) => hashFile(path, readFile),
  signal,
}) {
  validateMediaManifestLayout({
    repoRoot,
    pointer: {
      schemaVersion: MEDIA_SCHEMA_VERSION,
      runId: manifest.runId,
      manifestPath,
    },
    manifest,
  })
  for (const { name } of MEDIA_CONTRACTS) {
    const measured = await hash(manifest.clips[name].poster)
    if (measured !== manifest.assetHashes.posters[name]) {
      throw new Error(`${name} staged poster hash does not match its manifest`)
    }
  }
  if ((await hash(manifest.animation)) !== manifest.assetHashes.animation) {
    throw new Error("staged README animation hash does not match its manifest")
  }
  const files = await collectMediaFiles(repoRoot, manifest, {
    published: false,
    stat,
    access,
    probe,
    readAnimation,
    readFile,
    hash,
    signal,
  })
  const failures = await validateLocalMediaContract({
    files,
    captions: manifest.captions ?? MEDIA_CAPTIONS,
  })
  if (failures.length > 0) {
    throw new Error(`Staged media contract failed:\n- ${failures.join("\n- ")}`)
  }
}

async function verifyPublishedCorrespondence(repoRoot, manifest, { hash = hashFile } = {}) {
  for (const contract of MEDIA_CONTRACTS) {
    const stagedHash = await hash(manifest.clips[contract.name].poster)
    const publishedHash = await hash(join(repoRoot, contract.poster))
    const expectedHash = manifest.assetHashes.posters[contract.name]
    if (stagedHash !== expectedHash || publishedHash !== expectedHash) {
      throw new Error(`${contract.name} fixed poster does not correspond to run ${manifest.runId}`)
    }
  }
  const stagedAnimationHash = await hash(manifest.animation)
  const publishedAnimationHash = await hash(join(repoRoot, README_ANIMATION_PATH))
  if (
    stagedAnimationHash !== manifest.assetHashes.animation ||
    publishedAnimationHash !== manifest.assetHashes.animation
  ) {
    throw new Error(`fixed README animation does not correspond to run ${manifest.runId}`)
  }
}

export async function checkLocalMedia({
  repoRoot = DEFAULT_REPO_ROOT,
  readFile = nodeReadFile,
  stat = nodeStat,
  access = nodeAccess,
  probe = probeFile,
  readAnimation = readAnimationMetadata,
  hash = (path) => hashFile(path, readFile),
  log = console.log,
  signal,
} = {}) {
  const { pointer, manifest } = await readLatestManifest(repoRoot, readFile)
  await verifyPublishedCorrespondence(repoRoot, manifest, { hash })
  const files = await collectMediaFiles(repoRoot, manifest, {
    published: true,
    stat,
    access,
    probe,
    readAnimation,
    readFile,
    hash,
    signal,
  })
  const failures = await validateLocalMediaContract({
    files,
    captions: manifest.captions ?? MEDIA_CAPTIONS,
  })
  if (failures.length > 0) {
    throw new Error(`Local media contract failed:\n- ${failures.join("\n- ")}`)
  }
  const passLines = [
    "PASS dimensions: every video is 1440x810 (16:9) and the README animation is 960x540",
    "PASS frame rate: every video is 30 fps and the README animation at most 15 fps",
    "PASS durations: flagship is 12-18s",
    "PASS codecs: MP4 is H.264, WebM is VP9, and the README animation is animated WebP",
    "PASS byte budgets: MP4/WebM <=2MB each and the README animation <=4MB",
    "PASS posters: the flagship poster is 1440x810 WebP",
    "PASS transcript: the static walkthrough exists",
    "PASS captions: no caption claims scaffolding appears",
  ]
  for (const line of passLines) log(line)
  const sourceFiles = new Map()
  for (const contract of MEDIA_CONTRACTS) {
    for (const format of ["mp4", "webm"]) {
      sourceFiles.set(manifest.clips[contract.name][format], files.get(contract[format]))
    }
  }
  return { pointer, manifest, sourceFiles, passLines }
}

const DEMO_MEDIA_KEYS = Object.freeze(["productLoop"])
const DEMO_MEDIA_FIELDS = Object.freeze([
  "mp4",
  "webm",
  "poster",
  "caption",
  "ariaLabel",
  "transcript",
])
const DEMO_MEDIA_NAMES = Object.freeze({
  productLoop: "product-loop",
})

export function urlHasExplicitPort(value) {
  if (typeof value !== "string") return false
  const authorityMatch = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(value)
  if (authorityMatch === null) return false
  const authority = authorityMatch[1]
  const hostAndPort = authority.slice(authority.lastIndexOf("@") + 1)
  if (hostAndPort.startsWith("[")) {
    const closingBracket = hostAndPort.indexOf("]")
    return closingBracket !== -1 && hostAndPort[closingBracket + 1] === ":"
  }
  return hostAndPort.includes(":")
}

function requireHttpsUrl(value, description) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${description} must be an HTTPS URL`)
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new Error(`${description} must be an HTTPS URL without credentials`)
  }
  if (urlHasExplicitPort(value)) {
    throw new Error(`${description} must not use an explicit port`)
  }
  if (value !== parsed.href) {
    throw new Error(`${description} must use canonical HTTPS URL serialization`)
  }
  return parsed
}

function requireStableMediaUrl(value, key, format) {
  const description = `${key}.${format}`
  const parsed = requireHttpsUrl(value, description)
  const expectedPath = `/b4/demo/${DEMO_MEDIA_NAMES[key]}.${format}`
  if (parsed.pathname !== expectedPath || parsed.search !== "" || parsed.hash !== "") {
    throw new Error(
      `${description} must use the exact stable path ${expectedPath} with no query or fragment`,
    )
  }
  return parsed
}

export function validateDemoMediaCatalog(catalog) {
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("demo media catalog must be an object")
  }
  const actualKeys = Object.keys(catalog)
  if (
    actualKeys.length !== DEMO_MEDIA_KEYS.length ||
    DEMO_MEDIA_KEYS.some((key, index) => actualKeys[index] !== key)
  ) {
    throw new Error(
      `demo media catalog must contain exactly ${DEMO_MEDIA_KEYS.join(", ")} in order`,
    )
  }
  let mediaOrigin
  for (const key of DEMO_MEDIA_KEYS) {
    const entry = catalog[key]
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${key} catalog entry must be an object`)
    }
    const actualFields = Object.keys(entry).sort()
    const expectedFields = [...DEMO_MEDIA_FIELDS].sort()
    const missingField = DEMO_MEDIA_FIELDS.find((field) => !Object.hasOwn(entry, field))
    if (missingField !== undefined) {
      throw new Error(`${key}.${missingField} is required`)
    }
    if (
      actualFields.length !== expectedFields.length ||
      expectedFields.some((field, index) => actualFields[index] !== field)
    ) {
      throw new Error(`${key} catalog entry must contain exactly ${DEMO_MEDIA_FIELDS.join(", ")}`)
    }
    for (const field of ["poster", "caption", "ariaLabel", "transcript"]) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`${key}.${field} is required`)
      }
    }
    const mp4 = requireStableMediaUrl(entry.mp4, key, "mp4")
    const webm = requireStableMediaUrl(entry.webm, key, "webm")
    mediaOrigin ??= mp4.origin
    if (mp4.origin !== mediaOrigin || webm.origin !== mediaOrigin) {
      throw new Error("all demo media URLs must use the same public origin")
    }
    if (entry.poster !== `/demo/${DEMO_MEDIA_NAMES[key]}-poster.webp`) {
      throw new Error(`${key}.poster must use its local /demo/*.webp path`)
    }
    requireHttpsUrl(entry.transcript, `${key}.transcript`)
  }
  return catalog
}

export async function runBoundedRemoteOperation({ label, timeoutMs, signal, operation }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("remote operation timeout must be a positive integer")
  }
  signal?.throwIfAborted()
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal.reason)
  signal?.addEventListener("abort", forwardAbort, { once: true })
  const timer = setTimeout(() => {
    const timeout = new Error(`${label} timed out after ${timeoutMs}ms`)
    timeout.code = "B4_MEDIA_REMOTE_TIMEOUT"
    controller.abort(timeout)
  }, timeoutMs)
  try {
    const result = await operation(controller.signal)
    if (controller.signal.aborted) throw controller.signal.reason
    return result
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", forwardAbort)
  }
}

export async function verifyRemoteMediaCatalog({
  catalog,
  fetch = globalThis.fetch,
  log = console.log,
  timeoutMs = 15_000,
  signal,
} = {}) {
  validateDemoMediaCatalog(catalog)
  const checks = []
  for (const key of DEMO_MEDIA_KEYS) {
    for (const [format, expectedContentType] of [
      ["mp4", "video/mp4"],
      ["webm", "video/webm"],
    ]) {
      const url = catalog[key][format]
      try {
        const response = await runBoundedRemoteOperation({
          label: `HEAD ${key}.${format}`,
          timeoutMs,
          signal,
          operation: (operationSignal) =>
            fetch(url, {
              method: "HEAD",
              redirect: "error",
              signal: operationSignal,
            }),
        })
        if (response.status !== 200) {
          throw new Error(`${key}.${format} must return 200; received ${response.status}`)
        }
        const actualContentType = response.headers.get("content-type")
        if (actualContentType !== expectedContentType) {
          throw new Error(
            `${key}.${format} must return ${expectedContentType}; received ${actualContentType ?? "missing"}`,
          )
        }
      } catch (error) {
        const annotated = new Error(error instanceof Error ? error.message : String(error))
        annotated.verificationUrl = url
        if (error?.code === "B4_MEDIA_REMOTE_TIMEOUT") {
          annotated.code = "B4_MEDIA_REMOTE_TIMEOUT"
        }
        if (error?.name === "AbortError") annotated.name = "AbortError"
        throw annotated
      }
      const line = `PASS remote: ${key}.${format} is 200 ${expectedContentType}`
      log(line)
      checks.push(line)
    }
  }
  return checks
}

export async function checkRemoteMedia({
  repoRoot = DEFAULT_REPO_ROOT,
  readFile = nodeReadFile,
  fetch = globalThis.fetch,
  log = console.log,
  timeoutMs = 15_000,
  signal,
} = {}) {
  const catalogPath = join(repoRoot, "apps/web/app/lib/demo-media.json")
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"))
  const passLines = await verifyRemoteMediaCatalog({
    catalog,
    fetch,
    log,
    timeoutMs,
    signal,
  })
  return { catalog, passLines }
}

export function parseMediaCheckArguments(args) {
  const forwarded = args.filter((arg) => arg !== "--")
  if (forwarded.length !== 1) {
    throw new Error("Usage: node docs/brand/demo/check-media.mjs (--local | --remote)")
  }
  if (forwarded[0] === "--local") return { local: true }
  if (forwarded[0] === "--remote") return { remote: true }
  throw new Error("Usage: node docs/brand/demo/check-media.mjs (--local | --remote)")
}

function isMainModule() {
  return (
    process.argv[1] !== undefined &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  )
}

if (isMainModule()) {
  try {
    const mode = parseMediaCheckArguments(process.argv.slice(2))
    if (mode.local) await checkLocalMedia()
    else await checkRemoteMedia()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}

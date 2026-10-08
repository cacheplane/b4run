import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { readFileSync } from "node:fs"
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename as renameFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tsImport } from "tsx/esm/api"

import {
  assertLoopbackModelBaseUrl,
  buildChildEnvironment,
  captureDemo,
  closeBrowserResources,
  createBrowserResources,
  createManagedChildRegistry,
  createManagedServiceMonitor,
  fillActiveWorkbenchComposer,
  frameSurface,
  generatedInstallCommand,
  generatedTestCommand,
  HIDE_NEXT_DEV_INDICATOR,
  installCaptureSignalHandlers,
  openReadyWorkbench,
  parseCaptureArguments,
  raceCapturePhase,
  restoreWorkbenchThread,
  runManagedCommand,
  sanitizeOperationalEnvironment,
  startHttpService,
  startWithAssignedPort,
  validateRunId,
  validateToolchainVersions,
  waitForWorkbenchRunCompletion,
} from "./capture.mjs"
import {
  checkLocalMedia,
  checkRemoteMedia,
  MEDIA_CAPTIONS,
  MEDIA_CONTRACTS,
  parseMediaCheckArguments,
  probeFile,
  runBoundedRemoteOperation,
  validateDemoMediaCatalog,
  validateLocalMediaContract,
  validateMediaManifestLayout,
  validateAnimation,
  validateStagedMediaManifest,
} from "./check-media.mjs"
import {
  CODE_PANE_LINES,
  DIRECTOR_FONTS,
  renderDirector,
  windowAround,
  wordmarkSvg,
} from "./director.mjs"
import {
  buildAnimationFilter,
  createTrimPlan,
  encodeCaptureArtifacts,
  encodePoster,
  encodeReadmeAnimation,
  encodeVideo,
  publishFixedAssets,
  README_ANIMATION_WEBP_OPTIONS,
  runEncoderCommand,
} from "./encode.mjs"
import { normalizeLog } from "./normalize-log.mjs"
import { getAvailableLoopbackPort, spawnManaged, stopManaged, waitForHttp } from "./processes.mjs"
import { startAwcStub } from "./awc-stub.mjs"
import { APP_ACTIONS, APP_FOCUS, STORYBOARD, storyboardPaths } from "./storyboard.mjs"
import {
  DEMO_FILE_PROMPT,
  DEMO_FIXTURES,
  DEMO_PLAN_ANSWER,
  DEMO_PLAN_TOOLS,
  DEMO_PROMPT,
  DEMO_SCENARIO,
  assertScenarioCurrent,
  demoAwcData,
  demoScenario,
} from "./scenario.mjs"
import {
  buildDemoMediaCatalog,
  createUploadPlan,
  MEDIA_UPLOAD_PATHS,
  parseUploadArguments,
  uploadReadmeMedia,
  validatePublicBaseUrl,
  validateUploadPathname,
  writeDemoMediaCatalog,
} from "./upload.mjs"

function videoProbe({
  codecName,
  duration,
  width = 1440,
  height = 810,
  frameRate = "30/1",
  reportedFrameRate = frameRate,
}) {
  return {
    streams: [
      {
        codec_name: codecName,
        codec_type: "video",
        width,
        height,
        avg_frame_rate: frameRate,
        r_frame_rate: reportedFrameRate,
      },
    ],
    format: { duration: String(duration) },
  }
}

const README_ANIMATION = "docs/brand/product-loop.webp"

/**
 * sharp's animated metadata for a deduplicated 15 fps encode: 220 frames whose
 * uneven delays total 15.2 seconds.
 */
function animationMetadata(overrides = {}) {
  const delay = Array.from({ length: 220 }, (_, index) => (index < 40 ? 133 : 54))
  delay[0] += 15_200 - delay.reduce((total, value) => total + value, 0)
  return {
    format: "webp",
    width: 960,
    pageHeight: 540,
    pages: delay.length,
    delay,
    loop: 0,
    ...overrides,
  }
}

function animationFile({ size = 3_200_000, ...overrides } = {}) {
  return { size, animation: animationMetadata(overrides) }
}

function validMediaFixtures() {
  const files = new Map()
  for (const contract of MEDIA_CONTRACTS) {
    files.set(contract.mp4, {
      size: 1_200_000,
      probe: videoProbe({
        codecName: "h264",
        duration: 15,
      }),
    })
    files.set(contract.webm, {
      size: 1_100_000,
      probe: videoProbe({
        codecName: "vp9",
        duration: 15,
      }),
    })
    files.set(contract.poster, {
      size: 80_000,
      probe: videoProbe({ codecName: "webp", duration: 0 }),
    })
  }
  files.set(README_ANIMATION, animationFile())
  files.set("docs/brand/demo/transcript.md", {
    size: 2_000,
    text: "Exact static walkthrough",
  })
  return files
}

async function validateMedia(overrides = new Map()) {
  const files = validMediaFixtures()
  for (const [path, value] of overrides) files.set(path, value)
  return validateLocalMediaContract({
    files,
    captions: {
      "product-loop":
        "Write an agent route, test it offline, run it in the Workbench, and restore the same thread after a browser reload.",
    },
  })
}

test("media contracts accept the exact flagship formats", async () => {
  assert.deepEqual(await validateMedia(), [])
})

test("the README animation contract points at the animated WebP", () => {
  assert.equal(MEDIA_CONTRACTS[0].animation, README_ANIMATION)
  assert.equal(Object.hasOwn(MEDIA_CONTRACTS[0], "gif"), false)
})

test("README animation accepts a deduplicated 960x540 15 fps animated WebP", () => {
  const file = animationFile()
  assert.equal(file.animation.pages, 220)
  assert.equal(
    file.animation.delay.reduce((total, value) => total + value, 0),
    15_200,
  )
  assert.deepEqual(validateAnimation(README_ANIMATION, file), [])
})

test("README animation reports a missing file", () => {
  assert.deepEqual(validateAnimation(README_ANIMATION, undefined), [
    "docs/brand/product-loop.webp is missing",
  ])
})

for (const [label, file, message] of [
  [
    "a non-WebP format",
    animationFile({ format: "gif" }),
    "docs/brand/product-loop.webp must use animated WebP",
  ],
  [
    "a single still frame",
    animationFile({ pages: 1, delay: [15_200] }),
    "docs/brand/product-loop.webp must be animated (more than one frame)",
  ],
  [
    "the wrong width",
    animationFile({ width: 1440 }),
    "docs/brand/product-loop.webp must be exactly 960x540; received 1440x540",
  ],
  [
    "the wrong frame height",
    animationFile({ pageHeight: 810 }),
    "docs/brand/product-loop.webp must be exactly 960x540; received 960x810",
  ],
  [
    "a finite loop count",
    animationFile({ loop: 1 }),
    "docs/brand/product-loop.webp must loop forever",
  ],
  [
    "a total delay under the flagship window",
    animationFile({ delay: Array.from({ length: 150 }, () => 66), pages: 150 }),
    "product-loop must be 12-18 seconds; docs/brand/product-loop.webp is 9.9",
  ],
  [
    "a total delay over the flagship window",
    animationFile({ delay: Array.from({ length: 200 }, () => 91), pages: 200 }),
    "product-loop must be 12-18 seconds; docs/brand/product-loop.webp is 18.2",
  ],
  [
    "missing frame delays",
    animationFile({ delay: undefined }),
    "product-loop must be 12-18 seconds; docs/brand/product-loop.webp is unknown",
  ],
  [
    "a file over the byte budget",
    animationFile({ size: 4_000_001 }),
    "docs/brand/product-loop.webp must be at most 4,000,000 bytes",
  ],
]) {
  test(`README animation rejects ${label}`, () => {
    assert.deepEqual(validateAnimation(README_ANIMATION, file), [message])
  })
}

test("README animation rejects an accidental 30 fps encode", () => {
  const delay = Array.from({ length: 450 }, () => 33)
  delay[0] += 15_000 - delay.reduce((total, value) => total + value, 0)
  assert.deepEqual(validateAnimation(README_ANIMATION, animationFile({ pages: 450, delay })), [
    "docs/brand/product-loop.webp must be at most 15 fps; received 30.00 fps",
  ])
})

test("README animation accepts a full 15 fps encode with no merged frames", () => {
  const delay = Array.from({ length: 228 }, () => 66)
  delay[0] += 15_200 - delay.reduce((total, value) => total + value, 0)
  assert.deepEqual(validateAnimation(README_ANIMATION, animationFile({ pages: 228, delay })), [])
})

test("media contracts reject wrong dimensions and aspect ratio", async () => {
  const failures = await validateMedia(
    new Map([
      [
        "docs/brand/demo/artifacts/output/product-loop.mp4",
        {
          size: 1_200_000,
          probe: videoProbe({
            codecName: "h264",
            duration: 15,
            width: 1280,
            height: 800,
          }),
        },
      ],
    ]),
  )
  assert.ok(failures.some((failure) => /1440x810/.test(failure)))
})

test("media contracts reject durations outside the flagship window", async () => {
  const failures = await validateMedia(
    new Map([
      [
        "docs/brand/demo/artifacts/output/product-loop.mp4",
        {
          size: 1_200_000,
          probe: videoProbe({ codecName: "h264", duration: 11.99 }),
        },
      ],
      [
        "docs/brand/demo/artifacts/output/product-loop.webm",
        {
          size: 1_100_000,
          probe: videoProbe({ codecName: "vp9", duration: 18.01 }),
        },
      ],
    ]),
  )
  assert.ok(failures.some((failure) => /product-loop\.mp4/.test(failure) && /12-18 seconds/.test(failure)))
  assert.ok(failures.some((failure) => /product-loop\.webm/.test(failure) && /12-18 seconds/.test(failure)))
})

test("media contracts reject files over their byte budgets", async () => {
  const failures = await validateMedia(
    new Map([
      [
        "docs/brand/demo/artifacts/output/product-loop.mp4",
        {
          size: 2_000_001,
          probe: videoProbe({ codecName: "h264", duration: 15 }),
        },
      ],
      [README_ANIMATION, animationFile({ size: 4_000_001 })],
    ]),
  )
  assert.ok(failures.some((failure) => /product-loop\.mp4.*2,000,000 bytes/.test(failure)))
  assert.ok(failures.some((failure) => /product-loop\.webp.*4,000,000 bytes/.test(failure)))
})

test("media contracts require every poster and the transcript", async () => {
  const files = validMediaFixtures()
  files.delete("apps/web/public/demo/product-loop-poster.webp")
  files.delete("docs/brand/demo/transcript.md")
  const failures = await validateLocalMediaContract({
    files,
    captions: Object.fromEntries(
      MEDIA_CONTRACTS.map(({ name }) => [name, "Accurate static description"]),
    ),
  })
  assert.ok(failures.some((failure) => /product-loop.*poster/.test(failure)))
  assert.ok(failures.some((failure) => /transcript/.test(failure)))
})

test("media contracts require 1440x810 WebP posters", async () => {
  const files = validMediaFixtures()
  files.set("apps/web/public/demo/product-loop-poster.webp", {
    size: 80_000,
    probe: videoProbe({
      codecName: "png",
      duration: 0,
      width: 1280,
      height: 720,
    }),
  })
  const failures = await validateLocalMediaContract({
    files,
    captions: Object.fromEntries(
      MEDIA_CONTRACTS.map(({ name }) => [name, "Accurate static description"]),
    ),
  })
  assert.ok(failures.some((failure) => /product-loop-poster\.webp.*WebP/.test(failure)))
  assert.ok(failures.some((failure) => /product-loop-poster\.webp.*1440x810/.test(failure)))
})

test("media contracts reject captions that claim scaffolding is visible", async () => {
  const files = validMediaFixtures()
  const failures = await validateLocalMediaContract({
    files,
    captions: {
      "product-loop": "Scaffold a B4.run app, then run it.",
    },
  })
  assert.ok(failures.some((failure) => /caption.*scaffold/i.test(failure)))
})

test("media contracts require H.264 MP4, VP9 WebM, and 30 fps", async () => {
  const failures = await validateMedia(
    new Map([
      [
        "docs/brand/demo/artifacts/output/product-loop.mp4",
        {
          size: 1_200_000,
          probe: videoProbe({ codecName: "hevc", duration: 15 }),
        },
      ],
      [
        "docs/brand/demo/artifacts/output/product-loop.webm",
        {
          size: 1_100_000,
          probe: videoProbe({
            codecName: "vp8",
            duration: 15,
            frameRate: "25/1",
          }),
        },
      ],
    ]),
  )
  assert.ok(failures.some((failure) => /product-loop\.mp4.*H\.264/.test(failure)))
  assert.ok(failures.some((failure) => /product-loop\.webm.*VP9/.test(failure)))
  assert.ok(failures.some((failure) => /product-loop\.webm.*30 fps/.test(failure)))
})

function validManifestLayout(repoRoot = "/repo", runId = "run-a") {
  const runRoot = `${repoRoot}/docs/brand/demo/artifacts/runs/${runId}`
  const outputRoot = `${runRoot}/output`
  const publicationRoot = `${runRoot}/publication`
  return {
    pointer: {
      schemaVersion: 1,
      runId,
      manifestPath: `${runRoot}/media-manifest.json`,
    },
    manifest: {
      schemaVersion: 1,
      runId,
      outputRoot,
      clips: Object.fromEntries(
        MEDIA_CONTRACTS.map(({ name }) => [
          name,
          {
            mp4: `${outputRoot}/${name}.mp4`,
            webm: `${outputRoot}/${name}.webm`,
            poster: `${publicationRoot}/${name}-poster.webp`,
          },
        ]),
      ),
      animation: `${publicationRoot}/product-loop.webp`,
      assetHashes: {
        animation: "a".repeat(64),
        posters: Object.fromEntries(MEDIA_CONTRACTS.map(({ name }) => [name, "b".repeat(64)])),
      },
    },
  }
}

test("media manifest layout rejects stale identity and cross-run paths", () => {
  const repoRoot = "/repo"
  const { pointer, manifest } = validManifestLayout(repoRoot)
  assert.doesNotThrow(() => validateMediaManifestLayout({ repoRoot, pointer, manifest }))
  assert.throws(
    () =>
      validateMediaManifestLayout({
        repoRoot,
        pointer: {
          ...pointer,
          runId: "stale-run",
          manifestPath: "/repo/docs/brand/demo/artifacts/runs/stale-run/media-manifest.json",
        },
        manifest,
      }),
    /pointer and manifest run IDs differ/,
  )
  assert.throws(
    () =>
      validateMediaManifestLayout({
        repoRoot,
        pointer,
        manifest: {
          ...manifest,
          clips: {
            ...manifest.clips,
            "product-loop": {
              ...manifest.clips["product-loop"],
              mp4: "/tmp/other-run/product-loop.mp4",
            },
          },
        },
      }),
    /product-loop\.mp4.*expected run output root/,
  )
  assert.throws(
    () =>
      validateMediaManifestLayout({
        repoRoot,
        pointer: { ...pointer, schemaVersion: 2 },
        manifest,
      }),
    /unsupported latest-media schema/,
  )
  assert.throws(
    () =>
      validateMediaManifestLayout({
        repoRoot,
        pointer,
        manifest: {
          ...manifest,
          animation: "/repo/docs/brand/demo/artifacts/runs/run-a/publication/product-loop.gif",
        },
      }),
    /README animation.*expected run output root/,
  )
  assert.throws(
    () =>
      validateMediaManifestLayout({
        repoRoot,
        pointer,
        manifest: {
          ...manifest,
          assetHashes: { ...manifest.assetHashes, animation: undefined, gif: "a".repeat(64) },
        },
      }),
    /README animation hash is missing or invalid/,
  )
})

test("local checker adapters surface manifest, probe, and CLI failures", async () => {
  await assert.rejects(
    checkLocalMedia({
      repoRoot: "/repo",
      async readFile() {
        throw new Error("manifest read failed")
      },
    }),
    /manifest read failed/,
  )
  const unsafeReads = []
  await assert.rejects(
    checkLocalMedia({
      repoRoot: "/repo",
      async readFile(path) {
        unsafeReads.push(path)
        if (path.endsWith("latest-media.json")) {
          return JSON.stringify({
            schemaVersion: 1,
            runId: "run-a",
            manifestPath: "/tmp/untrusted-manifest.json",
          })
        }
        throw new Error("unsafe manifest read")
      },
    }),
    /manifest path.*expected run output root/,
  )
  assert.deepEqual(unsafeReads, ["/repo/docs/brand/demo/artifacts/latest-media.json"])
  const repoRoot = "/repo"
  const { pointer, manifest } = validManifestLayout(repoRoot)
  await assert.rejects(
    checkLocalMedia({
      repoRoot,
      async readFile(path) {
        if (path.endsWith("latest-media.json")) return JSON.stringify(pointer)
        if (path.endsWith("media-manifest.json")) return JSON.stringify(manifest)
        if (path.endsWith("transcript.md")) return "transcript"
        throw new Error(`unexpected read: ${path}`)
      },
      async stat(path) {
        return {
          size: path.endsWith("product-loop.webp")
            ? 3_200_000
            : path.endsWith(".mp4")
              ? 1_200_000
              : 80_000,
        }
      },
      async access() {},
      async probe() {
        throw new Error("probe failed")
      },
      async hash(path) {
        return path.endsWith("product-loop.webp") ? "a".repeat(64) : "b".repeat(64)
      },
      log() {},
    }),
    /probe failed/,
  )
  assert.deepEqual(parseMediaCheckArguments(["--", "--local"]), {
    local: true,
  })
  assert.throws(() => parseMediaCheckArguments(["--invalid"]), /Usage:.*--local.*--remote/)
})

test("local checker rejects a fixed asset that differs from its selected run", async () => {
  const repoRoot = "/repo"
  const { pointer, manifest } = validManifestLayout(repoRoot)
  const fixedProductPoster = join(repoRoot, MEDIA_CONTRACTS[0].poster)
  await assert.rejects(
    checkLocalMedia({
      repoRoot,
      async readFile(path) {
        if (path.endsWith("latest-media.json")) return JSON.stringify(pointer)
        if (path.endsWith("media-manifest.json")) return JSON.stringify(manifest)
        throw new Error(`unexpected read: ${path}`)
      },
      async hash(path) {
        if (path === fixedProductPoster) return "c".repeat(64)
        return path.endsWith("product-loop.webp") ? "a".repeat(64) : "b".repeat(64)
      },
      log() {},
    }),
    /product-loop fixed poster does not correspond to run run-a/,
  )
})

test("staged validation aborts and joins ffprobe before caller cleanup", async () => {
  const repoRoot = "/repo"
  const { pointer, manifest } = validManifestLayout(repoRoot)
  const controller = new AbortController()
  const reason = new Error("cancel staged validation")
  const events = []
  let markStarted
  const started = new Promise((resolve) => {
    markStarted = resolve
  })
  const validation = validateStagedMediaManifest({
    repoRoot,
    manifest,
    manifestPath: pointer.manifestPath,
    signal: controller.signal,
    async hash(path) {
      return path.endsWith("product-loop.webp") ? "a".repeat(64) : "b".repeat(64)
    },
    async stat(path) {
      return { size: path.endsWith(".mp4") ? 1_200_000 : 1_100_000 }
    },
    async access() {},
    async readFile() {
      return "transcript"
    },
    probe(path, options) {
      return probeFile(path, {
        ...options,
        exec: async (_command, _args, { signal }) => {
          events.push("ffprobe started")
          markStarted()
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                events.push("ffprobe abort received")
                setImmediate(() => {
                  events.push("ffprobe child settled")
                  reject(new Error("native child abort"))
                })
              },
              { once: true },
            )
          })
        },
      })
    },
  })
  await started
  controller.abort(reason)
  await assert.rejects(validation, (error) => error === reason)
  events.push("encoding cleanup")
  assert.deepEqual(events, [
    "ffprobe started",
    "ffprobe abort received",
    "ffprobe child settled",
    "encoding cleanup",
  ])
})

const BEAT_SCENES = {
  author: { startMs: 2_000, endMs: 5_000 },
  prove: { startMs: 5_000, endMs: 8_000 },
  run: { startMs: 8_000, endMs: 14_000 },
  close: { startMs: 14_000, endMs: 16_500 },
}

test("trim plan spans the recorded beats and poses the poster on the docked author beat", () => {
  const trim = createTrimPlan({
    videoTimeline: { unit: "milliseconds", scenes: BEAT_SCENES },
  })
  assert.deepEqual(trim, { start: 2, duration: 14.5, posterTime: 2.75 })
})

test("trim plan rejects a missing or out-of-order beat", () => {
  assert.throws(
    () =>
      createTrimPlan({
        videoTimeline: { unit: "milliseconds", scenes: { ...BEAT_SCENES, prove: undefined } },
      }),
    /invalid prove beat/,
  )
  assert.throws(
    () =>
      createTrimPlan({
        videoTimeline: {
          unit: "milliseconds",
          scenes: { ...BEAT_SCENES, close: { startMs: 7_000, endMs: 9_000 } },
        },
      }),
    /close beat starts before run ends/,
  )
  assert.throws(
    () => createTrimPlan({ videoTimeline: { unit: "seconds", scenes: BEAT_SCENES } }),
    /milliseconds/,
  )
})

test("README animation filter makes a 960x540 12 fps 256-colour intermediate with no overlays", () => {
  assert.equal(
    buildAnimationFilter(),
    "[0:v]fps=12,scale=960:540:flags=lanczos,split[a][b];[b]palettegen=max_colors=256:stats_mode=diff[p];[a][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle[outv]",
  )
})

test("README animation encodes a trimmed intermediate GIF, converts it to WebP, and removes the intermediate", async () => {
  const calls = []
  await encodeReadmeAnimation({
    source: "/run/raw.webm",
    destination: "/run/publication/product-loop.webp",
    trim: { start: 2, duration: 14.5, posterTime: 2.75 },
    async run(command, args) {
      calls.push({ command, args })
    },
    async convert(input, output) {
      calls.push({ convert: [input, output] })
    },
    async rename(source, destination) {
      calls.push({ rename: [source, destination] })
    },
    async remove(path) {
      calls.push({ remove: path })
    },
  })

  assert.equal(calls[0].command, "ffmpeg")
  const args = calls[0].args
  const ss = args.indexOf("-ss")
  assert.deepEqual(args.slice(ss, ss + 6), ["-ss", "2.000", "-t", "14.500", "-i", "/run/raw.webm"])
  const filter = args.indexOf("-filter_complex")
  assert.equal(args[filter + 1], buildAnimationFilter())
  const map = args.indexOf("-map")
  assert.deepEqual(args.slice(map, map + 2), ["-map", "[outv]"])
  const gifflags = args.indexOf("-gifflags")
  assert.deepEqual(args.slice(gifflags, gifflags + 2), ["-gifflags", "+transdiff"])
  assert.equal(args.at(-1), "/run/publication/product-loop.webp.tmp.gif")
  assert.equal(args.includes("libwebp"), false)
  assert.deepEqual(calls.slice(1), [
    {
      convert: [
        "/run/publication/product-loop.webp.tmp.gif",
        "/run/publication/product-loop.webp.tmp.webp",
      ],
    },
    {
      rename: ["/run/publication/product-loop.webp.tmp.webp", "/run/publication/product-loop.webp"],
    },
    { remove: "/run/publication/product-loop.webp.tmp.gif" },
  ])
})

test("WebM encodes constrained-quality VP9 to stay under the video byte budget", async () => {
  let ffmpegArgs
  await encodeVideo({
    source: "/run/raw.webm",
    destination: "/run/output/product-loop.webm",
    trim: { start: 2, duration: 14.5, posterTime: 2.75 },
    format: "webm",
    async run(_command, args) {
      ffmpegArgs = args
    },
    async rename() {},
    async remove() {},
  })
  const codec = ffmpegArgs.indexOf("-c:v")
  assert.equal(ffmpegArgs[codec + 1], "libvpx-vp9")
  assert.deepEqual(ffmpegArgs.slice(codec), [
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "800k",
    "-crf",
    "44",
    "-maxrate",
    "900k",
    "-bufsize",
    "1800k",
    "-deadline",
    "good",
    "-cpu-used",
    "2",
    "-row-mt",
    "1",
    "/run/output/product-loop.webm.tmp.webm",
  ])
})

test("README animation WebP conversion uses quality 62 at effort 6", () => {
  assert.deepEqual(README_ANIMATION_WEBP_OPTIONS, { quality: 62, effort: 6 })
  assert.equal(Object.isFrozen(README_ANIMATION_WEBP_OPTIONS), true)
})

test("README animation rechecks abort after conversion and removes both temps", async () => {
  const controller = new AbortController()
  const calls = []
  await assert.rejects(
    encodeReadmeAnimation({
      source: "/run/raw.webm",
      destination: "/run/publication/product-loop.webp",
      trim: { start: 2, duration: 14.5, posterTime: 2.75 },
      signal: controller.signal,
      async run() {
        calls.push("ffmpeg")
      },
      async convert() {
        calls.push("convert")
        controller.abort(new Error("abort after convert"))
      },
      async rename(...args) {
        calls.push(["rename", ...args])
      },
      async remove(path) {
        calls.push(["remove", path])
      },
    }),
    /abort after convert/,
  )
  assert.deepEqual(calls, [
    "ffmpeg",
    "convert",
    ["remove", "/run/publication/product-loop.webp.tmp.gif"],
    ["remove", "/run/publication/product-loop.webp.tmp.webp"],
  ])
})

test("poster encoding extracts a real frame before WebP conversion", async () => {
  const calls = []
  await encodePoster({
    source: "/capture/raw.webm",
    destination: "/repo/apps/web/public/demo/product-loop-poster.webp",
    time: 0.75,
    async run(command, args) {
      calls.push({ command, args })
    },
    async convert(source, destination) {
      calls.push({ convert: [source, destination] })
    },
    async rename(source, destination) {
      calls.push({ rename: [source, destination] })
    },
    async remove(path) {
      calls.push({ remove: path })
    },
  })

  assert.equal(calls[0].command, "ffmpeg")
  assert.ok(calls[0].args.includes("/capture/raw.webm"))
  assert.ok(calls[0].args.at(-1).endsWith(".tmp.png"))
  assert.equal(calls[0].args.includes("libwebp"), false)
  assert.deepEqual(calls[1], {
    convert: [
      "/repo/apps/web/public/demo/product-loop-poster.webp.tmp.png",
      "/repo/apps/web/public/demo/product-loop-poster.webp.tmp.webp",
    ],
  })
  assert.deepEqual(calls[2], {
    rename: [
      "/repo/apps/web/public/demo/product-loop-poster.webp.tmp.webp",
      "/repo/apps/web/public/demo/product-loop-poster.webp",
    ],
  })
  assert.deepEqual(calls[3], {
    remove: "/repo/apps/web/public/demo/product-loop-poster.webp.tmp.png",
  })
})

test("video and README animation encoders trim the recording, recheck abort before rename, and clean their temps", async () => {
  const trim = { start: 2, duration: 14.5, posterTime: 2.75 }
  for (const [name, encode, destination, expectedTemporaryPaths] of [
    [
      "video",
      encodeVideo,
      "/run/output/product-loop.mp4",
      ["/run/output/product-loop.mp4.tmp.mp4"],
    ],
    [
      "animation",
      encodeReadmeAnimation,
      "/run/publication/product-loop.webp",
      ["/run/publication/product-loop.webp.tmp.gif", "/run/publication/product-loop.webp.tmp.webp"],
    ],
  ]) {
    const controller = new AbortController()
    const calls = []
    let ffmpegArgs
    await assert.rejects(
      encode({
        source: "/run/raw.webm",
        destination,
        trim,
        ...(name === "video" ? { format: "mp4" } : {}),
        signal: controller.signal,
        async run(_command, args) {
          ffmpegArgs = args
          controller.abort(new Error(`abort ${name}`))
        },
        async convert() {
          calls.push(["convert"])
        },
        async rename(...args) {
          calls.push(["rename", ...args])
        },
        async remove(path) {
          calls.push(["remove", path])
        },
      }),
      new RegExp(`abort ${name}`),
    )
    assert.deepEqual(
      calls,
      expectedTemporaryPaths.map((path) => ["remove", path]),
    )
    const ss = ffmpegArgs.indexOf("-ss")
    assert.deepEqual(ffmpegArgs.slice(ss, ss + 6), ["-ss", "2.000", "-t", "14.500", "-i", "/run/raw.webm"])
    assert.equal(ffmpegArgs.some((arg) => /overlay|tpad/.test(arg)), false)
    if (name === "animation") {
      const map = ffmpegArgs.indexOf("-map")
      assert.deepEqual(ffmpegArgs.slice(map, map + 2), ["-map", "[outv]"])
    }
  }
})

test("fixed media publication rolls back every prior asset and pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-media-publish-"))
  try {
    for (const failureAt of ["poster", "animation", "pointer"]) {
      const caseRoot = join(root, failureAt)
      const stagedRoot = join(caseRoot, "staged")
      const fixedRoot = join(caseRoot, "fixed")
      await Promise.all([
        mkdir(stagedRoot, { recursive: true }),
        mkdir(fixedRoot, { recursive: true }),
      ])
      const entries = ["poster", "animation", "pointer"].map((name) => ({
        name,
        stagedPath: join(stagedRoot, name),
        targetPath: join(fixedRoot, name),
      }))
      for (const entry of entries) {
        await writeFile(entry.stagedPath, `new-${entry.name}`)
        await writeFile(entry.targetPath, `old-${entry.name}`)
      }

      await assert.rejects(
        publishFixedAssets({
          entries,
          transactionId: `run-${failureAt}`,
          async afterPublish(name) {
            if (name === failureAt) throw new Error(`fail after ${name}`)
          },
        }),
        new RegExp(`fail after ${failureAt}`),
      )
      for (const entry of entries) {
        assert.equal(await readFile(entry.targetPath, "utf8"), `old-${entry.name}`)
      }
      assert.deepEqual((await readdir(fixedRoot)).sort(), ["animation", "pointer", "poster"])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failed backup restoration preserves and reports the recovery file", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-media-recovery-"))
  try {
    const stagedPath = join(root, "staged")
    const targetPath = join(root, "fixed")
    const transactionId = "run-recovery"
    const backupPath = `${targetPath}.backup-${transactionId}`
    await writeFile(stagedPath, "new bytes")
    await writeFile(targetPath, "old recoverable bytes")
    let thrown
    try {
      await publishFixedAssets({
        entries: [{ name: "animation", stagedPath, targetPath }],
        transactionId,
        afterPublish() {
          throw new Error("publish failed")
        },
        rename(source, destination) {
          if (source === backupPath && destination === targetPath) {
            throw new Error("restore rename failed")
          }
          return renameFile(source, destination)
        },
      })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof AggregateError)
    assert.match(thrown.message, new RegExp(backupPath.replaceAll("/", "\\/")))
    await assert.rejects(readFile(targetPath), { code: "ENOENT" })
    assert.equal(await readFile(backupPath, "utf8"), "old recoverable bytes")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("publication preflight preserves and reports every existing recovery backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-media-preflight-"))
  try {
    const transactionId = "run-preflight"
    const entries = ["manifest", "pointer"].map((name) => ({
      name,
      stagedPath: join(root, `${name}.staged`),
      targetPath: join(root, `${name}.fixed`),
    }))
    for (const entry of entries) {
      await writeFile(entry.stagedPath, `new:${entry.name}`)
      await writeFile(entry.targetPath, `old:${entry.name}`)
      await writeFile(`${entry.targetPath}.backup-${transactionId}`, `recovery:${entry.name}`)
      await writeFile(`${entry.targetPath}.next-${transactionId}`, `candidate:${entry.name}`)
    }
    let thrown
    try {
      await publishFixedAssets({ entries, transactionId })
    } catch (error) {
      thrown = error
    }
    assert.ok(thrown instanceof Error)
    for (const entry of entries) {
      const backupPath = `${entry.targetPath}.backup-${transactionId}`
      assert.match(thrown.message, new RegExp(backupPath.replaceAll("/", "\\/")))
      assert.equal(await readFile(entry.targetPath, "utf8"), `old:${entry.name}`)
      assert.equal(await readFile(backupPath, "utf8"), `recovery:${entry.name}`)
      assert.equal(
        await readFile(`${entry.targetPath}.next-${transactionId}`, "utf8"),
        `candidate:${entry.name}`,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("encoding failures never mix fixed assets or the latest pointer across runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-media-encode-"))
  try {
    for (const failureAt of ["video", "poster", "animation", "pointer"]) {
      const repoRoot = join(root, failureAt)
      const runId = `run-${failureAt}`
      const artifactsDir = join(repoRoot, "docs/brand/demo/artifacts/runs", runId)
      const recordingsDir = join(repoRoot, "docs/brand/demo/raw-recordings/runs", runId)
      const source = join(recordingsDir, "raw.webm")
      const summaryPath = join(artifactsDir, "capture-summary.json")
      const fixedPaths = [
        join(artifactsDir, "media-manifest.json"),
        ...MEDIA_CONTRACTS.map(({ name }) =>
          join(repoRoot, `apps/web/public/demo/${name}-poster.webp`),
        ),
        join(repoRoot, "docs/brand/product-loop.webp"),
        join(repoRoot, "docs/brand/demo/artifacts/latest-media.json"),
      ]
      await Promise.all([
        mkdir(recordingsDir, { recursive: true }),
        mkdir(artifactsDir, { recursive: true }),
        mkdir(join(repoRoot, "apps/web/public/demo"), { recursive: true }),
        mkdir(join(repoRoot, "docs/brand"), { recursive: true }),
        mkdir(join(repoRoot, "docs/brand/demo/artifacts"), { recursive: true }),
      ])
      await writeFile(source, "raw")
      for (const path of fixedPaths) await writeFile(path, `old:${path}`)
      const summary = {
        runId,
        videoPath: source,
        videoTimeline: {
          unit: "milliseconds",
          scenes: BEAT_SCENES,
        },
      }
      const controller = new AbortController()

      await assert.rejects(
        encodeCaptureArtifacts({
          repoRoot,
          artifactsDir,
          recordingsDir,
          summary,
          summaryPath,
          signal: controller.signal,
          dependencies: {
            async encodeVideo({ destination }) {
              await writeFile(destination, "video")
            },
            async encodePoster({ source: posterSource, destination, time }) {
              assert.equal(posterSource, join(artifactsDir, "output/product-loop.mp4"))
              assert.equal(
                time,
                createTrimPlan({ videoTimeline: summary.videoTimeline }).posterTime,
              )
              assert.equal(time, 2.75)
              await writeFile(destination, "poster")
            },
            async encodeReadmeAnimation({ destination, trim }) {
              assert.equal(
                destination,
                join(artifactsDir, "publication/product-loop.webp"),
              )
              assert.deepEqual(trim, { start: 2, duration: 14.5, posterTime: 2.75 })
              await writeFile(destination, "animation")
            },
            async validateStagedMedia(options) {
              assert.equal(options.signal, controller.signal)
            },
            async afterPhase(phase) {
              if (phase === failureAt) throw new Error(`fail after ${phase}`)
            },
          },
        }),
        new RegExp(`fail after ${failureAt}`),
      )
      for (const path of fixedPaths) {
        assert.equal(await readFile(path, "utf8"), `old:${path}`)
      }
      const fixedNames = await readdir(join(repoRoot, "apps/web/public/demo"))
      assert.equal(
        fixedNames.some((name) => /\.(?:next|backup|tmp)-/u.test(name)),
        false,
      )
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("scenario prompts fit the thread title and state the aircraft fact", () => {
  // The Workbench cuts a thread title to 80 characters; the capture matches the
  // whole prompt against that title.
  assert.ok(DEMO_PROMPT.length <= 80, `DEMO_PROMPT is ${DEMO_PROMPT.length} characters`)
  for (const part of ["KSTP", "KRST", "4500", "1400Z", "N738ZU", "long-range tanks"]) {
    assert.ok(DEMO_PROMPT.includes(part), `DEMO_PROMPT names ${part}`)
  }
  assert.equal(DEMO_FILE_PROMPT, "File the flight plan.")
  assert.equal(DEMO_FIXTURES, DEMO_SCENARIO.fixtures)
  assert.equal(DEMO_PLAN_ANSWER, DEMO_SCENARIO.planAnswer)
  assert.deepEqual(DEMO_PLAN_TOOLS, DEMO_SCENARIO.planTools)
})

test("normalizeLog narrowly removes capture instability", () => {
  const temporaryRoot = "/tmp/b4-demo-[42]"
  const raw = [
    `\u001B[32mPASS\u001B[39m ${temporaryRoot}/server/test/navlog.test.ts 143ms`,
    "✓ splits the first leg into a climb segment and a cruise segment 1.27s",
    "command: npm test -- --seed=42",
    "7 passed, score 98.6, port 3002",
    "FAIL preserves this test name and exit code 17",
    "/tmp/b4-demo-other/server 143widgets v1.27stable",
  ].join("\n")

  assert.equal(
    normalizeLog(raw, { temporaryRoot }),
    [
      "PASS <workspace>/server/test/navlog.test.ts <time>",
      "✓ splits the first leg into a climb segment and a cruise segment <time>",
      "command: npm test -- --seed=42",
      "7 passed, score 98.6, port 3002",
      "FAIL preserves this test name and exit code 17",
      "/tmp/b4-demo-other/server 143widgets v1.27stable",
    ].join("\n"),
  )
})

test("normalizeLog validates meaningful inputs", () => {
  assert.throws(() => normalizeLog(42, { temporaryRoot: "/tmp/demo" }), /log must be a string/)
  assert.throws(() => normalizeLog("PASS", { temporaryRoot: "" }), /temporaryRoot/)
})

const NAVLOG_TEMPLATE = fileURLToPath(
  new URL("../../../packages/devkit/templates/app-navlog/", import.meta.url),
)

/** The storyboard's files, read from the navlog template the scaffold copies. */
function templateFiles() {
  return Object.fromEntries(
    storyboardPaths().map((path) => [path, readFileSync(join(NAVLOG_TEMPLATE, path), "utf8")]),
  )
}

const DIRECTOR_WORDMARK = '<svg viewBox="-5 -5 522 115"><circle r="17"/></svg>'

/** Minimal sources that satisfy every focal pattern, with markup to escape. */
function syntheticFiles() {
  const files = {}
  for (const beat of STORYBOARD) {
    for (const pane of beat.panes ?? []) {
      const focal = {
        "server/src/app/navlog/index.ts":
          '  tools: { deny: ["runBash"], approve: [{ tool: "fileFlightPlan", allowAlways: false }] },',
        "server/src/app/navlog/subagents/weather/index.ts":
          '    allow: ["getMetar", "getTaf", "getWindsAloft", "getAdvisories"],',
        "server/src/tools/getMetar.ts": '    flightCategory: record.fltCat ?? "UNKNOWN",',
        "server/src/tools/computeNavlog.ts": "  computeNavlog(input)",
        "server/src/lib/navlog.ts": "      const tri = solveWindTriangle({",
        "server/src/app/navlog/memory.ts": '  scope: ["workspace", "route"],',
      }[pane.path]
      files[pane.path] = `// ${pane.path} <Generic>\nexport default x\n${focal}\n})`
    }
  }
  return files
}

test("storyboard follows the spec's twelve beats, frozen", () => {
  assert.deepEqual(
    STORYBOARD.map(({ id, kind, headline }) => [id, kind, headline]),
    [
      ["title", "title", "navlog"],
      ["agent", "code", "One file is the agent."],
      ["ask", "app", "Ask for a flight."],
      ["subagents", "code", "Subagents brief the weather."],
      ["weather", "app", "Live weather, judged."],
      ["tools", "code", "Tools do the math."],
      ["navlog", "app", "A real navlog."],
      ["gate", "code", "Filing needs a yes."],
      ["file", "app", "Approve once."],
      ["memory", "code", "It remembers you."],
      ["reload", "app", "Reload. Still there."],
      ["close", "close", "Ridiculous speed. Readable code."],
    ],
  )
  assert.equal(STORYBOARD[0].subtitle, "A VFR flight planner, built with B4.run")
  assert.equal(new Set(STORYBOARD.map((beat) => beat.id)).size, STORYBOARD.length)
  assert.equal(Object.isFrozen(STORYBOARD), true)
  for (const beat of STORYBOARD) {
    assert.equal(Object.isFrozen(beat), true, beat.id)
    assert.equal(Number.isInteger(beat.holdMs) && beat.holdMs > 0, true, beat.id)
    if (beat.kind !== "title") {
      assert.equal(beat.headline.split(" ").length >= 2 && beat.headline.split(" ").length <= 5, true)
    }
    if (beat.kind === "code") {
      assert.equal(beat.panes.length === 1 || beat.panes.length === 2, true, beat.id)
      assert.equal(Object.isFrozen(beat.panes), true)
      for (const pane of beat.panes) {
        assert.equal(Object.isFrozen(pane), true)
        assert.match(pane.path, /^server\/src\/.+\.ts$/)
        assert.equal(pane.focal instanceof RegExp, true)
      }
    } else {
      assert.equal(beat.panes, undefined, beat.id)
    }
    if (beat.kind === "app") {
      assert.equal(Object.hasOwn(APP_FOCUS, beat.focus), true, beat.id)
      assert.equal(APP_ACTIONS.includes(beat.action), true, beat.id)
    } else {
      assert.equal(beat.focus ?? beat.action, undefined, beat.id)
    }
  }
  assert.deepEqual(
    STORYBOARD.filter((beat) => beat.kind === "app").map((beat) => beat.action),
    [...APP_ACTIONS],
  )
  assert.deepEqual(storyboardPaths(), [
    "server/src/app/navlog/index.ts",
    "server/src/app/navlog/subagents/weather/index.ts",
    "server/src/tools/getMetar.ts",
    "server/src/tools/computeNavlog.ts",
    "server/src/lib/navlog.ts",
    "server/src/app/navlog/memory.ts",
  ])
})

test("app camera presets are the seven named regions, as data", () => {
  assert.deepEqual(Object.keys(APP_FOCUS), [
    "rest",
    "todos",
    "weather",
    "map",
    "sheet",
    "approval",
    "memory",
  ])
  assert.deepEqual(APP_FOCUS.rest, { scale: 1, origin: "50% 50%" })
  assert.equal(Object.isFrozen(APP_FOCUS), true)
  for (const [name, preset] of Object.entries(APP_FOCUS)) {
    assert.equal(Object.isFrozen(preset), true, name)
    assert.equal(preset.scale >= 1 && preset.scale <= 2, true, name)
    const [x, y] = preset.origin.split(" ").map((part) => Number(part.replace(/%$/, "")))
    assert.match(preset.origin, /^\d+(?:\.\d+)?% \d+(?:\.\d+)?%$/, name)
    assert.equal(x >= 0 && x <= 100 && y >= 0 && y <= 100, true, name)
  }
})

test("every storyboard focal pattern matches exactly its intended line of the real template", () => {
  const intended = {
    agent: [
      '  tools: { deny: ["runBash"], approve: [{ tool: "fileFlightPlan", allowAlways: false }] },',
    ],
    subagents: [
      '    allow: ["getMetar", "getTaf", "getWindsAloft", "getAdvisories"],',
      '    flightCategory: record.fltCat ?? "UNKNOWN",',
    ],
    tools: ["  computeNavlog(input)", "      const tri = solveWindTriangle({"],
    gate: [
      '  tools: { deny: ["runBash"], approve: [{ tool: "fileFlightPlan", allowAlways: false }] },',
    ],
    memory: ['  scope: ["workspace", "route"],'],
  }
  const files = templateFiles()
  for (const beat of STORYBOARD.filter((candidate) => candidate.kind === "code")) {
    beat.panes.forEach((pane, at) => {
      const matches = files[pane.path].split("\n").filter((line) => pane.focal.test(line))
      assert.deepEqual(matches, [intended[beat.id][at]], `${beat.id} ${pane.path}`)
    })
  }
  // The gate beat marks the approve part of the line the agent beat marks whole.
  const route = files["server/src/app/navlog/index.ts"].split("\n")
  const toolsLine = route.find((line) => STORYBOARD[1].panes[0].focal.test(line))
  assert.equal(
    toolsLine.match(STORYBOARD[7].panes[0].focal)[0],
    'approve: [{ tool: "fileFlightPlan", allowAlways: false }]',
  )
})

test("windowAround keeps a fixed-size window around the index, clamped to the file", () => {
  const lines = Array.from({ length: 40 }, (_, at) => `line-${at}`)
  assert.deepEqual(windowAround(lines, 20, { before: 3, after: 2 }), {
    lines: lines.slice(17, 23),
    start: 17,
    focusIndex: 3,
  })
  assert.deepEqual(windowAround(lines, 1, { before: 3, after: 2 }), {
    lines: lines.slice(0, 6),
    start: 0,
    focusIndex: 1,
  })
  assert.deepEqual(windowAround(lines, 39, { before: 3, after: 2 }), {
    lines: lines.slice(34, 40),
    start: 34,
    focusIndex: 5,
  })
  assert.deepEqual(windowAround(lines.slice(0, 4), 2, { before: 3, after: 2 }), {
    lines: lines.slice(0, 4),
    start: 0,
    focusIndex: 2,
  })
  assert.throws(() => windowAround(lines, 40, { before: 1, after: 1 }), /index/)
})

test("director renders a layer per code beat from the real template, escaped and focal-marked", () => {
  const files = templateFiles()
  const html = renderDirector({ files, wordmark: DIRECTOR_WORDMARK })
  const codeBeats = STORYBOARD.filter((beat) => beat.kind === "code")
  for (const beat of codeBeats) {
    const layer = html.match(
      new RegExp(`<div class="layer code[^"]*" data-layer="${beat.id}"[^>]*>([\\s\\S]*?)</section></div>`),
    )
    assert.ok(layer, beat.id)
    assert.equal(layer[1].match(/class="focus"/g)?.length, beat.panes.length, beat.id)
    for (const pane of beat.panes) assert.ok(layer[1].includes(`<div class="strip">${pane.path}</div>`))
    if (beat.panes.length === 2) assert.match(layer[0], /class="layer code two"/)
  }
  assert.equal(
    html.match(/class="focus"/g)?.length,
    codeBeats.reduce((sum, beat) => sum + beat.panes.length, 0),
  )
  // Escaped, never raw: computeNavlog.ts has generics, the route has template literals.
  assert.ok(html.includes("Promise&lt;Navlog&gt;"))
  assert.equal(html.includes("Promise<Navlog>"), false)
  assert.ok(html.includes('<span class="hit part">approve: [{ tool: &quot;fileFlightPlan&quot;, allowAlways: false }]</span>'))
  assert.ok(html.includes('<span class="hit">const tri = solveWindTriangle({</span>'))
  // A long file shows a window: navlog.ts is far longer than one pane.
  const navlogPane = html.match(/<div class="strip">server\/src\/lib\/navlog\.ts<\/div><pre>([\s\S]*?)<\/pre>/)[1]
  assert.equal(navlogPane.split("\n").length, CODE_PANE_LINES.two)
  assert.match(navlogPane, /const tri = solveWindTriangle/)
  assert.doesNotMatch(navlogPane, /^import /m)
  // A short file shows whole.
  const memoryPane = html.match(/<div class="strip">server\/src\/app\/navlog\/memory\.ts<\/div><pre>([\s\S]*?)<\/pre>/)[1]
  assert.match(memoryPane, /^import \{ defineMemory \}/)
  assert.match(memoryPane, /^\}\)$/m)
})

test("director page holds the title card, the Workbench iframe, the close and the tokens, with no header or act chip", () => {
  const html = renderDirector({ files: syntheticFiles(), wordmark: DIRECTOR_WORDMARK })
  assert.ok(html.includes("&lt;Generic&gt;"))
  assert.equal(html.includes("<Generic>"), false)
  const title = html.match(/<div class="title">([\s\S]*?)<\/div><\/div>\n/)[1]
  assert.ok(title.startsWith('<svg viewBox="-5 -5 522 115"><circle r="17"/></svg>'))
  assert.equal(
    title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    "navlog A VFR flight planner, built with B4.run",
  )
  assert.equal(html.match(/<svg viewBox="-5 -5 522 115">/g)?.length, 2)
  assert.match(html, /<iframe name="workbench" src="about:blank"/)
  assert.equal(html.match(/<iframe/g)?.length, 1)
  for (const token of ["#f5f4f0", "#111111", "#17181b", "#b4ce37", "#75796a"]) {
    assert.match(html, new RegExp(token, "i"))
  }
  for (const font of Object.keys(DIRECTOR_FONTS)) assert.match(html, new RegExp(`fonts/${font.replace(".", "\\.")}`))
  assert.match(html, /npm create b4-app@latest my-agent/)
  assert.match(html, /Ridiculous speed\. Readable code\./)
  assert.match(html, /<div class="sweep"><\/div>/)
  assert.match(html, /window\.director = \{ ready: true, reset, play, focus \}/)
  assert.ok(html.includes(JSON.stringify(APP_FOCUS)))
  assert.doesNotMatch(html, /<header|\bact-chip\b|\bAUTHOR\b|\bPROVE\b/)
  assert.doesNotMatch(html, /border-radius:\s*(?!50%)\d/)
  assert.doesNotMatch(html, /box-shadow:\s*0 \d/)
})

test("director page keeps the take-1 runtime fixes", () => {
  const html = renderDirector({ files: syntheticFiles(), wordmark: DIRECTOR_WORDMARK })
  // The sweep and its dot stay hidden until the close.
  assert.ok(html.includes(".sweep { visibility: hidden;"))
  assert.ok(html.includes(".closing .sweep { left: 0; visibility: visible; }"))
  // The focal bar sits behind its line, not over the code.
  assert.ok(html.includes(".focus { position: relative; z-index: 0; }"))
  assert.ok(html.includes(".roll { overflow: hidden; height: 1.12em; }"))
  assert.match(html, /\.stage \{[^}]*overflow: clip;/)
  assert.match(html, /\.frame \{[^}]*overflow: clip;/)
  // The camera's origin never changes: it moves by translate + scale about 0 0,
  // so no zoom, in or out or between presets, can jump.
  assert.match(html, /\.camera \{[^}]*transform-origin: 0 0;/)
  assert.doesNotMatch(html, /transformOrigin/)
  // Layers stack in DOM order; the Workbench layer is last so it takes clicks.
  const layers = [...html.matchAll(/data-layer="([a-z-]+)"/g)].map((match) => match[1])
  assert.deepEqual(layers, [
    ...STORYBOARD.filter((beat) => beat.kind === "code").map((beat) => beat.id),
    "app",
  ])
  assert.ok(html.includes(".layer:not(.on) { pointer-events: none; }"))
  // Preparation state: the frame in place with the Workbench showing.
  assert.match(html, /<div class="stage prep">/)
  assert.match(html, /<div class="layer app on" data-layer="app">/)
})

test("director refuses a missing file, a missing focal line and an ambiguous one", () => {
  const files = syntheticFiles()
  const { "server/src/lib/navlog.ts": _removed, ...missing } = files
  assert.throws(
    () => renderDirector({ files: missing, wordmark: DIRECTOR_WORDMARK }),
    /storyboard beat "tools" needs server\/src\/lib\/navlog\.ts, which files does not include/,
  )
  assert.throws(
    () =>
      renderDirector({
        files: { ...files, "server/src/app/navlog/memory.ts": "export default defineMemory({})" },
        wordmark: DIRECTOR_WORDMARK,
      }),
    /storyboard beat "memory": no line of server\/src\/app\/navlog\/memory\.ts matches/,
  )
  assert.throws(
    () =>
      renderDirector({
        files: {
          ...files,
          "server/src/tools/computeNavlog.ts": "  computeNavlog(input)\n  computeNavlog(input)",
        },
        wordmark: DIRECTOR_WORDMARK,
      }),
    /storyboard beat "tools": 2 lines of server\/src\/tools\/computeNavlog\.ts match/,
  )
  assert.throws(() => renderDirector({ files: null, wordmark: DIRECTOR_WORDMARK }), /files must be an object/)
  assert.throws(() => renderDirector({ files, wordmark: "" }), /wordmark must be a non-empty string/)
})

test("wordmark comes from the ink SVG master without its title or description", () => {
  const svg = wordmarkSvg()
  assert.match(svg, /^<svg /)
  assert.match(svg, /viewBox="-5 -5 522 115"/)
  assert.doesNotMatch(svg, /<title>|<desc>/)
  assert.match(svg, /fill="#111111"/)
})

class FakeChild extends EventEmitter {
  constructor(pid = 4321) {
    super()
    this.pid = pid
    this.exitCode = null
    this.signalCode = null
  }

  exit(code = 0) {
    this.exitCode = code
    this.emit("exit", code, null)
  }
}

class ExitDuringListenerChild extends FakeChild {
  once(event, listener) {
    if (event === "exit" && this.exitCode === null) this.exitCode = 23
    return super.once(event, listener)
  }
}

test("encoder command owns and joins an aborted ffmpeg child", async () => {
  const child = new FakeChild(7654)
  const controller = new AbortController()
  const stopped = []
  const command = runEncoderCommand("ffmpeg", ["-version"], {
    signal: controller.signal,
    spawn: () => child,
    stop: async (ownedChild) => {
      stopped.push(ownedChild.pid)
      ownedChild.exit(0)
    },
  })
  controller.abort(new Error("encoding cancelled"))
  await assert.rejects(command, /encoding cancelled/)
  assert.deepEqual(stopped, [7654])
})

function manualTimers() {
  const scheduled = []
  return {
    scheduled,
    timers: {
      setTimeout(callback, delay) {
        const handle = { callback, delay, cleared: false }
        scheduled.push(handle)
        return handle
      },
      clearTimeout(handle) {
        handle.cleared = true
      },
    },
  }
}

test("spawnManaged delegates one command to the injected spawn function", () => {
  const child = new FakeChild()
  const calls = []
  const result = spawnManaged("npm", ["test"], {
    spawn(command, args, options) {
      calls.push({ command, args, options })
      return child
    },
    options: { cwd: "/tmp/demo" },
  })

  assert.equal(result, child)
  assert.deepEqual(calls, [
    {
      command: "npm",
      args: ["test"],
      options: { cwd: "/tmp/demo", stdio: "pipe" },
    },
  ])
})

test("waitForHttp resolves when the injected fetch reports readiness", async () => {
  const child = new FakeChild()
  const { timers } = manualTimers()
  const calls = []
  await waitForHttp("http://127.0.0.1:3002/health", child, {
    fetch: async (url) => {
      calls.push(url)
      return { ok: true }
    },
    timers,
    timeoutMs: 500,
    intervalMs: 10,
  })
  assert.deepEqual(calls, ["http://127.0.0.1:3002/health"])
})

test("waitForHttp rejects when the managed child exits before readiness", async () => {
  const child = new FakeChild()
  const { timers } = manualTimers()
  const readiness = waitForHttp("http://127.0.0.1:3002/health", child, {
    fetch: async () => {
      throw new Error("not ready")
    },
    timers,
    timeoutMs: 500,
    intervalMs: 10,
  })
  child.exit(1)
  await assert.rejects(readiness, /exited before .* became ready.*code 1/)
})

test("waitForHttp rejects when the managed child already exited by signal", async () => {
  const child = new FakeChild()
  child.signalCode = "SIGTERM"
  let fetchCalls = 0
  await assert.rejects(
    waitForHttp("http://127.0.0.1:3002/health", child, {
      fetch: async () => {
        fetchCalls += 1
        return { ok: true }
      },
    }),
    /already exited with signal SIGTERM/,
  )
  assert.equal(fetchCalls, 0)
})

test("waitForHttp catches exit state that changes while its listener is installed", async () => {
  const child = new ExitDuringListenerChild()
  let fetchCalls = 0
  await assert.rejects(
    waitForHttp("http://127.0.0.1:3002/health", child, {
      fetch: async () => {
        fetchCalls += 1
        return { ok: true }
      },
    }),
    /already exited with code 23/,
  )
  assert.equal(fetchCalls, 0)
})

test("waitForHttp rejects on the injected readiness timeout", async () => {
  const child = new FakeChild()
  const { scheduled, timers } = manualTimers()
  const readiness = waitForHttp("http://127.0.0.1:3002/health", child, {
    fetch: async () => {
      throw new Error("not ready")
    },
    timers,
    timeoutMs: 500,
    intervalMs: 10,
  })
  const timeout = scheduled.find(({ delay }) => delay === 500)
  assert.ok(timeout)
  timeout.callback()
  await assert.rejects(readiness, /Timed out after 500ms waiting for/)
})

test("waitForHttp aborts an in-flight probe and removes readiness listeners", async () => {
  const child = new FakeChild()
  const { timers } = manualTimers()
  const controller = new AbortController()
  const cancellation = new Error("cancel readiness probe")
  let probeAborted = false
  const readiness = waitForHttp("http://127.0.0.1:3002/health", child, {
    fetch: (_url, options) =>
      new Promise((_, reject) => {
        assert.equal(options.signal, controller.signal)
        options.signal.addEventListener(
          "abort",
          () => {
            probeAborted = true
            reject(options.signal.reason)
          },
          { once: true },
        )
      }),
    timers,
    timeoutMs: 500,
    intervalMs: 10,
    signal: controller.signal,
  })
  controller.abort(cancellation)

  await assert.rejects(readiness, (error) => error === cancellation)
  assert.equal(probeAborted, true)
  assert.equal(child.listenerCount("exit"), 0)
  assert.equal(child.listenerCount("error"), 0)
})

test("stopManaged sends SIGTERM and clears its timeout when the child exits", async () => {
  const child = new FakeChild(4321)
  const { scheduled, timers } = manualTimers()
  const signals = []
  const stopped = stopManaged(child, {
    kill(pid, signal) {
      signals.push([pid, signal])
    },
    timers,
    timeoutMs: 250,
  })
  assert.deepEqual(signals, [[4321, "SIGTERM"]])
  child.exit(0)
  await stopped
  assert.equal(scheduled[0]?.cleared, true)
  assert.deepEqual(signals, [[4321, "SIGTERM"]])
})

test("stopManaged does not signal a child that already exited by signal", async () => {
  const child = new FakeChild(4321)
  child.signalCode = "SIGTERM"
  const signals = []
  await stopManaged(child, {
    kill(pid, signal) {
      signals.push([pid, signal])
    },
  })
  assert.deepEqual(signals, [])
})

test("stopManaged catches exit state that changes while its listener is installed", async () => {
  const child = new ExitDuringListenerChild(4321)
  const signals = []
  await stopManaged(child, {
    kill(pid, signal) {
      signals.push([pid, signal])
    },
  })
  assert.deepEqual(signals, [])
})

test("stopManaged waits for confirmed child close after escalating its known PID", async () => {
  const child = new FakeChild(9876)
  const { scheduled, timers } = manualTimers()
  const signals = []
  let settled = false
  const stopped = stopManaged(child, {
    kill(pid, signal) {
      signals.push([pid, signal])
    },
    timers,
    timeoutMs: 250,
    confirmationTimeoutMs: 100,
  })
  void stopped.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  assert.equal(scheduled[0]?.delay, 250)
  scheduled[0].callback()
  await Promise.resolve()
  assert.deepEqual(signals, [
    [9876, "SIGTERM"],
    [9876, "SIGKILL"],
  ])
  assert.equal(settled, false)
  assert.equal(scheduled[1]?.delay, 100)
  child.emit("close", null, "SIGKILL")
  await stopped
  assert.equal(settled, true)
})

test("stopManaged rejects when SIGKILL termination is not confirmed in time", async () => {
  const child = new FakeChild(9876)
  const { scheduled, timers } = manualTimers()
  const stopped = stopManaged(child, {
    kill() {},
    timers,
    timeoutMs: 250,
    confirmationTimeoutMs: 100,
  })
  scheduled[0].callback()
  assert.equal(scheduled[1]?.delay, 100)
  scheduled[1].callback()
  await assert.rejects(stopped, /Managed child PID 9876 did not exit within 100ms after SIGKILL/)
})

const EXPECTED_ANSWER = DEMO_PLAN_ANSWER

function orchestrationFixture({ failAt } = {}) {
  const operations = []
  const writes = []
  const renames = []
  const stopped = []
  const childEnvironments = []
  const workspaceRoot = "/tmp/b4-demo-unit-abc123"
  const appRoot = `${workspaceRoot}/my-agent`
  const server = { name: "server" }
  const workbench = { name: "workbench" }
  const aimock = {
    baseUrl: "http://127.0.0.1:4040/v1",
    async close() {
      operations.push("close aimock")
    },
  }
  let assignedPort = 4100
  let monotonicNow = 0

  const adapters = {
    commands: {
      async checkToolchain() {
        operations.push("check toolchain")
        return { node: "v24.19.0", pnpm: "10.33.0" }
      },
      async build() {
        operations.push("build")
      },
      async scaffold(options) {
        operations.push("scaffold --mode internal")
        assert.equal(options.appRoot, appRoot)
      },
      async install(options) {
        operations.push("install")
        assert.equal(options.appRoot, appRoot)
      },
      async test(options) {
        operations.push("npm test")
        assert.equal(options.appRoot, appRoot)
        return {
          stdout: [
            `\u001B[32mPASS\u001B[39m ${appRoot}/server/test/navlog.test.ts 143ms`,
            "\u2713 splits the first leg into a climb segment and a cruise segment 1.27s",
            "Tests 7 passed",
          ].join("\n"),
          stderr: "",
          exitCode: 0,
        }
      },
    },
    filesystem: {
      async mkdtemp() {
        return workspaceRoot
      },
      async mkdir() {},
      async writeFile(path, contents) {
        writes.push({ path, contents })
        if (path.endsWith("capture-summary.json")) {
          operations.push("write summary")
        }
      },
      async rename(from, to) {
        renames.push({ from, to })
        operations.push("publish summary")
      },
      async readFile(path) {
        const source = storyboardPaths().find((candidate) => path === `${appRoot}/${candidate}`)
        if (source !== undefined) return readFileSync(join(NAVLOG_TEMPLATE, source), "utf8")
        if (path.endsWith(".ttf")) {
          return Buffer.from(`font:${path.split("/").at(-1)}`)
        }
        throw new Error(`unexpected read: ${path}`)
      },
      async rm(path) {
        operations.push(`remove ${path}`)
      },
    },
    processes: {
      async startAimock(fixtures) {
        operations.push("start aimock")
        assert.deepEqual(fixtures, DEMO_FIXTURES)
        return aimock
      },
      async getPort(excluded) {
        const port = assignedPort++
        assert.equal(excluded.has(port), false)
        operations.push(`assign port ${port}`)
        return port
      },
      async startB4(options) {
        operations.push("start B4.run server")
        assert.equal(options.cwd, `${appRoot}/server`)
        childEnvironments.push({ service: "server", env: options.env })
        return server
      },
      async startWorkbench(options) {
        operations.push("start Workbench")
        assert.equal(options.cwd, `${appRoot}/web`)
        childEnvironments.push({ service: "workbench", env: options.env })
        return workbench
      },
      async stop(child) {
        stopped.push(child)
        operations.push(`stop ${child.name}`)
      },
    },
    browser: {
      async open(options) {
        assert.deepEqual(options.viewport, { width: 1440, height: 810 })
        assert.match(
          options.recordingsDir,
          /docs\/brand\/demo\/raw-recordings\/runs\/[A-Za-z0-9_-]+$/,
        )
        return {
          async openDirector({ origin, html, fonts }) {
            operations.push("open director")
            assert.equal(origin, "http://127.0.0.1:4101")
            assert.match(html, /export default agent\(\{/)
            for (const path of storyboardPaths()) {
              assert.ok(html.includes(`<div class="strip">${path}</div>`), path)
            }
            assert.match(html, /<span class="hit">computeNavlog\(input\)<\/span>/)
            assert.doesNotMatch(html, /b4-demo-unit-abc123/)
            assert.equal(html.includes("\u001B"), false)
            assert.deepEqual(Object.keys(fonts), [
              "Inter-400.ttf",
              "Inter-600.ttf",
              "JetBrainsMono-400.ttf",
            ])
          },
          async prepareWorkbench(options) {
            operations.push("prepare Workbench")
            assert.equal(options.url, "http://127.0.0.1:4101")
            assert.equal(options.prompt, DEMO_PROMPT)
          },
          async play({ beat }) {
            operations.push(`play ${beat}`)
          },
          async focus({ target }) {
            operations.push(`focus ${target}`)
          },
          async runScenario(options) {
            operations.push("run Workbench scenario")
            assert.equal(options.prompt, DEMO_PROMPT)
            assert.deepEqual(options.tools, DEMO_PLAN_TOOLS)
            assert.equal(options.answer, EXPECTED_ANSWER)
            if (failAt === "scenario") throw new Error("scenario failed")
            return { threadId: "thread-unit-1" }
          },
          async reloadAndRestore(options) {
            operations.push("reload")
            assert.equal(options.threadId, "thread-unit-1")
            assert.equal(options.answer, EXPECTED_ANSWER)
          },
          async close() {
            operations.push("close browser")
            return { videoPath: `${options.recordingsDir}/demo.webm` }
          },
        }
      },
    },
    timing: {
      now() {
        monotonicNow += 1
        return monotonicNow
      },
      async sleep() {},
    },
  }

  return {
    adapters,
    aimock,
    appRoot,
    childEnvironments,
    operations,
    renames,
    stopped,
    workspaceRoot,
    writes,
  }
}

test("capture orchestrates the real-product phases in exact order and cleans up", async () => {
  const fixture = orchestrationFixture()
  const result = await captureDemo({
    repoRoot: "/repo",
    parentEnv: { PATH: "/bin", HOME: "/home/test", LANG: "en_US.UTF-8" },
    adapters: fixture.adapters,
    recordOnly: true,
  })

  assert.deepEqual(fixture.operations, [
    "check toolchain",
    "build",
    "scaffold --mode internal",
    "install",
    "npm test",
    "start aimock",
    "assign port 4100",
    "start B4.run server",
    "assign port 4101",
    "start Workbench",
    "open director",
    "prepare Workbench",
    "play 0",
    "play 1",
    "play 5",
    "play 2",
    "run Workbench scenario",
    "focus todos",
    "focus rest",
    "reload",
    "focus sheet",
    "play 11",
    "close browser",
    "publish summary",
    "stop workbench",
    "stop server",
    "close aimock",
    `remove ${fixture.workspaceRoot}`,
  ])
  assert.deepEqual(fixture.stopped, [{ name: "workbench" }, { name: "server" }])
  assert.equal(result.threadId, "thread-unit-1")
  assert.equal(result.serverPort, 4100)
  assert.equal(result.workbenchPort, 4101)
})

test("capture stores raw test output only in ignored artifacts and stages normalized output", async () => {
  const fixture = orchestrationFixture()
  await captureDemo({
    repoRoot: "/repo",
    adapters: fixture.adapters,
    recordOnly: true,
  })

  const rawWrites = fixture.writes.filter(({ path }) => /test\.(stdout|stderr|result)/.test(path))
  assert.equal(rawWrites.length, 3)
  for (const write of rawWrites) {
    assert.match(write.path, /^\/repo\/docs\/brand\/demo\/artifacts\//)
  }
  assert.equal(
    fixture.writes.some(({ path }) => path.includes("raw-recordings") && path.endsWith(".log")),
    false,
  )
})

test("capture finally closes owned resources and removes only its exact mkdtemp workspace", async () => {
  const fixture = orchestrationFixture({ failAt: "scenario" })
  await assert.rejects(
    captureDemo({
      repoRoot: "/repo",
      adapters: fixture.adapters,
      recordOnly: true,
    }),
    /scenario failed/,
  )
  assert.deepEqual(fixture.stopped, [{ name: "workbench" }, { name: "server" }])
  assert.deepEqual(fixture.operations.slice(-5), [
    "close browser",
    "stop workbench",
    "stop server",
    "close aimock",
    `remove ${fixture.workspaceRoot}`,
  ])
  assert.equal(
    fixture.operations.some(
      (operation) => operation.includes("/tmp") && operation !== `remove ${fixture.workspaceRoot}`,
    ),
    false,
  )
})

test("operational environment copies only the documented local-toolchain allowlist", () => {
  assert.deepEqual(
    sanitizeOperationalEnvironment({
      PATH: "/toolchain/bin",
      HOME: "/home/test",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      TMPDIR: "/tmp/unit",
      TMP: "/tmp",
      TEMP: "/var/tmp",
      CI: "1",
      PNPM_HOME: "/cache/pnpm",
      COREPACK_HOME: "/cache/corepack",
      XDG_CACHE_HOME: "/cache/xdg",
      npm_config_cache: "/cache/npm",
      npm_config_store_dir: "/cache/pnpm-store",
      npm_config_userconfig: "/home/test/.npmrc",
      GITHUB_TOKEN: "github-secret",
      DATABASE_URL: "postgres://secret",
      CUSTOM_DEPLOY_SECRET: "custom-secret",
      OPENAI_API_KEY: "provider-secret",
    }),
    {
      PATH: "/toolchain/bin",
      HOME: "/home/test",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      LC_CTYPE: "C.UTF-8",
      TMPDIR: "/tmp/unit",
      TMP: "/tmp",
      TEMP: "/var/tmp",
      CI: "1",
      PNPM_HOME: "/cache/pnpm",
      COREPACK_HOME: "/cache/corepack",
      XDG_CACHE_HOME: "/cache/xdg",
      npm_config_cache: "/cache/npm",
      npm_config_store_dir: "/cache/pnpm-store",
      npm_config_userconfig: "/home/test/.npmrc",
    },
  )
})

test("child environment allowlists operations before applying exact server overrides", () => {
  const environment = buildChildEnvironment(
    {
      PATH: "/toolchain/bin",
      HOME: "/home/test",
      LANG: "en_US.UTF-8",
      LC_ALL: "C.UTF-8",
      TMPDIR: "/tmp/unit",
      npm_config_cache: "/cache/npm",
      PNPM_HOME: "/cache/pnpm",
      GITHUB_TOKEN: "github-secret",
      DATABASE_URL: "postgres://secret",
      CUSTOM_DEPLOY_SECRET: "custom-secret",
      OPENAI_API_KEY: "openai-parent",
      OPENAI_BASE_URL: "https://api.openai.com/v1",
      ANTHROPIC_API_KEY: "anthropic-parent",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      GOOGLE_API_KEY: "google-parent",
      GOOGLE_GENERATIVE_AI_BASE_URL: "https://google.example",
      AZURE_OPENAI_API_KEY: "azure-parent",
      AZURE_OPENAI_ENDPOINT: "https://azure.example",
      AWS_ACCESS_KEY_ID: "aws-parent",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      AWS_SESSION_TOKEN: "aws-token",
      AWS_BEDROCK_ENDPOINT: "https://bedrock.example",
      LANGCHAIN_TRACING_V2: "true",
      LANGSMITH_TRACING: "true",
    },
    "http://127.0.0.1:4040/v1",
  )

  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "npm_config_cache", "PNPM_HOME"]) {
    assert.ok(key in environment, `${key} must be preserved`)
  }
  assert.deepEqual(
    Object.fromEntries(
      ["OPENAI_BASE_URL", "OPENAI_API_KEY", "COPILOTKIT_TELEMETRY_DISABLED", "DO_NOT_TRACK"].map(
        (key) => [key, environment[key]],
      ),
    ),
    {
      OPENAI_BASE_URL: "http://127.0.0.1:4040/v1",
      OPENAI_API_KEY: "test-not-used",
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
    },
  )
  assert.equal(environment.npm_config_package, "@b4run/cli")
  for (const key of [
    "GITHUB_TOKEN",
    "DATABASE_URL",
    "CUSTOM_DEPLOY_SECRET",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEDROCK_ENDPOINT",
    "LANGCHAIN_TRACING_V2",
    "LANGSMITH_TRACING",
  ]) {
    assert.equal(environment[key], undefined, `${key} must be stripped`)
  }
})

test("capture gives both services sanitized environments and only B4.run receives model overrides", async () => {
  const fixture = orchestrationFixture()
  await captureDemo({
    repoRoot: "/repo",
    parentEnv: {
      PATH: "/toolchain/bin",
      npm_config_userconfig: "/home/test/.npmrc",
      GITHUB_TOKEN: "parent-github",
      DATABASE_URL: "postgres://parent-secret",
      CUSTOM_DEPLOY_SECRET: "parent-custom",
      OPENAI_API_KEY: "parent-openai",
      ANTHROPIC_API_KEY: "parent-anthropic",
      GOOGLE_API_KEY: "parent-google",
      AZURE_OPENAI_API_KEY: "parent-azure",
      AWS_SECRET_ACCESS_KEY: "parent-aws",
    },
    adapters: fixture.adapters,
    recordOnly: true,
  })

  const serverEnvironment = fixture.childEnvironments.find(
    ({ service }) => service === "server",
  )?.env
  const workbenchEnvironment = fixture.childEnvironments.find(
    ({ service }) => service === "workbench",
  )?.env
  assert.deepEqual(
    Object.fromEntries(
      ["OPENAI_BASE_URL", "OPENAI_API_KEY", "COPILOTKIT_TELEMETRY_DISABLED", "DO_NOT_TRACK"].map(
        (key) => [key, serverEnvironment?.[key]],
      ),
    ),
    {
      OPENAI_BASE_URL: "http://127.0.0.1:4040/v1",
      OPENAI_API_KEY: "test-not-used",
      COPILOTKIT_TELEMETRY_DISABLED: "true",
      DO_NOT_TRACK: "1",
    },
  )
  assert.equal(workbenchEnvironment?.B4_SERVER_URL, "http://127.0.0.1:4100")
  assert.equal(workbenchEnvironment?.NEXT_TELEMETRY_DISABLED, "1")
  assert.equal(serverEnvironment?.npm_config_package, "@b4run/cli")
  assert.equal(workbenchEnvironment?.OPENAI_API_KEY, undefined)
  for (const environment of [serverEnvironment, workbenchEnvironment]) {
    assert.equal(environment?.PATH, "/toolchain/bin")
    assert.equal(environment?.npm_config_userconfig, "/home/test/.npmrc")
    for (const key of [
      "GITHUB_TOKEN",
      "DATABASE_URL",
      "CUSTOM_DEPLOY_SECRET",
      "ANTHROPIC_API_KEY",
      "GOOGLE_API_KEY",
      "AZURE_OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      assert.equal(environment?.[key], undefined)
    }
  }
})

test("model base URL accepts loopback HTTP(S) and rejects public or unsafe URLs", () => {
  assert.equal(
    assertLoopbackModelBaseUrl("http://127.0.0.1:4040/v1").href,
    "http://127.0.0.1:4040/v1",
  )
  assert.equal(assertLoopbackModelBaseUrl("https://[::1]:4040/v1").hostname, "[::1]")
  for (const unsafe of [
    "https://api.openai.com/v1",
    "http://192.168.1.20:4040/v1",
    "file:///tmp/mock",
    "not a URL",
  ]) {
    assert.throws(() => assertLoopbackModelBaseUrl(unsafe), /loopback HTTP\(S\)/)
  }
})

test("available-port helper asks node:net for an ephemeral loopback port", async () => {
  const calls = []
  const fakeServer = new EventEmitter()
  fakeServer.unref = () => calls.push("unref")
  fakeServer.address = () => ({
    address: "127.0.0.1",
    family: "IPv4",
    port: 45678,
  })
  fakeServer.listen = (options, callback) => {
    calls.push(["listen", options])
    callback()
  }
  fakeServer.close = (callback) => {
    calls.push("close")
    callback()
  }

  assert.equal(await getAvailableLoopbackPort({ createServer: () => fakeServer }), 45678)
  assert.deepEqual(calls, [
    ["listen", { host: "127.0.0.1", port: 0, exclusive: true }],
    "unref",
    "close",
  ])
})

test("assigned-port startup retries only EADDRINUSE with fresh distinct ports", async () => {
  const assigned = [4100, 4101, 4102]
  const starts = []
  const result = await startWithAssignedPort({
    service: "B4.run server",
    excludedPorts: new Set([3002, 3010]),
    getPort: async () => assigned.shift(),
    start: async (port) => {
      starts.push(port)
      if (starts.length < 3) throw Object.assign(new Error("address busy"), { code: "EADDRINUSE" })
      return { child: { name: "server" }, port }
    },
  })
  assert.deepEqual(starts, [4100, 4101, 4102])
  assert.equal(result.port, 4102)
})

test("assigned-port startup never retries other errors or more than three bind races", async () => {
  let calls = 0
  await assert.rejects(
    startWithAssignedPort({
      service: "Workbench",
      excludedPorts: new Set([3002, 3010]),
      getPort: async () => 4200 + calls,
      start: async () => {
        calls += 1
        throw Object.assign(new Error("boom"), { code: "ECONNREFUSED" })
      },
    }),
    /boom/,
  )
  assert.equal(calls, 1)

  calls = 0
  await assert.rejects(
    startWithAssignedPort({
      service: "Workbench",
      excludedPorts: new Set([3002, 3010]),
      getPort: async () => 4300 + calls,
      start: async () => {
        calls += 1
        throw Object.assign(new Error("address busy"), { code: "EADDRINUSE" })
      },
    }),
    /after 3 EADDRINUSE attempts/,
  )
  assert.equal(calls, 3)
})

test("capture CLI accepts pnpm's forwarded separator before --record-only", () => {
  assert.deepEqual(parseCaptureArguments(["--", "--record-only"]), {
    recordOnly: true,
  })
  assert.throws(() => parseCaptureArguments(["--", "--unexpected"]), /Unknown capture argument/)
})

test("toolchain validation accepts the repository Node floor and records actual patches", () => {
  assert.deepEqual(validateToolchainVersions({ node: "v24.0.0", pnpm: "10.33.0" }), {
    node: "v24.0.0",
    pnpm: "10.33.0",
  })
  assert.deepEqual(validateToolchainVersions({ node: "v25.4.1", pnpm: "10.33.0" }), {
    node: "v25.4.1",
    pnpm: "10.33.0",
  })
  assert.throws(
    () => validateToolchainVersions({ node: "v23.11.0", pnpm: "10.33.0" }),
    /Node >=24\.0\.0/,
  )
  assert.throws(
    () => validateToolchainVersions({ node: "v24.19.0", pnpm: "10.32.0" }),
    /pnpm 10\.33\.0/,
  )
})

test("run ids accept focused safe names and reject traversal", () => {
  assert.equal(validateRunId("run-2026_09_01"), "run-2026_09_01")
  for (const unsafe of ["", ".", "..", "../escape", "nested/run", "run.id"])
    assert.throws(() => validateRunId(unsafe), /run id/)
})

test("generated npm test command enables the real runner's verbose named-test output", () => {
  assert.deepEqual(generatedTestCommand(), {
    command: "npm",
    args: ["test", "--", "--", "--reporter=verbose"],
  })
})

test("internal scaffold installation uses its pnpm workspace so Workbench resolves local packages", () => {
  assert.deepEqual(generatedInstallCommand(), {
    command: "pnpm",
    args: ["install"],
  })
})

/**
 * The dock's "Threads" disclosure button, as the fake pages below see it: it
 * records each call and flips `aria-expanded` on click, like the real one.
 */
function threadsToggle(calls, { dropClicks = 0 } = {}) {
  let expanded = false
  let dropped = 0
  return {
    async waitFor(waitOptions) {
      calls.push(["threads toggle", waitOptions])
    },
    async getAttribute(name) {
      return name === "aria-expanded" ? String(expanded) : null
    },
    async click() {
      // A click that lands before hydration does nothing.
      if (dropped < dropClicks) {
        dropped += 1
        calls.push("dropped click")
        return
      }
      expanded = !expanded
      calls.push(expanded ? "open threads" : "close threads")
    },
  }
}

/** The thread list's `nav` landmark, which appears once the list is open. */
function threadList(calls) {
  return {
    async waitFor(waitOptions) {
      calls.push(["thread list", waitOptions.state])
    },
  }
}

/** A Workbench page with the dock's Threads toggle, its list and the composer. */
function composerPage(calls, toggle) {
  return {
    getByRole(role, options) {
      if (role === "button" && options.name === "Threads") return toggle
      if (role === "navigation" && options.name === "Conversations") return threadList(calls)
      if (role === "button" && options.name === "New conversation") {
        return {
          async scrollIntoViewIfNeeded() {
            calls.push("scroll active row")
          },
          async waitFor(waitOptions) {
            calls.push(["active row", waitOptions])
          },
        }
      }
      if (role === "textbox" && options.name === "Message") {
        return {
          async fill(value) {
            calls.push(["fill", value])
          },
        }
      }
      throw new Error(`unexpected locator: ${role} ${options.name}`)
    },
  }
}

test("Workbench capture waits for the active rail row before filling the keyed composer", async () => {
  const calls = []
  await fillActiveWorkbenchComposer(composerPage(calls, threadsToggle(calls)), DEMO_PROMPT)
  // The row lives behind the dock's Threads disclosure: open, wait for the
  // list, scroll and wait for the row, close, fill.
  assert.deepEqual(calls, [
    ["threads toggle", { state: "visible", timeout: 60_000 }],
    "open threads",
    ["thread list", "visible"],
    "scroll active row",
    ["active row", { state: "visible", timeout: 60_000 }],
    "close threads",
    ["fill", DEMO_PROMPT],
  ])
})

test("Workbench capture re-sends a Threads click that was dropped before hydration", async () => {
  const calls = []
  await fillActiveWorkbenchComposer(
    composerPage(calls, threadsToggle(calls, { dropClicks: 1 })),
    DEMO_PROMPT,
  )
  // CI's W7 failure: the first click landed before React hydrated and did
  // nothing. The poll notices aria-expanded stayed false and clicks again.
  assert.deepEqual(calls.slice(0, 4), [
    ["threads toggle", { state: "visible", timeout: 60_000 }],
    "dropped click",
    "open threads",
    ["thread list", "visible"],
  ])
})

test("Workbench capture arms and verifies CopilotKit runtime readiness before interaction", async () => {
  const calls = []
  let responsePredicate
  const response = {
    ok: () => true,
    request: () => ({ method: () => "GET" }),
    url: () => "http://127.0.0.1:4101/api/copilotkit/info",
  }
  const page = {
    waitForResponse(predicate, options) {
      responsePredicate = predicate
      calls.push(["arm response", options])
      return Promise.resolve(response)
    },
    async goto(url, options) {
      calls.push(["goto", url, options])
    },
  }

  await openReadyWorkbench(page, "http://127.0.0.1:4101")
  assert.equal(responsePredicate(response), true)
  assert.deepEqual(calls, [
    ["arm response", { timeout: 60_000 }],
    ["goto", "http://127.0.0.1:4101", { waitUntil: "domcontentloaded" }],
  ])
})

test("failed Workbench navigation handles its later readiness rejection and closes once", async () => {
  const fixture = orchestrationFixture()
  const originalOpen = fixture.adapters.browser.open
  const navigationError = new Error("Workbench navigation failed")
  const readinessError = new Error("readiness waiter closed later")
  const unhandled = []
  let rejectReadiness
  let closeCount = 0
  const onUnhandled = (error) => unhandled.push(error)
  process.on("unhandledRejection", onUnhandled)
  try {
    fixture.adapters.browser.open = async (options) => {
      const session = await originalOpen(options)
      session.prepareWorkbench = ({ url }) =>
        openReadyWorkbench(
          {
            waitForResponse() {
              return new Promise((_, reject) => {
                rejectReadiness = reject
              })
            },
            async goto() {
              throw navigationError
            },
          },
          url,
        )
      session.close = async () => {
        closeCount += 1
        fixture.operations.push("close browser")
      }
      return session
    }

    await assert.rejects(
      captureDemo({
        repoRoot: "/repo",
        adapters: fixture.adapters,
        recordOnly: true,
        runIdFactory: () => "run-navigation-waiter-failure",
      }),
      (error) => error === navigationError,
    )
    rejectReadiness(readinessError)
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(unhandled, [])
    assert.equal(closeCount, 1)
    assert.equal(
      fixture.operations.indexOf("close browser") < fixture.operations.indexOf("stop workbench"),
      true,
    )
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("Workbench completion waits for the turn to settle, Stop to leave and the real composer to return", async () => {
  const calls = []
  const page = {
    getByRole(role, options) {
      if (role === "main") return recordingLocator(calls, "main")
      if (role === "button" && options.name === "Stop") {
        return {
          async waitFor(waitOptions) {
            calls.push(["stop", waitOptions])
          },
        }
      }
      if (role === "button" && options.name === "Send") {
        return {
          async waitFor(waitOptions) {
            calls.push(["send", waitOptions])
          },
        }
      }
      if (role === "textbox" && options.name === "Message") {
        return {
          async fill(value, fillOptions) {
            calls.push(["composer", value, fillOptions])
          },
        }
      }
      throw new Error(`unexpected role: ${role}`)
    },
  }

  await waitForWorkbenchRunCompletion(page)
  assert.deepEqual(calls, [
    // The run's own turn settling comes first: Stop and Send are one button,
    // so a wait that started before the run showed Stop would pass at once.
    [
      "waitFor",
      'main > section.b4-turn:not(.b4-step__children *):is([data-state="done"], [data-state="failed"], [data-state="stopped"]) .last',
      "visible",
    ],
    ["stop", { state: "hidden", timeout: 120_000 }],
    ["send", { state: "visible", timeout: 120_000 }],
    ["composer", "", { timeout: 120_000 }],
  ])
})

/**
 * A fake locator chain: every step it takes is recorded in `calls` under the
 * chain's description, so a test can assert what was located and in what
 * order. `answers` decides counts and attributes, and sees each click.
 */
function recordingLocator(calls, desc, answers = {}) {
  const child = (suffix) => recordingLocator(calls, `${desc} ${suffix}`, answers)
  return {
    locator: (selector) => child(`> ${selector}`),
    getByText: (text, options) =>
      child(`> text=${JSON.stringify(text)}${options?.exact ? " (exact)" : ""}`),
    first: () => child(".first"),
    last: () => child(".last"),
    async waitFor(waitOptions) {
      calls.push(["waitFor", desc, waitOptions.state])
    },
    async count() {
      calls.push(["count", desc])
      return answers.count?.(desc) ?? 1
    },
    async getAttribute(name) {
      calls.push(["attribute", desc, name])
      return answers.attribute?.(desc, name) ?? null
    },
    async click() {
      calls.push(["click", desc])
      answers.click?.(desc)
    },
  }
}

/** A turn summary that starts folded and opens on its first click, like a restored turn's. */
function foldedSummary() {
  let expanded = false
  return {
    attribute: (desc, name) =>
      name === "aria-expanded" && desc.includes("b4-turn__summary") ? String(expanded) : null,
    click: (desc) => {
      if (desc.includes("b4-turn__summary")) expanded = true
    },
  }
}

const RESTORE_ORIGIN = "http://127.0.0.1:4101"
const CONNECT_URL = `${RESTORE_ORIGIN}/api/copilotkit/agent/default/connect`

function connectResponse({
  url = CONNECT_URL,
  method = "POST",
  body = JSON.stringify({ threadId: "thread-unit-1", runId: "r", messages: [] }),
  ok = true,
} = {}) {
  return {
    ok: () => ok,
    status: () => (ok ? 200 : 500),
    request: () => ({ method: () => method, postData: () => body }),
    url: () => url,
  }
}

/** A Workbench page for the restore: the dock, the thread list and the transcript. */
function restorePage(calls, { answers = {}, response = connectResponse() } = {}) {
  const toggle = threadsToggle(calls)
  const page = {
    predicate: undefined,
    waitForResponse(predicate, options) {
      page.predicate = predicate
      calls.push(["arm connect", options])
      return Promise.resolve(response)
    },
    async reload(options) {
      calls.push(["reload", options])
    },
    getByRole(role, options) {
      if (role === "main") return recordingLocator(calls, "main", answers)
      if (role === "button" && options.name === "Threads") return toggle
      if (role === "navigation" && options.name === "Conversations") return threadList(calls)
      if (role === "heading") {
        return {
          async waitFor(waitOptions) {
            calls.push(["heading", options, waitOptions.state])
          },
        }
      }
      if (role === "button" && options.name === DEMO_PROMPT) {
        return {
          async scrollIntoViewIfNeeded() {
            calls.push("scroll row")
          },
          async waitFor(waitOptions) {
            calls.push(["row", waitOptions])
          },
          async click() {
            calls.push("click row")
          },
        }
      }
      throw new Error(`unexpected role: ${role}`)
    },
  }
  return page
}

const RESTORE_OPTIONS = {
  workbenchUrl: RESTORE_ORIGIN,
  threadId: "thread-unit-1",
  prompt: DEMO_PROMPT,
  tools: ["computeNavlog"],
  answer: EXPECTED_ANSWER,
}

const ROOT_TURN = "section.b4-turn:not(.b4-step__children *)"
const SETTLED_ROOT_TURN = `${ROOT_TURN}:is([data-state="done"], [data-state="failed"], [data-state="stopped"])`
const TURN_SUMMARY = `main > ${SETTLED_ROOT_TURN} .last > :scope > button.b4-turn__summary`
const ROOT_TOOL_STEPS = `main > ${SETTLED_ROOT_TURN} .last > :scope > ol.b4-turn__steps > li.b4-step[data-kind="tool"]`

test("restoration connects the thread, then proves the restored turn, its steps and the answer", async () => {
  const calls = []
  const page = restorePage(calls, { answers: foldedSummary() })

  const result = await restoreWorkbenchThread(page, RESTORE_OPTIONS)

  assert.equal(result.connectUrl, CONNECT_URL)
  // Selecting the thread: reload, open the list, click the row, then the dock
  // title (an h2) is the evidence — the row detaches when the workbench remounts.
  assert.deepEqual(calls.slice(0, 9), [
    ["arm connect", { timeout: 120_000 }],
    ["reload", { waitUntil: "domcontentloaded" }],
    ["threads toggle", { state: "visible", timeout: 60_000 }],
    "open threads",
    ["thread list", "visible"],
    "scroll row",
    ["row", { state: "visible", timeout: 60_000 }],
    "click row",
    ["heading", { level: 2, name: DEMO_PROMPT, exact: true }, "visible"],
  ])
  // Re-selecting the thread the reload already showed remounts nothing.
  assert.equal(calls[9], "close threads")
  assert.deepEqual(calls.slice(10), [
    ["waitFor", `main > text=${JSON.stringify(DEMO_PROMPT)} (exact) .last`, "visible"],
    ["waitFor", `main > ${SETTLED_ROOT_TURN} .first`, "visible"],
    ["count", `main > ${ROOT_TURN}`],
    ["waitFor", `main > ${SETTLED_ROOT_TURN} .last`, "visible"],
    ["attribute", TURN_SUMMARY, "aria-expanded"],
    ["click", TURN_SUMMARY],
    ["attribute", TURN_SUMMARY, "aria-expanded"],
    ["waitFor", `${ROOT_TOOL_STEPS} .first`, "visible"],
    ["count", ROOT_TOOL_STEPS],
    ["waitFor", `main > text=${JSON.stringify(EXPECTED_ANSWER)} (exact) .last`, "visible"],
  ])
})

test("frame surface sends DOM calls to the Workbench frame and network waits to the page", async () => {
  const calls = []
  const frame = {
    getByRole: (...args) => {
      calls.push(["frame.getByRole", ...args])
      return "role"
    },
    locator: (...args) => {
      calls.push(["frame.locator", ...args])
      return "locator"
    },
    evaluate: async (...args) => {
      calls.push(["frame.evaluate", ...args])
      return "value"
    },
    waitForTimeout: async (ms) => {
      calls.push(["frame.waitForTimeout", ms])
    },
    goto: async (url, options) => {
      calls.push(["frame.goto", url, options])
      return { ok: () => true }
    },
    url: () => "http://127.0.0.1:4101/",
  }
  const page = {
    waitForResponse: async (...args) => {
      calls.push(["page.waitForResponse", ...args])
      return "response"
    },
  }
  const surface = frameSurface(page, frame)

  assert.equal(surface.getByRole("button", { name: "Send" }), "role")
  assert.equal(surface.locator("main"), "locator")
  assert.equal(await surface.evaluate(() => 1), "value")
  await surface.waitForTimeout(5)
  assert.equal(await surface.waitForResponse(() => true), "response")
  await surface.goto("http://127.0.0.1:4101/", { waitUntil: "domcontentloaded" })
  await surface.reload({ waitUntil: "domcontentloaded" })

  assert.deepEqual(
    calls.map(([name]) => name),
    [
      "frame.getByRole",
      "frame.locator",
      "frame.evaluate",
      "frame.waitForTimeout",
      "page.waitForResponse",
      "frame.goto",
      "frame.goto",
    ],
  )
  assert.deepEqual(calls.at(-1), [
    "frame.goto",
    "http://127.0.0.1:4101/",
    { waitUntil: "domcontentloaded" },
  ])
})

test("frame surface wraps a refused framing navigation", async () => {
  const blocked = new Error("net::ERR_BLOCKED_BY_RESPONSE at http://127.0.0.1:4101/")
  const frame = {
    goto: async () => {
      throw blocked
    },
    url: () => "about:blank",
  }
  const surface = frameSurface({ waitForResponse: async () => undefined }, frame)
  await assert.rejects(surface.goto("http://127.0.0.1:4101/"), (error) => {
    assert.equal(
      error.message,
      "The Workbench did not load inside the director frame (net::ERR_BLOCKED_BY_RESPONSE at http://127.0.0.1:4101/)",
    )
    assert.equal(error.cause, blocked)
    return true
  })
})

test("frame surface goto accepts a null response, but reload treats it as no reload", async () => {
  const calls = []
  const frame = {
    goto: async (url, options) => {
      calls.push([url, options])
      return null
    },
    url: () => "http://127.0.0.1:4101/#thread",
  }
  const surface = frameSurface({ waitForResponse: async () => undefined }, frame)
  assert.equal(await surface.goto("http://127.0.0.1:4101/"), null)
  await assert.rejects(
    surface.reload({ waitUntil: "domcontentloaded" }),
    /^Error: The Workbench frame did not reload \(same-document navigation\)$/,
  )
  assert.deepEqual(calls.at(-1), [
    "http://127.0.0.1:4101/#thread",
    { waitUntil: "domcontentloaded" },
  ])
})

test("frame surface fails when the Workbench refuses to load in the frame", async () => {
  const frame = {
    goto: async () => null,
    url: () => "chrome-error://chromewebdata/",
  }
  const surface = frameSurface({ waitForResponse: async () => undefined }, frame)
  await assert.rejects(
    surface.goto("http://127.0.0.1:4101/"),
    /The Workbench did not load inside the director frame \(chrome-error:\/\/chromewebdata\/\)/,
  )
})

test("restoration matches only this Workbench's connect POST for this thread", async () => {
  const calls = []
  const page = restorePage(calls, { answers: foldedSummary() })
  await restoreWorkbenchThread(page, RESTORE_OPTIONS)
  const { predicate } = page
  assert.equal(predicate(connectResponse()), true)
  assert.equal(predicate(connectResponse({ method: "GET" })), false)
  assert.equal(
    predicate(connectResponse({ url: "http://public.example/api/copilotkit/agent/default/connect" })),
    false,
  )
  assert.equal(
    predicate(connectResponse({ url: `${RESTORE_ORIGIN}/api/copilotkit/agent/default/run` })),
    false,
  )
  assert.equal(
    predicate(connectResponse({ body: JSON.stringify({ threadId: "thread-other" }) })),
    false,
  )
  assert.equal(predicate(connectResponse({ body: "{not json" })), false)
  assert.equal(predicate(connectResponse({ body: null })), false)
})

test("restoration fails on a failed connect", async () => {
  const calls = []
  const page = restorePage(calls, {
    answers: foldedSummary(),
    response: connectResponse({ ok: false }),
  })
  await assert.rejects(
    restoreWorkbenchThread(page, RESTORE_OPTIONS),
    /Thread restoration failed with HTTP 500/,
  )
})

test("restoration fails when the thread renders more than one turn", async () => {
  const calls = []
  const page = restorePage(calls, {
    answers: { ...foldedSummary(), count: (desc) => (desc === `main > ${ROOT_TURN}` ? 2 : 1) },
  })
  await assert.rejects(
    restoreWorkbenchThread(page, RESTORE_OPTIONS),
    /rendered 2 turns, expected exactly 1/,
  )
})

test("restoration fails when the restored turn's tool steps do not match the run", async () => {
  const calls = []
  const page = restorePage(calls, {
    answers: { ...foldedSummary(), count: (desc) => (desc === ROOT_TOOL_STEPS ? 2 : 1) },
  })
  await assert.rejects(
    restoreWorkbenchThread(page, RESTORE_OPTIONS),
    /rendered 2 tool steps, expected 1 \(computeNavlog\)/,
  )
})

test("restoration fails when the restored turn's summary will not open", async () => {
  const calls = []
  const page = restorePage(calls, {
    answers: { attribute: (_desc, name) => (name === "aria-expanded" ? "false" : null) },
  })
  await assert.rejects(
    restoreWorkbenchThread(page, RESTORE_OPTIONS),
    /summary did not expand/,
  )
})

test("failed restoration interaction handles its later connect rejection and closes once", async () => {
  const fixture = orchestrationFixture()
  const originalOpen = fixture.adapters.browser.open
  const reloadError = new Error("Workbench reload failed")
  const connectError = new Error("connect waiter closed later")
  const unhandled = []
  let rejectConnect
  let closeCount = 0
  const onUnhandled = (error) => unhandled.push(error)
  process.on("unhandledRejection", onUnhandled)
  try {
    fixture.adapters.browser.open = async (options) => {
      const session = await originalOpen(options)
      session.reloadAndRestore = (restoreOptions) =>
        restoreWorkbenchThread(
          {
            waitForResponse() {
              return new Promise((_, reject) => {
                rejectConnect = reject
              })
            },
            async reload() {
              throw reloadError
            },
          },
          restoreOptions,
        )
      session.close = async () => {
        closeCount += 1
        fixture.operations.push("close browser")
      }
      return session
    }

    await assert.rejects(
      captureDemo({
        repoRoot: "/repo",
        adapters: fixture.adapters,
        recordOnly: true,
        runIdFactory: () => "run-restoration-waiter-failure",
      }),
      (error) => error === reloadError,
    )
    rejectConnect(connectError)
    await new Promise((resolve) => setImmediate(resolve))

    assert.deepEqual(unhandled, [])
    assert.equal(closeCount, 1)
    assert.equal(
      fixture.operations.indexOf("close browser") < fixture.operations.indexOf("stop workbench"),
      true,
    )
  } finally {
    process.off("unhandledRejection", onUnhandled)
  }
})

test("managed-child registry retains a child whose stop fails and retries it during final cleanup", async () => {
  const child = { name: "failed-start" }
  const unrelated = { name: "unrelated" }
  const calls = []
  let attempt = 0
  const registry = createManagedChildRegistry(async (candidate) => {
    calls.push(candidate)
    attempt += 1
    if (attempt === 1) throw new Error("first stop failed")
  })
  registry.track(child)
  await assert.rejects(registry.stop(child), /first stop failed/)
  await registry.stopRemaining()
  assert.deepEqual(calls, [child, child])
  assert.equal(calls.includes(unrelated), false)
})

test("managed command cancellation stops and confirms its exact owned child", async () => {
  const child = new EventEmitter()
  child.pid = 8123
  child.exitCode = null
  child.signalCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  const stopped = []
  const registry = createManagedChildRegistry(async (candidate) => {
    stopped.push(candidate)
    candidate.signalCode = "SIGTERM"
  })
  const controller = new AbortController()
  const cancellation = new Error("cancel build now")
  const command = runManagedCommand("pnpm", ["build"], {
    cwd: "/repo",
    childRegistry: registry,
    signal: controller.signal,
    spawn: () => child,
  })
  controller.abort(cancellation)

  await assert.rejects(command, (error) => error === cancellation)
  assert.deepEqual(stopped, [child])
  await registry.stopRemaining()
  assert.deepEqual(stopped, [child])
})

test("service readiness cancellation stops the just-started child exactly once", async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  const stopped = []
  const registry = createManagedChildRegistry(async (candidate) => {
    stopped.push(candidate)
  })
  const controller = new AbortController()
  const cancellation = new Error("cancel readiness now")
  const starting = startHttpService({
    command: "npm",
    args: ["exec", "--", "b4", "dev"],
    cwd: "/repo/server",
    env: { PATH: "/bin" },
    readyUrl: "http://127.0.0.1:4100/healthz",
    service: "B4.run server",
    childRegistry: registry,
    signal: controller.signal,
    spawn: () => child,
    waitUntilReady(_url, candidate, options) {
      assert.equal(candidate, child)
      assert.equal(options.signal, controller.signal)
      return new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        })
      })
    },
  })
  controller.abort(cancellation)

  await assert.rejects(starting, (error) => error.cause === cancellation)
  assert.deepEqual(stopped, [child])
  await registry.stopRemaining()
  assert.deepEqual(stopped, [child])
})

test("managed-service monitor reports post-readiness exit with bounded transcript", async () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdout.setEncoding = () => {}
  child.stderr.setEncoding = () => {}
  const monitor = createManagedServiceMonitor({
    child,
    service: "Workbench",
    maxTranscriptLength: 40,
  })
  monitor.arm()
  child.stdout.emit("data", "prefix-that-must-be-truncated-")
  child.stderr.emit("data", "fatal-tail-from-workbench")
  child.emit("exit", 7, null)
  await assert.rejects(monitor.unexpectedExit, (error) => {
    assert.match(error.message, /Workbench exited unexpectedly \(code 7\)/)
    assert.match(error.message, /fatal-tail-from-workbench/)
    assert.equal(error.message.includes("prefix-that-must"), false)
    return true
  })
})

test("expected managed-service cleanup cannot win a capture-phase race", async () => {
  const child = new EventEmitter()
  const monitor = createManagedServiceMonitor({
    child,
    service: "B4.run server",
  })
  monitor.arm()
  monitor.markExpectedExit()
  child.emit("exit", 0, null)
  assert.equal(
    await raceCapturePhase("close", async () => "phase complete", [monitor]),
    "phase complete",
  )
})

test("capture phase fails promptly when a ready service exits", async () => {
  const serviceFailure = Promise.reject(
    new Error("B4.run server exited unexpectedly (signal SIGTERM)\nserver-tail"),
  )
  serviceFailure.catch(() => {})
  await assert.rejects(
    raceCapturePhase("restoration", () => new Promise(() => {}), [
      { unexpectedExit: serviceFailure },
    ]),
    /B4.run server exited unexpectedly.*server-tail/s,
  )
})

test("capture signal handlers abort once, force on the second signal, and restore", () => {
  const calls = []
  const handlers = new Map()
  const signalAdapter = {
    on(signal, handler) {
      calls.push(["on", signal])
      handlers.set(signal, handler)
    },
    off(signal, handler) {
      calls.push(["off", signal])
      assert.equal(handlers.get(signal), handler)
      handlers.delete(signal)
    },
    forceExit(signal) {
      calls.push(["force", signal])
    },
  }
  const scope = installCaptureSignalHandlers({ signalAdapter })
  handlers.get("SIGINT")()
  assert.equal(scope.signal.aborted, true)
  assert.match(scope.signal.reason.message, /cancelled by SIGINT/)
  handlers.get("SIGTERM")()
  scope.restore()
  assert.deepEqual(calls, [
    ["on", "SIGINT"],
    ["on", "SIGTERM"],
    ["force", "SIGTERM"],
    ["off", "SIGINT"],
    ["off", "SIGTERM"],
  ])
})

function captureSignalFixture() {
  const calls = []
  const handlers = new Map()
  return {
    calls,
    handlers,
    adapter: {
      on(signal, handler) {
        calls.push(["on", signal])
        handlers.set(signal, handler)
      },
      off(signal, handler) {
        calls.push(["off", signal])
        assert.equal(handlers.get(signal), handler)
        handlers.delete(signal)
      },
      forceExit() {
        throw new Error("force exit must not run for one signal")
      },
    },
  }
}

test("SIGTERM during build aborts the command owner before capture restores handlers", {
  timeout: 1_000,
}, async () => {
  const fixture = orchestrationFixture()
  const signals = captureSignalFixture()
  let commandSettled = false
  fixture.adapters.commands.build = ({ signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          fixture.operations.push("abort build child")
          commandSettled = true
          reject(signal.reason)
        },
        { once: true },
      )
      queueMicrotask(() => signals.handlers.get("SIGTERM")())
    })
  fixture.adapters.commands.stopRemaining = async () => {
    fixture.operations.push("confirm command children stopped")
  }

  await assert.rejects(
    captureDemo({
      repoRoot: "/repo",
      adapters: fixture.adapters,
      recordOnly: true,
      runIdFactory: () => "run-cancel-build",
      signalAdapter: signals.adapter,
    }),
    /cancelled by SIGTERM/,
  )
  assert.equal(commandSettled, true)
  assert.equal(fixture.operations.includes("confirm command children stopped"), true)
  assert.equal(signals.handlers.size, 0)
})

test("SIGTERM during B4.run readiness aborts and confirms the startup child before cleanup", {
  timeout: 1_000,
}, async () => {
  const fixture = orchestrationFixture()
  const signals = captureSignalFixture()
  let startupSettled = false
  fixture.adapters.processes.startB4 = ({ signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          fixture.operations.push("stop startup child")
          startupSettled = true
          reject(signal.reason)
        },
        { once: true },
      )
      queueMicrotask(() => signals.handlers.get("SIGTERM")())
    })

  await assert.rejects(
    captureDemo({
      repoRoot: "/repo",
      adapters: fixture.adapters,
      recordOnly: true,
      runIdFactory: () => "run-cancel-readiness",
      signalAdapter: signals.adapter,
    }),
    /cancelled by SIGTERM/,
  )
  assert.equal(startupSettled, true)
  assert.equal(fixture.operations.includes("stop startup child"), true)
  assert.equal(fixture.operations.includes("close aimock"), true)
  assert.equal(fixture.operations.includes(`remove ${fixture.workspaceRoot}`), true)
  assert.equal(signals.handlers.size, 0)
})

test("capture awaits and closes a browser session acquired after cancellation", {
  timeout: 1_000,
}, async () => {
  const fixture = orchestrationFixture()
  const signals = captureSignalFixture()
  let resolveAcquisition
  let captureSettled = false
  let closeCount = 0
  const lateSession = {
    async close() {
      closeCount += 1
      fixture.operations.push("close late browser")
    },
  }
  fixture.adapters.browser.open = ({ signal }) => {
    assert.ok(signal instanceof AbortSignal)
    queueMicrotask(() => signals.handlers.get("SIGINT")())
    return new Promise((resolve) => {
      resolveAcquisition = resolve
    })
  }

  const outcome = captureDemo({
    repoRoot: "/repo",
    adapters: fixture.adapters,
    recordOnly: true,
    runIdFactory: () => "run-late-browser",
    signalAdapter: signals.adapter,
  })
    .then(() => ({ status: "fulfilled" }))
    .catch((error) => ({ error, status: "rejected" }))
    .finally(() => {
      captureSettled = true
    })
  await new Promise((resolve) => setImmediate(resolve))
  const settledBeforeAcquisition = captureSettled
  resolveAcquisition(lateSession)
  const result = await outcome

  assert.equal(settledBeforeAcquisition, false)
  assert.equal(result.status, "rejected")
  assert.match(result.error.message, /cancelled by SIGINT/)
  assert.equal(closeCount, 1)
  assert.equal(
    fixture.operations.indexOf("close late browser") < fixture.operations.indexOf("stop workbench"),
    true,
  )
  assert.equal(signals.handlers.size, 0)
})

test("capture closes the browser and awaits an aborted session action before service cleanup", {
  timeout: 1_000,
}, async () => {
  const fixture = orchestrationFixture()
  const signals = captureSignalFixture()
  const originalOpen = fixture.adapters.browser.open
  let rejectAction
  let closeCount = 0
  let captureSettled = false
  fixture.adapters.browser.open = async (options) => {
    const session = await originalOpen(options)
    session.runScenario = ({ signal }) =>
      new Promise((_, reject) => {
        rejectAction = () => {
          fixture.operations.push("session action settled")
          reject(signal.reason)
        }
        signal.addEventListener(
          "abort",
          () => fixture.operations.push("session action observed abort"),
          { once: true },
        )
        queueMicrotask(() => signals.handlers.get("SIGINT")())
      })
    session.close = async () => {
      closeCount += 1
      fixture.operations.push("close browser")
    }
    return session
  }

  const outcome = captureDemo({
    repoRoot: "/repo",
    adapters: fixture.adapters,
    recordOnly: true,
    runIdFactory: () => "run-session-action-cancel",
    signalAdapter: signals.adapter,
  })
    .then(() => ({ status: "fulfilled" }))
    .catch((error) => ({ error, status: "rejected" }))
    .finally(() => {
      captureSettled = true
    })
  await new Promise((resolve) => setImmediate(resolve))
  const settledBeforeAction = captureSettled
  const stoppedBeforeAction = fixture.operations.includes("stop workbench")
  rejectAction()
  const result = await outcome

  assert.equal(settledBeforeAction, false)
  assert.equal(stoppedBeforeAction, false)
  assert.equal(result.status, "rejected")
  assert.match(result.error.message, /cancelled by SIGINT/)
  assert.equal(closeCount, 1)
  assert.equal(
    fixture.operations.indexOf("session action settled") <
      fixture.operations.indexOf("stop workbench"),
    true,
  )
  assert.equal(signals.handlers.size, 0)
})

test("capture retains and awaits its memoized browser finalization after cancellation", {
  timeout: 1_000,
}, async () => {
  const fixture = orchestrationFixture()
  const signals = captureSignalFixture()
  const originalOpen = fixture.adapters.browser.open
  let resolveFinalization
  let closeCount = 0
  let captureSettled = false
  fixture.adapters.browser.open = async (options) => {
    const session = await originalOpen(options)
    let closePromise
    session.close = () => {
      closeCount += 1
      fixture.operations.push("begin browser finalization")
      queueMicrotask(() => signals.handlers.get("SIGTERM")())
      closePromise ??= new Promise((resolve) => {
        resolveFinalization = () => {
          fixture.operations.push("browser finalization settled")
          resolve({ videoPath: `${options.recordingsDir}/demo.webm` })
        }
      })
      return closePromise
    }
    return session
  }

  const outcome = captureDemo({
    repoRoot: "/repo",
    adapters: fixture.adapters,
    recordOnly: true,
    runIdFactory: () => "run-finalization-cancel",
    signalAdapter: signals.adapter,
  })
    .then(() => ({ status: "fulfilled" }))
    .catch((error) => ({ error, status: "rejected" }))
    .finally(() => {
      captureSettled = true
    })
  await new Promise((resolve) => setImmediate(resolve))
  const settledBeforeFinalization = captureSettled
  const stoppedBeforeFinalization = fixture.operations.includes("stop workbench")
  resolveFinalization()
  const result = await outcome

  assert.equal(settledBeforeFinalization, false)
  assert.equal(stoppedBeforeFinalization, false)
  assert.equal(result.status, "rejected")
  assert.match(result.error.message, /cancelled by SIGTERM/)
  assert.equal(closeCount, 1)
  assert.equal(
    fixture.operations.indexOf("browser finalization settled") <
      fixture.operations.indexOf("stop workbench"),
    true,
  )
  assert.equal(signals.handlers.size, 0)
})

test("browser cleanup always closes Chromium even when context finalization fails", async () => {
  const calls = []
  await assert.rejects(
    closeBrowserResources({
      context: {
        async close() {
          calls.push("context")
          throw new Error("context failed")
        },
      },
      video: {
        async path() {
          calls.push("video")
          return "/ignored/demo.webm"
        },
      },
      browser: {
        async close() {
          calls.push("browser")
        },
      },
    }),
    /context failed/,
  )
  assert.deepEqual(calls, ["context", "video", "browser"])
})

test("browser acquisition closes Chromium when context creation fails", async () => {
  const calls = []
  const acquisitionError = new Error("context creation failed")
  const chromium = {
    async launch() {
      calls.push("launch")
      return {
        async newContext() {
          calls.push("new context")
          throw acquisitionError
        },
        async close() {
          calls.push("close browser")
        },
      }
    },
  }

  await assert.rejects(
    createBrowserResources({
      chromium,
      recordingsDir: "/ignored/raw-recordings",
      viewport: { width: 1440, height: 810 },
    }),
    (error) => {
      assert.equal(error, acquisitionError)
      return true
    },
  )
  assert.deepEqual(calls, ["launch", "new context", "close browser"])
})

test("browser acquisition reduces motion and hides the Next dev badge before the first page", async () => {
  const calls = []
  const video = { path: async () => "/ignored/video.webm" }
  const chromium = {
    async launch() {
      return {
        async newContext(options) {
          calls.push(["new context", options])
          return {
            async addInitScript(script) {
              calls.push(["init script", script])
            },
            async newPage() {
              calls.push(["new page"])
              return { video: () => video }
            },
          }
        },
      }
    },
  }
  const resources = await createBrowserResources({
    chromium,
    recordingsDir: "/ignored/raw-recordings",
    viewport: { width: 1440, height: 810 },
  })
  assert.equal(resources.video, video)
  assert.deepEqual(calls, [
    [
      "new context",
      {
        viewport: { width: 1440, height: 810 },
        recordVideo: { dir: "/ignored/raw-recordings", size: { width: 1440, height: 810 } },
        reducedMotion: "reduce",
      },
    ],
    ["init script", HIDE_NEXT_DEV_INDICATOR],
    ["new page"],
  ])
  assert.match(HIDE_NEXT_DEV_INDICATOR, /nextjs-portal \{ display: none !important; \}/)
})

test("browser acquisition rolls back a late Chromium launch after abort", async () => {
  const calls = []
  const controller = new AbortController()
  const cancellation = new Error("cancel browser launch")
  let resolveLaunch
  const browser = {
    async newContext() {
      calls.push("new context")
      throw new Error("context must not start after cancellation")
    },
    async close() {
      calls.push("close browser")
    },
  }
  const acquiring = createBrowserResources({
    chromium: {
      launch() {
        calls.push("launch")
        return new Promise((resolve) => {
          resolveLaunch = resolve
        })
      },
    },
    recordingsDir: "/ignored/raw-recordings",
    viewport: { width: 1440, height: 810 },
    signal: controller.signal,
  })
  controller.abort(cancellation)
  resolveLaunch(browser)

  await assert.rejects(acquiring, (error) => error === cancellation)
  assert.deepEqual(calls, ["launch", "close browser"])
})

test("browser acquisition closes context then Chromium when page creation fails", async () => {
  const calls = []
  const acquisitionError = new Error("page creation failed")
  const chromium = {
    async launch() {
      calls.push("launch")
      return {
        async newContext() {
          calls.push("new context")
          return {
            async addInitScript() {
              calls.push("init script")
            },
            async newPage() {
              calls.push("new page")
              throw acquisitionError
            },
            async close() {
              calls.push("close context")
            },
          }
        },
        async close() {
          calls.push("close browser")
        },
      }
    },
  }

  await assert.rejects(
    createBrowserResources({
      chromium,
      recordingsDir: "/ignored/raw-recordings",
      viewport: { width: 1440, height: 810 },
    }),
    (error) => {
      assert.equal(error, acquisitionError)
      return true
    },
  )
  assert.deepEqual(calls, [
    "launch",
    "new context",
    "init script",
    "new page",
    "close context",
    "close browser",
  ])
})

test("capture invokes the future encoder after finalizing recordings and summary", async () => {
  const fixture = orchestrationFixture()
  await captureDemo({
    repoRoot: "/repo",
    adapters: fixture.adapters,
    recordOnly: false,
    runIdFactory: () => "run-unit-encode",
    async encodeCaptureArtifacts(options) {
      fixture.operations.push("encode capture")
      assert.ok(options.signal instanceof AbortSignal)
      assert.equal(
        options.summaryPath,
        "/repo/docs/brand/demo/artifacts/runs/run-unit-encode/capture-summary.json",
      )
      assert.equal(
        options.summary.videoPath,
        "/repo/docs/brand/demo/raw-recordings/runs/run-unit-encode/demo.webm",
      )
    },
  })

  assert.deepEqual(fixture.operations.slice(-7), [
    "close browser",
    "publish summary",
    "encode capture",
    "stop workbench",
    "stop server",
    "close aimock",
    `remove ${fixture.workspaceRoot}`,
  ])
})

test("SIGTERM during encoding aborts and awaits the encoder before final cleanup", {
  timeout: 1_000,
}, async () => {
  const fixture = orchestrationFixture()
  const signals = captureSignalFixture()
  let encoderSettled = false
  let encoderSignal

  await assert.rejects(
    captureDemo({
      repoRoot: "/repo",
      adapters: fixture.adapters,
      recordOnly: false,
      runIdFactory: () => "run-cancel-encoder",
      signalAdapter: signals.adapter,
      encodeCaptureArtifacts(options) {
        encoderSignal = options.signal
        return new Promise((_, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              fixture.operations.push("abort encoder child")
              encoderSettled = true
              reject(options.signal.reason)
            },
            { once: true },
          )
          queueMicrotask(() => signals.handlers.get("SIGTERM")())
        })
      },
    }),
    /cancelled by SIGTERM/,
  )

  assert.ok(encoderSignal instanceof AbortSignal)
  assert.equal(encoderSettled, true)
  assert.equal(fixture.operations.includes("abort encoder child"), true)
  assert.deepEqual(fixture.operations.slice(-5), [
    "stop workbench",
    "stop server",
    "close aimock",
    `remove ${fixture.workspaceRoot}`,
    "remove /repo/docs/brand/demo/artifacts/runs/run-cancel-encoder/capture-summary.json",
  ])
  assert.equal(signals.handlers.size, 0)
})

test("capture publishes a versioned run-specific manifest with deterministic scene boundaries", async () => {
  const fixture = orchestrationFixture()
  let tick = 1_000
  const holds = []
  const summary = await captureDemo({
    repoRoot: "/repo",
    adapters: fixture.adapters,
    recordOnly: true,
    runIdFactory: () => "run-unit-manifest",
    timing: {
      now() {
        const value = tick
        tick += 100
        return value
      },
      async sleep(durationMs) {
        holds.push(durationMs)
      },
    },
    holdDurations: { preReloadMs: 700, restorationMs: 900 },
  })

  assert.equal(summary.schemaVersion, 1)
  assert.equal(summary.runId, "run-unit-manifest")
  assert.deepEqual(summary.toolchain, {
    node: "v24.19.0",
    pnpm: "10.33.0",
  })
  assert.deepEqual(summary.paths, {
    artifactsRoot: "/repo/docs/brand/demo/artifacts/runs/run-unit-manifest",
    recordingsRoot: "/repo/docs/brand/demo/raw-recordings/runs/run-unit-manifest",
    logs: {
      stdout: "/repo/docs/brand/demo/artifacts/runs/run-unit-manifest/test.stdout.log",
      stderr: "/repo/docs/brand/demo/artifacts/runs/run-unit-manifest/test.stderr.log",
      result: "/repo/docs/brand/demo/artifacts/runs/run-unit-manifest/test.result.json",
    },
    recording: "/repo/docs/brand/demo/raw-recordings/runs/run-unit-manifest/demo.webm",
  })
  assert.deepEqual(Object.keys(summary.videoTimeline.scenes), ["author", "prove", "run", "close"])
  let previousEnd = -1
  for (const boundary of Object.values(summary.videoTimeline.scenes)) {
    assert.equal(Number.isFinite(boundary.startMs), true)
    assert.equal(boundary.endMs >= boundary.startMs, true)
    assert.equal(boundary.startMs >= previousEnd, true)
    previousEnd = boundary.endMs
  }
  assert.deepEqual(holds, [700, 900])
  assert.deepEqual(summary.evidence, {
    prompt: DEMO_PROMPT,
    tools: DEMO_PLAN_TOOLS,
    answer: EXPECTED_ANSWER,
    threadId: "thread-unit-1",
    connectUrl: undefined,
  })
})

test("distinct run ids own disjoint raw and artifact roots", async () => {
  const first = orchestrationFixture()
  const second = orchestrationFixture()
  await Promise.all([
    captureDemo({
      repoRoot: "/repo",
      adapters: first.adapters,
      recordOnly: true,
      runIdFactory: () => "run-concurrent-a",
    }),
    captureDemo({
      repoRoot: "/repo",
      adapters: second.adapters,
      recordOnly: true,
      runIdFactory: () => "run-concurrent-b",
    }),
  ])
  for (const write of first.writes) assert.match(write.path, /\/runs\/run-concurrent-a\//)
  for (const write of second.writes) assert.match(write.path, /\/runs\/run-concurrent-b\//)
})

test("successful summaries publish atomically and failed runs leave no success summary", async () => {
  const success = orchestrationFixture()
  await captureDemo({
    repoRoot: "/repo",
    adapters: success.adapters,
    recordOnly: true,
    runIdFactory: () => "run-atomic-success",
  })
  assert.deepEqual(success.renames, [
    {
      from: "/repo/docs/brand/demo/artifacts/runs/run-atomic-success/capture-summary.json.tmp",
      to: "/repo/docs/brand/demo/artifacts/runs/run-atomic-success/capture-summary.json",
    },
  ])

  const failed = orchestrationFixture({ failAt: "scenario" })
  await assert.rejects(
    captureDemo({
      repoRoot: "/repo",
      adapters: failed.adapters,
      recordOnly: true,
      runIdFactory: () => "run-atomic-failure",
    }),
    /scenario failed/,
  )
  assert.equal(
    failed.writes.some(({ path }) => path.includes("capture-summary.json")),
    false,
  )
  assert.deepEqual(failed.renames, [])
})

test("record-only capture never invokes the future encoder", async () => {
  const fixture = orchestrationFixture()
  let invoked = false
  await captureDemo({
    repoRoot: "/repo",
    adapters: fixture.adapters,
    recordOnly: true,
    async encodeCaptureArtifacts() {
      invoked = true
    },
  })
  assert.equal(invoked, false)
})

test("non-record-only capture cleans up when the encoder fails", async () => {
  const fixture = orchestrationFixture()
  await assert.rejects(
    captureDemo({
      repoRoot: "/repo",
      adapters: fixture.adapters,
      recordOnly: false,
      async encodeCaptureArtifacts() {
        throw new Error("encoder failed")
      },
    }),
    /encoder failed/,
  )
  assert.deepEqual(fixture.operations.slice(-5, -1), [
    "stop workbench",
    "stop server",
    "close aimock",
    `remove ${fixture.workspaceRoot}`,
  ])
  assert.match(
    fixture.operations.at(-1),
    /^remove \/repo\/docs\/brand\/demo\/artifacts\/runs\/[A-Za-z0-9_-]+\/capture-summary\.json$/,
  )
})

const EXPECTED_UPLOAD_PATHS = ["b4/demo/product-loop.mp4", "b4/demo/product-loop.webm"]
const AUTHORIZED_MEDIA_STORE_ID = "store_9RQ8eZyGheVy0wOp"
const AUTHORIZED_MEDIA_ORIGIN = "https://9rq8ezyghevy0wop.public.blob.vercel-storage.com"

function authorizedLegacyToken(secret) {
  return `vercel_blob_rw_9RQ8eZyGheVy0wOp_${secret}`
}

const AUTHORIZED_LEGACY_TOKEN = authorizedLegacyToken("testsecret")

function validUploadFixture(repoRoot = "/repo", runId = "run-upload") {
  const fixture = validManifestLayout(repoRoot, runId)
  fixture.manifest.captions = { ...MEDIA_CAPTIONS }
  return fixture
}

function uploadBodies(manifest) {
  return new Map(
    EXPECTED_UPLOAD_PATHS.map((pathname) => {
      const [name, format] = pathname.slice("b4/demo/".length).split(".")
      const sourcePath = manifest.clips[name][format]
      return [sourcePath, Buffer.from(`immutable:${pathname}`)]
    }),
  )
}

function validatedUploadMedia(pointer, manifest, bodies = uploadBodies(manifest)) {
  return {
    pointer,
    manifest,
    sourceFiles: new Map(
      [...bodies].map(([sourcePath, body]) => [
        sourcePath,
        {
          size: body.byteLength,
          probe: { validated: true },
          sha256: createHash("sha256").update(body).digest("hex"),
        },
      ]),
    ),
  }
}

function response(status, contentType) {
  return {
    status,
    headers: new Headers(contentType === undefined ? {} : { "content-type": contentType }),
  }
}

function inspectErrorSurface(error) {
  const seen = new Set()
  function inspect(value) {
    if (value === null || typeof value !== "object") return value
    if (seen.has(value)) return "<circular>"
    seen.add(value)
    return Object.fromEntries(
      Reflect.ownKeys(value).map((key) => [String(key), inspect(value[key])]),
    )
  }
  return JSON.stringify(inspect(error))
}

test("upload plan binds the exact suffix-free paths to the validated run manifest", () => {
  const repoRoot = "/repo"
  const { pointer, manifest } = validUploadFixture(repoRoot)
  const plan = createUploadPlan({
    repoRoot,
    pointer,
    manifest,
    baseUrl: AUTHORIZED_MEDIA_ORIGIN,
  })

  assert.deepEqual(MEDIA_UPLOAD_PATHS, EXPECTED_UPLOAD_PATHS)
  assert.deepEqual(
    plan.map(({ pathname }) => pathname),
    EXPECTED_UPLOAD_PATHS,
  )
  assert.deepEqual(
    plan.map(({ sourcePath }) => sourcePath),
    EXPECTED_UPLOAD_PATHS.map(
      (pathname) =>
        `${repoRoot}/docs/brand/demo/artifacts/runs/run-upload/output/${pathname.slice("b4/demo/".length)}`,
    ),
  )
  assert.deepEqual(
    plan.map(({ contentType }) => contentType),
    EXPECTED_UPLOAD_PATHS.map((pathname) =>
      pathname.endsWith(".mp4") ? "video/mp4" : "video/webm",
    ),
  )
  assert.deepEqual(
    plan.map(({ url }) => url),
    EXPECTED_UPLOAD_PATHS.map((pathname) => `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`),
  )

  assert.throws(
    () =>
      createUploadPlan({
        repoRoot,
        pointer,
        manifest: {
          ...manifest,
          clips: {
            ...manifest.clips,
            "product-loop": {
              ...manifest.clips["product-loop"],
              mp4: "/tmp/unbound/product-loop.mp4",
            },
          },
        },
        baseUrl: AUTHORIZED_MEDIA_ORIGIN,
      }),
    /product-loop\.mp4.*expected run output root/,
  )
})

test("upload options default to dry run and reject conflicting or unknown flags", () => {
  assert.deepEqual(parseUploadArguments([]), { apply: false })
  assert.deepEqual(parseUploadArguments(["--dry-run"]), { apply: false })
  assert.deepEqual(parseUploadArguments(["--", "--apply"]), { apply: true })
  assert.throws(() => parseUploadArguments(["--dry-run", "--apply"]), /Usage:.*--dry-run.*--apply/)
  assert.throws(() => parseUploadArguments(["--force"]), /Usage:/)
})

test("recording guide documents the local development OIDC requirement", async () => {
  const guide = await readFile(join(import.meta.dirname, "../recording-guide.md"), "utf8")
  assert.match(guide, /vercel env pull/u)
  assert.match(guide, /local OIDC tokens.*development/u)
  assert.match(guide, /store connection.*include.*development/u)
  const [, committedOutputs] =
    guide.match(/Committed outputs are:\n\n```text\n([\s\S]*?)\n```/u) ?? []
  assert.ok(committedOutputs, "recording guide must list committed outputs")
  assert.match(committedOutputs, /^apps\/web\/app\/lib\/demo-media\.json$/mu)
})

test("upload validation rejects unsafe bases and randomized or nested path suffixes", () => {
  assert.equal(validatePublicBaseUrl(AUTHORIZED_MEDIA_ORIGIN), AUTHORIZED_MEDIA_ORIGIN)
  assert.equal(validatePublicBaseUrl("https://[2001:db8::1]"), "https://[2001:db8::1]")
  assert.equal(validatePublicBaseUrl("https://xn--xample-9ua.com"), "https://xn--xample-9ua.com")
  for (const unsafeBase of [
    "http://b4-media.example.com",
    "https://user:secret@b4-media.example.com",
    "https://b4-media.example.com:443",
    " https://b4-media.example.com",
    "https://b4-media.example.com ",
    "https:\\b4-media.example.com",
    "HTTPS://b4-media.example.com",
    "https://B4.run-Media.example.com",
    "https://éxample.com",
    "https://[2001:0db8::1]",
    "https://b4-media.example.com/",
    "https://b4-media.example.com/prefix",
    "https://b4-media.example.com?token=secret",
    "not a URL",
  ]) {
    assert.throws(() => validatePublicBaseUrl(unsafeBase), /public base URL/i)
  }
  for (const unsafePath of [
    "demo/product-loop.mp4",
    "b4/demo/product-loop-abc123.mp4",
    "demo/nested/product-loop.mp4",
    "../demo/product-loop.mp4",
    "demo/product-loop.mov",
    "demo/product-loop.mp4?download=1",
  ]) {
    assert.throws(() => validateUploadPathname(unsafePath), /stable media path/i)
  }
  for (const pathname of EXPECTED_UPLOAD_PATHS) {
    assert.equal(validateUploadPathname(pathname), pathname)
  }
})

test("dry run validates local media but performs no network or catalog I/O", async () => {
  const { pointer, manifest } = validUploadFixture()
  const lines = []
  let validationCalls = 0
  const env = new Proxy(
    {},
    {
      get(_target, property) {
        if (
          [
            "VERCEL_OIDC_TOKEN",
            "BLOB_STORE_ID",
            "BLOB_READ_WRITE_TOKEN",
            "B4_MEDIA_PUBLIC_BASE_URL",
          ].includes(property)
        ) {
          throw new Error(`dry run must not read ${property}`)
        }
        return undefined
      },
    },
  )
  const result = await uploadReadmeMedia({
    args: [],
    env,
    repoRoot: "/repo",
    async loadValidatedMedia() {
      validationCalls += 1
      return { pointer, manifest }
    },
    async readFile() {
      throw new Error("dry run must not read upload bodies")
    },
    async put() {
      throw new Error("dry run must not call put")
    },
    async fetch() {
      throw new Error("dry run must not call fetch")
    },
    async writeCatalog() {
      throw new Error("dry run must not write a catalog")
    },
    log(line) {
      lines.push(line)
    },
  })

  assert.equal(validationCalls, 1)
  assert.equal(result.applied, false)
  assert.equal(result.catalog, undefined)
  assert.match(lines[0], /DRY RUN.*no uploads.*no catalog/i)
  for (const [index, pathname] of EXPECTED_UPLOAD_PATHS.entries()) {
    assert.match(lines[index + 1], new RegExp(pathname.replaceAll(".", "\\.")))
    assert.match(lines[index + 1], /\/repo\/docs\/brand\/demo\/artifacts\/runs\/run-upload\/output/)
    assert.match(lines[index + 1], /<B4_MEDIA_PUBLIC_BASE_URL>/)
  }
})

test("apply rejects missing, partial, conflicting, or incorrectly bound credential modes", async () => {
  const { pointer, manifest } = validUploadFixture()
  let validationCalls = 0
  const options = {
    args: ["--apply"],
    repoRoot: "/repo",
    async loadValidatedMedia() {
      validationCalls += 1
      return { pointer, manifest }
    },
    log() {},
  }
  for (const [env, expected] of [
    [{}, /exactly one.*credential mode/i],
    [{ VERCEL_OIDC_TOKEN: "oidc-secret" }, /VERCEL_OIDC_TOKEN.*BLOB_STORE_ID/i],
    [{ BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID }, /VERCEL_OIDC_TOKEN.*BLOB_STORE_ID/i],
    [
      {
        VERCEL_OIDC_TOKEN: "oidc-secret",
        BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
        BLOB_READ_WRITE_TOKEN: "legacy-secret",
      },
      /exactly one.*credential mode|conflicting/i,
    ],
    [
      {
        VERCEL_OIDC_TOKEN: "oidc-secret",
        BLOB_STORE_ID: "9RQ8eZyGheVy0wOp",
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      /BLOB_STORE_ID.*authorized B4.run media store/i,
    ],
    [
      {
        VERCEL_OIDC_TOKEN: "oidc-secret",
        BLOB_STORE_ID: `${AUTHORIZED_MEDIA_STORE_ID} `,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      /BLOB_STORE_ID.*authorized B4.run media store/i,
    ],
    [
      {
        VERCEL_OIDC_TOKEN: "oidc-secret",
        BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
        B4_MEDIA_PUBLIC_BASE_URL: "https://other.public.blob.vercel-storage.com",
      },
      /public base URL.*authorized.*store/i,
    ],
  ]) {
    await assert.rejects(uploadReadmeMedia({ ...options, env }), expected)
  }
  assert.equal(validationCalls, 0)
})

test("legacy credentials reject malformed or wrong-store tokens and a mismatched base before put", async () => {
  const { pointer, manifest } = validUploadFixture()
  let validationCalls = 0
  let puts = 0
  const options = {
    args: ["--apply"],
    repoRoot: "/repo",
    async loadValidatedMedia() {
      validationCalls += 1
      return { pointer, manifest }
    },
    async put() {
      puts += 1
    },
    log() {},
  }
  for (const [env, expected] of [
    [
      {
        BLOB_READ_WRITE_TOKEN: "not-a-vercel-blob-token",
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      /BLOB_READ_WRITE_TOKEN.*canonical Vercel Blob/i,
    ],
    [
      {
        BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_wrongStore_secret",
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      /BLOB_READ_WRITE_TOKEN.*authorized B4.run media store/i,
    ],
    [
      {
        BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
        B4_MEDIA_PUBLIC_BASE_URL: "https://other.public.blob.vercel-storage.com",
      },
      /public base URL.*authorized.*store/i,
    ],
  ]) {
    await assert.rejects(uploadReadmeMedia({ ...options, env }), expected)
  }
  assert.equal(validationCalls, 0)
  assert.equal(puts, 0)
})

test("credential values reject surrounding whitespace without leaking their trimmed secrets", async () => {
  const { pointer, manifest } = validUploadFixture()
  let validationCalls = 0
  let puts = 0
  const cases = [
    {
      env: {
        VERCEL_OIDC_TOKEN: " oidc-whitespace-secret ",
        BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      secret: "oidc-whitespace-secret",
    },
    {
      env: {
        BLOB_READ_WRITE_TOKEN: ` ${AUTHORIZED_LEGACY_TOKEN} `,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      secret: AUTHORIZED_LEGACY_TOKEN,
    },
  ]
  for (const { env, secret } of cases) {
    let captured
    try {
      await uploadReadmeMedia({
        args: ["--apply"],
        env,
        repoRoot: "/repo",
        async loadValidatedMedia() {
          validationCalls += 1
          return { pointer, manifest }
        },
        async put() {
          puts += 1
        },
        log() {},
      })
    } catch (error) {
      captured = error
    }
    assert.match(captured.message, /credential.*surrounding whitespace/i)
    assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(secret))
  }
  assert.equal(validationCalls, 0)
  assert.equal(puts, 0)
})

test("OIDC apply passes only the explicit authorized oidcToken and storeId to put", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const oidcToken = "short-lived-oidc-secret"
  const puts = []
  await uploadReadmeMedia({
    args: ["--apply"],
    env: {
      VERCEL_OIDC_TOKEN: oidcToken,
      BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
      B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
    },
    repoRoot: "/repo",
    async loadValidatedMedia() {
      return validatedUploadMedia(pointer, manifest, bodies)
    },
    async readFile(path) {
      return bodies.get(path)
    },
    async put(pathname, _body, options) {
      puts.push({ pathname, options })
      return { url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}` }
    },
    async fetch(url) {
      return response(200, url.endsWith(".mp4") ? "video/mp4" : "video/webm")
    },
    async writeCatalog() {},
    log(line) {
      assert.doesNotMatch(line, new RegExp(oidcToken))
    },
  })
  assert.equal(puts.length, 2)
  for (const { options } of puts) {
    assert.equal(options.oidcToken, oidcToken)
    assert.equal(options.storeId, AUTHORIZED_MEDIA_STORE_ID)
    assert.equal(Object.hasOwn(options, "token"), false)
  }
})

test("OIDC provider failures redact the credential from the full error surface", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const oidcToken = "provider-oidc-secret"
  let captured
  try {
    await uploadReadmeMedia({
      args: ["--apply"],
      env: {
        VERCEL_OIDC_TOKEN: oidcToken,
        BLOB_STORE_ID: AUTHORIZED_MEDIA_STORE_ID,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put() {
        const error = new Error(`OIDC authorization failed: ${oidcToken}`)
        error.authorization = oidcToken
        throw error
      },
      log() {},
    })
  } catch (error) {
    captured = error
  }
  assert.equal(captured.cause, undefined)
  assert.match(captured.message, /OIDC authorization failed: <redacted>/)
  assert.doesNotMatch(captured.stack, new RegExp(oidcToken))
  assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(oidcToken))
})

test("legacy apply remains compatible and requires an explicit safe public base", async () => {
  const { pointer, manifest } = validUploadFixture()
  const legacyToken = authorizedLegacyToken("topsecrettoken")
  const options = {
    args: ["--apply"],
    repoRoot: "/repo",
    async loadValidatedMedia() {
      return { pointer, manifest }
    },
    log() {},
  }
  await assert.rejects(uploadReadmeMedia({ ...options, env: {} }), /BLOB_READ_WRITE_TOKEN/)
  await assert.rejects(
    uploadReadmeMedia({
      ...options,
      env: { BLOB_READ_WRITE_TOKEN: legacyToken },
    }),
    (error) => {
      assert.match(error.message, /B4_MEDIA_PUBLIC_BASE_URL/)
      assert.doesNotMatch(error.message, new RegExp(legacyToken))
      return true
    },
  )
  await assert.rejects(
    uploadReadmeMedia({
      ...options,
      env: {
        BLOB_READ_WRITE_TOKEN: legacyToken,
        B4_MEDIA_PUBLIC_BASE_URL: "http://unsafe.example.com",
      },
    }),
    (error) => {
      assert.doesNotMatch(error.message, new RegExp(legacyToken))
      return /public base URL/i.test(error.message)
    },
  )
})

test("provider failures expose no token-bearing cause, stack, or serialized property", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const token = authorizedLegacyToken("providersecretwritetoken")
  let captured
  try {
    await uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: token,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put() {
        const providerError = new Error(`provider rejected Authorization: Bearer ${token}`)
        providerError.request = {
          headers: { authorization: `Bearer ${token}` },
        }
        throw providerError
      },
      async fetch() {
        throw new Error("fetch must not run after a failed put")
      },
      async writeCatalog() {
        throw new Error("catalog must not be written after a failed put")
      },
      log() {},
    })
  } catch (error) {
    captured = error
  }
  assert.ok(captured instanceof Error)
  assert.match(captured.message, /Upload did not converge at b4\/demo\/product-loop\.mp4/)
  assert.match(captured.message, /provider rejected Authorization: Bearer <redacted>/)
  assert.equal(captured.cause, undefined)
  assert.doesNotMatch(captured.stack, new RegExp(token))
  assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(token))
})

test("upload preflights all bodies and hashes before the first put", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const events = []
  const putBodies = []
  const result = await uploadReadmeMedia({
    args: ["--apply"],
    env: {
      BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
      B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
    },
    repoRoot: "/repo",
    async loadValidatedMedia() {
      return validatedUploadMedia(pointer, manifest, bodies)
    },
    async readFile(path) {
      events.push(`read:${path}`)
      return bodies.get(path)
    },
    async put(pathname, body) {
      events.push(`put:${pathname}`)
      putBodies.push(body)
      return {
        url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
      }
    },
    async fetch(url) {
      return response(200, url.endsWith(".mp4") ? "video/mp4" : "video/webm")
    },
    async writeCatalog() {},
    log() {},
  })

  assert.equal(
    events.slice(0, 2).every((event) => event.startsWith("read:")),
    true,
  )
  assert.equal(
    events.slice(2).every((event) => event.startsWith("put:")),
    true,
  )
  assert.equal(Object.isFrozen(result.plan), true)
  for (const [index, entry] of result.plan.entries()) {
    const expectedBody = bodies.get(entry.sourcePath)
    assert.equal(Object.isFrozen(entry), true)
    assert.equal(entry.body, expectedBody)
    assert.equal(putBodies[index], entry.body)
    assert.equal(entry.size, expectedBody.byteLength)
    assert.equal(entry.sha256, createHash("sha256").update(expectedBody).digest("hex"))
  }
})

test("a late preflight read failure performs zero puts", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  let reads = 0
  let puts = 0
  await assert.rejects(
    uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        reads += 1
        if (reads === 2) throw new Error("late local read failed")
        return bodies.get(path)
      },
      async put() {
        puts += 1
      },
      log() {},
    }),
    /late local read failed/,
  )
  assert.equal(reads, 2)
  assert.equal(puts, 0)
})

test("same-size video mutation fails the validation-time hash before any put", async () => {
  const { pointer, manifest } = validUploadFixture()
  const validatedBodies = uploadBodies(manifest)
  const mutatedBodies = new Map(validatedBodies)
  const sourcePath = manifest.clips["product-loop"].mp4
  const original = validatedBodies.get(sourcePath)
  const mutated = Buffer.from(original)
  mutated[0] ^= 0xff
  assert.equal(mutated.byteLength, original.byteLength)
  mutatedBodies.set(sourcePath, mutated)
  let puts = 0
  await assert.rejects(
    uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, validatedBodies)
      },
      async readFile(path) {
        return mutatedBodies.get(path)
      },
      async put() {
        puts += 1
      },
      log() {},
    }),
    /product-loop\.mp4.*SHA-256.*validation-time hash/i,
  )
  assert.equal(puts, 0)
})

test("partial provider failure reports safe convergence and a full replay succeeds", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const token = authorizedLegacyToken("convergencesecret")
  let writes = 0
  const firstPuts = []
  let firstError
  try {
    await uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: token,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put(pathname) {
        firstPuts.push(pathname)
        if (firstPuts.length === 2) {
          throw new Error(`provider failed ${token}`)
        }
        return {
          url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
        }
      },
      async writeCatalog() {
        writes += 1
      },
      log() {},
    })
  } catch (error) {
    firstError = error
  }
  assert.equal(writes, 0)
  assert.deepEqual(firstPuts, EXPECTED_UPLOAD_PATHS.slice(0, 2))
  assert.match(firstError.message, /confirmed completed stable paths: [^.]*product-loop\.mp4\./is)
  assert.match(
    firstError.message,
    /potentially completed stable path: b4\/demo\/product-loop\.webm\./is,
  )
  assert.match(firstError.message, /definitely pending stable paths: none\./is)
  assert.match(firstError.message, /full two-path.*idempotent.*replay/is)
  assert.doesNotMatch(inspectErrorSurface(firstError), new RegExp(token))
  assert.doesNotMatch(firstError.message, /rollback/i)

  const replayPuts = []
  let heads = 0
  await uploadReadmeMedia({
    args: ["--apply"],
    env: {
      BLOB_READ_WRITE_TOKEN: token,
      B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
    },
    repoRoot: "/repo",
    async loadValidatedMedia() {
      return validatedUploadMedia(pointer, manifest, bodies)
    },
    async readFile(path) {
      return bodies.get(path)
    },
    async put(pathname, body, options) {
      replayPuts.push({ pathname, body, options })
      return {
        url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
      }
    },
    async fetch(url) {
      heads += 1
      return response(200, url.endsWith(".mp4") ? "video/mp4" : "video/webm")
    },
    async writeCatalog() {
      writes += 1
    },
    log() {},
  })
  assert.deepEqual(
    replayPuts.map(({ pathname }) => pathname),
    EXPECTED_UPLOAD_PATHS,
  )
  for (const put of replayPuts) {
    assert.equal(put.options.allowOverwrite, true)
    assert.equal(put.options.addRandomSuffix, false)
    assert.equal(
      put.body,
      bodies.get(
        manifest.clips[put.pathname.split("/")[2].split(".")[0]][
          put.pathname.endsWith(".mp4") ? "mp4" : "webm"
        ],
      ),
    )
  }
  assert.equal(heads, 2)
  assert.equal(writes, 1)
})

test("apply uses official stable put options and writes only after all HEAD checks", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const events = []
  const token = authorizedLegacyToken("privatewritetoken")
  const baseUrl = AUTHORIZED_MEDIA_ORIGIN
  const result = await uploadReadmeMedia({
    args: ["--apply"],
    env: {
      BLOB_READ_WRITE_TOKEN: token,
      B4_MEDIA_PUBLIC_BASE_URL: baseUrl,
    },
    repoRoot: "/repo",
    async loadValidatedMedia() {
      return validatedUploadMedia(pointer, manifest, bodies)
    },
    async readFile(path) {
      events.push({ type: "read", path })
      return bodies.get(path)
    },
    async put(pathname, body, options) {
      events.push({ type: "put", pathname, body, options })
      return { url: `${baseUrl}/${pathname}` }
    },
    async fetch(url, options) {
      events.push({ type: "head", url, options })
      return response(200, url.endsWith(".mp4") ? "video/mp4" : "video/webm")
    },
    async writeCatalog(catalog) {
      events.push({ type: "write", catalog })
    },
    log(line) {
      assert.doesNotMatch(line, new RegExp(token))
    },
  })

  const putEvents = events.filter(({ type }) => type === "put")
  assert.equal(putEvents.length, 2)
  for (const [index, event] of putEvents.entries()) {
    assert.equal(event.pathname, EXPECTED_UPLOAD_PATHS[index])
    assert.ok(Buffer.isBuffer(event.body))
    assert.ok(event.options.abortSignal instanceof AbortSignal)
    assert.deepEqual(
      { ...event.options, abortSignal: undefined },
      {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: event.pathname.endsWith(".mp4") ? "video/mp4" : "video/webm",
        token,
        abortSignal: undefined,
      },
    )
  }
  const headEvents = events.filter(({ type }) => type === "head")
  assert.equal(headEvents.length, 2)
  for (const event of headEvents) {
    assert.equal(event.options.method, "HEAD")
    assert.equal(event.options.redirect, "error")
    assert.ok(event.options.signal instanceof AbortSignal)
    assert.equal("headers" in event.options, false)
  }
  assert.equal(events.at(-1).type, "write")
  assert.deepEqual(result.catalog, events.at(-1).catalog)
  assert.equal(result.applied, true)
  assert.doesNotMatch(JSON.stringify(result.catalog), new RegExp(token))
})

test("returned URL mismatch reports the current mutation uncertainty and safe convergence", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const token = authorizedLegacyToken("mismatchsecret")
  let puts = 0
  let writes = 0
  let captured
  try {
    await uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: token,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put(pathname) {
        puts += 1
        return {
          url:
            puts === 2
              ? `https://other.example.com/${pathname}-${token}`
              : `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
        }
      },
      async fetch() {
        throw new Error("HEAD must wait for valid upload URLs")
      },
      async writeCatalog() {
        writes += 1
      },
      log() {},
    })
  } catch (error) {
    captured = error
  }
  assert.equal(puts, 2)
  assert.equal(writes, 0)
  assert.equal(captured.cause, undefined)
  assert.match(captured.message, /returned URL.*stable public URL/i)
  assert.match(captured.message, /confirmed completed stable paths: b4\/demo\/product-loop\.mp4\./is)
  assert.match(captured.message, /potentially completed stable path: b4\/demo\/product-loop\.webm\./is)
  assert.match(captured.message, /definitely pending stable paths: none\./is)
  assert.match(
    captured.message,
    /correct.*BLOB_READ_WRITE_TOKEN.*B4_MEDIA_PUBLIC_BASE_URL.*full two-path.*replay/is,
  )
  assert.match(captured.message, /catalog.*not written|catalog.*withheld/i)
  assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(token))
})

test("non-timeout HEAD failure withholds the catalog and reports safe post-mutation convergence", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  let writes = 0
  let headCalls = 0
  let captured
  try {
    await uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put(pathname) {
        return {
          url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
        }
      },
      async fetch(url) {
        headCalls += 1
        return response(
          url.endsWith("product-loop.webm") ? 503 : 200,
          url.endsWith(".mp4") ? "video/mp4" : "video/webm",
        )
      },
      async writeCatalog() {
        writes += 1
      },
      log() {},
    })
  } catch (error) {
    captured = error
  }
  assert.equal(headCalls, 2)
  assert.equal(writes, 0)
  assert.match(captured.message, /product-loop\.webm.*200.*503/i)
  assert.match(captured.message, /both upload calls returned/i)
  assert.match(captured.message, /catalog.*not written|catalog.*withheld/i)
  assert.match(captured.message, /verification outcome.*uncertain.*product-loop\.webm/is)
  assert.match(captured.message, /full two-path.*replay|re-verif/is)
})

test("HEAD timeout after all puts preserves safe identity and post-mutation guidance", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const token = authorizedLegacyToken("headtimeoutsecret")
  let puts = 0
  let heads = 0
  let writes = 0
  let captured
  try {
    await uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: token,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      timeoutMs: 5,
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put(pathname) {
        puts += 1
        return {
          url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
        }
      },
      async fetch(_url, options) {
        heads += 1
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          })
        })
      },
      async writeCatalog() {
        writes += 1
      },
      log() {},
    })
  } catch (error) {
    captured = error
  }
  assert.equal(puts, 2)
  assert.equal(heads, 1)
  assert.equal(writes, 0)
  assert.equal(captured.code, "B4_MEDIA_REMOTE_TIMEOUT")
  assert.equal(captured.cause, undefined)
  assert.match(captured.message, /both upload calls returned/i)
  for (const pathname of EXPECTED_UPLOAD_PATHS) {
    assert.match(captured.message, new RegExp(pathname.replace(".", "\\.")))
  }
  assert.match(captured.message, /catalog.*not written|catalog.*withheld/i)
  assert.match(
    captured.message,
    /verification outcome.*uncertain.*https:\/\/9rq8ezyghevy0wop\.public\.blob\.vercel-storage\.com\/b4\/demo\/product-loop\.mp4/is,
  )
  assert.match(captured.message, /full two-path.*replay|re-verif/is)
  assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(token))
})

test("HEAD abort after all puts preserves safe abort identity without a secret-bearing cause", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  const token = authorizedLegacyToken("headabortsecret")
  let puts = 0
  let writes = 0
  let captured
  try {
    await uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: token,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put(pathname) {
        puts += 1
        return {
          url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
        }
      },
      async fetch() {
        const error = new Error(`provider abort ${token}`)
        error.name = "AbortError"
        throw error
      },
      async writeCatalog() {
        writes += 1
      },
      log() {},
    })
  } catch (error) {
    captured = error
  }
  assert.equal(puts, 2)
  assert.equal(writes, 0)
  assert.equal(captured.name, "AbortError")
  assert.equal(captured.code, "B4_MEDIA_REMOTE_ABORT")
  assert.equal(captured.cause, undefined)
  assert.match(captured.message, /both upload calls returned/i)
  assert.match(captured.message, /catalog.*not written|catalog.*withheld/i)
  assert.match(captured.message, /verification outcome.*uncertain/i)
  assert.match(captured.message, /full two-path.*replay|re-verif/is)
  assert.doesNotMatch(inspectErrorSurface(captured), new RegExp(token))
})

test("stalled put and HEAD operations abort at the bounded timeout", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  let putSignal
  await assert.rejects(
    uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: AUTHORIZED_LEGACY_TOKEN,
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      timeoutMs: 5,
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put(_pathname, _body, options) {
        putSignal = options.abortSignal
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("put safety timeout")), 30)
          options.abortSignal?.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
          })
        })
      },
      log() {},
    }),
    /put b4\/demo\/product-loop\.mp4 timed out after 5ms/,
  )
  assert.equal(putSignal.aborted, true)

  const catalog = buildDemoMediaCatalog({
    manifest,
    plan: createUploadPlan({
      repoRoot: "/repo",
      pointer,
      manifest,
      baseUrl: AUTHORIZED_MEDIA_ORIGIN,
    }),
  })
  let headSignal
  await assert.rejects(
    checkRemoteMedia({
      repoRoot: "/repo",
      timeoutMs: 5,
      async readFile() {
        return JSON.stringify(catalog)
      },
      async fetch(_url, options) {
        headSignal = options.signal
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("HEAD safety timeout")), 30)
          options.signal?.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          })
        })
      },
      log() {},
    }),
    /HEAD productLoop\.mp4 timed out after 5ms/,
  )
  assert.equal(headSignal.aborted, true)
})

test("timeout after prior puts reports uncertainty and full idempotent convergence", async () => {
  const { pointer, manifest } = validUploadFixture()
  const bodies = uploadBodies(manifest)
  let puts = 0
  let writes = 0
  let captured
  try {
    await uploadReadmeMedia({
      args: ["--apply"],
      env: {
        BLOB_READ_WRITE_TOKEN: authorizedLegacyToken("timeoutsecret"),
        B4_MEDIA_PUBLIC_BASE_URL: AUTHORIZED_MEDIA_ORIGIN,
      },
      timeoutMs: 5,
      repoRoot: "/repo",
      async loadValidatedMedia() {
        return validatedUploadMedia(pointer, manifest, bodies)
      },
      async readFile(path) {
        return bodies.get(path)
      },
      async put(pathname, _body, options) {
        puts += 1
        if (puts < 2) {
          return {
            url: `${AUTHORIZED_MEDIA_ORIGIN}/${pathname}`,
          }
        }
        return new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () => reject(options.abortSignal.reason), {
            once: true,
          })
        })
      },
      async writeCatalog() {
        writes += 1
      },
      log() {},
    })
  } catch (error) {
    captured = error
  }
  assert.equal(puts, 2)
  assert.equal(writes, 0)
  assert.equal(captured.code, "B4_MEDIA_REMOTE_TIMEOUT")
  assert.equal(captured.cause, undefined)
  assert.match(captured.message, /confirmed completed stable paths: b4\/demo\/product-loop\.mp4\./is)
  assert.match(captured.message, /potentially completed stable path: b4\/demo\/product-loop\.webm\./is)
  assert.match(captured.message, /definitely pending stable paths: none\./is)
  assert.match(captured.message, /full two-path.*idempotent.*replay/is)
  assert.doesNotMatch(inspectErrorSurface(captured), /timeout-secret/)
})

test("bounded remote operation rejects a fired timeout after an ignoring operation resolves", async () => {
  let operationSignal
  await assert.rejects(
    runBoundedRemoteOperation({
      label: "late provider operation",
      timeoutMs: 5,
      async operation(signal) {
        operationSignal = signal
        await new Promise((resolve) => setTimeout(resolve, 20))
        return "late success"
      },
    }),
    (error) =>
      error.code === "B4_MEDIA_REMOTE_TIMEOUT" &&
      /late provider operation timed out after 5ms/.test(error.message),
  )
  assert.equal(operationSignal.aborted, true)
})

test("catalog entries contain exactly the six required fields", () => {
  const { pointer, manifest } = validUploadFixture()
  const plan = createUploadPlan({
    repoRoot: "/repo",
    pointer,
    manifest,
    baseUrl: AUTHORIZED_MEDIA_ORIGIN,
  })
  const catalog = buildDemoMediaCatalog({ manifest, plan })
  assert.deepEqual(Object.keys(catalog), ["productLoop"])
  for (const entry of Object.values(catalog)) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "ariaLabel",
      "caption",
      "mp4",
      "poster",
      "transcript",
      "webm",
    ])
  }
  assert.deepEqual(validateDemoMediaCatalog(catalog), catalog)
  const missingTranscript = structuredClone(catalog)
  delete missingTranscript.productLoop.transcript
  assert.throws(() => validateDemoMediaCatalog(missingTranscript), /productLoop\.transcript.*required/i)
  const unexpectedField = structuredClone(catalog)
  unexpectedField.productLoop.extra = true
  assert.throws(
    () => validateDemoMediaCatalog(unexpectedField),
    /productLoop.*exactly.*ariaLabel.*transcript/i,
  )
})

test("catalog media URLs require exact stable paths with no authority or URL suffix drift", () => {
  const { pointer, manifest } = validUploadFixture()
  const catalog = buildDemoMediaCatalog({
    manifest,
    plan: createUploadPlan({
      repoRoot: "/repo",
      pointer,
      manifest,
      baseUrl: AUTHORIZED_MEDIA_ORIGIN,
    }),
  })
  for (const [name, url, pattern] of [
    [
      "extra path prefix",
      "https://b4-media.public.blob.vercel-storage.com/extra/demo/product-loop.mp4",
      /productLoop\.mp4.*exact stable path/i,
    ],
    [
      "query suffix",
      "https://b4-media.public.blob.vercel-storage.com/demo/product-loop.mp4?unstable=1",
      /productLoop\.mp4.*query|exact stable path/i,
    ],
    [
      "fragment suffix",
      "https://b4-media.public.blob.vercel-storage.com/demo/product-loop.mp4#unstable",
      /productLoop\.mp4.*fragment|exact stable path/i,
    ],
    [
      "credentials",
      "https://user:secret@b4-media.public.blob.vercel-storage.com/demo/product-loop.mp4",
      /productLoop\.mp4.*credentials/i,
    ],
    [
      "nonstandard port",
      "https://b4-media.public.blob.vercel-storage.com:8443/demo/product-loop.mp4",
      /productLoop\.mp4.*port|same public origin/i,
    ],
    [
      "explicit default port",
      "https://b4-media.public.blob.vercel-storage.com:443/demo/product-loop.mp4",
      /productLoop\.mp4.*explicit port/i,
    ],
    [
      "leading whitespace",
      " https://b4-media.public.blob.vercel-storage.com/demo/product-loop.mp4",
      /productLoop\.mp4.*canonical/i,
    ],
    [
      "trailing whitespace",
      "https://b4-media.public.blob.vercel-storage.com/demo/product-loop.mp4 ",
      /productLoop\.mp4.*canonical/i,
    ],
    [
      "backslashes",
      "https://b4-media.public.blob.vercel-storage.com\\demo\\product-loop.mp4",
      /productLoop\.mp4.*canonical/i,
    ],
    [
      "uppercase host",
      "https://B4-MEDIA.public.blob.vercel-storage.com/demo/product-loop.mp4",
      /productLoop\.mp4.*canonical/i,
    ],
  ]) {
    const candidate = structuredClone(catalog)
    candidate.productLoop.mp4 = url
    assert.throws(() => validateDemoMediaCatalog(candidate), pattern, name)
  }
  for (const [name, noncanonicalHost] of [
    ["Unicode IDN", "éxample.com"],
    ["expanded IPv6", "[2001:0db8::1]"],
  ]) {
    const candidate = structuredClone(catalog)
    for (const entry of Object.values(candidate)) {
      entry.mp4 = entry.mp4.replace(new URL(AUTHORIZED_MEDIA_ORIGIN).host, noncanonicalHost)
      entry.webm = entry.webm.replace(new URL(AUTHORIZED_MEDIA_ORIGIN).host, noncanonicalHost)
    }
    assert.throws(() => validateDemoMediaCatalog(candidate), /canonical/i, name)
  }
  for (const canonicalHost of ["xn--xample-9ua.com", "[2001:db8::1]"]) {
    const candidate = structuredClone(catalog)
    for (const entry of Object.values(candidate)) {
      entry.mp4 = entry.mp4.replace(new URL(AUTHORIZED_MEDIA_ORIGIN).host, canonicalHost)
      entry.webm = entry.webm.replace(new URL(AUTHORIZED_MEDIA_ORIGIN).host, canonicalHost)
    }
    assert.doesNotThrow(() => validateDemoMediaCatalog(candidate))
  }
})

test("remote checker loads the checked-in catalog and HEAD-verifies every URL without a token", async () => {
  const { pointer, manifest } = validUploadFixture()
  const plan = createUploadPlan({
    repoRoot: "/repo",
    pointer,
    manifest,
    baseUrl: AUTHORIZED_MEDIA_ORIGIN,
  })
  const catalog = buildDemoMediaCatalog({ manifest, plan })
  const calls = []
  const lines = []
  const result = await checkRemoteMedia({
    repoRoot: "/repo",
    async readFile(path) {
      assert.equal(path, "/repo/apps/web/app/lib/demo-media.json")
      return JSON.stringify(catalog)
    },
    async fetch(url, options) {
      calls.push({ url, options })
      return response(200, url.endsWith(".mp4") ? "video/mp4" : "video/webm")
    },
    log(line) {
      lines.push(line)
    },
  })
  assert.deepEqual(result.catalog, catalog)
  assert.equal(calls.length, 2)
  for (const call of calls) {
    assert.equal(call.options.method, "HEAD")
    assert.equal(call.options.redirect, "error")
    assert.ok(call.options.signal instanceof AbortSignal)
    assert.equal("headers" in call.options, false)
  }
  assert.equal(lines.length, 2)
  assert.ok(lines.every((line) => line.startsWith("PASS remote:")))
})

test("remote checker fails for a missing URL, non-200 status, or wrong content type", async () => {
  const { pointer, manifest } = validUploadFixture()
  const catalog = buildDemoMediaCatalog({
    manifest,
    plan: createUploadPlan({
      repoRoot: "/repo",
      pointer,
      manifest,
      baseUrl: AUTHORIZED_MEDIA_ORIGIN,
    }),
  })
  for (const [name, mutate, fetch, pattern] of [
    [
      "missing URL",
      (value) => {
        value.productLoop.webm = ""
      },
      async () => response(200, "video/webm"),
      /productLoop\.webm.*HTTPS URL/i,
    ],
    [
      "non-200",
      () => {},
      async (url) =>
        response(
          url.endsWith("product-loop.mp4") ? 404 : 200,
          url.endsWith(".mp4") ? "video/mp4" : "video/webm",
        ),
      /productLoop\.mp4.*200.*404/i,
    ],
    [
      "wrong type",
      () => {},
      async (url) =>
        response(
          200,
          url.endsWith("product-loop.webm")
            ? "application/octet-stream"
            : url.endsWith(".mp4")
              ? "video/mp4"
              : "video/webm",
        ),
      /productLoop\.webm.*video\/webm.*application\/octet-stream/i,
    ],
  ]) {
    const candidate = structuredClone(catalog)
    mutate(candidate)
    await assert.rejects(
      checkRemoteMedia({
        repoRoot: "/repo",
        async readFile() {
          return JSON.stringify(candidate)
        },
        fetch,
        log() {},
      }),
      pattern,
      name,
    )
  }
})

test("media checker CLI requires exactly one local or remote mode", () => {
  assert.deepEqual(parseMediaCheckArguments(["--", "--remote"]), {
    remote: true,
  })
  assert.deepEqual(parseMediaCheckArguments(["--local"]), { local: true })
  for (const args of [[], ["--local", "--remote"], ["--remote", "--remote"]]) {
    assert.throws(() => parseMediaCheckArguments(args), /Usage:.*--local.*--remote/)
  }
})

test("catalog writer removes its temporary path after real write and rename failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "b4-demo-catalog-atomic-"))
  try {
    const target = join(root, "apps/web/app/lib/demo-media.json")
    const temporary = `${target}.tmp`
    const parent = join(root, "apps/web/app/lib")
    await mkdir(parent, { recursive: true })
    const outsideDirectory = join(root, "outside-directory")
    await mkdir(outsideDirectory)
    await symlink(outsideDirectory, temporary)
    await assert.rejects(
      writeDemoMediaCatalog({ safe: true }, { repoRoot: root }),
      /EISDIR|illegal operation|directory/i,
    )
    await assert.rejects(lstat(temporary), /ENOENT/)
    assert.equal((await lstat(outsideDirectory)).isDirectory(), true)
    await mkdir(target)
    await assert.rejects(
      writeDemoMediaCatalog({ safe: true }, { repoRoot: root }),
      /EISDIR|ENOTEMPTY|directory/i,
    )
    await assert.rejects(lstat(temporary), /ENOENT/)
    assert.equal((await lstat(target)).isDirectory(), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Take 2: the deterministic scenario and the AWC stub.
//
// The template's own TypeScript (tools, lib and the web's parsers) runs here
// through tsx, so the fixtures are checked against the code the generated app
// runs rather than against a copy of it.

const TEMPLATE_ROOT = fileURLToPath(
  new URL("../../../packages/devkit/templates/app-navlog/", import.meta.url),
)
const importTemplate = (relative) =>
  tsImport(pathToFileURL(join(TEMPLATE_ROOT, relative)).href, import.meta.url)

// Clock times either side of 1400Z, across a month and a year boundary, and
// through the early-UTC hours where the FB product choice is easiest to get wrong.
const SCENARIO_NOWS = [
  "2026-10-08T00:30:00.000Z",
  "2026-10-08T03:00:00.000Z",
  "2026-10-08T06:30:00.000Z",
  "2026-10-08T07:50:00.000Z",
  "2026-10-07T13:10:00.000Z",
  "2026-10-07T14:00:00.000Z",
  "2026-10-07T15:20:00.000Z",
  "2026-10-31T23:59:00.000Z",
  "2026-12-31T22:45:00.000Z",
].map((iso) => Date.parse(iso))

/** The scripted fixtures grouped by the thread (first user message) they answer. */
function fixtureGroups(fixtures) {
  const groups = new Map()
  for (const fixture of fixtures) {
    const key = fixture.match.userMessage
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(fixture)
  }
  return groups
}

const toolCallOf = (fixture) => {
  const calls = fixture.response.toolCalls
  assert.equal(calls?.length, 1, "each scripted step makes exactly one tool call")
  return calls[0]
}

function assertScriptedThread(steps, expectedTools) {
  assert.equal(steps.length, expectedTools.length + 1)
  steps.forEach((fixture, index) => {
    assert.equal(fixture.match.turnIndex, index)
    assert.equal(fixture.match.hasToolResult, index > 0)
  })
  assert.deepEqual(
    steps.slice(0, -1).map((fixture) => toolCallOf(fixture).name),
    expectedTools,
  )
  const reply = steps.at(-1).response.content
  assert.equal(typeof reply, "string")
  return { calls: steps.slice(0, -1).map(toolCallOf), reply }
}

test("demoScenario resolves 1400Z exactly as the template's resolveDeparture does", async () => {
  const { parseUtcInstant } = await importTemplate("server/src/lib/fpl.ts")
  for (const now of SCENARIO_NOWS) {
    const scenario = demoScenario({ now })
    const expected = parseUtcInstant("1400Z", () => now)
    assert.equal(scenario.departureUtc, expected.toISOString())
    assert.equal(
      scenario.hoursAhead,
      Math.round(((expected.getTime() - now) / 3_600_000) * 10) / 10,
    )
  }
  // The live tool reads the wall clock; it agrees with a scenario built now.
  const { default: resolveDeparture } = await importTemplate("server/src/tools/resolveDeparture.ts")
  const before = Date.now()
  const live = await resolveDeparture({ departure: "1400Z" }, {})
  assert.equal(live.departureUtc, demoScenario({ now: before }).departureUtc)
})

test("the parent's turn 1 follows the route's order and hands each child its own thread", () => {
  for (const now of SCENARIO_NOWS) {
    const scenario = demoScenario({ now })
    const groups = fixtureGroups(scenario.fixtures)
    assert.deepEqual(
      [...groups.keys()],
      [DEMO_PROMPT, DEMO_FILE_PROMPT, scenario.weatherInput, scenario.performanceInput],
    )
    const { calls, reply } = assertScriptedThread(groups.get(DEMO_PROMPT), [
      "recall",
      "resolveDeparture",
      "writeTodos",
      "lookupAirport",
      "lookupAirport",
      "task",
      "task",
      "computeNavlog",
      "remember",
      "writeFile",
    ])
    assert.deepEqual(scenario.planTools, calls.map((call) => call.name))
    assert.equal(reply, scenario.planAnswer)
    const args = calls.map((call) => call.arguments)
    assert.deepEqual(args[0], { query: "aircraft profile and pilot preferences" })
    assert.deepEqual(args[1], { departure: "1400Z" })
    assert.deepEqual(args[2], { todos: scenario.todos })
    assert.ok(scenario.todos.length >= 3)
    for (const todo of scenario.todos) {
      assert.ok(["pending", "in_progress", "completed"].includes(todo.status))
      assert.equal(typeof todo.content, "string")
    }
    assert.deepEqual(args[3], { id: "KSTP" })
    assert.deepEqual(args[4], { id: "KRST" })
    // aimock matches a child's turns by its first user message, which is the task input verbatim.
    assert.deepEqual(args[5], { subagent: "weather", input: scenario.weatherInput })
    assert.deepEqual(args[6], { subagent: "performance", input: scenario.performanceInput })
    assert.ok(scenario.weatherInput.includes(scenario.departureUtc))
    assert.ok(scenario.weatherInput.includes(`hoursAhead ${scenario.hoursAhead}`))
    assert.ok(scenario.weatherInput.includes("KSTP (44.9346, -93.0603)"))
    assert.deepEqual(args[7], scenario.navlogInput)
    assert.equal(args[7].departureTimeUtc, scenario.departureUtc)
    assert.deepEqual(args[8], scenario.memory)
    assert.deepEqual(args[9], { path: "reports/KSTP-KRST.md", content: scenario.navlogTable })
  }
})

test("the remember call matches the route's memory schema and states a fact the prompt gives", async () => {
  const memorySource = await readFile(join(TEMPLATE_ROOT, "server/src/app/navlog/memory.ts"), "utf8")
  const schemaKeys = [...memorySource.matchAll(/^\s{4}(\w+): z\.string\(\)/gm)].map((m) => m[1])
  assert.deepEqual(schemaKeys, ["subject", "predicate", "value"])
  const { data, content } = DEMO_SCENARIO.memory
  assert.deepEqual(Object.keys(data), schemaKeys)
  for (const value of Object.values(data)) assert.equal(typeof value, "string")
  assert.deepEqual(Object.keys(DEMO_SCENARIO.memory), ["data", "content"])
  // The memory panel lists the candidate by its content.
  assert.ok(content.length > 0 && content.length <= 80)
  assert.match(content, /N738ZU/)
  assert.match(DEMO_PROMPT, /N738ZU has long-range tanks/)
})

test("the children brief from their own tools and turn 2 files the computed plan", () => {
  for (const now of SCENARIO_NOWS) {
    const scenario = demoScenario({ now })
    const groups = fixtureGroups(scenario.fixtures)
    const weather = assertScriptedThread(groups.get(scenario.weatherInput), [
      "getMetar",
      "getTaf",
      "getWindsAloft",
      "getAdvisories",
      "getAdvisories",
    ])
    assert.deepEqual(weather.calls[0].arguments, { ids: ["KSTP", "KRST"] })
    assert.deepEqual(weather.calls[1].arguments, { ids: ["KSTP", "KRST"] })
    assert.deepEqual(weather.calls[2].arguments, {
      region: "chi",
      station: "MSP",
      altitudeFt: 4500,
      forecastHours: scenario.windsForecastHours,
    })
    assert.ok(scenario.windsForecastHours >= 6 && scenario.windsForecastHours <= 24)
    assert.deepEqual(weather.calls[3].arguments, { lat: 44.9346, lon: -93.0603 })
    assert.deepEqual(weather.calls[4].arguments, { lat: 43.9083, lon: -92.49 })
    assert.equal(weather.reply, scenario.weatherBrief)

    const performance = assertScriptedThread(groups.get(scenario.performanceInput), ["readDoc"])
    assert.deepEqual(performance.calls[0].arguments, { path: "poh/cruise-performance.md" })
    assert.equal(performance.reply, scenario.performanceBrief)

    const filing = assertScriptedThread(groups.get(DEMO_FILE_PROMPT), ["fileFlightPlan"])
    assert.deepEqual(filing.calls[0].arguments, { flightPlan: scenario.flightPlan })
    assert.equal(filing.reply, scenario.filedAnswer)
    assert.deepEqual(scenario.fileTools, ["fileFlightPlan"])
  }
})

test("the navlog numbers and flight plan are what the template's computeNavlog returns", async () => {
  const { computeNavlog } = await importTemplate("server/src/lib/navlog.ts")
  const { formatFplMessage } = await importTemplate("server/src/lib/fpl.ts")
  for (const now of SCENARIO_NOWS) {
    const scenario = demoScenario({ now })
    const navlog = computeNavlog(scenario.navlogInput, () => now)
    assert.deepEqual(scenario.flightPlan, navlog.flightPlan)
    assert.equal(navlog.departureTimeUtc, scenario.departureUtc)
    assert.deepEqual(scenario.navlog.totals, navlog.totals)
    assert.deepEqual(
      scenario.navlog.legs,
      navlog.legs.map((leg) => ({
        segment: leg.segment,
        magneticHeading: leg.magneticHeading,
        groundspeedKt: leg.groundspeedKt,
        distanceNm: leg.distanceNm,
        eteMin: leg.eteMin,
        fuelGal: leg.fuelGal,
      })),
    )
    assert.equal(scenario.etaUtc, navlog.legs.at(-1).etaUtc)
    assert.equal(scenario.navlog.tasKt, navlog.aircraft.tasKt)
    assert.equal(scenario.navlog.gph, navlog.aircraft.gph)
    // The performance subagent quotes the same cruise row the code computes with.
    assert.match(scenario.performanceBrief, new RegExp(`about ${Math.round(navlog.aircraft.tasKt)} KTAS`))
    assert.match(scenario.performanceBrief, new RegExp(`${navlog.aircraft.gph.toFixed(1)} GPH`))
    // The brief and the report quote the code's numbers, never their own.
    const answer = scenario.planAnswer
    assert.match(answer, new RegExp(`\\b${navlog.totals.distanceNm} nm\\b`))
    assert.match(answer, new RegExp(`ETE ${navlog.totals.eteMin} min`))
    assert.match(answer, new RegExp(`${navlog.totals.fuelGal.toFixed(1)} gal burned`))
    assert.match(answer, new RegExp(`${navlog.totals.fuelRemainingGal.toFixed(1)} gal at landing`))
    const reserve = `${Math.floor(navlog.totals.reserveMin / 60)}:${String(navlog.totals.reserveMin % 60).padStart(2, "0")}`
    assert.match(answer, new RegExp(`reserve ${reserve}\\b`))
    assert.match(answer, new RegExp(`${navlog.aircraft.gph.toFixed(1)} GPH`))
    const eta = navlog.legs.at(-1).etaUtc.slice(11, 16).replace(":", "")
    assert.match(answer, new RegExp(`${eta}Z ETA`))
    for (const leg of navlog.legs) {
      assert.ok(
        scenario.navlogTable.includes(
          `| ${leg.from} | ${leg.to} | ${leg.segment} | ${leg.magneticHeading} | ${leg.groundspeedKt} | ${leg.distanceNm} | ${leg.eteMin} | ${leg.fuelGal} |`,
        ),
      )
    }
    // The filed reply reads the items the tool records.
    assert.ok(formatFplMessage(navlog.flightPlan).includes(`-${navlog.flightPlan.item15}`))
    assert.ok(scenario.filedAnswer.includes(navlog.flightPlan.item15))
    assert.ok(scenario.filedAnswer.includes(navlog.flightPlan.item16))
  }
})

test("the scripted briefs render in the weather strip, the verdict card and the planning answer", async () => {
  const { parseWeatherBrief, parseWindsLine } = await importTemplate("web/app/lib/weather-selectors.ts")
  const { resolveVerdict } = await importTemplate("web/app/lib/verdict.ts")
  const { parsePlanningAnswer } = await importTemplate("web/app/lib/assistant-text.ts")
  const { computeNavlog } = await importTemplate("server/src/lib/navlog.ts")
  for (const now of SCENARIO_NOWS) {
    const scenario = demoScenario({ now })
    const brief = parseWeatherBrief(scenario.weatherBrief)
    assert.deepEqual(
      brief.airports.map((airport) => [airport.id, airport.now, airport.atEta]),
      [
        ["KSTP", "VFR", "VFR"],
        ["KRST", "VFR", "VFR"],
      ],
    )
    for (const airport of brief.airports) {
      assert.match(airport.metar, new RegExp(`^METAR ${airport.id} `))
      assert.match(airport.taf, new RegExp(`^TAF ${airport.id} `))
    }
    assert.equal(brief.verdict?.level, "GO")
    assert.deepEqual(brief.advisories, [])
    assert.equal(brief.winds.length, 1)
    const wind = parseWindsLine(brief.winds[0])
    assert.deepEqual([wind.leg, wind.dir, wind.kt, wind.altitudeFt, wind.station], [1, 320, 20, 4500, "MSP"])
    assert.notEqual(brief.note, "")

    const navlog = computeNavlog(scenario.navlogInput, () => now)
    const verdict = resolveVerdict({ weather: brief, answer: scenario.planAnswer, navlog })
    assert.equal(verdict.level, "GO")
    assert.equal(verdict.raisedFrom, undefined)

    const answer = parsePlanningAnswer(scenario.planAnswer)
    assert.equal(answer.verdict?.level, "GO")
    assert.deepEqual(
      answer.sections.map((section) => section.title),
      ["Watch for", "Numbers", "Assumptions"],
    )
    assert.match(answer.closing ?? "", /file the plan/)
    assert.ok(scenario.planAnswer.split(/\s+/).length < 180)
    // The eval's guards on a planning answer.
    for (const pattern of [/\brecall\(/, /\[(completed|pending|in_progress)\]/, /reports\//, /engine-on/i]) {
      assert.doesNotMatch(scenario.planAnswer, pattern)
    }
    assert.match(scenario.planAnswer, /\[poh\/cruise-performance\.md, Figure 5-7\]/)
    const assumptions = answer.sections.find((section) => section.title === "Assumptions")
    assert.match(assumptions.items.join(" "), new RegExp(scenario.departureLabel))
    assert.match(assumptions.items.join(" "), /1 person on board assumed/)

    const filed = scenario.filedAnswer.split("\n")
    assert.ok(filed.length >= 2 && filed.length <= 4)
    assert.match(filed[0], /^Recorded the flight plan for N738ZU KSTP→KRST, departing 1400Z /)
    assert.match(scenario.filedAnswer, /does not transmit to Flight Service/)
    assert.ok(scenario.filedAnswer.includes(scenario.departureLabel))
  }
})

/** GET a stub path and return status, content type and body. */
async function getStub(baseUrl, path) {
  const response = await fetch(`${baseUrl}/${path}`)
  return {
    status: response.status,
    type: response.headers.get("content-type") ?? "",
    body: await response.text(),
  }
}

async function portIsFree(port) {
  return new Promise((resolve) => {
    const server = createNetServer()
    server.once("error", () => resolve(false))
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(true)))
  })
}

test("the AWC stub answers every endpoint over loopback, counts hits and frees its port", async () => {
  const now = Date.parse("2026-10-07T15:20:00Z")
  let asked = 0
  const stub = await startAwcStub({
    now,
    getPort: async () => {
      asked += 1
      return getAvailableLoopbackPort()
    },
  })
  const port = Number(new URL(stub.baseUrl).port)
  try {
    assert.equal(asked, 1)
    assert.match(stub.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
    assert.deepEqual(stub.hits, { airport: 0, metar: 0, taf: 0, windtemp: 0, gairmet: 0, airsigmet: 0 })

    const airport = await getStub(stub.baseUrl, "airport?ids=KSTP&format=json")
    assert.equal(airport.status, 200)
    assert.match(airport.type, /^application\/json/)
    const [kstp] = JSON.parse(airport.body)
    assert.equal(kstp.icaoId, "KSTP")
    assert.equal(kstp.elev, 215)

    const metar = await getStub(stub.baseUrl, "metar?ids=KSTP%2CKRST&format=json")
    assert.equal(metar.status, 200)
    assert.match(metar.type, /^application\/json/)
    assert.deepEqual(
      JSON.parse(metar.body).map((record) => [record.icaoId, record.fltCat, record.wdir, record.wspd]),
      [
        ["KSTP", "VFR", 320, 8],
        ["KRST", "VFR", 320, 8],
      ],
    )

    const taf = await getStub(stub.baseUrl, "taf?ids=KRST&format=json")
    assert.equal(taf.status, 200)
    assert.deepEqual(JSON.parse(taf.body).map((record) => record.icaoId), ["KRST"])

    const windtemp = await getStub(stub.baseUrl, "windtemp?region=chi&level=low&fcst=06")
    assert.equal(windtemp.status, 200)
    assert.match(windtemp.type, /^text\/plain/)
    assert.match(windtemp.body, /^FT {2}3000 {4}6000/m)
    assert.match(windtemp.body, /^MSP 3220 3220\+05 /m)

    for (const product of ["gairmet", "airsigmet"]) {
      const advisories = await getStub(stub.baseUrl, `${product}?format=json`)
      assert.equal(advisories.status, 200)
      assert.match(advisories.type, /^application\/json/)
      assert.deepEqual(JSON.parse(advisories.body), [])
    }

    // An id the stub does not know matches nothing, as AWC answers.
    assert.equal((await getStub(stub.baseUrl, "metar?ids=KXXX&format=json")).status, 204)

    const unknown = await getStub(stub.baseUrl, "pirep?format=json")
    assert.equal(unknown.status, 404)
    assert.match(unknown.body, /AWC stub: no endpoint \/pirep/)
    const noFormat = await getStub(stub.baseUrl, "metar?ids=KSTP")
    assert.equal(noFormat.status, 400)
    assert.match(noFormat.body, /format=json/)
    const badRegion = await getStub(stub.baseUrl, "windtemp?region=bos&level=low&fcst=06")
    assert.equal(badRegion.status, 400)
    assert.match(badRegion.body, /region/)

    // A request the stub refuses (400) is not a hit: hits count what it served.
    assert.deepEqual(stub.hits, { airport: 1, metar: 2, taf: 1, windtemp: 1, gairmet: 1, airsigmet: 1 })
  } finally {
    await stub.close()
  }
  assert.equal(await portIsFree(port), true)
  // The stub has no clock of its own: it serves the scenario's.
  await assert.rejects(startAwcStub({}), /needs \{ now \}/)
  await assert.rejects(startAwcStub(), /needs \{ now \}/)
  // Without getPort the stub takes any free loopback port.
  const anyPort = await startAwcStub({ now })
  try {
    assert.match(anyPort.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/)
  } finally {
    await anyPort.close()
  }
})

test("the template's real tools parse the stub and agree with every scripted call and brief", async () => {
  const now = Date.now()
  const scenario = demoScenario({ now })
  const stub = await startAwcStub({ now })
  // The tools' shared AWC client reads B4_AWC_BASE_URL when its module loads;
  // set only for this test's imports, so no turbo task depends on it.
  const awcBaseUrlVariable = "B4_AWC_BASE_URL"
  const previous = process.env[awcBaseUrlVariable]
  process.env[awcBaseUrlVariable] = stub.baseUrl
  try {
    const tool = async (name) => (await importTemplate(`server/src/tools/${name}.ts`)).default
    const written = new Map()
    const ctx = {
      signal: new AbortController().signal,
      fs: {
        async readFile(path) {
          return readFile(join(TEMPLATE_ROOT, "server/workspace", path), "utf8")
        },
        async writeFile(path, content) {
          written.set(path, content)
        },
      },
    }
    const groups = fixtureGroups(scenario.fixtures)
    const callsOf = (key) => groups.get(key).filter((f) => f.response.toolCalls).map(toolCallOf)
    const results = new Map()
    const run = async (call) => {
      const output = await (await tool(call.name))(call.arguments, ctx)
      results.set(call.id, output)
      return output
    }

    // The parent's own tools (the runtime's built-ins aside).
    const parentCalls = callsOf(DEMO_PROMPT)
    const byName = (name) => parentCalls.filter((call) => call.name === name)
    const resolved = await run(byName("resolveDeparture")[0])
    assert.equal(resolved.departureUtc, scenario.departureUtc)
    const airports = []
    for (const call of byName("lookupAirport")) airports.push(await run(call))
    assert.deepEqual(
      airports.map(({ id, lat, lon, elevationFt, magneticVariationDeg }) => ({
        id,
        kind: "airport",
        lat,
        lon,
        elevationFt,
        magneticVariationDeg,
      })),
      scenario.navlogInput.waypoints.map(({ id, kind, lat, lon, elevationFt, magneticVariationDeg }) => ({
        id,
        kind,
        lat,
        lon,
        elevationFt,
        magneticVariationDeg,
      })),
    )
    const navlog = await run(byName("computeNavlog")[0])
    assert.deepEqual(navlog.flightPlan, scenario.flightPlan)

    // The weather child: every claim in its brief is what its tools returned.
    const [metarCall, tafCall, windsCall, ...advisoryCalls] = callsOf(scenario.weatherInput)
    const metars = await run(metarCall)
    assert.deepEqual(
      metars.map((m) => [m.id, m.flightCategory, m.windDirDeg, m.windKt, m.visibilityMi, m.ceilingFt]),
      [
        ["KSTP", "VFR", 320, 8, 10, null],
        ["KRST", "VFR", 320, 8, 10, null],
      ],
    )
    const tafs = await run(tafCall)
    const eta = Date.parse(scenario.etaUtc)
    const departure = Date.parse(scenario.departureUtc)
    for (const taf of tafs) {
      const covering = taf.periods.filter(
        (period) => Date.parse(period.fromUtc) <= departure && Date.parse(period.toUtc) >= eta,
      )
      assert.equal(covering.length, 1, `${taf.id}'s TAF covers the flight`)
      assert.equal(covering[0].flightCategory, "VFR")
      assert.equal(covering[0].windDirDeg, 320)
      assert.equal(covering[0].windKt, 8)
      assert.equal(taf.periods.length, 1)
    }
    const winds = await run(windsCall)
    assert.deepEqual(winds.wind, { dirDegTrue: 320, speedKt: 20, tempC: null })
    assert.deepEqual(scenario.navlogInput.winds, [{ dirDegTrue: 320, speedKt: 20 }])
    for (const call of advisoryCalls) assert.deepEqual(await run(call), [])
    for (const metar of metars) assert.ok(scenario.weatherBrief.includes(metar.raw))
    for (const taf of tafs) assert.ok(scenario.weatherBrief.includes(taf.raw))
    assert.ok(scenario.weatherBrief.includes(`valid ${winds.validAt}`))
    assert.match(scenario.weatherBrief, /^Advisories: none$/m)
    assert.match(scenario.weatherBrief, /^Forecast horizon: Departure is within TAF and winds-aloft coverage\.$/m)

    // The performance child reads the real POH table it cites.
    const [readCall] = callsOf(scenario.performanceInput)
    const doc = await run(readCall)
    assert.match(doc.content, /\| 4000 \| 2400 \| 68 \/ 111 \/ 7\.6 \| 64 \/ 110 \/ 7\.1 \|/)
    assert.match(doc.content, /\| 6000 \| 2400 \| 64 \/ 110 \/ 7\.2 \| 60 \/ 109 \/ 6\.8 \|/)
    assert.match(scenario.performanceBrief, /\[poh\/cruise-performance\.md, Figure 5-7\]/)

    // Turn 2 records the plan computeNavlog produced.
    const [fileCall] = callsOf(DEMO_FILE_PROMPT)
    const filed = await run(fileCall)
    assert.equal(filed.status, "recorded")
    assert.equal(filed.transmitted, false)
    assert.match(written.get(filed.path), /^\(FPL-N738ZU-VG\n/)

    for (const endpoint of Object.keys(stub.hits)) {
      assert.ok(stub.hits[endpoint] >= 1, `the scripted flow reaches ${endpoint}`)
    }
  } finally {
    if (previous === undefined) delete process.env[awcBaseUrlVariable]
    else process.env[awcBaseUrlVariable] = previous
    await stub.close()
  }
})

test("demoAwcData keeps the stub's weather consistent with the scripted brief for any clock", () => {
  for (const now of SCENARIO_NOWS) {
    const scenario = demoScenario({ now })
    const data = demoAwcData(now)
    for (const id of ["KSTP", "KRST"]) {
      assert.ok(scenario.weatherBrief.includes(data.metars[id].rawOb))
      assert.ok(scenario.weatherBrief.includes(data.tafs[id].rawTAF))
      assert.ok(Date.parse(data.metars[id].reportTime) <= now + 60 * 60_000)
    }
    const product = data.windtemp(String(scenario.windsForecastHours <= 6 ? 6 : scenario.windsForecastHours <= 12 ? 12 : 24).padStart(2, "0"))
    assert.match(product, /^MSP 3220 3220\+05 /m)
  }
})

/** A `DDHHMMZ` group as the instant nearest `near` whose day of the month matches. */
function resolveDayGroup(group, near) {
  const match = /^(\d{2})(\d{2})(\d{2})Z$/.exec(group)
  assert.ok(match, `${group} is a DDHHMMZ group`)
  const [, day, hour, minute] = match.map(Number)
  const candidates = []
  for (let offset = -3; offset <= 3; offset += 1) {
    const date = new Date(near + offset * 86_400_000)
    if (date.getUTCDate() !== day) continue
    candidates.push(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), day, hour, minute),
    )
  }
  assert.ok(candidates.length > 0, `${group} falls within three days of the flight`)
  return candidates.sort((a, b) => Math.abs(a - near) - Math.abs(b - near))[0]
}

/** The absolute FOR USE window around `validAt`: the HHMM at or before it to the HHMM at or after it. */
function forUseWindow(forUse, validAt) {
  const match = /^(\d{2})(\d{2})-(\d{2})(\d{2})Z$/.exec(forUse)
  assert.ok(match, `${forUse} is an HHMM-HHMMZ window`)
  const [, fromH, fromM, toH, toM] = match.map(Number)
  const valid = new Date(validAt)
  const sameDay = (h, m) =>
    Date.UTC(valid.getUTCFullYear(), valid.getUTCMonth(), valid.getUTCDate(), h, m)
  let from = sameDay(fromH, fromM)
  if (from > validAt) from -= 86_400_000
  let to = sameDay(toH, toM)
  if (to < validAt) to += 86_400_000
  return { from, to }
}

test("the stub's FB product covers the whole flight at every capture hour, through the real tool", async () => {
  const awcBaseUrlVariable = "B4_AWC_BASE_URL"
  const previous = process.env[awcBaseUrlVariable]
  try {
    for (const now of SCENARIO_NOWS) {
      const scenario = demoScenario({ now })
      const windsCall = fixtureGroups(scenario.fixtures)
        .get(scenario.weatherInput)
        .map((fixture) => fixture.response.toolCalls?.[0])
        .find((call) => call?.name === "getWindsAloft")
      const stub = await startAwcStub({ now })
      try {
        process.env[awcBaseUrlVariable] = stub.baseUrl
        // Each tsImport is a fresh module namespace, so the tools' shared AWC
        // client is rebuilt and reads this stub's base URL.
        const { default: getWindsAloft } = await importTemplate("server/src/tools/getWindsAloft.ts")
        const winds = await getWindsAloft(windsCall.arguments, { signal: new AbortController().signal })
        const departure = Date.parse(scenario.departureUtc)
        const eta = Date.parse(scenario.etaUtc)
        const label = new Date(now).toISOString()
        const basedOn = resolveDayGroup(winds.basedOn, now)
        assert.ok(basedOn <= now, `${label}: FB data time ${winds.basedOn} is not in the future`)
        assert.ok(now - basedOn <= 8 * 3_600_000, `${label}: FB data time ${winds.basedOn} is current`)
        const validAt = resolveDayGroup(winds.validAt, departure)
        const window = forUseWindow(winds.forUse, validAt)
        assert.ok(
          window.from <= departure && eta <= window.to,
          `${label}: FOR USE ${winds.forUse} (valid ${winds.validAt}) spans ${scenario.departureUtc}..${scenario.etaUtc}`,
        )
        assert.equal(winds.forecastHours, windsCall.arguments.forecastHours)
        assert.ok(scenario.weatherBrief.includes(`valid ${winds.validAt}`))
        assert.deepEqual(winds.wind, { dirDegTrue: 320, speedKt: 20, tempC: null })
      } finally {
        await stub.close()
      }
    }
  } finally {
    if (previous === undefined) delete process.env[awcBaseUrlVariable]
    else process.env[awcBaseUrlVariable] = previous
  }
})

test("every capture minute of a day gets a covering FB product and a covering TAF", async () => {
  const { parseWindsAloft } = await importTemplate("server/src/lib/winds-aloft.ts")
  const start = Date.parse("2026-10-08T00:00:00.000Z")
  for (let now = start; now < start + 86_400_000; now += 10 * 60_000) {
    // demoScenario refuses to script a brief whose coverage the stub would not serve.
    const scenario = demoScenario({ now })
    const data = demoAwcData(now)
    const product = parseWindsAloft(data.windtemp(String(scenario.windsForecastHours).padStart(2, "0")))
    const departure = Date.parse(scenario.departureUtc)
    const eta = Date.parse(scenario.etaUtc)
    const window = forUseWindow(product.forUse, resolveDayGroup(product.validAt, departure))
    assert.ok(window.from <= departure && eta <= window.to, new Date(now).toISOString())
    assert.ok(resolveDayGroup(product.basedOn, now) <= now)
    for (const id of ["KSTP", "KRST"]) {
      const taf = data.tafs[id]
      assert.ok(taf.validTimeFrom * 1000 <= departure && eta <= taf.validTimeTo * 1000)
      assert.ok(Date.parse(taf.issueTime) <= now)
    }
  }
})

test("assertScenarioCurrent throws once 1400Z has passed since the scenario was built", () => {
  const scenario = demoScenario({ now: Date.parse("2026-10-08T13:50:00.000Z") })
  assert.equal(scenario.departureUtc, "2026-10-08T14:00:00.000Z")
  assertScenarioCurrent(scenario, Date.parse("2026-10-08T13:59:59.999Z"))
  assertScenarioCurrent(scenario, Date.parse("2026-10-08T14:00:00.000Z"))
  assert.throws(
    () => assertScenarioCurrent(scenario, Date.parse("2026-10-08T14:00:00.001Z")),
    /stale: "1400Z" now resolves to 2026-10-09T14:00:00\.000Z, but the scenario scripted 2026-10-08T14:00:00\.000Z/,
  )
  // The default clock is the wall clock, which a scenario built now agrees with.
  assertScenarioCurrent(demoScenario())
})

test("the scripted order and tools agree with the template's route and subagent definitions", async () => {
  // The prompt is a template literal, so its backticks are escaped in the source.
  const routeSource = (
    await readFile(join(TEMPLATE_ROOT, "server/src/app/navlog/index.ts"), "utf8")
  ).replaceAll("\\`", "`")
  const steps = [...routeSource.matchAll(/^(\d+)\. (.*)$/gm)].map((m) => ({
    number: Number(m[1]),
    text: m[2],
  }))
  assert.ok(steps.length >= 7, "the route prompt has numbered steps")
  // Where each tool is called, by its backticked name; the todos step names no tool.
  const callIn = {
    recall: /`recall\(/,
    resolveDeparture: /`resolveDeparture\(/,
    writeTodos: /\btodos\b/,
    lookupAirport: /`lookupAirport`/,
    task: /`task\(/,
    computeNavlog: /`computeNavlog`/,
    writeFile: /`writeFile\(/,
  }
  const stepOf = (tool) => steps.find((step) => callIn[tool].test(step.text))?.number
  const order = Object.keys(callIn)
  const numbers = order.map(stepOf)
  for (const [index, tool] of order.entries()) {
    assert.equal(typeof numbers[index], "number", `the route prompt has a step that calls ${tool}`)
    if (index > 0) {
      assert.ok(
        numbers[index] > numbers[index - 1],
        `${tool} (step ${numbers[index]}) comes after ${order[index - 1]} (step ${numbers[index - 1]})`,
      )
    }
  }
  // The scripted parent follows that order; remember is the route's to place (steps 1 and 10).
  const scripted = DEMO_PLAN_TOOLS.filter((tool) => tool !== "remember").filter(
    (tool, index, all) => tool !== all[index - 1],
  )
  assert.deepEqual(scripted, order)
  assert.ok(steps.some((step) => /`remember`|`remember\(/.test(step.text)))

  const subagentsRoot = join(TEMPLATE_ROOT, "server/src/app/navlog/subagents")
  const subagents = (await readdir(subagentsRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const listed = (source, key) => {
    const match = new RegExp(`\\b${key}: \\[([^\\]]*)\\]`).exec(source)
    assert.ok(match, `the subagent lists ${key}`)
    return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  }
  for (const now of SCENARIO_NOWS) {
    const scenario = demoScenario({ now })
    const groups = fixtureGroups(scenario.fixtures)
    const tasks = groups
      .get(DEMO_PROMPT)
      .flatMap((fixture) => fixture.response.toolCalls ?? [])
      .filter((call) => call.name === "task")
      .map((call) => call.arguments)
    assert.deepEqual(tasks.map((task) => task.subagent).sort(), subagents)
    for (const task of tasks) {
      const source = await readFile(join(subagentsRoot, task.subagent, "index.ts"), "utf8")
      const allow = listed(source, "allow")
      const deny = listed(source, "deny")
      const called = groups.get(task.input).flatMap((fixture) => fixture.response.toolCalls ?? [])
      assert.ok(called.length > 0)
      for (const call of called) {
        assert.ok(allow.includes(call.name), `${task.subagent} allows ${call.name}`)
        assert.ok(!deny.includes(call.name), `${task.subagent} does not deny ${call.name}`)
      }
    }
  }
})

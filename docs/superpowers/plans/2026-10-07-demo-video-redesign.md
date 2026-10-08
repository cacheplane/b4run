# Demo Video Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the README product-loop video with a 15-second Paper Relay video recorded from one "director" page that holds the real Workbench in an iframe, and ship one flagship clip instead of four.

**Architecture:**
- The capture opens a director page (rendered by a new `director.mjs`) at the Workbench's own origin through a Playwright route. The real Workbench therefore loads same-origin in an iframe.
- The director page plays four beats (author, prove, run, close) with CSS motion, while Playwright drives the real Workbench inside the frame through a small `Frame` proxy, so the existing Workbench helpers keep working.
- ffmpeg only trims the recording to the beats and encodes the MP4, WebM, GIF and poster. The checker, uploader and catalog shrink from four clips to one.

**Tech Stack:**
- Node 24 ESM `.mjs`, with tests on `node:test` (one file, `docs/brand/demo/demo.test.mjs`).
- Playwright 1.62.1 (Chromium), ffmpeg/ffprobe 8.1.1, and sharp for the WebP poster.
- Biome lint via `--config-path packages/config-biome/biome.json`.

**Spec:** `docs/superpowers/specs/2026-10-07-demo-video-redesign-design.md`

---

## Ground rules for every task

- Work on branch `blove/navlog-demo-clips`, from the repo root, on Node 24 (`node --version` must print `v24.x`).
- `packages/testing/dist` must exist, because the demo modules import it. If `pnpm test:brand-demo` fails with `ERR_MODULE_NOT_FOUND` for `packages/testing/dist`, run `pnpm build` once.
- The test command is `pnpm test:brand-demo`, which runs `node --test docs/brand/demo/demo.test.mjs`. The suite currently prints `ℹ pass 124` and `ℹ fail 0`; the counts change per task as noted.
- The lint gate for these files is `pnpm exec biome lint --config-path packages/config-biome/biome.json docs/brand/demo`. Never run bare `biome check --write`. These files are not format-checked; keep the existing style of each file (`encode.mjs` uses tabs and semicolons; the others use two spaces and no semicolons).
- Commit after every task. End every commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Deviation from the spec (approved by the plan, record it in Task 7)

Spec §4.2 says the director page is served from its own `127.0.0.1` port via `startHttpService`. This plan instead serves it with `page.route()` at `<workbench origin>/__b4_demo_director/`. The browser intercepts that path, so the Workbench server never sees the request. The director page and the iframed Workbench are then **same-origin**, which is strictly stronger than same-site: storage is never partitioned, and the director can read the frame if needed. It also needs no extra process. Task 7 updates the spec sentence.

## File map

| File | Change |
|---|---|
| `docs/brand/demo/check-media.mjs` | One `product-loop` contract (12–18 s), one caption, single-key catalog. |
| `docs/brand/demo/upload.mjs` | One clip in `CLIPS`; transcript anchor `#product-loop`. |
| `docs/brand/demo/encode.mjs` | Remove act labels and segment timelines; add `createTrimPlan` and `buildGifFilter`; encode one clip. |
| `docs/brand/demo/director.mjs` | **New.** Renders the director page; exports `BEATS`, `HEADLINES`, `DIRECTOR_TIMING`, `RUN_FOCUS`, `DIRECTOR_FONTS`, `wordmarkSvg`, `renderDirector`. |
| `docs/brand/demo/stage.mjs` | **Delete.** |
| `docs/brand/demo/capture.mjs` | `frameSurface`; new browser session API (`openDirector`, `prepareWorkbench`, `play`, `focus`, `runScenario`, `reloadAndRestore`, `close`); beat sequence in `captureDemo`. |
| `docs/brand/demo/demo.test.mjs` | Tests follow each task. |
| `docs/brand/demo/transcript.md`, `docs/brand/recording-guide.md`, `docs/brand/demo/evidence-matrix.md` | Copy. |
| `README.md`, `scripts/lib/readme-contracts.mjs`, `scripts/readme-contracts.test.mjs` | The GIF alt text. |
| `apps/web/app/lib/demo-media.json` | Single `productLoop` entry. |
| `apps/web/public/demo/{author,test,run}-poster.webp` | **Delete.** |

---

### Task 1: One-clip media contract (`check-media.mjs`)

**Files:**
- Modify: `docs/brand/demo/check-media.mjs:14-38` and `:424-438`
- Test: `docs/brand/demo/demo.test.mjs` (media contract tests at about lines 113–300 and catalog tests at about 4465–4560)

- [ ] **Step 1: Update the tests first**

In `docs/brand/demo/demo.test.mjs`:

1. In `validMediaFixtures()`, change both `duration: contract.name === "product-loop" ? 24 : 10` occurrences to `duration: 15`. Change the GIF fixture's `duration: 24` to `duration: 15`.
2. In `validateMedia()`, replace the `captions` object with:
   ```js
    captions: {
      "product-loop":
        "Write an agent route, test it offline, run it in the Workbench, and restore the same thread after a browser reload.",
    },
   ```
3. Rename the test `"media contracts accept the exact flagship and derivative formats"` to `"media contracts accept the exact flagship formats"`.
4. In `"media contracts accept GIF centisecond timing reported as 30 fps"`, change `duration: 24.03` to `duration: 15.03`, and replace its `captions` with `{ "product-loop": "Write, test, run, reload, and restore." }`.
5. In `"media contracts reject wrong dimensions and aspect ratio"`, change the override path `"docs/brand/demo/artifacts/output/author.mp4"` to `"docs/brand/demo/artifacts/output/product-loop.mp4"` and its `duration: 10` to `duration: 15`.
6. Replace the whole test `"media contracts reject durations outside each clip window"` with:
   ```js
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
   ```
7. In `"media contracts reject files over their byte budgets"`, change the path `"docs/brand/demo/artifacts/output/test.mp4"` to `"docs/brand/demo/artifacts/output/product-loop.mp4"`, change both durations (`10` and `24`) to `15`, and change the first assertion's regex to `/product-loop\.mp4.*2,000,000 bytes/`.
8. In `"media contracts require every poster and the transcript"`, change `files.delete("apps/web/public/demo/run-poster.webp")` to `files.delete("apps/web/public/demo/product-loop-poster.webp")`, and the assertion regex `/run.*poster/` to `/product-loop.*poster/`.
9. Read every remaining test between `"media contracts require 1440x810 WebP posters"` and `"media contracts require H.264 MP4, VP9 WebM, and 30 fps"` (about lines 261–356):
   - change any path naming `author`, `test` or `run` media to the `product-loop` equivalent (`.../output/product-loop.mp4`, `.../output/product-loop.webm`, `apps/web/public/demo/product-loop-poster.webp`);
   - change any `duration: 10` or `24` to `15`;
   - replace any multi-clip `captions` object with `{ "product-loop": "<the same sentence the test used for product-loop>" }`.
10. In `"media manifest layout rejects stale identity and cross-run paths"` (about line 357), the override `clips: { ..., mp4: "/tmp/other-run/run.mp4" }` targets the `run` clip. Change that clip key to `"product-loop"` and the path to `"/tmp/other-run/product-loop.mp4"`.
11. In `"catalog entries contain exactly the six required fields"` (about line 4465), change `assert.deepEqual(Object.keys(catalog), ["productLoop", "author", "test", "run"])` to `assert.deepEqual(Object.keys(catalog), ["productLoop"])`.
12. In `"catalog media URLs require exact stable paths with no authority or URL suffix drift"` (about lines 4497–4580):
    - in every candidate URL, change `/demo/run.mp4` to `/demo/product-loop.mp4`;
    - change `candidate.run.mp4 = url` to `candidate.productLoop.mp4 = url`.
13. In `"remote checker fails for a missing URL, non-200 status, or wrong content type"` (about line 4622):
    - change `value.test.webm = ""` to `value.productLoop.webm = ""`;
    - change `url.endsWith("author.mp4")` to `url.endsWith("product-loop.mp4")`;
    - change `url.endsWith("run.webm")` to `url.endsWith("product-loop.webm")`.

    If the test asserts on how many failures a mutation produces, keep the assertion and fix the expected count by reading the checker's output in Step 4. The new catalog has one entry with two URLs.
14. In `"remote checker loads the checked-in catalog and HEAD-verifies every URL without a token"`, change `assert.equal(calls.length, 8)` to `assert.equal(calls.length, 2)`.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^ℹ (pass|fail)|^not ok' | head -30`
Expected: failures, including `media contracts reject durations outside the flagship window` and the catalog-keys test. Contract and upload tests that iterate the old four clips also fail until the source changes in Steps 3 and 5 of this task and in Task 2.

- [ ] **Step 3: Change the contract tables**

In `docs/brand/demo/check-media.mjs`, replace lines 14–38 (`MEDIA_CAPTIONS` and `MEDIA_CONTRACTS`) with:

```js
export const MEDIA_CAPTIONS = Object.freeze({
  "product-loop":
    "Write the navlog agent's route, test it offline with npm test, run it in the B4.run Workbench, then reload the browser and see the same thread restored.",
})

export const MEDIA_CONTRACTS = Object.freeze(
  [{ name: "product-loop", minimumDuration: 12, maximumDuration: 18 }].map((contract) =>
    Object.freeze({
      ...contract,
      mp4: `docs/brand/demo/artifacts/output/${contract.name}.mp4`,
      webm: `docs/brand/demo/artifacts/output/${contract.name}.webm`,
      poster: `apps/web/public/demo/${contract.name}-poster.webp`,
      gif: "docs/brand/product-loop.gif",
    }),
  ),
)
```

Replace `DEMO_MEDIA_KEYS` and `DEMO_MEDIA_NAMES` (about lines 424–438) with:

```js
const DEMO_MEDIA_KEYS = Object.freeze(["productLoop"])
```

and

```js
const DEMO_MEDIA_NAMES = Object.freeze({
  productLoop: "product-loop",
})
```

Leave `DEMO_MEDIA_FIELDS` unchanged.

- [ ] **Step 4: Run the contract and catalog tests**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^not ok' | head -40`

Expected: no failing test whose name starts with `media contracts`, `media manifest layout`, `catalog`, or `remote checker`. Upload-plan tests may still fail; Task 2 fixes them. If a `media contracts`, `catalog` or `remote checker` test still fails, read its assertion and apply the substitutions from Step 1 that it still needs:
- `author`, `test` or `run` media paths become `product-loop` paths;
- durations become `15`;
- catalog keys become `productLoop`;
- URL counts become `2`.

- [ ] **Step 5: Shrink the checked-in catalog**

Replace `apps/web/app/lib/demo-media.json` with the single entry. Keep the current URLs; the upload in Task 8 rewrites them.

```json
{
  "productLoop": {
    "mp4": "https://9rq8ezyghevy0wop.public.blob.vercel-storage.com/b4/demo/product-loop.mp4",
    "webm": "https://9rq8ezyghevy0wop.public.blob.vercel-storage.com/b4/demo/product-loop.webm",
    "poster": "/demo/product-loop-poster.webp",
    "caption": "Write the navlog agent's route, test it offline with npm test, run it in the B4.run Workbench, then reload the browser and see the same thread restored.",
    "ariaLabel": "B4.run product loop: write the agent, test it offline, run it, reload, and restore",
    "transcript": "https://github.com/cacheplane/b4run/blob/main/docs/brand/demo/transcript.md#product-loop"
  }
}
```

- [ ] **Step 6: Commit**

```bash
git add docs/brand/demo/check-media.mjs docs/brand/demo/demo.test.mjs apps/web/app/lib/demo-media.json
git commit -m "feat(demo): one 12-18 s flagship clip in the media contract

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One-clip uploader (`upload.mjs`)

**Files:**
- Modify: `docs/brand/demo/upload.mjs:33-58`
- Test: `docs/brand/demo/demo.test.mjs` (upload tests at about lines 3281–4460)

- [ ] **Step 1: Update the tests**

1. Replace `EXPECTED_UPLOAD_PATHS` (about line 3281) with:
   ```js
   const EXPECTED_UPLOAD_PATHS = ["b4/demo/product-loop.mp4", "b4/demo/product-loop.webm"]
   ```
2. In `"upload plan binds the exact suffix-free paths to the validated run manifest"`, the override `run: { ...manifest.clips.run, mp4: "/tmp/unbound/run.mp4" }` becomes `"product-loop": { ...manifest.clips["product-loop"], mp4: "/tmp/unbound/product-loop.mp4" }`.
3. In `"same-size video mutation fails the validation-time hash before any put"`, change `manifest.clips.author.mp4` to `manifest.clips["product-loop"].mp4`.
4. In `"non-timeout HEAD failure withholds the catalog and reports safe post-mutation convergence"`, change `url.endsWith("run.webm")` to `url.endsWith("product-loop.webm")`.
5. Search the upload tests for the literal counts of eight files or puts, and change each to the two-file equivalent. Run `grep -n -E '\b8\b|eight|\.length, [0-9]' docs/brand/demo/demo.test.mjs`, and for every hit inside the upload tests (lines about 3353–4460):
   - change an expected `8` puts or HEADs to `2`;
   - change a "prior completed" list of seven paths to `["b4/demo/product-loop.mp4"]`, or to whatever prefix of `EXPECTED_UPLOAD_PATHS` the test's failure index implies.

   The failure-index tests (`"partial provider failure ..."`, `"timeout after prior puts ..."`, `"returned URL mismatch ..."`) choose an index into the plan. Any index ≥ 2 must become `1`, and the expected prior/current/pending sets must be recomputed from `EXPECTED_UPLOAD_PATHS` at the new index.

- [ ] **Step 2: Run the upload tests to see them fail**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^not ok' | head -40`
Expected: upload and catalog-building tests fail on `author`, `test` or `run` clips the manifest no longer has.

- [ ] **Step 3: Change the clip table**

In `docs/brand/demo/upload.mjs`, replace `CLIPS` (lines 33–58) with:

```js
const CLIPS = Object.freeze([
  Object.freeze({
    name: "product-loop",
    catalogKey: "productLoop",
    ariaLabel: "B4.run product loop: write the agent, test it offline, run it, reload, and restore",
    transcript: `${TRANSCRIPT_BASE_URL}#product-loop`,
  }),
])
```

- [ ] **Step 4: Run all tests**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^ℹ (pass|fail)|^not ok'`
Expected: `ℹ fail 0`. The encode tests (`encoding plan ...`, `encoding failures never mix ...`) may still fail, because `encodeCaptureArtifacts` still writes four clips; Task 3 replaces them. Every other test must pass. If an upload test still fails, it holds a hard-coded count or index from the four-clip plan; fix it as in Step 1.5.

- [ ] **Step 5: Commit**

```bash
git add docs/brand/demo/upload.mjs docs/brand/demo/demo.test.mjs
git commit -m "feat(demo): upload and catalog the flagship clip only

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Trim-only encoder (`encode.mjs`)

**Files:**
- Modify: `docs/brand/demo/encode.mjs` (remove lines 25–46 constants, `requireScene`/`segment`/`createTimelinePlan` 47–175, `buildTimelineFilter` 374–423, the label helpers 425–487; rewrite `encodeVideo`, `encodeGif`, `encodeCaptureArtifacts`)
- Test: `docs/brand/demo/demo.test.mjs`

- [ ] **Step 1: Replace the encoder tests**

In `docs/brand/demo/demo.test.mjs`:

1. In the `./encode.mjs` import, replace `buildTimelineFilter, createTimelinePlan,` with `buildGifFilter, createTrimPlan,`.
2. Delete the tests `"encoding plan builds the four honest capture timelines"` and `"encoding refuses to truncate an overlong Workbench restoration endpoint"`, and add in their place:

```js
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

test("GIF filter keeps 1440x810 at 30 fps with a diff palette and no overlays", () => {
  assert.equal(
    buildGifFilter(),
    "[0:v]fps=30,scale=1440:810:flags=lanczos,split[gifbase][paletteinput];[paletteinput]palettegen=max_colors=28:stats_mode=diff[palette];[gifbase][palette]paletteuse=dither=none:diff_mode=rectangle[outv]",
  )
})
```

3. In `"poster encoding extracts a real frame before WebP conversion"`, change every `author-poster` to `product-loop-poster`.
4. Replace `"video and GIF encoders recheck abort before rename and clean their temps"` with:

```js
test("video and GIF encoders trim the recording, recheck abort before rename, and clean their temps", async () => {
  const trim = { start: 2, duration: 14.5, posterTime: 2.75 }
  for (const [name, encode, destination, expectedTemporaryPath] of [
    ["video", encodeVideo, "/run/output/product-loop.mp4", "/run/output/product-loop.mp4.tmp.mp4"],
    [
      "GIF",
      encodeGif,
      "/run/publication/product-loop.gif",
      "/run/publication/product-loop.gif.tmp.gif",
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
        async rename(...args) {
          calls.push(["rename", ...args])
        },
        async remove(path) {
          calls.push(["remove", path])
        },
      }),
      new RegExp(`abort ${name}`),
    )
    assert.deepEqual(calls, [["remove", expectedTemporaryPath]])
    const ss = ffmpegArgs.indexOf("-ss")
    assert.deepEqual(ffmpegArgs.slice(ss, ss + 6), ["-ss", "2.000", "-t", "14.500", "-i", "/run/raw.webm"])
    assert.equal(ffmpegArgs.some((arg) => /overlay|tpad/.test(arg)), false)
  }
})
```

5. Find `"encoding failures never mix fixed assets or the latest pointer across runs"` (about line 831) and every other test that calls `encodeCaptureArtifacts`. In each one:
   - the summary's `videoTimeline.scenes` becomes `BEAT_SCENES`;
   - fake `encodeVideo`/`encodeGif` dependencies must accept `{ source, destination, trim, format, signal }` (no `plan`, no `labelAssets`);
   - any assertion listing per-clip phases (`afterPhase("video", { name })` for four names, four posters) expects one name, `"product-loop"`;
   - any expected publication entry list contains `manifest`, `poster:product-loop`, `gif`, `pointer`, in that order.

   Run `grep -n 'encodeCaptureArtifacts(' docs/brand/demo/demo.test.mjs` to find them all.

- [ ] **Step 2: Run the tests to see them fail**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^not ok' | head`
Expected: `SyntaxError` or a failure because `buildGifFilter` and `createTrimPlan` are not exported.

- [ ] **Step 3: Rewrite the encoder**

In `docs/brand/demo/encode.mjs`:

1. Delete: `SCENE_END_GUARD_MS`, `ACT_LABEL_WIDTH`, `ACT_LABEL_HEIGHT`, `ACT_LABEL_GLYPHS`, `ACT_LABELS`, `requireScene`, `segment`, `createTimelinePlan`, `buildTimelineFilter`, `labelGlyphPath`, `labelSvg`, `createActLabelAssets`, `buildLabelInputs`.
2. Add after the `OUTPUT_FPS` constant:

```js
const BEAT_ORDER = Object.freeze(["author", "prove", "run", "close"]);

function requireBeat(scenes, name) {
	const beat = scenes?.[name];
	if (
		beat === undefined ||
		!Number.isFinite(beat.startMs) ||
		!Number.isFinite(beat.endMs) ||
		beat.startMs < 0 ||
		beat.endMs <= beat.startMs
	) {
		throw new Error(`capture summary has an invalid ${name} beat`);
	}
	return beat;
}

/**
 * The flagship is the recording from the start of the author beat to the end
 * of the close beat: everything before it (loading the director page and the
 * Workbench) is trimmed off, and nothing inside it is padded or reordered.
 * The poster is the author beat's last moment, once its headline has docked
 * and the camera has settled on the route.
 */
export function createTrimPlan(summary) {
	if (summary?.videoTimeline?.unit !== "milliseconds") {
		throw new Error("capture summary timeline must use milliseconds");
	}
	const scenes = summary.videoTimeline.scenes;
	const beats = BEAT_ORDER.map((name) => requireBeat(scenes, name));
	for (let index = 1; index < beats.length; index++) {
		if (beats[index].startMs < beats[index - 1].endMs) {
			throw new Error(
				`capture summary ${BEAT_ORDER[index]} beat starts before ${BEAT_ORDER[index - 1]} ends`,
			);
		}
	}
	const [author, , , close] = beats;
	const start = author.startMs / 1_000;
	return {
		start,
		duration: (close.endMs - author.startMs) / 1_000,
		posterTime: Math.max(0, (author.endMs - author.startMs) / 1_000 - 0.25),
	};
}

function trimArguments(trim) {
	return ["-ss", trim.start.toFixed(3), "-t", trim.duration.toFixed(3)];
}

const SCALE_FILTER = `fps=${OUTPUT_FPS},scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:flags=lanczos`;

export function buildGifFilter() {
	return `[0:v]${SCALE_FILTER},split[gifbase][paletteinput];[paletteinput]palettegen=max_colors=28:stats_mode=diff[palette];[gifbase][palette]paletteuse=dither=none:diff_mode=rectangle[outv]`;
}
```

3. Replace `encodeVideo` with:

```js
export async function encodeVideo({
	source,
	destination,
	trim,
	format,
	signal,
	run = runEncoderCommand,
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
}) {
	const temporaryPath = `${destination}.tmp.${format}`;
	let published = false;
	const codecArguments =
		format === "mp4"
			? [
					"-c:v",
					"libx264",
					"-preset",
					"slow",
					"-crf",
					"32",
					"-maxrate",
					"420k",
					"-bufsize",
					"840k",
					"-pix_fmt",
					"yuv420p",
					"-movflags",
					"+faststart",
				]
			: [
					"-c:v",
					"libvpx-vp9",
					"-b:v",
					"0",
					"-crf",
					"38",
					"-deadline",
					"good",
					"-cpu-used",
					"2",
					"-row-mt",
					"1",
				];
	try {
		await run(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				...trimArguments(trim),
				"-i",
				source,
				"-vf",
				SCALE_FILTER,
				"-an",
				...codecArguments,
				temporaryPath,
			],
			{ signal },
		);
		signal?.throwIfAborted();
		await rename(temporaryPath, destination);
		published = true;
	} finally {
		if (!published) await remove(temporaryPath);
	}
}
```

4. Replace `encodeGif` with:

```js
export async function encodeGif({
	source,
	destination,
	trim,
	signal,
	run = runEncoderCommand,
	rename = nodeRename,
	remove = (path) => nodeRm(path, { force: true }),
}) {
	const temporaryPath = `${destination}.tmp.gif`;
	let published = false;
	try {
		await run(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				...trimArguments(trim),
				"-i",
				source,
				"-filter_complex",
				buildGifFilter(),
				"-map",
				"[outv]",
				"-an",
				"-gifflags",
				"+transdiff",
				temporaryPath,
			],
			{ signal },
		);
		signal?.throwIfAborted();
		await rename(temporaryPath, destination);
		published = true;
	} finally {
		if (!published) await remove(temporaryPath);
	}
}
```

5. In `encodeCaptureArtifacts`, replace everything from `const plans = createTimelinePlan(summary);` through the end of the `const manifest = { ... };` object with:

```js
	const trim = createTrimPlan(summary);
	const outputDir = join(artifactsDir, "output");
	const publicationDir = join(artifactsDir, "publication");
	const posterDir = join(repoRoot, "apps/web/public/demo");
	await Promise.all([
		nodeMkdir(outputDir, { recursive: true }),
		nodeMkdir(publicationDir, { recursive: true }),
		nodeMkdir(posterDir, { recursive: true }),
	]);

	const name = "product-loop";
	const mp4 = join(outputDir, `${name}.mp4`);
	const webm = join(outputDir, `${name}.webm`);
	const poster = join(publicationDir, `${name}-poster.webp`);
	await encodeVideoImplementation({ source, destination: mp4, trim, format: "mp4", signal });
	await encodeVideoImplementation({ source, destination: webm, trim, format: "webm", signal });
	await afterPhase("video", { name });
	await encodePosterImplementation({ source: mp4, destination: poster, time: trim.posterTime, signal });
	await afterPhase("poster", { name });
	const clips = { [name]: { mp4, webm, poster, duration: trim.duration } };
	const gif = join(publicationDir, "product-loop.gif");
	await encodeGifImplementation({ source, destination: gif, trim, signal });
	await afterPhase("gif");
	signal?.throwIfAborted();

	const manifestPath = join(artifactsDir, "media-manifest.json");
	const assetHashes = {
		gif: await hashFile(gif),
		posters: { [name]: await hashFile(poster) },
	};
	const manifest = {
		schemaVersion: 1,
		runId: summary.runId,
		captureSummaryPath: summaryPath,
		sourceRecording: source,
		outputRoot: outputDir,
		clips,
		gif,
		assetHashes,
		captions: MEDIA_CAPTIONS,
	};
```

Leave the rest of `encodeCaptureArtifacts` (validation, staging, `publishFixedAssets`) as it is: its `Object.entries(clips)` now yields the one poster. `sharp` stays imported for `encodePoster`.

- [ ] **Step 4: Run all tests and lint**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^ℹ (pass|fail)|^not ok'`
Expected: `ℹ fail 0`.
Run: `pnpm exec biome lint --config-path packages/config-biome/biome.json docs/brand/demo`
Expected: `No fixes applied` and no errors. Unused-import warnings mean a deleted helper's import (for example `copyFile` or `access`) is still used; keep the imports that `publishFixedAssets` and `pathExists` use.

- [ ] **Step 5: Commit**

```bash
git add docs/brand/demo/encode.mjs docs/brand/demo/demo.test.mjs
git commit -m "feat(demo): encode by trimming the recorded beats, without labels or holds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The director page (`director.mjs`)

**Files:**
- Create: `docs/brand/demo/director.mjs`
- Test: `docs/brand/demo/demo.test.mjs`

The page runs inside Chromium during capture. Its runtime script is a string in the HTML, so unit tests cover what can be asserted without a browser: inputs, escaping, the focal marks, the timing table, fonts, the iframe, and the absence of the old chrome. Task 8's real capture verifies the motion.

- [ ] **Step 1: Write the failing tests**

Add to the imports in `demo.test.mjs`:

```js
import {
  BEATS,
  DIRECTOR_FONTS,
  DIRECTOR_TIMING,
  HEADLINES,
  RUN_FOCUS,
  renderDirector,
  wordmarkSvg,
} from "./director.mjs"
```

Add the tests (place them where the `stage` tests are now, about line 974):

```js
const DIRECTOR_INPUT = {
  routeSource: [
    'import { agent } from "@b4run/sdk"',
    "export default agent({",
    '  model: "gpt-5-mini",',
    '  description: "A VFR flight planner for a Cessna 172N <C172N>",',
    "})",
  ].join("\n"),
  toolSource: "export default async (input) => computeNavlog(input)",
  testLog: [
    "✓ test/navlog.test.ts > splits the first leg into a climb segment and a cruise segment <time>",
    "Tests  92 passed (92)",
  ].join("\n"),
  wordmark: '<svg viewBox="-5 -5 522 115"><circle r="17"/></svg>',
}

test("director exports the four beats, their headlines, and one timing table", () => {
  assert.deepEqual(BEATS, ["author", "prove", "run", "close"])
  assert.deepEqual(HEADLINES, {
    author: "Write the agent.",
    prove: "Test it offline.",
    run: "Reload. Still there.",
    close: "Ridiculous speed. Readable code.",
  })
  for (const value of Object.values(DIRECTOR_TIMING)) {
    assert.equal(Number.isInteger(value) && value > 0, true)
  }
  assert.deepEqual(Object.keys(RUN_FOCUS), ["rest", "answer", "sheet"])
  assert.equal(Object.isFrozen(DIRECTOR_TIMING) && Object.isFrozen(RUN_FOCUS), true)
})

test("director page renders the real sources and log, escaped, with one focal mark each", () => {
  const html = renderDirector(DIRECTOR_INPUT)
  assert.match(html, /&lt;C172N&gt;/)
  assert.doesNotMatch(html, /<C172N>/)
  assert.match(html, /computeNavlog\(input\)/)
  assert.match(html, /splits the first leg into a climb segment and a cruise segment/)
  assert.equal(html.match(/class="focus"/g)?.length, 2)
  assert.match(html, /<span class="focus">  description: /)
  assert.match(html, /<span class="focus">Tests  92 passed \(92\)<\/span>/)
})

test("director page holds the Workbench iframe, the wordmark, and the brand tokens, with no header or act chip", () => {
  const html = renderDirector(DIRECTOR_INPUT)
  assert.match(html, /<iframe name="workbench" src="about:blank"/)
  assert.match(html, /<svg viewBox="-5 -5 522 115"><circle r="17"\/><\/svg>/)
  for (const token of ["#f5f4f0", "#111111", "#17181b", "#b4ce37", "#75796a"]) {
    assert.match(html, new RegExp(token, "i"))
  }
  for (const font of Object.keys(DIRECTOR_FONTS)) assert.match(html, new RegExp(`fonts/${font.replace(".", "\\.")}`))
  assert.match(html, /npm create b4-app@latest my-agent/)
  assert.match(html, /window\.director = /)
  assert.doesNotMatch(html, /\b(AUTHOR|PROVE)\b/)
  assert.doesNotMatch(html, /border-radius:\s*(?!50%)\d/)
  assert.doesNotMatch(html, /box-shadow:\s*0 \d/)
})

test("director page refuses sources without their focal line", () => {
  assert.throws(
    () => renderDirector({ ...DIRECTOR_INPUT, routeSource: "export default agent({})" }),
    /route source has no description line/,
  )
  assert.throws(
    () => renderDirector({ ...DIRECTOR_INPUT, testLog: "nothing passed here" }),
    /test log has no passing summary/,
  )
})

test("wordmark comes from the ink SVG master without its title or description", () => {
  const svg = wordmarkSvg()
  assert.match(svg, /^<svg /)
  assert.match(svg, /viewBox="-5 -5 522 115"/)
  assert.doesNotMatch(svg, /<title>|<desc>/)
  assert.match(svg, /fill="#111111"/)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test:brand-demo 2>&1 | head -5`
Expected: `ERR_MODULE_NOT_FOUND` for `./director.mjs`.

- [ ] **Step 3: Write `docs/brand/demo/director.mjs`**

```js
import { readFileSync } from "node:fs"

/** The four beats, in recording order. */
export const BEATS = Object.freeze(["author", "prove", "run", "close"])

export const HEADLINES = Object.freeze({
  author: "Write the agent.",
  prove: "Test it offline.",
  run: "Reload. Still there.",
  close: "Ridiculous speed. Readable code.",
})

/** Every duration the director page waits on, in milliseconds. */
export const DIRECTOR_TIMING = Object.freeze({
  wordStaggerMs: 45,
  wordRevealMs: 380,
  readMs: 800,
  dockMs: 420,
  swapMs: 550,
  cameraMs: 700,
  holdMs: 1200,
  closeSweepMs: 750,
  closeHoldMs: 1800,
})

/**
 * Camera presets for the Run beat, over the Workbench as the frame shows it:
 * the chat dock's answer on the left, the navlog sheet's numbers along the
 * bottom. The Workbench lays out at a fixed 1440x810 inside the frame, so
 * fixed presets are enough.
 */
export const RUN_FOCUS = Object.freeze({
  rest: Object.freeze({ scale: 1, origin: "50% 50%" }),
  answer: Object.freeze({ scale: 1.6, origin: "8% 62%" }),
  sheet: Object.freeze({ scale: 1.45, origin: "70% 94%" }),
})

/** Font files the page loads, served by the capture from the brand kit. */
export const DIRECTOR_FONTS = Object.freeze({
  "Inter-400.ttf": "apps/web/public/brand/identity/fonts/Inter-400.ttf",
  "Inter-600.ttf": "apps/web/public/brand/identity/fonts/Inter-600.ttf",
  "JetBrainsMono-400.ttf": "apps/web/public/brand/identity/fonts/JetBrainsMono-400.ttf",
})

const WORDMARK_MASTER = new URL(
  "../../../apps/web/public/brand/identity/logos/wordmark-ink.svg",
  import.meta.url,
)

/** The ink wordmark master, inline-ready: no title or description. */
export function wordmarkSvg(read = readFileSync) {
  return read(WORDMARK_MASTER, "utf8")
    .replace(/<\?xml[^>]*>/u, "")
    .replace(/<title>[\s\S]*?<\/title>|<desc>[\s\S]*?<\/desc>/gu, "")
    .replace(/\n\s*\n/gu, "\n")
    .trim()
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}

function requireString(value, name) {
  if (typeof value !== "string" || value === "") throw new TypeError(`${name} must be a non-empty string`)
}

/** Escaped lines, with the first line matching `focal` wrapped as the beat's focal mark. */
function markedCode(source, focal, missing) {
  const lines = source.split("\n")
  const index = lines.findIndex((line) => focal.test(line))
  if (index === -1) throw new Error(missing)
  return lines
    .map((line, at) => (at === index ? `<span class="focus">${escapeHtml(line)}</span>` : escapeHtml(line)))
    .join("\n")
}

const STYLE = `
@font-face { font-family: "Inter"; font-weight: 400; src: url("fonts/Inter-400.ttf") format("truetype"); }
@font-face { font-family: "Inter"; font-weight: 600; src: url("fonts/Inter-600.ttf") format("truetype"); }
@font-face { font-family: "JetBrains Mono"; font-weight: 400; src: url("fonts/JetBrainsMono-400.ttf") format("truetype"); }
:root {
  --paper: #f5f4f0; --ink: #111111; --ink-muted: #595b53; --rule-strong: #75796a;
  --panel: #17181b; --panel-strip: #202226; --panel-ink: #f5f4f0; --panel-dim: #a3aa99;
  --relay: #b4ce37; --relay-wash: rgb(180 206 55 / 0.16);
  --ease-out: cubic-bezier(.16, 1, .3, 1); --ease-in-out: cubic-bezier(.65, 0, .35, 1);
}
* { box-sizing: border-box; margin: 0; }
html, body { width: 1440px; height: 810px; overflow: hidden; background: var(--paper); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
.stage { position: relative; width: 1440px; height: 810px; overflow: hidden; }
.head { position: absolute; left: 163px; top: 44px; font-weight: 600; font-size: 88px; line-height: 1.06; letter-spacing: -0.055em; transform-origin: 0 0; transform: translateY(300px); transition: transform var(--dock) var(--ease-out); white-space: nowrap; }
.docked .head { transform: scale(0.42); }
.roll { overflow: hidden; height: 1.06em; }
.lines { transition: transform var(--swap) var(--ease-in-out); }
.rolling .lines { transform: translateY(-1.06em); }
.instant, .instant * { transition: none !important; }
.w { display: inline-block; overflow: hidden; vertical-align: bottom; padding-bottom: 0.06em; margin-right: 0.22em; }
.w > span { display: inline-block; transform: translateY(105%); transition: transform var(--reveal) var(--ease-out); }
.revealed .head .w > span, .close-revealed .close .w > span { transform: none; }
.frame { position: absolute; left: 163px; top: 128px; width: 1113px; height: 626px; overflow: hidden; outline: 1px solid var(--rule-strong); background: var(--panel); transform: translateY(820px); transition: transform var(--dock) var(--ease-out); }
.docked .frame, .prep .frame { transform: none; }
.camera { position: absolute; inset: 0; transition: transform var(--camera) var(--ease-in-out); }
.layer { position: absolute; inset: 0; opacity: 0; filter: blur(6px); transform: scale(1.03); transition: opacity var(--swap) var(--ease-in-out), filter var(--swap) var(--ease-in-out), transform var(--swap) var(--ease-in-out); }
.layer.on { opacity: 1; filter: none; transform: none; }
.strip { height: 40px; padding: 11px 24px; background: var(--panel-strip); color: var(--panel-dim); font: 400 14px/18px "JetBrains Mono", ui-monospace, monospace; }
pre { padding: 24px; color: var(--panel-ink); font: 400 17px/1.65 "JetBrains Mono", ui-monospace, monospace; white-space: pre; overflow: hidden; }
.author { display: grid; grid-template-rows: 1fr 0.62fr; }
.author > div + div { border-top: 1px solid #4d5148; }
.focus { position: relative; }
.focus::before { content: ""; position: absolute; left: -24px; right: -2000px; top: -2px; bottom: -2px; background: var(--relay-wash); box-shadow: inset 3px 0 0 var(--relay); transform: scaleX(0); transform-origin: 0 50%; transition: transform var(--swap) var(--ease-out); z-index: -1; }
.marked .focus::before { transform: none; }
.run { background: var(--paper); }
.run iframe { position: absolute; left: 0; top: 0; width: 1440px; height: 810px; border: 0; transform: scale(0.772917); transform-origin: 0 0; }
.close { position: absolute; inset: 0; z-index: 4; display: grid; place-content: center; justify-items: center; gap: 36px; background: var(--paper); clip-path: inset(0 0 0 100%); transition: clip-path var(--sweep) var(--ease-in-out); }
.closing .close { clip-path: inset(0 0 0 0); }
.close svg { width: 300px; height: auto; }
.close .tagline { font-weight: 600; font-size: 72px; line-height: 1.06; letter-spacing: -0.055em; white-space: nowrap; }
.close .command { padding: 18px 26px; background: var(--panel); color: var(--panel-ink); font: 400 20px/1 "JetBrains Mono", ui-monospace, monospace; }
.sweep { position: absolute; top: 0; bottom: 0; left: 1440px; width: 1px; z-index: 5; background: var(--rule-strong); transition: left var(--sweep) var(--ease-in-out); }
.sweep::after { content: ""; position: absolute; left: -11px; top: 394px; width: 22px; height: 22px; border-radius: 50%; background: var(--relay); }
.closing .sweep { left: 0; }
.swept .sweep { visibility: hidden; }
`

const RUNTIME = `
(() => {
  const T = TIMING, H = HEADLINES_JSON, FOCUS = FOCUS_JSON
  const stage = document.querySelector(".stage")
  const roll = stage.querySelector(".roll")
  const lines = stage.querySelector(".lines")
  const camera = stage.querySelector(".camera")
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  for (const [name, value] of [["--dock", T.dockMs], ["--swap", T.swapMs], ["--reveal", T.wordRevealMs], ["--camera", T.cameraMs], ["--sweep", T.closeSweepMs]]) {
    stage.style.setProperty(name, value + "ms")
  }
  function words(text) {
    const line = document.createElement("div")
    text.split(" ").forEach((word, index) => {
      const outer = document.createElement("span"); outer.className = "w"
      const inner = document.createElement("span"); inner.textContent = word
      inner.style.transitionDelay = index * T.wordStaggerMs + "ms"
      outer.append(inner); line.append(outer)
    })
    return line
  }
  const revealMs = (text) => T.wordRevealMs + (text.split(" ").length - 1) * T.wordStaggerMs
  function show(layer) {
    for (const element of stage.querySelectorAll(".layer")) element.classList.toggle("on", element.dataset.layer === layer)
  }
  async function cameraTo(scale, origin) {
    camera.style.transformOrigin = origin
    camera.style.transform = scale === 1 ? "none" : "scale(" + scale + ")"
    await wait(T.cameraMs)
  }
  async function focusOn(layer, scale) {
    const mark = stage.querySelector('[data-layer="' + layer + '"] .focus')
    const box = mark.getBoundingClientRect(), view = camera.getBoundingClientRect()
    const y = ((box.top + box.height / 2 - view.top) / view.height) * 100
    stage.classList.add("marked")
    await cameraTo(scale, "0% " + y.toFixed(2) + "%")
  }
  async function rollTo(text) {
    lines.append(words(text))
    stage.classList.remove("marked")
    roll.classList.add("rolling")
    await wait(T.swapMs)
    roll.classList.add("instant")
    lines.firstElementChild.remove()
    roll.classList.remove("rolling")
    await frame()
    roll.classList.remove("instant")
  }
  async function play(beat) {
    if (beat === "author") {
      lines.replaceChildren(words(H.author))
      await frame()
      stage.classList.add("revealed")
      await wait(revealMs(H.author) + T.readMs)
      show("author")
      stage.classList.add("docked")
      await wait(T.dockMs)
      await focusOn("author", 1.35)
      await wait(T.holdMs)
      return
    }
    if (beat === "prove" || beat === "run") {
      const settle = cameraTo(1, "50% 50%")
      show(beat)
      await rollTo(H[beat])
      await settle
      if (beat === "prove") {
        await focusOn("prove", 1.5)
        await wait(T.holdMs)
      }
      return
    }
    if (beat === "close") {
      stage.classList.add("closing")
      await wait(T.closeSweepMs)
      stage.classList.add("swept", "close-revealed")
      await wait(revealMs(H.close) + T.closeHoldMs)
      return
    }
    throw new Error("unknown beat " + beat)
  }
  async function focus(target) {
    const preset = FOCUS[target]
    if (preset === undefined) throw new Error("unknown focus " + target)
    await cameraTo(preset.scale, preset.origin)
  }
  /** Leaves the Workbench preparation state for the opening frame, with no motion. */
  async function reset() {
    stage.classList.add("instant")
    stage.classList.remove("prep")
    show(null)
    await frame()
    stage.classList.remove("instant")
    await frame()
  }
  window.director = { play, focus, reset, ready: true }
})()
`

/**
 * The director page: paper stage, docking headline, square product frame, and
 * the closing card. It starts in the preparation state (frame in place, the
 * Workbench layer showing) so the capture can load and fill the Workbench
 * before recording the beats; `director.reset()` then moves to the opening
 * frame without animating.
 */
export function renderDirector({ routeSource, toolSource, testLog, wordmark = wordmarkSvg() }) {
  requireString(routeSource, "routeSource")
  requireString(toolSource, "toolSource")
  requireString(testLog, "testLog")
  requireString(wordmark, "wordmark")
  const route = markedCode(routeSource, /^\s*description:/u, "route source has no description line")
  const proof = markedCode(
    testLog,
    /(?:Tests?\s+.*passed|\d+\s+passed)/iu,
    "test log has no passing summary",
  )
  const runtime = RUNTIME.replace("TIMING", JSON.stringify(DIRECTOR_TIMING))
    .replace("HEADLINES_JSON", JSON.stringify(HEADLINES))
    .replace("FOCUS_JSON", JSON.stringify(RUN_FOCUS))
  const closeWords = HEADLINES.close
    .split(" ")
    .map((word, index) => `<span class="w"><span style="transition-delay:${index * DIRECTOR_TIMING.wordStaggerMs}ms">${escapeHtml(word)}</span></span>`)
    .join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>B4.run demo</title>
<style>${STYLE}</style>
</head>
<body>
<div class="stage prep">
  <h1 class="head"><div class="roll"><div class="lines"></div></div></h1>
  <div class="frame"><div class="camera">
    <div class="layer author" data-layer="author">
      <div><div class="strip">server/src/app/navlog/index.ts</div><pre>${route}</pre></div>
      <div><div class="strip">server/src/tools/computeNavlog.ts</div><pre>${escapeHtml(toolSource)}</pre></div>
    </div>
    <div class="layer prove" data-layer="prove"><div class="strip">npm test</div><pre>${proof}</pre></div>
    <div class="layer run on" data-layer="run"><iframe name="workbench" src="about:blank" title="B4.run Workbench"></iframe></div>
  </div></div>
  <div class="close">${wordmark}<div class="tagline">${closeWords}</div><div class="command">npm create b4-app@latest my-agent</div></div>
  <div class="sweep"></div>
</div>
<script>${runtime}</script>
</body>
</html>`
}
```

- [ ] **Step 4: Run the tests and lint**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^ℹ (pass|fail)|^not ok'`
Expected: `ℹ fail 0`.

If `"director page holds the Workbench iframe ... no header or act chip"` fails on `border-radius`, the only allowed radius is the sweep dot's `50%`; remove any other. If it fails on `\b(AUTHOR|PROVE)\b`, a test log line contains those words in capitals; the assertion is about chrome, so change the test input rather than the page.

Run: `pnpm exec biome lint --config-path packages/config-biome/biome.json docs/brand/demo`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add docs/brand/demo/director.mjs docs/brand/demo/demo.test.mjs
git commit -m "feat(demo): director page for the Paper Relay demo video

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Drive the Workbench inside the frame (`frameSurface`)

**Files:**
- Modify: `docs/brand/demo/capture.mjs` (add after `restoreWorkbenchThread`, about line 950)
- Test: `docs/brand/demo/demo.test.mjs`

- [ ] **Step 1: Write the failing test**

Add `frameSurface` to the `./capture.mjs` import list, then add:

```js
test("frame surface sends DOM calls to the Workbench frame and network waits to the page", async () => {
  const calls = []
  const frame = {
    getByRole: (...args) => (calls.push(["frame.getByRole", ...args]), "role"),
    locator: (...args) => (calls.push(["frame.locator", ...args]), "locator"),
    evaluate: async (...args) => (calls.push(["frame.evaluate", ...args]), "value"),
    waitForTimeout: async (ms) => calls.push(["frame.waitForTimeout", ms]),
    goto: async (url, options) => (calls.push(["frame.goto", url, options]), { ok: () => true }),
    url: () => "http://127.0.0.1:4101/",
  }
  const page = { waitForResponse: async (...args) => (calls.push(["page.waitForResponse", ...args]), "response") }
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
  assert.deepEqual(calls.at(-1), ["frame.goto", "http://127.0.0.1:4101/", { waitUntil: "domcontentloaded" }])
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
```

- [ ] **Step 2: Run to see it fail**

Run: `pnpm test:brand-demo 2>&1 | grep -E 'frame surface|SyntaxError' | head`
Expected: `SyntaxError: The requested module './capture.mjs' does not provide an export named 'frameSurface'`.

- [ ] **Step 3: Implement**

In `docs/brand/demo/capture.mjs`, after `restoreWorkbenchThread`, add:

```js
/**
 * A page-shaped view of the Workbench iframe, so `openReadyWorkbench`,
 * `fillActiveWorkbenchComposer`, `waitForWorkbenchRunCompletion`,
 * `expandLatestTurn` and `restoreWorkbenchThread` drive the real Workbench
 * inside the director page unchanged. DOM calls go to the frame; response
 * waits go to the page, which sees the frame's requests; a reload is a fresh
 * navigation of the frame to its own URL, as a browser reload would be.
 */
export function frameSurface(page, frame) {
  const goto = async (url, options) => {
    const response = await frame.goto(url, options)
    const loaded = frame.url()
    if (loaded.startsWith("chrome-error:")) {
      throw new Error(`The Workbench did not load inside the director frame (${loaded})`)
    }
    return response
  }
  return {
    getByRole: (...args) => frame.getByRole(...args),
    locator: (...args) => frame.locator(...args),
    evaluate: (...args) => frame.evaluate(...args),
    waitForTimeout: (ms) => frame.waitForTimeout(ms),
    waitForResponse: (...args) => page.waitForResponse(...args),
    goto,
    reload: (options) => goto(frame.url(), options),
  }
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^ℹ (pass|fail)|^not ok'`
Expected: `ℹ fail 0`.

- [ ] **Step 5: Commit**

```bash
git add docs/brand/demo/capture.mjs docs/brand/demo/demo.test.mjs
git commit -m "feat(demo): drive the real Workbench through its director iframe

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Record the beats (`captureDemo` and the browser session)

**Files:**
- Modify: `docs/brand/demo/capture.mjs`:
  - imports (lines 17–20);
  - `DEFAULT_HOLD_DURATIONS` (36–39);
  - `createBrowserAdapter` (1030–1147);
  - the director and beat section of `captureDemo` (from `const [primarySource, secondarySource]` about line 1331 to `result = {` about line 1430).
- Delete: `docs/brand/demo/stage.mjs`
- Test: `docs/brand/demo/demo.test.mjs`

The new session API that `captureDemo` calls is:

| Method | Does |
|---|---|
| `openDirector({ origin, html, fonts, signal })` | Routes `${origin}/__b4_demo_director/` to `html` and its `fonts/*` to the font bytes, navigates there, and waits for `window.director.ready` and `document.fonts.ready`. |
| `prepareWorkbench({ url, prompt, signal })` | `openReadyWorkbench` and `fillActiveWorkbenchComposer` through `frameSurface`, then `director.reset()`. |
| `play({ beat, signal })` | `window.director.play(beat)`. |
| `focus({ target, signal })` | `window.director.focus(target)`. |
| `runScenario({ prompt, tools, answer, signal })` | Clicks Send in the frame, then the existing completion, steps, answer and thread-id checks. |
| `reloadAndRestore({ workbenchUrl, threadId, prompt, tools, answer, signal })` | `restoreWorkbenchThread(frameSurface(...), ...)`. |
| `close()` | Unchanged. |

- [ ] **Step 1: Update the capture tests**

In `docs/brand/demo/demo.test.mjs`:

1. Delete the import `import { renderStage } from "./stage.mjs"`.
2. Delete these tests:
   - `"stage exports a frozen canonical generated-path inventory"`
   - `"author stage renders exactly the generated tree and escaped source"`
   - `"author stage keeps both real source panels in the 16:9 viewport"`
   - `"test stage renders escaped normalized npm test output"`
   - `"close stage renders B4.run category, headline, and scaffold command"`
   - `"renderStage rejects unsupported acts and incomplete author input"`

   Also delete the `GENERATED_TREE` constant if nothing else uses it (`grep -n GENERATED_TREE docs/brand/demo/demo.test.mjs`).
3. In `orchestrationFixture`:
   - In `filesystem.readFile(path)`, add before the final `throw`:
     ```js
        if (path.endsWith(".ttf")) {
          return Buffer.from(`font:${path.split("/").at(-1)}`)
        }
     ```
   - Change the navlog route stub to contain a description line, because the director requires one:
     ```js
        if (path.endsWith("server/src/app/navlog/index.ts")) {
          return 'export default agent({\n  description: "A VFR flight planner",\n  tools: [computeNavlog],\n})'
        }
     ```
   - Replace the object returned by `browser.open` (from `async recordStage({ act, html })` through the end of `async recordRun() { ... },`) with:
     ```js
          async openDirector({ origin, html, fonts }) {
            operations.push("open director")
            assert.equal(origin, "http://127.0.0.1:4101")
            assert.match(html, /export default agent\(\{/)
            assert.match(html, /computeNavlog/)
            assert.match(html, /splits the first leg into a climb segment and a cruise segment/)
            assert.match(html, /Tests 7 passed/)
            assert.match(html, /&lt;workspace&gt;/)
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
            assert.deepEqual(options.tools, ["computeNavlog"])
            assert.equal(options.answer, EXPECTED_ANSWER)
            if (failAt === "scenario") throw new Error("scenario failed")
            return { threadId: "thread-unit-1" }
          },
          async reloadAndRestore(options) {
            operations.push("reload")
            assert.equal(options.threadId, "thread-unit-1")
            assert.equal(options.answer, EXPECTED_ANSWER)
          },
     ```
     (keep the existing `async close()`).
4. In `"capture orchestrates the real-product phases in exact order and cleans up"`, replace the slice of expected operations from `"record author"` through `"record close"` with:
   ```js
    "open director",
    "prepare Workbench",
    "play author",
    "play prove",
    "play run",
    "run Workbench scenario",
    "focus answer",
    "focus rest",
    "reload",
    "focus sheet",
    "play close",
   ```
5. In `"capture publishes a versioned run-specific manifest with deterministic scene boundaries"`, change the expected scene keys to `["author", "prove", "run", "close"]`. Keep `holds` `[700, 900]`.
6. Run `grep -n -E 'recordStage|recordRun|"record (author|test|close|run)"' docs/brand/demo/demo.test.mjs`. Every hit is in a capture test that builds its own fake browser session (the cancellation tests at about lines 2692–2860 and 3047–3260):
   - rename `recordStage` to `play` and `recordRun` to `focus` in those fakes;
   - change expected operation strings `record author` to `play author`;
   - add `openDirector` and `prepareWorkbench` methods that resolve, and record `"open director"` and `"prepare Workbench"` if the test asserts the full operation list.

   A test that aborts "during the browser session" keeps aborting at the same phase it targeted; only the names change.

- [ ] **Step 2: Run to see the capture tests fail**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^not ok' | head`
Expected: the capture orchestration tests fail because `captureDemo` still calls `recordStage`.

- [ ] **Step 3: Implement the session and the beat sequence**

In `docs/brand/demo/capture.mjs`:

1. Replace the import `import { GENERATED_PATHS, renderStage } from "./stage.mjs"` with:
   ```js
   import { DIRECTOR_FONTS, renderDirector } from "./director.mjs"
   ```
2. Replace `DEFAULT_HOLD_DURATIONS` with:
   ```js
   const DEFAULT_HOLD_DURATIONS = Object.freeze({
     preReloadMs: 1_200,
     restorationMs: 1_500,
   })
   const DIRECTOR_PATH = "/__b4_demo_director/"
   ```
3. In `createBrowserAdapter().open`, replace the whole `return { recordStage, runScenario, reloadAndRestore, recordRun, close }` statement (from `return {` to its closing `}`, keeping the `runSessionOperation` and `close` helpers above it) with:

```js
      let surface
      const workbench = () => {
        surface ??= frameSurface(page, page.frame({ name: "workbench" }))
        return surface
      }
      return {
        async openDirector({ origin, html, fonts, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            await page.route(`${origin}${DIRECTOR_PATH}**`, (route) => {
              const { pathname } = new URL(route.request().url())
              if (pathname === DIRECTOR_PATH) {
                return route.fulfill({
                  status: 200,
                  contentType: "text/html; charset=utf-8",
                  body: html,
                })
              }
              const font = fonts[pathname.slice(`${DIRECTOR_PATH}fonts/`.length)]
              if (pathname.startsWith(`${DIRECTOR_PATH}fonts/`) && font !== undefined) {
                return route.fulfill({ status: 200, contentType: "font/ttf", body: font })
              }
              return route.fulfill({ status: 404, body: "" })
            })
            await page.goto(`${origin}${DIRECTOR_PATH}`, { waitUntil: "load" })
            await page.waitForFunction(() => window.director?.ready === true, undefined, {
              timeout: 30_000,
            })
            await page.evaluate(() => document.fonts.ready.then(() => undefined))
          })
        },
        async prepareWorkbench({ url, prompt, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            await openReadyWorkbench(workbench(), url)
            await fillActiveWorkbenchComposer(workbench(), prompt)
            await page.evaluate(() => window.director.reset())
          })
        },
        async play({ beat, signal: operationSignal }) {
          return runSessionOperation(operationSignal, () =>
            page.evaluate((name) => window.director.play(name), beat),
          )
        },
        async focus({ target, signal: operationSignal }) {
          return runSessionOperation(operationSignal, () =>
            page.evaluate((name) => window.director.focus(name), target),
          )
        },
        async runScenario({ prompt, tools, answer, signal: operationSignal }) {
          return runSessionOperation(operationSignal, async () => {
            const frame = workbench()
            await frame.getByRole("button", { name: "Send", exact: true }).click()
            await waitForWorkbenchRunCompletion(frame)
            // The settled turn is folded: open it so its steps are on screen
            // (and in the recording) before they are counted.
            const turn = await expandLatestTurn(frame)
            const steps = rootToolSteps(turn)
            await steps.first().waitFor({ state: "visible", timeout: 120_000 })
            const stepCount = await steps.count()
            if (stepCount < tools.length) {
              throw new Error(
                `The run rendered ${stepCount} tool steps, expected at least ${tools.length}`,
              )
            }
            await frame.getByRole("main").getByText(answer, { exact: true }).last().waitFor({
              state: "visible",
              timeout: 120_000,
            })
            const threadId = await frame.evaluate((title) => {
              const raw = localStorage.getItem("b4.workbench.threads")
              const threads = raw === null ? [] : JSON.parse(raw)
              const thread = threads.find((entry) => entry?.title === title)
              return typeof thread?.id === "string" ? thread.id : undefined
            }, prompt)
            if (threadId === undefined) {
              throw new Error("Workbench did not persist the active thread id")
            }
            return { threadId }
          })
        },
        async reloadAndRestore({
          workbenchUrl,
          threadId,
          prompt,
          tools,
          answer,
          signal: operationSignal,
        }) {
          return runSessionOperation(operationSignal, () =>
            restoreWorkbenchThread(workbench(), {
              workbenchUrl,
              threadId,
              prompt,
              tools,
              answer,
            }),
          )
        },
        close,
      }
```

4. In `captureDemo`, replace the block from `const [primarySource, secondarySource] = await racePhase(...)` through the `const testHtml = renderStage(...)` line with:

```js
    const [routeSource, toolSource, ...fontBytes] = await racePhase("read director inputs", () =>
      Promise.all([
        adapters.filesystem.readFile(join(appRoot, "server/src/app/navlog/index.ts"), "utf8"),
        adapters.filesystem.readFile(join(appRoot, "server/src/tools/computeNavlog.ts"), "utf8"),
        ...Object.values(DIRECTOR_FONTS).map((path) =>
          adapters.filesystem.readFile(join(repoRoot, path)),
        ),
      ]),
    )
    const directorHtml = renderDirector({ routeSource, toolSource, testLog: normalizedTestLog })
    const directorFonts = Object.fromEntries(
      Object.keys(DIRECTOR_FONTS).map((name, index) => [name, fontBytes[index]]),
    )
    const workbenchUrl = `http://127.0.0.1:${workbenchStart.port}`
```

5. Replace everything from `const timeline = createVideoTimeline(timing.now)` through the closing of the `timeline.scene("close", ...)` call with:

```js
    // The recording starts with the page; the timeline starts here, so the
    // director's load and the Workbench's warm-up fall before the author beat
    // and the encoder trims them off.
    const timeline = createVideoTimeline(timing.now)
    await browserPhase("open director", () =>
      browserSession.openDirector({
        origin: workbenchUrl,
        html: directorHtml,
        fonts: directorFonts,
        signal: signalScope.signal,
      }),
    )
    await browserPhase("prepare Workbench", () =>
      browserSession.prepareWorkbench({
        url: workbenchUrl,
        prompt: DEMO_PROMPT,
        signal: signalScope.signal,
      }),
    )
    const play = (beat) =>
      browserPhase(`play ${beat}`, () => browserSession.play({ beat, signal: signalScope.signal }))
    const focus = (target) =>
      browserPhase(`focus ${target}`, () =>
        browserSession.focus({ target, signal: signalScope.signal }),
      )
    await timeline.scene("author", () => play("author"))
    await timeline.scene("prove", () => play("prove"))
    let restoration
    const scenario = await timeline.scene("run", async () => {
      await play("run")
      const ran = await browserPhase("run Workbench scenario", () =>
        browserSession.runScenario({
          prompt: DEMO_PROMPT,
          tools: EXPECTED_TOOLS,
          answer: EXPECTED_ANSWER,
          signal: signalScope.signal,
        }),
      )
      await focus("answer")
      await browserPhase("hold completed run", () =>
        timing.sleep(holdDurations.preReloadMs, { signal: signalScope.signal }),
      )
      await focus("rest")
      restoration = await browserPhase("restore Workbench thread", () =>
        browserSession.reloadAndRestore({
          workbenchUrl,
          threadId: ran.threadId,
          prompt: DEMO_PROMPT,
          tools: EXPECTED_TOOLS,
          answer: EXPECTED_ANSWER,
          signal: signalScope.signal,
        }),
      )
      await focus("sheet")
      await browserPhase("hold restored run", () =>
        timing.sleep(holdDurations.restorationMs, { signal: signalScope.signal }),
      )
      return ran
    })
    await timeline.scene("close", () => play("close"))
```

Leave `result = { ... }` and everything after it unchanged. It already reads `scenario.threadId` and `restoration?.connectUrl`.

6. Delete `docs/brand/demo/stage.mjs`:
   ```bash
   git rm docs/brand/demo/stage.mjs
   ```

- [ ] **Step 4: Run tests and lint**

Run: `pnpm test:brand-demo 2>&1 | grep -E '^ℹ (pass|fail)|^not ok'`
Expected: `ℹ fail 0`. If a cancellation test fails, its fake session lacks one of `openDirector`, `prepareWorkbench`, `play` or `focus`; add a resolving method as in Step 1.6.

Run: `pnpm exec biome lint --config-path packages/config-biome/biome.json docs/brand/demo`
Expected: no errors. An `noUnusedVariables` warning on `GENERATED_PATHS` or `renderStage` means a leftover reference; remove it.

- [ ] **Step 5: Commit**

```bash
git add docs/brand/demo/capture.mjs docs/brand/demo/demo.test.mjs
git commit -m "feat(demo): record the four beats through the director page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Copy, alt text, and retired posters

**Files:**
- Modify:
  - `docs/brand/demo/transcript.md` (rewrite)
  - `docs/brand/recording-guide.md`
  - `docs/brand/demo/evidence-matrix.md`
  - `README.md:37`
  - `scripts/lib/readme-contracts.mjs:91`
  - `scripts/readme-contracts.test.mjs:460,1507,1520`
  - `docs/superpowers/specs/2026-10-07-demo-video-redesign-design.md`
- Delete: `apps/web/public/demo/author-poster.webp`, `apps/web/public/demo/test-poster.webp`, `apps/web/public/demo/run-poster.webp`

- [ ] **Step 1: Rewrite the transcript**

Replace `docs/brand/demo/transcript.md` with:

```markdown
# B4.run product-loop media transcript

The product loop is silent. Its headlines are repeated here so the same proof
is available without motion. The footage begins inside an existing generated
navlog workspace; it does not show the scaffold command running.

## Product loop

### Write the agent.

The headline docks above a square frame that shows two real files from the
generated workspace: the route `server/src/app/navlog/index.ts`, with its
`export default agent({` descriptor, and the shared tool
`server/src/tools/computeNavlog.ts`. The camera eases to the route's
`description` line, marked with a Relay bar.

### Test it offline.

The frame shows the generated workspace's real `npm test` output, narrowly
normalized: ANSI codes are removed, the temporary root reads `<workspace>`, and
durations read `<time>`. The navlog tests pass without a provider key, and the
camera eases to the passing summary.

### Reload. Still there.

The frame holds the actual generated B4.run Workbench. It sends “Plan a VFR
flight from KSTP to KRST at 4500 feet, departing 1400Z.” to `/navlog#agent`.
The visible activity names the `computeNavlog` call, and the answer reads
“KSTP and KRST are VFR. 66 nm, 33 minutes, 5.5 gal burned, reserve about 6
hours. [poh/cruise-performance.md, Figure 5-7]”. The browser frame then
reloads, the same thread is reopened from the rail, and the prompt, the tool
call, the answer, and the navlog sheet reappear from the server checkpoint.
This shows browser-reload restoration with the B4.run server still running,
not restoration after a server restart.

### Close

A hairline carrying the Relay dot sweeps across to the closing card: the
b4.run wordmark, “Ridiculous speed. Readable code.”, and
`npm create b4-app@latest my-agent`. The command is an activation next step;
scaffolding is not part of the footage.
```

- [ ] **Step 2: Update the README alt text and its pins**

The old alt text is exactly:
`Animation showing an existing generated research workspace, a deterministic test, and the B4.run Workbench`

The new alt text is exactly:
`Animation showing the generated navlog agent's route, an offline npm test, and a B4.run Workbench run restored after a browser reload`

Replace every occurrence:

```bash
OLD="Animation showing an existing generated research workspace, a deterministic test, and the B4.run Workbench"
NEW="Animation showing the generated navlog agent's route, an offline npm test, and a B4.run Workbench run restored after a browser reload"
grep -rln "$OLD" README.md scripts/lib/readme-contracts.mjs scripts/readme-contracts.test.mjs \
  | xargs perl -0pi -e "s/\Q$OLD\E/$NEW/g"
grep -rn "$OLD" README.md scripts || echo "no old alt text left"
```

Expected: `no old alt text left`.

Run: `node --test scripts/readme-contracts.test.mjs 2>&1 | grep -E '^ℹ (pass|fail)'`
Expected: `ℹ fail 0`.

- [ ] **Step 3: Update the recording guide**

In `docs/brand/recording-guide.md`:

1. Replace the paragraph that begins `After Playwright finalizes its recording` and the numbered list after it (the four timelines), plus the paragraphs about label chips and frozen-frame holds (through `it does not claim a server restart.`), with:

```markdown
The capture records one page, the **director page** (`docs/brand/demo/director.mjs`).
Playwright serves it at the Workbench's own origin under
`/__b4_demo_director/` (the request never reaches the Workbench server), with
fonts from the brand kit. The real Workbench loads in its iframe and is
prepared out of shot. The capture then plays four beats:

1. **Write the agent.** The real route and shared tool.
2. **Test it offline.** The real, narrowly normalized `npm test` output.
3. **Reload. Still there.** The real Workbench run, a frame reload, and the same
   thread restored.
4. **Close.** The wordmark, the tagline, and the create command.

Headlines, the camera, and the crossfades are CSS on the director page; the
product moments happen in real time inside the frame, and nothing is
synthesized. ffmpeg trims the recording from the start of the first beat to the
end of the close and encodes one flagship of about 15 seconds: MP4, WebM, the
README GIF, and a WebP poster taken from the docked first beat. The capture
browser asks for reduced motion (the navlog map then skips its animations) and
hides the Next.js dev badge.
```

2. In the validate bullet list:
   - change `a 20–30 second flagship and 8–12 second derivatives;` to `a 12–18 second flagship;`;
   - change `H.264 MP4 and VP9 WebM for all four clips;` to `H.264 MP4 and VP9 WebM for the flagship;`;
   - change `all four WebP posters and the Markdown transcript;` to `the WebP poster and the Markdown transcript;`.
3. In "Authorized publication convergence", replace each `all eight run-scoped files` with `both run-scoped files`, `all eight upload calls` with `both upload calls`, `all eight remote paths` with `both remote paths`, `all eight stable paths` with `both stable paths`, and `all eight public URLs` with `both public URLs`. Run `grep -n -i eight docs/brand/recording-guide.md` until nothing is left. Replace the last paragraph's `the eight stable video paths` with `the two stable video paths`.
4. In "Committed outputs", delete the three lines `apps/web/public/demo/author-poster.webp`, `apps/web/public/demo/test-poster.webp`, and `apps/web/public/demo/run-poster.webp`.
5. Replace the "Visual inspection" paragraph's first two sentences with:

```markdown
Inspect the poster and representative frames from the local MP4 and WebM at
full 1440×810 size and at reduced README and mobile widths. Confirm that the
file paths, the `npm test` result, `computeNavlog`, the cited answer, the frame
reload, the restored thread, and the four headlines correspond exactly to
[the transcript](./demo/transcript.md).
```

- [ ] **Step 4: Correct the evidence matrix**

In `docs/brand/demo/evidence-matrix.md`, find every row that names the research starter as the footage's subject:

```bash
grep -n -E 'research starter|searchCorpus|/research#agent|research\.test' docs/brand/demo/evidence-matrix.md
```

For each hit in a row about what the video shows, make these substitutions and leave the evidence commands as they are:
- the research starter becomes the navlog starter (`--template navlog`);
- `/research#agent` becomes `/navlog#agent`;
- `app-research/server/src/app/research/index.ts` becomes `app-navlog/server/src/app/navlog/index.ts`;
- `research.test.ts.template` becomes `navlog.test.ts.template`;
- `searchCorpus` and `readDoc` become `computeNavlog`.

Rows that record a dated historical receipt (the "receipt above records the 2026-09-01 source only" text) stay as written.

- [ ] **Step 5: Record the routing deviation in the spec**

In `docs/superpowers/specs/2026-10-07-demo-video-redesign-design.md`, replace the `capture.mjs` bullet's sentence starting `New: it serves the director page from its own` and the sentence after it with:

```markdown
     New: it serves the director page with Playwright's `page.route()` at
     `<workbench origin>/__b4_demo_director/` (the request never reaches the
     Workbench server), so the director page and the iframed Workbench are
     same-origin and the Workbench's `localStorage` thread list behaves as it
     does top-level.
```

- [ ] **Step 6: Delete the retired posters and run the docs gate**

```bash
git rm apps/web/public/demo/author-poster.webp apps/web/public/demo/test-poster.webp apps/web/public/demo/run-poster.webp
grep -rn -E 'author-poster|test-poster|run-poster' apps docs/brand scripts README.md || echo "no references left"
node scripts/check-docs.mjs 2>&1 | tail -3
pnpm test:brand-demo 2>&1 | grep -E '^ℹ (pass|fail)'
```

Expected:
- `no references left`;
- check-docs reports success (it prints its summary with no failures);
- `ℹ fail 0`.

- [ ] **Step 7: Commit**

```bash
git add docs/brand/demo/transcript.md docs/brand/recording-guide.md docs/brand/demo/evidence-matrix.md README.md scripts/lib/readme-contracts.mjs scripts/readme-contracts.test.mjs docs/superpowers/specs/2026-10-07-demo-video-redesign-design.md
git commit -m "docs(demo): transcript, guide and alt text for the redesigned video

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Record, check, and hand to Brian (manual)

This task needs a real browser, ffmpeg and about five minutes. It changes committed media (`docs/brand/product-loop.gif` and `apps/web/public/demo/product-loop-poster.webp`), so its results go to Brian before anything is committed or uploaded.

- [ ] **Step 1: Capture**

```bash
pnpm media:readme:capture 2>&1 | tail -20
```

Expected: exit 0. On failure, read the error's phase name (`open director`, `prepare Workbench`, `play author`, `run Workbench scenario`, `restore Workbench thread`, and so on). Then:
- **`prepare Workbench` times out:** check the frame loaded (the `chrome-error` message from `frameSurface`).
- **A click inside the frame misses:** the frame is scaled by `0.772917`. Confirm the click happened while the camera was at rest; the sequence only clicks before `focus("answer")` and after `focus("rest")`.
- **The staged media contract fails on duration:** report the measured length; do not change the 12–18 s contract. Tune `DIRECTOR_TIMING.holdMs`, `readMs` or `holdDurations` instead.
- **The GIF is over 4 MB:** first tighten `RUN_FOCUS.sheet` and `RUN_FOCUS.answer` (higher `scale`, so fewer map pixels change). Then, for the GIF only, try `max_colors=24` in `buildGifFilter`, with its test updated. Record which lever was used in the PR description.

- [ ] **Step 2: Check**

```bash
pnpm media:readme:check -- --local
```

Expected: a `PASS` line for each contract group.

- [ ] **Step 3: Build a contact sheet for review**

```bash
R=$(ls -td docs/brand/demo/artifacts/runs/*/ | head -1)
ffmpeg -v error -y -i "$R/output/product-loop.mp4" -vf "fps=2,scale=480:-1,tile=6x5" -frames:v 1 "$R/contact-sheet.png"
ls -la "$R/output" "$R/publication" docs/brand/product-loop.gif
```

Send Brian the MP4, the GIF, the poster, and the contact sheet (use `SendUserFile`), with the measured duration and file sizes. **Stop here.** Committing the GIF and poster, and running `pnpm media:readme:upload -- --apply`, wait for his review.

- [ ] **Step 4: After Brian approves (only then)**

```bash
git add docs/brand/product-loop.gif apps/web/public/demo/product-loop-poster.webp
git commit -m "docs(brand): re-record the product loop on the redesigned director page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The upload (`pnpm media:readme:upload -- --apply`) needs the Blob credentials described in the recording guide. Brian runs it, or explicitly hands it over.

---

## Self-review

- **Spec coverage:**
  - §2 decisions: Tasks 4, 6 and 7.
  - §3 motion: Task 4, through the director's CSS and runtime.
  - §4.1–4.3 architecture and units: Tasks 1–6.
  - §5 error handling:
    - phase timeouts are unchanged (Task 6 wraps every call in `browserPhase`);
    - the evidence assertions are kept in `runScenario` and `reloadAndRestore`;
    - framing refusal: `frameSurface.goto` (Task 5);
    - budgets: the checker (Task 1) and the levers (Task 8).
  - §6 testing: Tasks 1–6.
  - §7 is already committed.
  - §8 out-of-scope items are respected; upload stays manual.
- **Placeholder scan:** none. The bulk test edits in Tasks 1, 2 and 6 name the exact strings and the rule for each substitution, because those tests are long and mostly unaffected.
- **Type consistency:**
  - Every caller passes `trim` (`{ start, duration, posterTime }`) to `encodeVideo` and `encodeGif`.
  - The session API names (`openDirector`, `prepareWorkbench`, `play`, `focus`, `runScenario`, `reloadAndRestore`, `close`) match between Task 6's adapter, `captureDemo`, and the fakes.
  - The beat names `author`, `prove`, `run` and `close` match `BEATS`, `createTrimPlan`'s `BEAT_ORDER`, and the timeline scenes.
  - `RUN_FOCUS` keys `rest`, `answer` and `sheet` match the `focus()` calls.

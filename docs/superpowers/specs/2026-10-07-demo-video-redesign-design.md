# Demo video redesign

Date: 2026-10-07. Status: approved in brainstorming, ready for an implementation plan.

## 1. Why

The README product-loop video still shows the retired research starter. Its
captions and transcript name `searchCorpus`, and its closing card carries the old
tagline ("TypeScript meta-framework for LangGraph.js / Build LangGraph agents like
Next.js apps"). The recording pipeline (`docs/brand/demo/`) was retargeted to the
navlog starter in the navlog series, but the clips were never re-recorded.

A first re-capture on the current pipeline exposed design problems beyond stale copy:

- The look is a brand header bar plus an `AUTHOR / PROVE / RUN` label chip over
  long frozen holds. It reads as dated and slow (25 s).
- The navlog Workbench's map makes the GIF 6.8–8.5 MB against the 4 MB limit.
- The Run act showed the Next.js dev badge, a continent-wide map, a blank reload
  frame, and a mid-animation zoom.

The goal is a modern, snappy video in the Paper Relay brand that stays an honest
evidence asset.

## 2. Decisions

| Topic | Decision |
|---|---|
| Direction | Type first, then the product takes the stage: each beat opens on large type, which docks small at the top-left as the product frame rises. |
| Palette and shape | Paper Relay tokens from `apps/web/app/styles/tokens.css`: paper `#F5F4F0` field, ink `#111111` type, dark panel `#17181B`, Relay `#B4CE37` on focal points only. Square corners, no shadows, no gradients. Inter for type, JetBrains Mono for code. Logo from the SVG master `apps/web/public/brand/identity/logos/wordmark-ink.svg`, never typed. |
| Header and labels | None. No brand header bar, no act chip, no step dots. |
| Beat transition | Swap in place: the headline rolls up to the next line and the frame's content crossfades through a light blur (about 550 ms, `cubic-bezier(.65,0,.35,1)`). The layout never moves between beats. |
| Close transition | Once, after Run: a hairline carrying a small Relay dot sweeps across and reveals the closing card (about 750 ms). |
| Headlines | Author: "Write the agent." Prove: "Test it offline." Run: "Reload. Still there." |
| Closing card | Wordmark, "Ridiculous speed. Readable code.", and `npm create b4-app@latest my-agent` in a dark panel. |
| Length | About 15 s: Author 3 s, Prove 3 s, Run about 6 s at real speed, Close 2.5 s. |
| Outputs | One flagship: MP4, WebM, README animation (960×540 animated WebP; see section 9), WebP poster. The three derivative clips (author, test, run) are dropped. |

The derivatives go because nothing renders them: no file under `apps/web/app`
imports `demo-media.json` since the homepage was rebuilt. They can return later
as cuts from the same recording.

## 3. Motion details

- **Headline reveal.** Words rise from a mask, 45 ms apart, each over about
  380 ms with `cubic-bezier(.16,1,.3,1)`.
- **Dock.** After about 0.8 s the headline scales to about 0.42 and moves to the
  top-left over about 420 ms. On the first beat the product frame rises from below
  at the same time; on later beats it is already in place and the content swaps.
- **Camera.** Each beat eases the frame's content toward its focal point over
  about 700 ms with `cubic-bezier(.65,0,.35,1)`. The zoom origin is anchored so
  code never clips at the left edge. Focal points: Author is the `description`
  line, Prove is the `Tests N passed` summary, and Run is the navlog sheet's
  numbers and the dock's answer.
- **Focal mark.** A Relay bar (3 px inset Relay plus a Relay tint) sweeps under
  the focal line as the camera arrives.
- **Reduced motion and dev tooling.** The capture browser keeps
  `reducedMotion: "reduce"` (the navlog map then skips its fit, fade and zoom
  animations) and hides the `nextjs-portal` dev badge with an init script. The
  director page's own motion is unaffected: it is the video, not the product.

## 4. Architecture

### 4.1 One recorded director page

The capture records a single page at 1440×810, the **director page**. It draws
the stage (paper field, headline, square product frame) and runs all motion in
CSS. ffmpeg no longer composes anything; it only trims and encodes.

- **Author and Prove.** The frame shows the real generated route
  (`server/src/app/navlog/index.ts`), the real shared tool
  (`server/src/tools/computeNavlog.ts`), and the real `npm test` log from the
  scaffold. The log keeps today's narrow normalization: ANSI codes stripped, the
  temporary root replaced with `<workspace>`, and durations replaced with `<time>`.
- **Run.** The frame contains the real Workbench in an iframe at its native
  1440×810, scaled to fit the frame. Playwright drives it through
  `frameSurface`: the prompt is filled into the composer before recording, and
  Send is clicked during the Run beat; it then waits for the completed turn,
  re-navigates the iframe, opens the thread from the rail, and checks the
  restoration.
  The camera transforms the frame element, never the Workbench document.

Nothing is synthesized. The product moments happen in real time inside the
frame; the director page only waits, moves the camera and swaps headlines.

### 4.2 Units

All paths are under `docs/brand/demo/`.

1. **`director.mjs`** (replaces `stage.mjs`).
   - Renders the director page's HTML from typed inputs: the beat headlines, the
     route and tool sources, the normalized test log, the Workbench URL, and the
     wordmark SVG markup.
   - Exposes `window.director.play(beat)` for `"author" | "prove" | "run" | "close"`.
     Each call resolves when that beat's motion has settled.
   - Exposes `window.director.focus(target)` to move the Run camera between the
     dock answer and the navlog sheet.
   - Holds every timing constant in one exported table.
   - Has no product logic and no network access beyond the iframe's `src`.
2. **`capture.mjs`**.
   - Unchanged:
     - the toolchain check, build, scaffold (`--mode internal --template navlog`),
       install and `npm test`;
     - aimock, the B4.run server and the Workbench on assigned loopback ports;
     - the signal, abort and cleanup handling.
   - New: it serves the director page with Playwright's `page.route()` at
     `<workbench origin>/__b4_demo_director/` (the request never reaches the
     Workbench server), so the director page and the iframed Workbench are
     same-origin and the Workbench's `localStorage` thread list behaves as it
     does top-level.
   - The beat sequence is:
     1. `play("author")`
     2. `play("prove")`
     3. `play("run")` and the real Workbench steps in the frame
     4. the reload and restoration checks
     5. `play("close")`
   - It records each beat's monotonic start and end times in the capture summary.
3. **`encode.mjs`**.
   - Trims the raw recording to the recorded start of Author and end of Close.
   - Encodes H.264 MP4, constrained-quality VP9 WebM and the README animation
     (a 960×540, 12 fps intermediate GIF that sharp converts to animated WebP),
     and extracts the poster frame from the MP4.
   - The label chips, frozen-hold padding, `buildLabelInputs` and the per-clip
     timeline plans all go.
4. **`check-media.mjs`**. The new contract:
   - the flagship lasts 12–18 s, at exactly 1440×810 and 30 fps;
   - the MP4 and WebM are each at most 2,000,000 bytes;
   - the README animation is an animated WebP at 960×540, at most 15 fps and
     at most 4,000,000 bytes, read through sharp because ffprobe cannot read
     animated WebP;
   - the catalog has the single `productLoop` entry, with captions describing the
     navlog footage.
5. **`upload.mjs`**. It uploads the flagship's four files and writes the
   single-entry catalog.
6. **Copy.**
   - `transcript.md` is rewritten for the new beats.
   - The README animation's alt text and its pins in `scripts/lib/readme-contracts.mjs`
     and `scripts/readme-contracts.test.mjs` are updated.
   - `recording-guide.md` describes the director page.
   - `evidence-matrix.md` rows that name the research starter are corrected.

### 4.3 Data flow per beat

1. The capture calls `play(beat)` with `page.evaluate`.
2. The director page reveals the headline, docks it, swaps the frame content
   (blur crossfade), eases the camera to the focal point, sweeps the focal mark,
   and resolves.
3. The capture logs the beat's times.
4. For Run, the capture performs the Workbench steps between `play("run")` and
   `play("close")`. Meanwhile the director page holds the frame still and moves
   the camera only through `focus`.

## 5. Error handling

- **A beat or Workbench step that does not settle.** Every `play()` call and
  Workbench step runs inside `raceCapturePhase` with its existing timeouts and
  abort signal. A timeout fails the capture with the beat's name, and partial
  recordings are never encoded.
- **Evidence assertions** keep today's strength, run through the frame:
  - the completed turn shows at least the fixture's tool steps and the exact
    fixture answer;
  - the reload's thread connect request returns OK;
  - the restored thread has exactly one turn, with the same steps and answer.

  Any failure fails the capture. There is no fallback footage.
- **Framing refused.** Before recording, the capture checks that the Workbench
  document loads inside the frame. If framing is refused, the capture fails with
  that reason rather than recording a blank frame.
- **Budgets.** The checker rejects any file over its size or duration limit.
  The limits themselves do not move; the encoder settings are tuned to stay
  about 10% under them (see section 9).

## 6. Testing

Unit tests in `demo.test.mjs`, with the existing fake-browser style:

- **The director page:** the rendered HTML (headlines, wordmark, sources, log,
  iframe `src`, no header or chip), the timing table, and the order of `play()`
  calls.
- **The capture:** beat sequencing, the evidence assertions through a fake
  `frameSurface`, the framing preflight, and cleanup when a beat fails.
- **The encoder:** the trim plan from recorded beat times, and the ffmpeg
  arguments for each output.
- **The checker:** the 12–18 s window, the size limits, and the single-entry
  catalog.
- **Retained tests:**
  - the demo prompt fits the Workbench's 80-character thread title;
  - `reducedMotion: "reduce"` and the dev-badge init script are set before the
    first page.

The real capture stays manual: `pnpm media:readme:capture`, then
`pnpm media:readme:check -- --local`. Brian reviews the clips before
`pnpm media:readme:upload -- --apply` or committing the README animation.

## 7. Already on the branch

These changes from the first re-capture are kept:

- `DEMO_PROMPT` shortened to fit the Workbench's 80-character thread title, with
  a test that pins it.
- The closing card's tagline updated (superseded by the closing card design
  above).
- The navlog `RouteMap` honors reduced motion fully: no tile fade, zoom
  animation or marker zoom animation. This change is in the example and the
  template.
- The capture context sets `reducedMotion: "reduce"` and hides the Next.js dev
  badge.

## 8. Out of scope

- Audio or voice-over (the video stays silent).
- Re-adding derivative clips or rendering video on the homepage.
- Changing the product's UI for the video, beyond the reduced-motion fix that
  stands on its own.
- Uploading to the blob store and committing the README animation. That happens
  after Brian reviews the recorded clips.

## 9. Approved deviations

- **README animation format.** With the camera zooms and blur crossfades, a
  1440×810, 30 fps GIF encodes at about 25 MB, and no GIF that fits 4 MB is
  watchable (900×506 at 10 fps is still 4.07 MB and visibly choppy). The README
  animation is therefore a 960×540, at most 15 fps animated WebP of at most
  4,000,000 bytes at `docs/brand/product-loop.webp`. ffmpeg here has no WebP
  encoder, so ffmpeg writes a 256-colour intermediate GIF and sharp converts it.
  The old `docs/brand/product-loop.gif` stays committed only because READMEs
  already published to npm load it from `main`.
- **WebM rate control.** The WebM uses constrained-quality VP9 (`-b:v 800k
  -crf 44 -maxrate 900k -bufsize 1800k`) so that captures from 15.9 to 16.9 s
  stay under the 2,000,000-byte limit.
- **README animation rate.** The WebP converts at quality 62, effort 6, and the
  encoder samples 12 fps (the checker still allows up to 15): at 15 fps a
  16.5 s capture produced 3.88 MB, too close to the 4 MB limit.

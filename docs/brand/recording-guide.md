# B4.run navlog demo recording guide

This guide rebuilds the silent navlog demo video (MP4 and WebM) and its poster
from the current local B4.run source tree. The root README embeds a
GitHub-hosted copy of the MP4 as GitHub's inline video player; the npm READMEs
show the poster and link it to the MP4 on the B4.run media store. There is no
README animation.

## Prerequisites

- Node.js 24 or newer. The capture summary records the exact version.
- Corepack with the repository's exact pnpm 10.33.0.
- Playwright Chromium installed for `@playwright/test` 1.62.1.
- ffmpeg and ffprobe with `libx264` and `libvpx-vp9`; these assets are tested
  with version 8.1.1. The checked-in `sharp` development dependency encodes the
  WebP poster after ffmpeg extracts its exact source frame.
- Repository dependencies installed and enough temporary disk space for a local
  generated navlog workspace and raw recording.

Run every command from the repository root.

## Capture and encode

```bash
pnpm media:readme:capture
```

Do not start a capture in the 15 minutes before 1400Z: the scenario resolves
the prompt's “1400Z” when it is built, and the capture refuses to send the
prompt once the live `resolveDeparture` tool would resolve it to the next day.

The command checks Node and pnpm before it builds the repository, creates the
current navlog starter in a temporary directory with `--mode internal`,
installs it, and runs the generated root `npm test` command (its output is kept
in the run's ignored artifacts; the video does not show it). It then starts
aimock, a loopback AWC stub, the B4.run server, and the generated Workbench on
assigned loopback ports and records the 1440×810 page as a lossless
screencast (see "The recorder" below). ffmpeg is exercised when
encoding begins; ffprobe is exercised by the local checker, so a missing
executable, encoder, or probe fails at that boundary with the command's
diagnostic.

The run is deterministic, offline and keyless:

- **The scenario.** `docs/brand/demo/scenario.mjs` builds both prompts, one
  aimock script for two parent turns and both subagents, and the stub's weather,
  all from one clock reading. Turn 1 plans the flight: recall, the 1400Z
  departure, a four-item plan, both airports, the weather and performance
  subagents, `computeNavlog`, a `remember` call, the saved navlog, and the
  answer. Turn 2 (“File the flight plan.”) calls `fileFlightPlan` with the
  flight plan `computeNavlog` produced, and replies.
- **The AWC stub.** `docs/brand/demo/awc-stub.mjs` is a loopback HTTP server
  that answers the weather tools with fixed data in AWC's shapes: KSTP and KRST
  VFR, clear, 10 SM, wind 320 at 8, FB winds 320/20 at MSP, no AIRMET, SIGMET or
  G-AIRMET. Only the B4.run server is pointed at it (`B4_AWC_BASE_URL`), and the
  capture fails if any endpoint the run reaches was never served.

Aimock is the only model endpoint. Provider credentials are excluded from child
environments and capture fails if the model base URL is not loopback. The
generated Workbench has no demo or fixture mode and receives no marketing-only
runtime branch; every tool runs for real.

The capture records one page, the **director page** (`docs/brand/demo/director.mjs`).
Playwright serves it at the Workbench's own origin under
`/__b4_demo_director/` (the request never reaches the Workbench server), with
fonts from the brand kit. The real Workbench loads in its iframe and is
prepared out of shot, with the first prompt filled into its composer. The
capture then plays the twelve beats of the **storyboard**
(`docs/brand/demo/storyboard.mjs`), recording one scene per beat
(`beat-00-title` … `beat-11-close`):

- a title card, then code beats that show real files from the generated
  workspace (the route, the weather subagent and `getMetar`, `computeNavlog`
  and the wind triangle, the approval line, the memory declaration), each with
  its focal line marked;
- app beats in the real Workbench, each with evidence assertions: the plan's
  to-dos after Send; the weather strip's and verdict card's “GO”; the route on
  the map and 66 nm on the navlog sheet; the filing request, whose approval
  card must offer Allow once and Deny and no Always allow, and the capture's
  click on **Allow once**; the suggested memory; and a frame reload that
  restores both turns of the same thread;
- the close: the wordmark, the tagline, and the create command.

Headlines, the camera, and the crossfades are CSS on the director page; the
product moments happen in real time inside the frame, and nothing is
synthesized. Holds are real waits (each beat's `holdMs`). ffmpeg trims the
recording from the start of the first beat to the end of the close, about 50
seconds, and encodes the MP4 and WebM at 1440×810 and 30 fps, with codec
settings chosen for crisp code text (`VIDEO_CODEC_ARGUMENTS` in `encode.mjs`):
H.264 CRF 18 with a 4,000 kbit/s ceiling, and constrained-quality VP9 at CRF 28
under 2,500 kbit/s. The poster is the encoded MP4's frame 0.25 s before the
navlog beat ends, with the camera on the navlog sheet. The capture browser asks
for reduced motion (the navlog map then skips its animations) and hides the
Next.js dev badge.

### The recorder

Playwright's own video recording is VP8 at about 0.9 Mbit/s and 25 fps, which
leaves code text soft. The capture instead records a Chromium DevTools
screencast: `Page.startScreencast` sends a lossless 1440×810 PNG each time the
page paints. Each frame is written under the run's raw-recordings directory
with its wall-clock timestamp and acknowledged. Because frames arrive only on
paint, a hold is the gap between two timestamps; Chromium can stamp a frame
slightly before the one ahead of it, so frames play in timestamp order. When
the run ends, ffmpeg's concat demuxer gives every frame its real duration (the
last lasts until the screencast stops), resamples to a constant 30 fps, and
writes `screencast.mp4` (near-lossless 4:4:4 H.264); the frames are then
deleted. A failed or cancelled run deletes them without assembling. The
timeline records its start on the same wall clock, so the summary's
`videoTimeline.videoOffsetMs` maps every scene time to video time, and the
encoder trims by those mapped times. The summary's `screencast.motion`
reports the frame rate while the page moved.

The screencast runs at scale 1 (`SCREENCAST_SCALE` in `capture.mjs`) by
measurement. At scale 2 (with `--force-device-scale-factor=2`, since headless
Chromium otherwise sends 1x frames) the 2880×1620 frames kept up at only about
14 fps while the page moved, PNG and JPEG alike, so camera moves stuttered,
and the downscaled text was not visibly crisper than the lossless 1x frames,
which arrive at about 41 fps.

## Validate

```bash
pnpm media:readme:check -- --local
```

The checker invokes ffprobe with JSON output for the videos and the poster, and
verifies:

- exact 1440×810 16:9 geometry and 30 fps for the videos;
- a 45–75 second flagship;
- H.264 MP4 and VP9 WebM for the flagship;
- no MP4 or WebM above 12,000,000 bytes (the media store hosts both, and
  GitHub hosts the root README's copy of the MP4);
- the 1440×810 WebP poster and the Markdown transcript;
- captions that describe the existing workspace footage without claiming the
  scaffold command is shown.

It prints one `PASS` line for each contract group and exits nonzero if any
contract fails.

## Generated files

The latest run has its own roots under:

```text
docs/brand/demo/raw-recordings/runs/<run-id>/
docs/brand/demo/artifacts/runs/<run-id>/
```

Its local MP4 and WebM files are in the run's `output/` directory. A gitignored
`docs/brand/demo/artifacts/latest-media.json` pointer lets the local checker find
the most recent successful encode. The poster is first completed and validated
in that run's `publication/` directory, then published together with the
manifest and the pointer using rollback backups. The checker requires exact
run-scoped paths and verifies that the fixed poster's hash matches the selected
run. Raw recordings, logs, MP4, and WebM files are not committed.

## Authorized publication convergence

Preview the publication plan without credentials or remote I/O:

```bash
pnpm media:readme:upload -- --dry-run
```

The local checker records a SHA-256 digest for each validated MP4/WebM alongside
its ffprobe and byte-size facts. An authorized `--apply` re-reads both run-scoped files
and requires each in-memory body's size and SHA-256 digest to match those validation-time facts. No upload starts unless the entire preflight
succeeds. Every upload then uses its stable `b4/demo/*.mp4` or `b4/demo/*.webm` path
with overwrites enabled and random suffixes disabled.

If an upload fails or returns a mismatched URL, the command reports three exact
sets: the prior stable paths whose upload calls are confirmed complete, the
current stable path as potentially completed or mutated, and the later stable
paths as definitely pending. The media catalog is withheld. The command does
not claim or attempt remote rollback.

If a `HEAD` check fails after both upload calls return, both remote
paths may have changed while the verification outcome for the current public
URL remains uncertain; the catalog is again withheld. Use exactly one
credential mode: the preferred short-lived `VERCEL_OIDC_TOKEN` together with
`BLOB_STORE_ID`, or the legacy `BLOB_READ_WRITE_TOKEN`. The OIDC store ID and
the store ID encoded in a canonical legacy token must both match the authorized
B4.run media store. In either mode, `B4_MEDIA_PUBLIC_BASE_URL` is pinned to that
store's exact public origin. Credential values with surrounding whitespace are
rejected before local validation or remote I/O.

Vercel issues local OIDC tokens only for the development environment through
`vercel env pull`, even when another environment was previously pulled. The
B4.run Blob store connection must therefore include the development environment
for local publication. Pull the token into an untracked or temporary environment
file, export it without printing it, and remove that file after the command. The
preferred invocation is:

```bash
VERCEL_OIDC_TOKEN='<short-lived OIDC token>' \
BLOB_STORE_ID='store_9RQ8eZyGheVy0wOp' \
B4_MEDIA_PUBLIC_BASE_URL='https://9rq8ezyghevy0wop.public.blob.vercel-storage.com' \
pnpm media:readme:upload -- --apply
```

With that correct credential/base/store pairing, rerunning the same authorized
command is the safe convergence path: it performs a fresh complete preflight,
overwrites both stable paths idempotently, verifies every public URL with
`HEAD`, and only then atomically publishes the catalog. Equivalently, an
operator may re-verify both public URLs before publishing the catalog
through the same atomic path.

Committed outputs are:

```text
apps/web/public/demo/product-loop-poster.webp
apps/web/app/lib/demo-media.json
docs/brand/demo/transcript.md
```

The `@b4run/cli`, `@b4run/sdk` and `create-b4-app` READMEs show that poster,
through its `raw.githubusercontent.com` URL, linked to the stable MP4 URL on
the media store, with a “Watch the 50-second navlog demo” link under it (npm
cannot play video). If a new take changes the rounded duration, update that
line and its pins in `scripts/readme-contracts.test.mjs`.

The root README instead embeds the video with GitHub's inline player: a
`https://github.com/user-attachments/assets/…` URL alone on its own line after
the first scaffold command (`DEMO_INLINE_VIDEO_URL` in
`scripts/lib/readme-contracts.mjs`). That copy is hosted by GitHub, not by the
media store, so **whenever the video is re-recorded, upload the new MP4
through github.com** (drag it into an issue or pull request comment), then
replace the URL in `README.md` and `DEMO_INLINE_VIDEO_URL` together. The media
store copy remains the canonical media for the npm READMEs and the website
catalog (`apps/web/app/lib/demo-media.json`). `docs/brand/product-loop.gif`
stays until the next release, because READMEs already published to npm load it
from `main`; nothing regenerates it.

## Visual inspection

Inspect the poster and representative frames from the local MP4 and WebM at
full 1440×810 size and at reduced README and mobile widths; a contact sheet
(`ffmpeg -i <mp4> -vf "fps=1,scale=480:-1,tile=6x10" -frames:v 1 sheet.png`)
shows every second at once. Confirm that the file paths and focal lines, the
plan, the weather verdict, the navlog numbers, the approval card and the filed
reply, the suggested memory, the frame reload, the restored thread, and the
twelve headlines correspond exactly to [the transcript](./demo/transcript.md).
Code text must stay legible in the held frames. No remote upload or store mutation is
part of regeneration or local validation.

The B4.run uploader writes the two stable video paths under `b4/demo/` in the
existing media store. The legacy `demo/` video paths are outside its upload
allowlist. Upload and verify B4.run media before switching the website; retire
legacy media during the domain and website cutover.

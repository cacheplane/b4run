# Brand assets

The B4.run D2.2 logos and the reproducible navlog demo media live here.

## Approved visual system

[Brand guidelines](./guidelines.md) define the approved Paper Relay direction:
paper surfaces, ink typography, yellow-green accents, Inter, and JetBrains Mono.
They take precedence over provisional palette and typography guidance in the
original identity kit. D2.2 vector masters remain authoritative for logo geometry.

The homepage now applies this direction to real agent source and a recorded
repair. Shared public surfaces follow the same paper, ink, and Relay palette.

## Logos

- `b4-logo-horizontal-black-on-white.png` — primary logo, light background.
- `b4-logo-horizontal-white-on-black.png` — inverted, dark background.
- `b4-social-avatar-white-on-black-1024.png` — square social/avatar.

## D2.2 identity kit

The selected Big Dot / Raised stem / Open counter lettering uses native editable
SVG geometry. The compact mark is `b4`; the primary wordmark is `b4.run`.

- [Editable masters and usage sheet](../../apps/web/public/brand/identity/index.html)
- [Public guidelines](../../apps/web/public/brand/identity/guidelines.md)
- [Concise usage guidance](../../apps/web/public/brand/identity/usage-notes.md)
- [Machine-readable manifest](../../apps/web/public/brand/assets.json)
- [Downloadable kit](../../apps/web/public/brand/b4-run-brand-assets.zip)

Existing public logo URLs remain stable. The reference page, usage sheet, notes,
manifest, and ZIP now follow Paper Relay in this repository revision. Tight Shift
files remain available as archived alternatives. The reference uses typography
specimens. Product-loop recordings are independent historical evidence; the
new developer walkthrough has its own recorded repair and evaluation report.

## Repository social preview

- [1280×640 PNG](./b4-repository-social.png) — ready for repository and social sharing.
- [Editable SVG](./b4-repository-social.svg) — supplied wordmark geometry and the
  approved headline. Install the checked-in Inter font when editing.

Regenerate from the repository root with installed dependencies:

```sh
node apps/web/scripts/export-repository-social.mjs
```

The renderer uses the checked-in Inter fonts through an isolated font configuration.
The assets are committed here; GitHub's repository social-preview setting is a
separate upload in repository settings. This script does not change that setting.

## Navlog demo media

The demo video alternates the code behind each navlog feature with the
feature running in the real Workbench, in about 50 seconds. The GitHub and npm
READMEs show its poster, linked to the MP4 on the B4.run media store, with a
“Watch the 50-second navlog demo” link; there is no README animation.

- `demo/transcript.md` — exact static walkthrough of the video, beat by beat.
- `demo/storyboard.mjs` — the twelve beats as data: headlines, the files and
  focal lines of the code beats, and the Workbench action and camera preset of
  the app beats.
- `demo/scenario.mjs` — the two prompts and the deterministic aimock script for
  both turns and both subagents, built from one clock reading.
- `demo/awc-stub.mjs` — the loopback stub of the aviationweather.gov API that
  the weather tools read during a capture.
- `demo/director.mjs` — the director page: headlines, camera, crossfades, the
  code layers, and the frame that holds the real Workbench.
- `demo/capture.mjs` — real internal scaffold, test, Workbench, and Playwright
  capture orchestration, including the approval click.
- `demo/encode.mjs` — trims the recording to the beats and encodes the MP4,
  the WebM, and the poster.
- `demo/check-media.mjs` — local codec, geometry, duration (45–75 s), size
  (12,000,000 bytes per video), poster, transcript, and caption contract
  checker.
- `demo/upload.mjs` — publishes the MP4 and WebM to their stable media-store
  paths and writes `apps/web/app/lib/demo-media.json`.
- `../../apps/web/public/demo/product-loop-poster.webp` — committed poster,
  shown by the READMEs and the website.
- `product-loop.gif` — the earlier README GIF. It stays only because READMEs
  already published to npm load it from `main`; nothing regenerates it.

MP4, WebM, raw Playwright recordings, test logs, summaries, and media manifests
are generated under the gitignored `demo/artifacts/` and
`demo/raw-recordings/` directories. Only the poster, the legacy GIF, the
transcript, the catalog, and the capture sources are committed.

## Regenerate and validate

From the repository root:

```bash
pnpm media:readme:capture
pnpm media:readme:check -- --local
```

See [recording-guide.md](./recording-guide.md) for prerequisites, the
storyboard, deterministic capture boundaries, and asset inspection guidance.
These commands create local assets only. They do not upload media or create a
remote store.

## Determinism and truthfulness

The capture creates the current local navlog starter in internal mode, runs
its real `npm test` path, and drives the generated Workbench against aimock and
a loopback AWC stub. Provider credentials are removed from child environments.
The Workbench has no demo or fixture mode; only its model endpoint and the
server's weather base URL are redirected by the capture process to the
deterministic services. Every tool runs for real against them, and the weather
on screen is the stub's fixed data, which the transcript says.

The capture records one flagship from one page, the director page
(`demo/director.mjs`). Playwright serves it through a route at the Workbench's
own origin, so the request never reaches the Workbench server, and the real
Workbench runs inside its iframe. The code beats show the generated files
unedited, each with its focal line marked.

All motion (headlines, the camera, and crossfades) is CSS on the director
page. The product moments happen in real time inside the frame: the planning
turn, the approval card and the Allow once click, the filing turn, the
suggested memory, the frame reload, and the restored thread. The first prompt
is filled into the composer before recording, and the filing prompt is filled
in one step; the transcript discloses both. Holds are real waits. The encoder
only trims the recording to the beats; it adds no holds, overlays, or labels,
and it never fabricates a source file, test result, tool call, response,
reload, or restored state. The poster is a frame of the encoded MP4.

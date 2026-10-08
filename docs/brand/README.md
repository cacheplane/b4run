# Brand assets

The B4.run D2.2 logos and reproducible product-loop media live here.

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

## Product-loop media

- `product-loop.webp` — committed 960×540, at most 15 fps animated WebP for
  the GitHub and npm READMEs.
- `product-loop.gif` — the earlier README GIF. It stays only because READMEs
  already published to npm load it from `main`; nothing regenerates it.
- `demo/transcript.md` — exact static walkthrough of the flagship.
- `demo/scenario.mjs` — the canonical prompt and deterministic aimock fixture.
- `demo/director.mjs` — the director page: headlines, camera, crossfades, and
  the frame that holds the real Workbench.
- `demo/capture.mjs` — real internal scaffold, test, Workbench, and Playwright
  capture orchestration.
- `demo/encode.mjs` — trims the recording and encodes the flagship, the README
  animation, and the poster.
- `demo/check-media.mjs` — local codec, geometry, duration, size, poster,
  transcript, and caption contract checker.
- `../../apps/web/public/demo/product-loop-poster.webp` — committed poster
  fallback.

MP4, WebM, raw Playwright recordings, test logs, summaries, and media manifests
are generated under the gitignored `demo/artifacts/` and
`demo/raw-recordings/` directories. Only the README animation, the legacy GIF,
the poster, the transcript, and the capture sources are committed.

## Regenerate and validate

From the repository root:

```bash
pnpm media:readme:capture
pnpm media:readme:check -- --local
```

See [recording-guide.md](./recording-guide.md) for prerequisites, the four
beats, deterministic capture boundaries, and asset inspection guidance.
These commands create local assets only. They do not upload media or create a
remote store.

## Determinism and truthfulness

The capture creates the current local navlog starter in internal mode, runs
its real `npm test` path, and drives the generated Workbench against aimock on a
loopback URL. Provider credentials are removed from child environments. The
Workbench has no demo or fixture mode; only its model endpoint is redirected by
the capture process to the deterministic fixture service.

The capture records one flagship from one page, the director page
(`demo/director.mjs`). Playwright serves it through a route at the Workbench's
own origin, so the request never reaches the Workbench server, and the real
Workbench runs inside its iframe. The director page shows the generated route
and shared tool and the real `npm test` output. Normalization strips ANSI,
replaces the temporary workspace root with `<workspace>`, and replaces
duration fields with `<time>`; it preserves test names, PASS/FAIL text,
commands, counts, ports, and other numeric output.

All motion (headlines, the camera, and crossfades) is CSS on the director
page. The product moments happen in real time inside the frame: the run, the
frame reload, and the restored thread. The encoder only trims the recording
to the beats; it adds no holds, overlays, or labels, and it never fabricates
a source file, test result, tool call, response, reload, or restored state.
The poster is a frame of the encoded MP4.

The README animation is an animated WebP because the camera zooms and blur
crossfades make a GIF under the 4 MB budget impossible. ffmpeg has no WebP
encoder in the supported toolchain, so ffmpeg writes a 960×540 256-colour
intermediate GIF and sharp converts it to the published WebP.

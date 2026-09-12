# Brand assets

The B4.run D2.2 logos and reproducible product-loop media live here.

## Approved visual system

[Brand guidelines](./guidelines.md) define the approved Paper Relay direction:
paper surfaces, ink typography, yellow-green accents, Inter, and JetBrains Mono.
They take precedence over provisional palette and typography guidance in the
original identity kit. D2.2 vector masters remain authoritative for logo geometry.

The guidelines formalize the visual identity. The homepage narrative and
structure will be rebuilt in a later phase; the current homepage and review
mockups do not constrain that redesign.

## Logos

- `b4-logo-horizontal-black-on-white.png` — primary logo, light background.
- `b4-logo-horizontal-white-on-black.png` — inverted, dark background.
- `b4-social-avatar-white-on-black-1024.png` — square social/avatar.

## D2.2 identity kit

The selected Big Dot / Raised stem / Open counter lettering uses native editable
SVG geometry. The compact mark is `b4`; the primary wordmark is `b4.run`.

- [Editable masters and usage sheet](../../apps/web/public/brand/identity/index.html)
- [Usage guidance and palettes](../../apps/web/public/brand/identity/usage-notes.md)
- [Machine-readable manifest](../../apps/web/public/brand/assets.json)
- [Downloadable kit](../../apps/web/public/brand/b4-run-brand-assets.zip)

Existing public logo URLs remain stable. This original kit supplies monochrome,
Relay, and Tight Shift alternatives. Its usage sheet, notes, and ZIP are an earlier
snapshot; synchronizing them to the approved guidelines is a subsequent task.
The documentation mockup in the usage sheet contains provisional messaging,
not replacement website copy. These guidelines do not change live styling or
favicon selection. Product-loop recordings are independent of this kit.

## Product-loop media

- `product-loop.gif` — committed 1440×810, 30 fps GitHub/npm animation.
- `demo/transcript.md` — exact static walkthrough for the flagship and three
  derivative clips.
- `demo/scenario.mjs` — the canonical prompt and deterministic aimock fixture.
- `demo/capture.mjs` — real internal scaffold, test, Workbench, and Playwright
  capture orchestration.
- `demo/encode.mjs` — product-loop, Author, Test, and Run timeline encoder.
- `demo/check-media.mjs` — local codec, geometry, duration, size, poster,
  transcript, and caption contract checker.
- `../../apps/web/public/demo/*-poster.webp` — committed poster fallbacks.

MP4, WebM, raw Playwright recordings, test logs, summaries, and media manifests
are generated under the gitignored `demo/artifacts/` and
`demo/raw-recordings/` directories. Only the flagship GIF, four posters,
transcript, and capture sources are committed.

## Regenerate and validate

From the repository root:

```bash
pnpm media:readme:capture
pnpm media:readme:check -- --local
```

See [recording-guide.md](./recording-guide.md) for prerequisites, the four
timelines, deterministic capture boundaries, and asset inspection guidance.
These commands create local assets only. They do not upload media or create a
remote store.

## Determinism and truthfulness

The capture creates the current local research starter in internal mode, runs
its real `npm test` path, and drives the generated Workbench against aimock on a
loopback URL. Provider credentials are removed from child environments. The
Workbench has no demo or fixture mode; only its model endpoint is redirected by
the capture process to the deterministic fixture service.

The Author and Test compositors display generated source and real command output.
Normalization strips ANSI, replaces the temporary workspace root with
`<workspace>`, and replaces duration fields with `<time>`; it preserves test
names, PASS/FAIL text, commands, counts, ports, and other numeric output.

Because the raw captured scenes are intentionally brief, encoding uses honest
frozen-frame holds around those same frames for legibility. It never fabricates
a source file, test result, tool call, response, reload, or restored state.
Sharp renders deterministic **Author**, **Prove**, and **Run** label chips into
the ignored run artifacts; ffmpeg composites them over the matching captured
segments. Posters are extracted from the labeled MP4 output, so their act and
footage remain in sync without changing B4.run runtime behavior.

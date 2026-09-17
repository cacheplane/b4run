---
"@b4run/cli": patch
"@b4run/core": patch
---

Let `build.vercel` describe the whole Vercel Build Output tree: a `static` directory with an optional SPA fallback, extra Node `functions` bundled from an entry with `runtime`/`maxDuration`/`supportsResponseStreaming`, and `routes` ordered ahead of the filesystem phase, the runtime function, and the SPA fallback. The runtime function is named `b4.func` once static assets are configured (or whatever `functionName` says) so it no longer shadows `static/index.html`; a bare runtime build still emits `index.func` behind the same catch-all. `validateVercelOutput` accepts the composed tree while keeping the runtime function config exact.

Under a SPA fallback the runtime route is scoped to the surfaces the runtime owns — `/healthz`, `/readyz`, `/agui`, `/threads`, `/memory` — so every other path reaches the SPA document. A surface missing from that list would serve HTML with a 200 instead of reaching the runtime, so the composed route is covered by a test per surface.

The runtime function now declares `supportsResponseStreaming: true`. It serves SSE on `/agui/:routeId` and `/threads/:id/runs/stream`, and without the flag Vercel's Node launcher buffers the response, so a deployed frontend received nothing until a run finished. Extra functions could already opt in; the function that always streams could not.

These keys join `reconcileVercelJson` in one validated `build.vercel`: a single resolver owns the shape, so `b4 check` and `b4 build` reject an unknown key or a malformed value the same way for every option, and the composed tree is only built from a shape that was checked.

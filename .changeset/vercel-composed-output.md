---
"@b4run/cli": patch
"@b4run/core": patch
---

Let `build.vercel` describe the whole Vercel Build Output tree: a `static` directory with an optional SPA fallback, extra Node `functions` bundled from an entry with `runtime`/`maxDuration`/`supportsResponseStreaming`, and `routes` ordered ahead of the filesystem phase, the runtime function, and the SPA fallback. The runtime function is named `b4.func` once static assets are configured (or whatever `functionName` says) so it no longer shadows `static/index.html`; a bare runtime build still emits `index.func` behind the same catch-all. `validateVercelOutput` accepts the composed tree while keeping the runtime function config exact.

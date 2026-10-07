---
"@b4run/devkit": patch
---

The navlog template plans from a demo aircraft baseline, `workspace/aircraft/c172n.md` (N734ST, 50 gal usable, 2400 RPM), which the agent reads with `readDoc` alongside `recall`; a recalled fact overrides it and the pilot's request overrides both. Its `b4.config.ts` wraps the workspace filesystem with a `readOnlyPaths` middleware, so the agent can no longer rewrite `AGENTS.md`, `aircraft/`, `poh/` or `regs/`, which every thread shares. The template now depends on `@b4run/workspace`.

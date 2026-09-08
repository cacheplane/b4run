---
"@b4run/sdk": patch
---

Rename the framework to B4.run and publish the package family under `@b4run`.
Use `b4`, `b4.config.ts`, `.b4`, and `create-b4-app` for the CLI, configuration,
local state, and scaffold. Branded public types and environment variables use
the B4 prefix. Existing package names, config files, state locations and exported
aliases are not supported by this release.

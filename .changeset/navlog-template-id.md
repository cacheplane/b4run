---
"create-b4-app": patch
"@b4run/devkit": patch
---

The research scaffold is now the `navlog` template: `npm create b4-app -- --template navlog`. The `research` id still works in `create-b4-app` for one release and prints a deprecation notice; `@b4run/devkit`'s `resolveTemplateDir` accepts only `basic` and `navlog`. The scaffold's route is now `/navlog` (`/navlog#agent`). Only names changed in this release; the flight-planning retheme follows.

---
"@b4run/cli": patch
---

Name the Vercel runtime function `b4.func` in every build. It was `index.func` unless `build.vercel.static` was configured, but the Build Output API also serves a function named `index` at `/`, where it shadows a static `index.html`. That hazard belongs to the name rather than to whether a particular build emits static assets, so the name is off the root always and an app that grows a frontend later does not have to rename its function to get one.

`.vercel/output/functions/b4.func/` replaces `.vercel/output/functions/index.func/`, and `config.json` routes to `/b4`. Anything reading the published tree by path, such as a local smoke script importing the bundle, follows the new path. `build.vercel.functionName: "index"` restores the old layout for a build with no static assets.

---
"@b4run/workspace": minor
"@b4run/cli": minor
---

`sandbox.workspace` may now be a `WorkspaceResolver`: host code called once per thread, at first admission, with the thread id and its stored client metadata, returning that thread's initial workspace definition. The result is captured and recorded by digest exactly as a static definition is; `b4 build` records a resolver marker in place of captured source and startup refuses an artifact whose form disagrees with the config; `b4 check` reports the per-thread form.

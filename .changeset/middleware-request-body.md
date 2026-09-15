---
"@b4run/sdk": patch
"@b4run/cli": patch
---

Expose a detached parsed request body to execution middleware on AG-UI and
Agent Protocol POST endpoints. Applications can validate client context and
resume decisions through the existing middleware API without modifying runtime
input or adding protocol-specific hooks.

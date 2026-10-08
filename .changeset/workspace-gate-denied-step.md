---
"@b4run/core": patch
---

A refused workspace operation settles as a denial, not a failure. When the permission gate refuses `runBash` (a person chose Deny, a deny rule matched, or non-interactive mode failed closed) or a file tool's path, the built-in workspace tool now returns the reason as a branded denial result, the way `tools.approve` does, instead of throwing it. The model reads "Permission denied by user: …" as the call's result rather than "Error: … Please fix your mistakes.", and the call's step settles as `denied`, so B4.run's chat components show "Denied" instead of a failed step. A workspace handle used directly (`ctx.fs`) still throws.

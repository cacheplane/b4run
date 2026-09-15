---
"@b4run/workspace": patch
"@b4run/sandbox": patch
---

Add bounded text workspace inspection for author filesystem handles and sandbox handles, with strict UTF-8, executable and symlink checks, exact expected dependency links, and cancellation support.

Bound built-in filesystem reads before collecting content so a growing file cannot bypass an explicit byte limit.

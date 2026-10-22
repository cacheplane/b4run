---
"@b4run/cli": patch
---

`b4 start` now validates the `PORT` environment variable before starting the server. Non-integer and out-of-range values report `Invalid port` instead of crashing in `net.listen`. Port `0` remains supported for a kernel-assigned port. Fixes #1063.

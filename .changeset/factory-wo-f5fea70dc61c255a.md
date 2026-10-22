---
"@b4run/cli": patch
---

`b4 start --port` now rejects values above 65535 with `Invalid port` instead of crashing with Node's `ERR_SOCKET_BAD_PORT`. Fixes #1047.

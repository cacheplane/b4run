---
"@b4run/cli": patch
---

`--port` has no upper bound: `b4 start --port 70000` crashes with Node's `ERR_SOCKET_BAD_PORT` instead of `Invalid port`. Refs #1047.

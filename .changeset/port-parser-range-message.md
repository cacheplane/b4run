---
"@b4run/cli": patch
---

An invalid `--port` now names the accepted range: `b4 dev` and `b4 inspect` report `Invalid port: <value> (expected an integer from 1 to 65535)`, and `b4 start` reports `0 to 65535`, since it accepts `0` for a kernel-assigned port.

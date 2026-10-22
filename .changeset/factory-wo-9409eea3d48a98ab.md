---
"@b4run/cli": patch
---

cli: a non-integer or out-of-range `PORT` env var reaches `net.listen` and crashes `b4 start`. Refs #1063.

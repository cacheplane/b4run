---
"@b4run/cli": patch
---

Validate `PORT` in `resolveServePort` to only accept decimal digits representing ports between 0 and 65535, falling back to 8000 on invalid values.

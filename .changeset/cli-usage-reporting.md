---
"@b4run/cli": patch
---

`b4` reports anonymous usage signals for development-time commands (`dev`, `build`, `add`, `check`, `typegen`, `verify`, `eval`) after a one-time notice. `b4 start` never reports. Disable with `B4_TELEMETRY_DISABLED=1` or `DO_NOT_TRACK=1`; CI is silent automatically. Details: https://b4.run/privacy

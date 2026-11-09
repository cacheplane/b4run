---
"@b4run/cli": patch
"@b4run/sdk": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Stage exact-execution stop, actual-unwind shutdown/deadline handling, and guarded temporary Thread cleanup with independent protected Run/result retention. Native storage now records unwind in its fenced release transaction and preserves uncertain ownership loss. Existing HTTP/native handlers and the physical provider cleanup bridge remain awaiting the coordinated runtime cutover.

Shutdown preserves dispatch/control failures after aborting and awaiting owned work. Retained search, retry and receipt reads validate canonical contributing authority and the original protected subject before returning data.

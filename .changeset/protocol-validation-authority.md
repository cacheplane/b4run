---
"@b4run/cli": patch
"@b4run/sdk": patch
---

Add shared Agent Protocol request validation, safe public error mapping, and scoped resource authorization helpers with distinct control and provenance context. Validate original webhook URI strings using the pinned format matcher without runtime schema compilation. Correct the shared custom-channel pattern translation to preserve pinned CDDL matching semantics.

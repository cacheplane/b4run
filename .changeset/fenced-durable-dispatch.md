---
"@b4run/cli": patch
"@b4run/sdk": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Add staged durable dispatch with atomic started markers, fenced execution ownership and conservative recovery for lost started Runs. Preserve accepted never-started work and retained receipts across ownership recovery without replaying uncertain effects.

---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Approval grant records are now pruned. Every `InterruptGrantStore` gains `prune({ before })`, which deletes consumed or voided records whose settle time (`voidedAt`, else `consumedAt`) is before `before`. Outstanding grants are never deleted, however old: a parked prompt with no grant row resumes without a grant under `approvals.grants: "optional"`, so an expired grant keeps its row until the thread moves past it. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement it.

`approvals.grantStore` is now shape-checked at boot: a store missing any method, `prune` included, fails the boot naming the missing methods. A custom store written before this release must add `prune`.

The runtime sweeps the store wherever it voids superseded grants, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `approvals.grantRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot). `b4 approvals prune [--retention <ms>]` runs the same pass by hand.

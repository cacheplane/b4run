---
"@b4run/sdk": patch
"@b4run/core": patch
"@b4run/cli": patch
"@b4run/sqlite-storage": patch
"@b4run/postgres-storage": patch
---

Approval grant records are now pruned. Every `InterruptGrantStore` gains `prune({ before })`, which deletes records whose `voidedAt` is before `before` and nothing else. `voidOutstanding` now also voids consumed grants whose prompt the thread moved past (every unvoided row of the thread not in the keep list), so a consumed grant is voided once its resumed turn completes and ages out from there; a consumed grant whose resume never completed, and an outstanding grant however old, are never deleted: in both cases the prompt is still parked, and a parked prompt with no grant row resumes without a grant under `approvals.grants: "optional"`. The SDK memory store, `@b4run/sqlite-storage` and `@b4run/postgres-storage` implement both; a custom store must match.

`approvals.grantStore` is now shape-checked at boot while grants are on: a store missing any method, `prune` included, fails the boot naming the missing methods. A custom store written before this release must add `prune`.

The runtime sweeps the store wherever it voids superseded grants, at most once an hour per store, and a failing sweep is logged without affecting the turn. The window is the new `approvals.grantRetentionMs` (default 7 days, a positive integer of at most one year, anything else fails the boot). `b4 approvals prune [--retention <ms>]` runs the same pass by hand.

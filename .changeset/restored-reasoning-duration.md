---
"@b4run/ag-ui": patch
---

A restored thread's reasoning reads "Show reasoning" instead of "Thought for <1s". The checkpoint keeps no reasoning timing, so the replay stamps a span's start and end with its message's one checkpoint time; `reduceTurns` now keeps a span that ends at the instant it started without a `settledAt`, so its length reads as unknown rather than zero.

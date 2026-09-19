---
"@b4run/ag-ui": minor
"@b4run/cli": minor
"@b4run/core": minor
"@b4run/langchain": minor
"@b4run/postgres-storage": minor
"@b4run/sdk": minor
"@b4run/sqlite-storage": minor
---

Add **approval grants**: a single-use capability bound to one parked tool call, minted when B4.run parks a human-in-the-loop approval and required when that approval is answered.

Until now a parked approval was addressed by `interruptId` and `resumeKey`, and neither is a credential — `interruptId` is a timestamp plus ~31 bits of `Math.random`, disclosed in the persisted envelope, and `resumeKey` is LangGraph's deterministic position hash. `ThreadAccessPolicy` gates *who* may touch a thread, but disclosure control is not consumption control: inside a session that legitimately holds the thread, nothing stopped the same approval being answered twice (applying a financial allocation twice) or an approval minted against an earlier proposal being applied to the current one. Replay protection was emergent from LangGraph advancing the checkpoint, not enforced or tested.

A grant is 32 CSPRNG bytes, stored only as a SHA-256 hash in a B4-owned table added by an additive versioned migration under the existing `runMigrations` advisory lock. It is minted at the park site in `@b4run/core`, reaches the client on the channels that already carry the prompt (the AG-UI interrupt, `GET /threads/:id/pending_interrupts`, the attach `state` frame), and comes back as an opaque `grant` on the resume entry. Consumption is a conditional `UPDATE … WHERE consumed_at IS NULL` — atomic, durable, replica-safe. A reused grant gives `409 grant_consumed` echoing the recorded decision rather than re-executing; a wrong grant gives `403 grant_invalid`, indistinguishable from "no such row" so the endpoint is not an oracle; a grant whose parked call the thread has moved past is voided and gives `409 stale_interrupt`. `deny` and `cancelled` consume the grant too — a denial is a decision, and a re-answerable denial is a replay surface of its own.

Off by default. `approvals.grants` in `b4.config.ts` takes `"off"` (unchanged behavior), `"optional"` (an interrupt that **has** a grant requires it; one parked without a grant resumes as before — the softness is per-interrupt-age, never per-request, or `"optional"` would be a bypass), or `"required"`. The minter is injected through LangGraph's `config.configurable`, the same channel this repo already uses for live per-call identity, so nothing in core's call graph grows a storage handle. That injection is optional by construction, and the absence **fails closed**: under `"required"`, a park with no minter aborts the turn loudly rather than parking a prompt that cannot be answered safely.

Two limits, stated rather than implied. At-most-once *delivery* is not exactly-once *effect* — an application's own idempotency key does not become redundant. And the plaintext grant is at rest in the checkpointer's `writes`, because the park site carries it in the interrupt envelope; the hash-only grant store protects the consumption ledger, not the checkpoint.

# Approval grants — a single-use capability bound to the parked tool call

Status: proposal (2026-09-18) — design note only, no implementation
Author: Brian Love (with Claude)
Issue: cacheplane/b4run#736

## Problem

B4.run parks a tool call for human approval and resumes it when an answer arrives. It does
not say **who** may answer, or **how many times**.

Today a parked approval is addressed by two values, and neither is a credential:

- `interruptId` — minted at `packages/core/src/capabilities/permission-gate.ts:425`:

  ```ts
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  ```

  A millisecond timestamp plus roughly 31 bits of non-cryptographic randomness. It is also
  disclosed well outside the gated path: it lives in the envelope that `interrupt(payload)`
  parks (`permission-gate.ts:436-466`), which is persisted verbatim and copied wholesale into
  the AG-UI interrupt's `metadata` (`packages/ag-ui/src/interrupts.ts:63`).

- `resumeKey` — not B4's at all. It is LangGraph's own interrupt id, an XXH3-128 hash of the
  checkpoint namespace string, rendered as 32 hex chars. B4 only recognizes its shape
  (`packages/cli/src/lib/dev/pending-interrupts.ts:228`, `const RESUME_KEY_PATTERN =
  /^[0-9a-f]{32}$/`). It is deterministic and position-derived: the same node at the same graph
  position always yields the same value. It carries no randomness and no per-request secret.

`packages/sdk/src/thread-access.ts:53-56` already names the pair as what it is — "the
credential an attacker needs to resume someone else's turn" — and gates its disclosure. That
work is correct and this design does not touch it. But **disclosure control is not
consumption control.** Inside a session that legitimately holds the thread, nothing stops:

1. **Replay.** The same answer submitted twice, applying a financial allocation twice.
2. **Staleness.** An answer minted against an earlier proposal applied to the current one.

What exists today instead of a check:

- `createPendingResumeClaims` (`pending-interrupts.ts:138`) is an in-process `Set<string>`
  keyed by **thread**, not by interrupt. It is a mutex that answers "is a resume in flight",
  never "was this answered before". It dies with the process and does not span replicas.
- `resolvePendingResume` (`pending-interrupts.ts:154`) matches by **exact set equality on
  `interruptId`** and then translates to `resumeKey`. There is no consumption record, no nonce,
  no expiry, and no "already used" flag anywhere in the repo.
- Replay protection is therefore entirely **emergent**: once LangGraph consumes the pending
  writes and advances the checkpoint, a replayed body gets `409 resume_required` /
  `stale_interrupt` because the pending set is empty. That is a side effect of LangGraph's
  semantics, not a property B4 enforces or tests.

The motivating application is the hashbrown invoicing example's
[`review-coordinator.ts`](https://github.com/liveloveapp/hashbrown/blob/main/examples/invoicing/server/src/review-coordinator.ts)
— 347 lines, of which roughly 150 are capability plumbing rather than invoicing: a server-only
token per decision slot stored on the thread record and never serialized to the browser,
convergent minting under compare-and-swap contention (with a `review_contention` outcome after
two conflicts), and an operation id recorded on an applied proposal so a replay returns the
first result instead of allocating again. Its own doc comment marks the seam:

> *"A once payload is only a requested decision. The B4 runtime must validate its actual
> pending interrupt before calling apply; this guard cannot prove that."*

That is the application stating the limit of what it can prove from outside the runtime. The
runtime knows the thread, the run, the exact tool call, and the checkpoint. It should mint the
proof.

## Proposal, in one paragraph

When B4 parks an interrupt it mints a **grant**: a high-entropy, server-generated, single-use
capability bound to that one parked call at that one checkpoint. The grant's hash is stored in
a B4-owned table. The plaintext reaches the client through the same already-gated channels the
prompt does, and the client echoes it opaquely on resume. Consumption is a conditional UPDATE,
so it is atomic, durable, and replica-safe. A second resume with the same grant is rejected
rather than re-executed; a grant for a different parked call does not match; a grant whose
checkpoint has been superseded is void.

## 1. Where the grant lives, and what it is bound to

### A new B4-owned table

```sql
CREATE TABLE interrupt_grants (
  thread_id         text    NOT NULL,
  interrupt_id      text    NOT NULL,   -- the envelope's own id
  resume_key        text    NOT NULL,   -- LangGraph's XXH3 position hash
  checkpoint_id     text    NOT NULL,   -- the checkpoint that parked it
  token_hash        text    NOT NULL,   -- SHA-256 of the grant; never the grant
  issued_at         text    NOT NULL,
  expires_at        text,               -- NULL = no TTL
  consumed_at       text,
  consumed_decision text,               -- 'once' | 'always' | 'deny'
  voided_at         text,
  PRIMARY KEY (thread_id, interrupt_id)
);
CREATE INDEX idx_interrupt_grants_thread ON interrupt_grants (thread_id, checkpoint_id);
```

Additive in both stores, alongside the existing checkpointer migrations at
`packages/postgres-storage/src/schema.ts:231` and
`packages/sqlite-storage/src/checkpointer/schema.ts:7-28`. **No change to `checkpoints` or
`writes`.**

The grant itself: 32 bytes from `crypto.randomBytes`, base64url, prefixed `b4ag_`. Only the
hash is stored, for the same reason a password is not stored — an operator with read access to
the database, or a leaked backup, must not thereby be able to answer approval prompts.

### Bound to

The tuple `(thread_id, interrupt_id, resume_key, checkpoint_id)`. All four are checked on
resume. `interrupt_id` binds it to the decision; `resume_key` binds it to the graph position,
so a grant cannot answer a structurally different park that reused an id; `checkpoint_id` is
what makes "the thread moved on" a fact B4 can assert rather than a behavior it inherits.

**Deliberately NOT bound to caller identity.** See §4.

### Why not the three obvious cheaper places

- **Thread metadata.** `GET /threads/:id` echoes stored metadata verbatim
  (`runtime-fetch-core.ts:925-936`), `ThreadSubject.metadata` is documented UNTRUSTED and
  client-writable (`thread-access.ts:82-88`), and `parked-route.ts:52` already had to mark its
  own key **NOT SECRET** for precisely this reason. Metadata is also one object per thread, so
  concurrent parks would contend on it — which is exactly the compare-and-swap machinery the
  invoicing example had to write, re-created inside the runtime for no reason.
- **The `writes` blob.** It is LangGraph's, it is returned to clients, and it is deleted on
  LangGraph's schedule rather than ours — we would lose the consumption record at exactly the
  moment we need it to answer a replay.
- **The envelope.** Putting the grant in the `interrupt(payload)` object would persist it in
  cleartext in `writes` and copy it into AG-UI `metadata`. The grant is attached at projection
  time, from the table, never from the envelope.

## 2. How it reaches the client, and how the client returns it

### Out

Through the channels that already carry the prompt, and only those, so that there is exactly
one disclosure gate to reason about.

- **Live (AG-UI).** `toAguiInterrupt` (`packages/ag-ui/src/interrupts.ts:39`) gains a
  top-level `grant` field on the emitted `Interrupt`. Top-level, not inside `metadata` — the
  `metadata` field is a verbatim copy of the envelope (`:63`) and the grant is not in the
  envelope.
- **Durable.** `GET /threads/:id/pending_interrupts` (`runtime-fetch-core.ts:2912-2919`) and
  the attach `state` frame (`:3110-3123`) already return `{ interruptId, resumeKey, value }`
  per parked interrupt; each gains `grant`. Both are already gated on
  `thread.pending_interrupts` / `thread.attach` **in addition to** the parking route's
  middleware, composed as AND (`thread-access.ts:51-67`). The grant inherits that gate exactly.

**The grant is re-readable, not read-once.** A client that reattaches after a reload must be
able to get it again, and reattach is a supported path. Single-use is a property of
**consumption**, not of disclosure. Stating this plainly because the opposite assumption is a
natural one and would break `GET /threads/:id/runs/stream`.

### Back

Per-entry in the resume body, not a header — a resume body carries one entry per pending
interrupt, and `resolvePendingResume` requires the set to match exactly.

```ts
/** A resume instruction addressed to one open B4.run interrupt. */
export interface B4ResumeRequest {
  readonly interruptId: string
  readonly status: "resolved" | "cancelled"
  readonly payload?: unknown
  /**
   * The single-use capability the parked prompt carried. Opaque: the client
   * echoes it and authors nothing about the decision beyond `status`/`payload`.
   * Optional at the type level for migration only; required at runtime under
   * `approvals.grants: "required"`. See §6.
   */
  readonly grant?: string
}
```

The same field on `B4ResumeEntry` (`pending-interrupts.ts:3`), and the body validator
`isB4ResumeBody` (`runtime-fetch-core.ts:3640`) extends its exact-key-set check to admit
`grant` on both the `resolved` and `cancelled` shapes.

## 3. The resume API, and every failure

Order at `POST /threads/:id/resume`, and at the resuming branch of `POST /agui/:routeId`:

1. **Thread-access gate.** Unchanged, and still first. The ordering exception documented at
   `runtime-fetch-core.ts:3236-3262` — the gate runs before `tryClaim` and therefore before
   middleware, because a denied caller must not be able to take the victim's claim, and must
   not be able to read 400/409 codes as an oracle on the victim's parked set — holds
   unchanged and applies to grant validation too. **Grant checks never run before the access
   gate**, or they become the oracle that comment exists to prevent.
2. **`tryClaim`.** Unchanged. Still the in-flight mutex.
3. Read pending interrupts and the thread's grant rows.
4. **Per entry, validate the grant.** Look up by `(threadId, interruptId)`; constant-time
   compare `SHA-256(presented)` against `token_hash`; check `resume_key` and `checkpoint_id`
   against the live pending entry; check `voided_at`, `expires_at`, `consumed_at`.
5. **Existing exact-set match** (`resolvePendingResume`), unchanged.
6. **Consume**, as a conditional update:

   ```sql
   UPDATE interrupt_grants SET consumed_at = ?, consumed_decision = ?
    WHERE thread_id = ? AND interrupt_id = ? AND consumed_at IS NULL AND voided_at IS NULL
   ```

   Zero rows affected means someone else consumed it first. This is the single-use point: it
   is atomic, it survives process restart, and it spans replicas — none of which
   `createPendingResumeClaims` does.

7. Deliver the resume to the graph.

**Consume before execute.** A crash between step 6 and step 7 loses the approval — the human
is prompted again — rather than risking a double application. That direction is chosen
deliberately, and it is the honest statement of what this buys: **at-most-once delivery, not
exactly-once effect.** See §5.

### Outcomes

| Situation | Result |
|---|---|
| Valid, first use | Resume proceeds exactly as today |
| **Grant reused** | `409 grant_consumed`, with `consumedAt` and the recorded `consumedDecision` echoed back, so a double-submitting UI renders "already approved" instead of re-prompting. **Not re-executed.** |
| **Grant for a different parked call** | `403 grant_invalid`. The lookup is keyed by `(thread, interruptId)`, so a grant minted for another interrupt simply fails the hash comparison. |
| No grant row, wrong thread, malformed grant | `403 grant_invalid` — the **same** code and body as above, so the endpoint does not become an oracle distinguishing "no such interrupt" from "wrong grant". Matches the existing discipline at `:3249`. |
| **Grant after the thread moved on** | `409 stale_interrupt` — the existing code. The grant's `checkpoint_id` no longer matches, or the interrupt is no longer pending. Additionally, when a turn settles, every outstanding grant for that thread's superseded checkpoint is stamped `voided_at`, so a stale approval can never be applied later. **This is the fix for the staleness half of the issue**; today the only defense is emergent. |
| Expired | `409 grant_expired`. TTL is opt-in and defaults to none — a human approval may legitimately sit overnight. |
| Missing grant, `required` mode | `400 grant_required` |
| Missing grant, `optional` mode, interrupt has a grant row | `403 grant_invalid` — see §6 |

## 4. Composition with the thread-access policy

Two layers. One axis each. Composed as AND, in a fixed order. No overlap.

| | `ThreadAccessPolicy` | Grant |
|---|---|---|
| Question | **Who** is this caller, and may they touch this thread at all | **Which** parked call is this answering, and is this the **first** answer |
| Knows about | Headers, identity, tenancy, the stamp, `resuming` | The thread, the interrupt, the checkpoint, the consumption record |
| Knows nothing about | Which interrupt, how many times | Who the caller is |
| Runs | First, always | Second, only after an allow |
| Failure | 403/404, policy's choice (`thread-access.ts:176-187`) | 403/409, fixed by the runtime |

`ThreadAccessPolicy` is coarse by construction: it cannot distinguish two resumes of the same
thread by the same caller, and it should not try. `ThreadAccessRequest.resuming`
(`thread-access.ts:134-159`) stays exactly as documented — the flag that lets a policy hold
resumes to a higher bar (step-up auth, a second approver, extra logging).

Three things this design explicitly does **not** do, each of which would create overlap:

- **It does not bind the grant to caller identity.** The runtime has no identity model, on
  purpose; `thread-access.ts:1-11` is a whole file existing because gating on the wrong axis is
  a real failure mode. If an app wants "the same human who was prompted must answer", that is a
  question its policy answers from its own identity, in `update` with `req.resuming === true`.
  Binding to a header the runtime does not understand would be theater.
- **It does not give the policy the grant value.** Adding a `grantPresent` or `grant` field to
  `ThreadAccessRequest` would tempt policies to authorize on a client-supplied value *before it
  has been verified* — and verification happens after the gate, by design.
- **It does not replace `createPendingResumeClaims`.** The claim answers "is one resume in
  flight"; the grant answers "was this answered before". Different questions, both needed. The
  claim stays.

## 5. What stays the application's job

Stated bluntly, because the value of this feature depends on not overselling it.

1. **What a decision MEANS.** B4's vocabulary is `once` / `always` / `deny` over a tool call.
   "Approve allocating $4,812.00 of payment P to invoice I" is not in that vocabulary and will
   not be. The grant is surfaced to the app on resume so it can attach its own meaning —
   exactly what the invoicing example does with its decision slots.
2. **Idempotency of the effect.** At-most-once *delivery* is not exactly-once *side effect*. A
   tool that half-applied a ledger write before crashing is still half-applied. The invoicing
   example's `operationId` replay protection does **not** become redundant and must stay.
3. **Binding the decision to the domain object the human was shown.** The runtime knows the
   tool call; it does not know which proposal version was on screen. Invoicing's
   `proposal_identity_conflict` check stays app-side.
4. **Authority.** Whether *this* human may approve *this* amount — approval limits, four-eyes,
   segregation of duties.
5. **Audit in domain terms.** The grants table records that an approval was consumed at a time
   with a decision. It does not record who, or why, or against what.

## 6. Migration

Config gate, `approvals.grants` in `b4.config.ts`:

- **`"off"`** — grants are minted and disclosed but never required. Escape hatch.
- **`"optional"`** — the default for one minor release.
- **`"required"`** — the default at the next major.

The load-bearing rule under `"optional"`:

> An interrupt that **has** a grant row **requires** its grant. An interrupt with **no** grant
> row — one parked before the migration — resumes exactly as today.

The softness is therefore per-interrupt-age, not per-request. Without that rule `"optional"`
would be a bypass: omit the grant, get the old path.

Consequences, stated:

- Threads parked before the migration cannot be retrofitted. Minting a grant after the fact
  would mean minting it for a prompt already disclosed to whoever saw it, which proves nothing.
  Under `"required"` they resolve to `409 grant_unavailable`, telling the operator the prompt
  must be re-parked. The residual set is small and bounded — it drains as those threads settle.
- No client change is forced at `"optional"`: `grant` is additive on the wire and an old client
  ignoring it is unaffected for old threads and correctly rejected for new ones.
- `@b4/testing`'s harness `resume` (`packages/testing/src/harness.ts:143`) should thread grants
  through automatically from the parked snapshot, so existing agent tests do not all have to be
  rewritten.
- The migration adds a table. It does not alter `checkpoints`, `writes`, or `threads`, so it is
  reversible by dropping one table plus setting `"off"`.

## 7. Considered and rejected

1. **Make `interruptId` itself unguessable and single-use.** The cheapest change by far.
   Rejected: `interruptId` is already disclosed in the persisted envelope and echoed by the
   ungated `GET /threads/:id/state` (the threat-model comment at `runtime-fetch-core.ts:2800`
   says so in as many words), and it is an addressing value that appears in logs and as a UI
   key. Conflating the *name* of a thing with the *right to act on it* is the bug being fixed;
   doing it harder is not the fix. And `resumeKey` is LangGraph's deterministic position hash —
   not ours to make secret.
2. **A signed stateless token (HMAC / JWT), no table.** Genuinely attractive: no migration, no
   write on the park path, trivially replica-safe. Rejected because **single-use is inherently
   stateful.** You cannot consume or revoke a stateless token without a store, so a consumed-ids
   table appears anyway — at which point statelessness buys only the absence of a mint-time
   write, and costs a signing key to provision, protect and rotate. It also cannot express "the
   thread moved on" without reading the checkpoint, which is a store read.
3. **Per-decision-slot tokens, as the invoicing example mints them** (`initial` / `once` /
   `cancelled`). Rejected for the runtime: those slots are the *app's* decision vocabulary, and
   the convergent compare-and-swap minting exists only because the app mints from outside,
   racing itself across concurrent runs. The runtime mints once, at park time, in the same
   write as the park. There is no contention to converge.
4. **Deliver the grant only once, at park time.** Rejected: breaks reattach, a supported path
   (`GET /threads/:id/runs/stream`, durable branch).
5. **Make `createPendingResumeClaims` durable and reuse it.** Rejected: it is keyed by thread
   and it is a mutex, not a ledger. Making it durable would answer a question we are not asking.
6. **Bind the grant to caller identity inside the runtime.** Rejected — §4.
7. **Put the grant in thread metadata.** Rejected — §1.

## 8. Open questions a human must settle

1. **Where minting actually happens.** The park occurs inside LangGraph's `interrupt()` throw
   at `permission-gate.ts:466`, in `packages/core`, which has no storage handle and deliberately
   holds no interrupt persistence at all. Either core grows an injected grant-minting port, or
   the CLI layer mints after reading the checkpoint once the park settles. The latter is much
   easier and opens a window in which an interrupt is visible with no grant — under `"optional"`
   that window is a bypass. This is the single largest open question and it decides the shape of
   the PR.
2. **Does a `deny` / `cancelled` consume the grant?** Recommendation: yes — a denial is a
   decision, and a re-answerable denial is a replay surface. Needs confirming against how UIs
   currently handle cancel.
3. **Subagent interrupts** carry `callId` and a child `threadId`
   (`permission-gate.ts:167-210`). Which thread owns the grant row — the parent or the child?
4. **Should `always` be grantable at all?** `always` writes a durable permission
   (`permission-gate.ts:477`). It is not one decision; it is a policy change. It may warrant a
   separate, stronger gate than a single-use grant.
5. **Should `resumeKey` stop crossing the wire** once grants are required? It is disclosed
   today only because it was the addressing half of the credential. If the grant carries the
   authority, the `resumeKey` could stay server-side — a strict improvement, and a breaking
   change to `AttachInterrupt` (`packages/cli/src/lib/threads/attach-state.ts:13`).
6. **Default TTL and the deprecation window** for `"optional"` → `"required"`.
7. **Should `interruptId`'s `Math.random` be replaced** regardless? It is not a credential under
   this design, but ~31 bits of non-crypto randomness in a persisted identifier invites
   collisions, and `resolvePendingResume` already treats duplicate ids as a `malformed_checkpoint`
   fault.

## Appendix — what did NOT generalize from the invoicing example

Roughly 150 of `review-coordinator.ts`'s 347 lines are capability plumbing. Of that, the parts
this design absorbs are: a server-only token per decision, never serialized to the browser; the
token rather than the client's claim deciding which decision is being made; and rejection of a
replayed approval. The rest stays where it is, and for good reasons:

- **Convergent minting under compare-and-swap contention** (`authorize`'s three-attempt ladder
  ending in `review_contention`) is an artifact of minting from *outside* the runtime, where two
  concurrent runs on one thread race to create the token. The runtime mints at park time with
  the park; there is no race.
- **The named decision slots** `initial` / `once` / `cancelled` are domain vocabulary, not
  runtime vocabulary.
- **`operationId` replay protection on an applied proposal** must stay app-side. At-most-once
  delivery is not exactly-once effect (§5.2). This is the finding most likely to be
  misread as "the app can now delete that code". It cannot.
- **`proposal_identity_conflict`** — binding the decision to the proposal version the human saw
  — stays app-side (§5.3).
- **The session / generation / tombstone model** (`assertThreadOwner`, `store.generation`) is the
  app's own session lifecycle, and overlaps `ThreadAccessPolicy`, not this.

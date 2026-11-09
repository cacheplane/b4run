# Protocol runtime reconciliation after cooperative Stop

User authorization: continue all follow-ups after PR #1133, retaining the prior
PR/merge-on-green instruction. The coordinated API release remains subject to
the existing exact-candidate release checkpoint. No publication or production
activation follows from this component work.

## Authority and current state

The approved November 5 coordinated, wire, runtime, Store, and b4app designs
remain authoritative except where the later approved November 8 cooperative
Stop design changes execution completion. Use the unmodified dependency pins,
native `RunControl.requestDrain`, separate soft Stop and hard-abort channels,
truthful natural/error/permission outcomes, and the documented exclusion of
arbitrary detached callbacks and remote effects. No fork, public ownedTool
factory, primitive-interception requirement, or universal raw-work guarantee.

C1–C5 and R1–R7 have reviewed commits through 4db0361db. R8 remains unfinished;
its dirty source was copied without modifying the original into the isolated
branch `protocol/cooperative-reconciliation-20261108`, then archived as a local
WIP checkpoint f0028d8ea. That checkpoint is not qualification evidence.
R9–R12, bindings B1–B7, Store S1–S6, client A1–A10, and release L1–L6 remain open.

Worktree: `/Users/blove/repos/b4run/.worktrees/protocol-cooperative-20261108`.
Parent owns this plan and execution records. One implementer owns product code
and integration conflicts. Preserve all original worktrees and private history.

## First cohesive task: durable execution and R8 native binding

- [ ] Read actual root/nested contributor instructions, approved November 8
  design, the existing R7/R8 implementation plans, and current adapters. Record
  branch/head; merge current main (990e7dfb6) into this continuation branch.
  Resolve conflicts in favor of the approved behavior, retaining the real R8
  inbox, saver, authority, and source-proof features. Never choose whole-file
  ours/theirs to avoid reasoning about a conflict. Preserve merged production
  behavior and examples; do not activate unfinished protocol endpoints.
- [ ] Install locked dependencies, build before testing dist consumers, and
  establish focused baseline evidence. Parent schedules resource work; use
  login:false and required sandbox escalation for Node/process/SQLite/network.
  Silently scrub provider keys, external DB targets, and unrelated gated flags.
  Use only owned temporary stores; record and close exact processes/containers.
- [ ] Add behavioral RED tests against the actual durable ExecutionHost and one
  real native agent adapter. Hold an active tool and real checkpoint write,
  accept exact-run Stop, prove the hard tool signal remains live, wait:true and
  execution ownership remain pending, and same-thread admission remains busy.
  After release, prove no next superstep runs and only an actual observed drain
  becomes stopped. Also prove natural final success, independent failure,
  permission park, stale predecessor Stop, hard shutdown, and hard ownership loss.
  Through the canonical native path, separately reject the held real saver write
  after accepting Stop: the original checkpoint failure must win over drain or
  user_stop, and execution ownership must stay held through that settlement.
  Cover both actual execute and streaming entrypoints, including consumer close.
- [ ] Separate durable host stopSignal from its existing hard controller.
  Accepted ordinary Stop requests drain; hard loss/shutdown use hard abort.
  Preserve durable exact-target control rows, leases/fences, required final
  writes, and the single owner. Resolve terminal truth from actual execution,
  not merely a control row or an arbitrary user result's cancelled field.
  Accepted control and completed execution are distinct observations.
- [ ] Bind cooperative control through the actual internal canonical R8 native
  entry path, including stream closure/error handling, without a second owner,
  scheduler, or callback tracker. Keep synchronous required checkpoint durability
  for managed native Stop calls and preserve checkpoint-error precedence.
  Remove superseded experimental primitive/callback interception and unsupported
  completion exports/restrictions; retain independent features only with a
  concrete non-Stop requirement and behavioral evidence.
- [ ] Requalify R8 exact-run FIFO injection and atomic applied dispositions,
  namespace/contributor authority, immutable protected-source proof, real
  permission restore/resume, and safe new turns. Fresh input must retire pending
  source tasks nonexecutingly; explicit authorized Command resumes retain their
  semantics. Stop alone proves neither that an action never ran nor that remote
  effects ended. Hard loss preserves uncertainty and stale-writer fencing.
- [ ] Update conflicting completion claims in the runtime spec/plan and relevant
  author docs to the already approved November 8 guarantee. Keep shared b4app
  spec copies consistent using isolated client work. Do not change frozen wire
  corpus/defaults or invent public API additions as an implementation shortcut.
- [ ] Build, typecheck, lint, and run focused actual SQLite/native invariants.
  Run actual Postgres variants sequentially with exact owned cleanup. Qualify
  strict packed consumers on unmodified native dependencies and keep existing
  platform/export/purity guards. Record counts and skips honestly.
- [ ] Freeze coherent source/evidence, obtain fresh SPEC review, fix with the
  same implementer and recheck with the same reviewer, then obtain independent
  QUALITY review with the same fix/recheck loop. The archival WIP and old focused
  greens are not R8 approval. Mark this task complete only after current proof.

## Subsequent approved execution

After this component passes, continue R9–R12 using their existing reviewed plans,
then bindings, Store, and b4app work in dependency order. Preserve main's coherent
public surface until coordinated qualification. Keep at most two maintainer full
CI submissions active, accounting for main. Separate release-credential, Railway,
and local timing work from protocol product changes. Required repository and
release-bearing CopilotKit/Vercel checks remain intact; no deadline or assertion
relaxation is a substitute for passing evidence.

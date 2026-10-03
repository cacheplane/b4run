# Software factory rung 1: live demonstration

Status: procedure written; the results section is filled in by the one recorded live run.
Spec: ../specs/2026-09-18-software-factory-rung1-design.md, "Proof" and success criteria 2–4.

This is evidence that the controller earns its own verdict against a real builder and a real
model: it captures the baseline, reads the builder's workspace, assembles and digests the
candidate, verifies it in its own container, freezes a review bundle, and exports only the
bytes that bundle names. It is not a benchmark and it says nothing about repair quality
beyond one fixture.

**Unblocked on the read side.** `createThreadWorkspaceReader` reads the builder's own
managed workspace through `withManagedWorkspaceReader` (`@b4run/cli/workspace`, see
`docs/superpowers/specs/2026-09-19-managed-workspace-read-design.md`): the thread is resolved
through the builder's installation store under its app root, and the published record's
volume is read in a separate read-only container. The builder in this runbook is this
package, run from its own root, which is the root the controller's command line reads. A
live run still needs a model key; nothing below has been run against one yet.

What *is* proven, without a live model, is the controller's half of the join:
`B4_TEST_DOCKER=1 pnpm --filter @b4-example/software-factory-server test:sandbox` reads a
real thread workspace, assembles, verifies in a real container, freezes a bundle and exports
it. This runbook stays open for the part that needs a real builder and a real model.

## Procedure

1. `nvm use 24`, `pnpm install`,
   `pnpm turbo run build --filter=@b4-example/software-factory-server^...`.
2. `pnpm --filter @b4-example/code-fixer-server sandbox:prepare` (builds
   `b4-code-fixer:fixture-v1`; the factory's builder and verifier both run that image, and
   its `/opt/fixtures/cli-flags/node_modules` is what the workspace's environment link
   points at).
3. Start the builder with a real key — **this package, not code-fixer**:
   `cd examples/software-factory/server && OPENAI_API_KEY=... pnpm dev --port 4100`.
4. In `examples/software-factory/server`, with `FACTORY_WORKER_URL=http://127.0.0.1:4100`,
   `FACTORY_WORKER_ROUTE=/build#agent`, `FACTORY_STATE_DIR=$PWD/.factory`:
   `pnpm factory create --task cli-flags`, then `pnpm factory dispatch <id> --wait`.
   Note the stderr line the CLI prints at startup; if it still names the #731 gap, stop.
5. Record the state. If it is `awaiting_approval`, do NOT approve yet.
6. Restart test: run `pnpm factory show <id>` (each CLI invocation is a fresh factory
   process, so this is a restart) and record that the state is still `awaiting_approval`
   with the same revision and the same bundle digest, and that no re-verification happened —
   `awaiting_approval` has no reconciliation rule, because the frozen bundle is already the
   whole record.
7. `pnpm factory evidence <id> > evidence.json`. Record the candidate digest, the receipt's
   verdict and `verifierIdentity`, and the bundle digest from it.
8. **Weak-repair refusal.** With a second work order, script a candidate that satisfies the
   visible suite and fails the independent checks — the simplest route is
   `FACTORY_BUILDER_MODEL` pointed at a model prompted to special-case the visible test, or
   a hand-edited workspace before the controller reads it. Record that the controller
   refuses it: state `blocked`, `blockedReason: verification_failed`, a `receipt_failed`
   event, **no bundle**, and nothing under `FACTORY_EXPORT_DIR`. This is the rung's headline
   claim; a run without it is not a rung 1 demonstration.
9. `pnpm factory approve <id> --revision <n> --bundle <bundleDigest>` for the *first* work
   order. Record the outcome and the export path.
10. `pnpm factory events <id> > events.json`; copy the fields below from it and from
    `evidence.json`.
11. Retry nothing. If the run fails or blocks, record that outcome; it is still evidence.

## Results

| Field | Value |
|---|---|
| Date | |
| Builder model (`FACTORY_BUILDER_MODEL`) | |
| Work order id | |
| Builder thread id (`thread_created` event) | |
| Baseline digest | |
| Candidate digest | |
| Receipt verdict | |
| Verifier identity (`verifierIdentity`) | |
| Bundle digest | |
| State after restart (`show`), and that no re-verification occurred | |
| Weak repair: final state, blocked reason, bundle absent, export dir empty | |
| Final state of the approved work order | |
| Export path (`delivery_observed`) | |
| Export filename equals the bundle digest | yes / no |
| Wall clock: dispatch to `verifying` | |
| Wall clock: `verifying` to `awaiting_approval` | |
| Wall clock: approve to `exported` | |
| Anything unexpected in the event log | |

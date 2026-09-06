# Adopted verifier repair implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for implementation and independent review.

**Goal:** Complete adopted 0.8.24 with corrected shared smoke verification and an explicit exact forward authorization.

**Architecture:** Preserve the accepted policy and adoption. Validate one immutable candidate-bound repair record in authority capture, historical executor admission, and fence selection. Keep the original closure path unchanged.

**Tech Stack:** Node ESM, node:test, GitHub Actions, gh, public npm, Linux systemd and Docker.

## Task 1: Exact repair admission

Files: scripts/release/recovery/authority.mjs, observe.mjs, fence.mjs; scripts/release/test/recovery-verifier-repair.test.mjs and relevant authority/observation/fence tests.

- [ ] Add failing positive mixed original/replacement closure tests and rejection tests for candidate/policy/source/ancestry/contract drift, absent/malformed record, unknown fields, changed input lists and altered historical bindings.
- [ ] Implement one shared read-only validator in authority.mjs (already inside the unchanged closure input list). Read canonical repair records only at the requested immutable controller SHA. Return actual closure and approved contract set; preserve original policy value and digest.
- [ ] Route authority and historical observation through it; route fence contract selection through identical authorization. Avoid cycles (authority does not import fence). Contract transformation must preserve all structure except explicitly enumerated current-default input hashes.
- [ ] Reject repair mode from captureRecoveryAuthority for every operation and match the original adoption asset descriptor/baseline executor in recoveryChain. Verify no new adoption/reset escape, and retain exact main CI, historical CI, identity and fresh fence checks. No changes to policy.mjs, schema.mjs, invocation.mjs or other probe inputs.
- [ ] Run node --test scripts/release/test/recovery-verifier-repair.test.mjs and focused affected suites; independent spec/quality review.

## Task 2: Shared smoke repairs and failure diagnostics

Files: scripts/release/smoke/runtime-targets.mjs, published-harness.mjs, docker-identity.mjs; scripts/release/smoke-containment.mjs; scripts/release/recovery/smoke-child.mjs, smoke.mjs, runtime.mjs or diagnostics.mjs only as needed; their existing tests.

- [ ] Write failing regressions for actual npm exports/adapter shape/setup and real systemd/Docker stderr cases.
- [ ] Apply the four smallest shared corrections specified by the design.
- [ ] Preserve bounded redacted failure details through the child boundary without adding unknown files to proof artifacts or accepting diagnostic data as proof. Test secrecy, output bounds and original failure status.
- [ ] Reproduce scaffold on Linux with retained command errors before any behavioral fix.
- [ ] Run focused tests and review against design then code quality.

## Task 3: Bind reviewed bytes and rehearse

Files: new scripts/release/recovery-verifier-repairs/v0.8.24.json; new content-addressed recovery-fence-contracts record; scripts/release/test/fixtures/release-script-hashes.json; retained artifacts.

- [ ] Generate complete old/current input hashes from original f18 and reviewed tree, preserving policy and intent bytes. Build replacement fence contract by exact allowed current-default input-hash transformation. Record baseline/new digests canonically; no self-hash cycle.
- [ ] Update content pins required by tests, retaining original records and baseline references. Add committed-record coherence tests using validator; never ordinary-refresh accepted policy.
- [ ] Run actual Linux shared smoke operations in personal lab against public 0.8.24; retain evidence and clean only owned runtime resources. Keep diagnostic results separate from production proof.
- [ ] Run full required validation and normal PR/main CI; no paid reviewer credits.

## Task 4: Complete production arc

- [ ] Freshly verify exact merged-main CI, unchanged adoption/payload, all seven fenced workflows disabled/drained, valid platform reviews and exact current source bindings.
- [ ] Dispatch normal owner workflow with existing intent and exact new main SHA. Investigate any concrete failure, preserving artifacts; no blind reruns.
- [ ] Verify successful smoke/evidence/audit/finalization/publication and immutable release readback.
- [ ] Run normal no-write replay and assert next-candidate arbitration. Restore only five routine workflows, retain two removed diagnostics disabled. Update durable checkpoint and report verified outcome.

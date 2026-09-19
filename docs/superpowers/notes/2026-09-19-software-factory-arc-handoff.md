# Handoff — software factory arc, rungs 0 and 1

**Snapshot date: 2026-09-19.** Point-in-time note. The PR and branch states below go stale the moment someone merges; the *decisions on record*, *what is actually proven*, and *open follow-ups* sections do not.

---

## 1. State at a glance

Two PRs merged this session. One branch of finished work is committed locally and not pushed.

| Change | Commit | State |
|---|---|---|
| Rung 1 — controller-owned verification, [#741](https://github.com/cacheplane/b4run/pull/741) | `c8e4f952` | MERGED to `main`, no failing checks |
| Byte channel framework surface, [#731](https://github.com/cacheplane/b4run/pull/731) | `7410154e` | MERGED to `main`, no failing checks |
| Byte channel wired into the example | `661f2129` | **Committed locally, unpushed, no PR** |

**Working copy:** `/Users/blove/repos/dawn/.claude/worktrees/dawn-gate-coverage-a66fe2`, on `blove/software-factory-byte-channel`, one commit ahead of `origin/main`. Gate green: 232 package tests, typecheck clean, lint clean, Docker lane 8/8 across three consecutive runs.

**Do not** start rung 2 from this worktree without first deciding what happens to `661f2129`. It is finished, reviewed-by-gate work that nobody else can see.

### `review` is red repo-wide and it is not about this work

The Anthropic org credit balance is exhausted. This is the **fourth** recorded outage of this kind. `validate` is the only required check on `main`, so a red `review` does not block merge, but it makes GitHub report the PR as `UNSTABLE`, which **does** block auto-merge. Both PRs this session were admin-merged for that reason.

```bash
gh api repos/cacheplane/b4run/branches/main/protection --jq '.required_status_checks.contexts'  # => ["validate"]
```

Every PR merged during an outage ships without the advisory review. Top up the credits; it is recurring maintenance, not a one-time fix.

---

## 2. Arc status

RFC: `docs/superpowers/specs/2026-09-16-software-factory-rfc.md`. The program is a dogfood: build a software factory and run it against this repo.

| Rung | Status |
|---|---|
| Rung 0 — spec in, verified patch out, controller drives a worker over the local Agent Protocol | **MERGED** (`8dbc0bdb`) |
| Rung 1 — controller-owned verification and the review bundle | **MERGED** (`c8e4f952`) |
| Byte channel — the controller reads the builder's workspace itself | **Partly landed.** Framework surface merged; the example is wired; the join to a *builder's own* workspace is blocked, see §4 |
| Rung 2 | Not specified |

Architecture chosen at the start, and still the right one: **an application-owned state machine driving `agent` routes over the local Agent Protocol.** Not a graph route, and not a root-agent orchestrator. Three code facts forced this and have not changed: only `agent` routes get a checkpointer, a thread id, interrupts and in-band cancellation; there are no in-process child runs; the tool argument preview truncates at 500 characters.

---

## 3. What rung 1 actually is

**The thesis: the builder has no channel for a verdict.** It edits a workspace. The controller alone captures a baseline, reads the workspace, assembles and digests a candidate, verifies it in its own container under a policy the builder cannot see, freezes a review bundle, and exports on approval.

Everything by which a worker could claim its own result was deleted in this rung: the prepare-review tool, the export gate, the outbox module, and the reconciliation rule that inspected them.

The example lives in `examples/software-factory/server`. The pieces that carry the thesis:

- `src/controller/verify.ts` — the verifying phase. Fail-closed: no throw may leave a row in `verifying` without a transition.
- `src/verification/docker-verifier.ts` — runs the visible suite and the independent checks in a container, with a 300 second internal deadline.
- `src/verification/assemble.ts` — turns observed bytes into a candidate, or rejects with a rule.
- `src/review/bundle.ts` — freezes a bundle; refuses a non-passing receipt or a mismatched candidate.
- `src/worker/workspace-reader.ts` — the byte channel.
- `src/domain/digest.ts` — canonicalization that **throws** rather than coercing.

---

## 4. The blocker, and why it is not a bug you can fix in the example

`openWorkspaceReader` addresses a thread's storage **by thread id**, building `b4-sbx-vol-<resourceId(threadId)>` (`packages/sandbox/src/docker/docker-sandbox.ts:106`, reader at :353).

The factory's builder declares `sandbox.workspace`, so `SandboxManager.getForThread` routes it to the managed workspace manager and returns before `acquire` is ever called (`packages/cli/src/lib/runtime/sandbox-manager.ts:42`, versus the `acquire` at :53). That volume therefore never exists. The builder's bytes live in `b4-ws-volume-<sha256([binding, installationId, operationId])>` (`packages/sandbox/src/docker/managed-workspace.ts:28`).

**A thread id cannot address a managed workspace.** The read design justified thread-id addressing on the grounds that it is what the first consumer has. This controller is that first consumer and it does not have it. That premise was wrong.

Two candidate fixes, both framework changes:

1. **Add a read operation to `ManagedWorkspaceProvider`.** Recommended. It keeps thread identity out of an addressing scheme that cannot carry it.
2. Let `OpenWorkspaceReaderInput` name a workspace rather than a thread.

Rejected workarounds, for the record. Acquiring the builder's sandbox from a second process **replaces** its container, because `acquire` is idempotent only within one provider lifecycle. Deriving the volume name depends on `resourceScope`, which is unexported addressing and not an ownership check. `reconnect` starts a session container.

`test/end-to-end.integration.test.ts` contains a test that **asserts the refusal**, deliberately, so nobody forms the belief that this works. Delete it when the framework fix lands.

---

## 5. What is proven, stated precisely

Do not overstate this in a PR description or a demo.

**Proven, under real Docker.** Bytes that exist only inside a real thread's workspace volume are read out through a real read-only reader container, diffed against the baseline the controller captured itself, assembled, verified in its own container, frozen into a bundle, approved (which re-verifies) and exported under the bundle digest. Both inspection options are exercised for real: the git directory is excluded while `.gitignore` survives, and the dependency symlink is validated against its exact target.

**Also proven.** A candidate that satisfies the visible suite while failing the independent checks gets a `fail`. A candidate that rewrites its own test is caught by the snapshot comparison. These are earned in a container, not scripted.

**Still resting on a fake.** The Agent Protocol worker in the end-to-end test, the model script, and — the one that matters — **the bytes are placed through a sandbox handle, not produced by a builder turn**, because of §4.

**Never run.** The live demonstration. It needs a model key *and* the §4 fix. `docs/superpowers/runbooks/software-factory-rung1-live.md` is blocked and its step 8, the weak-repair refusal, is under-specified on purpose: there was no honest way to write an exact recipe for producing a weak repair without a live model or a hand-edited workspace.

---

## 6. Decisions on record — do not relitigate without new information

- **Controller is an application-owned state machine, not a graph route or a root agent.** §2 has the three code facts.
- **The offline test layer was deferred at rung 0** rather than adopting a two-turn worker protocol, because aimock fixtures are static and cannot see a workspace. It came back at rung 1 as Task 16 and worked, because each builder step gets a distinct turn index.
- **The controller stays an example with clean seams.** The service shape is deferred. §8 names the one thing that must be untangled first.
- **Verification has no durable external effect**, so a row interrupted mid-phase is simply verified again from the controller's own baseline. It is never resumed and never re-dispatched.
- **Inconclusive is a real verdict, not a failure.** A verifier that cannot run, times out, or emits unparseable output is inconclusive. Do not collapse it into `fail`.
- **Reconciliation does not read the workspace to decide first.** An earlier design had it probe, justified by "an inconclusive verdict would retry for ever". That was factually wrong in this codebase, and the probe cost a second container read per row. Removed.

---

## 7. Traps that cost real time

- **Biome will reformat fixture bytes** and thereby break every digest and the reference patch. `biome.json` needs `"!fixtures"`, mirroring code-fixer's `"!sample"`.
- **`docker run -v absent:/workspace:ro` silently *creates* the missing volume.** Measured, not assumed. This is why the reader binds the backing directory read-only instead of mounting a named volume: otherwise a reader racing a delete would resurrect a workspace.
- **Digest canonicalization must throw, not coerce.** Four collision paths were found: `JSON.stringify` dropping `undefined`, lone surrogates folding to U+FFFD under utf8, non-plain objects canonicalizing to `{}`, and `__proto__` mutating the prototype instead of storing. The accumulator is `Object.create(null)`.
- **The bundle digest must bind its work order id.** Without it a retried task producing a byte-identical bundle collides on the primary key, `INSERT OR IGNORE` keeps the first, and approve loads a bundle naming a different work order.
- **A test that reads a file outside its package must declare it as a turbo input**, or the cache serves a stale pass. `node scripts/check-build-cache-config.mjs` is the gate. The rung 1 readme is already declared.
- **Adding or editing a workflow requires regenerating both audited allowlist fixtures**, and the audit throws one opaque string with no diff. Splice the fixtures surgically; re-serializing the JSON produces hundreds of lines of formatting churn.
- **`@b4run/workspace`'s source-bundle and source-capture tests flake** under full-suite contention with a timeout signature. They pass in 4.5 seconds in isolation. This is the documented process-spawn-contention flake, not your change.
- **Node 24 is required.** `nvm use 24` before any test run.

---

## 8. Open follow-ups

Ordered by what I would do first. All were found in review and deliberately deferred so the rung stayed reviewable.

1. **The §4 addressing decision.** Blocks the real end-to-end proof. Framework change, spec-level.
2. **Push `661f2129` and open a PR**, or fold it into whatever comes next.
3. **Cancel and budget exhaustion do not stop a running verifier.** `src/controller/verify.ts:148` passes `ctx.signal`, the factory-wide abort, not a per-work-order one. The record settles correctly but the container runs to its 300 second deadline.
4. **Boot does unbounded, unbudgeted container work.** `src/controller/factory.ts:831` awaits `reconcileAll` before `startBudgetTicker` at :836 and before HTTP listens. A hanging verifier hangs boot with nothing alive to cancel it.
5. **`candidateVerified` is a dead column** (`src/registry/work-orders.ts:78`, only ever written `null` at `src/controller/factory.ts:353`). It is exactly the rung 0 field where the worker reported its own verdict. Of everything here, it is the likeliest thing for a copier to misread.
6. **`recordBundle`'s stated invariant is false.** `src/registry/evidence.ts:112` justifies `INSERT OR IGNORE` by saying the digest covers the record's own content, but `receiptId` and `frozenAt` are not in `bundleDigest`. A re-verified bundle silently keeps the first receipt id, so the evidence view can show a stale receipt.
7. **The fixture catalog is the seam leak that blocks a service extraction.** `src/fixtures/catalog.ts:7` derives `appRoot` from `import.meta.url` and `src/fixtures/workspace.ts:19` reads `process.env` at module load. The controller imports both directly, so its completion policy is hard-wired to this package's directory layout.
8. **`environmentIdentity` is a mutable tag, not a pinned digest**, which the spec forbids. Resolving it needs a Docker call on a path every test executes. Documented rather than faked.
9. **Reconciliation trusts an exported file by name alone**, without comparing content the way `exportApproved` does.
10. **A flake class worth auditing before rung 2.** At least three tests synchronize on a state transition rather than on the thing they mean to be inside. One of them was a real false red and was fixed; the others were not audited.
11. **The managed workspace volume and record pair survives** `harness.close({ destroyWorkspaces: true })`. Pre-existing, predates this arc.

---

## 9. Where the durable knowledge lives

- Specs: `docs/superpowers/specs/2026-09-16-software-factory-rfc.md`, `…-rung0-design.md`, `2026-09-18-software-factory-rung1-design.md`
- Plans: `docs/superpowers/plans/2026-09-16-software-factory-rung0.md`, `2026-09-18-software-factory-rung1.md`
- Runbooks: `docs/superpowers/runbooks/software-factory-rung0-live.md`, `software-factory-rung1-live.md`
- Reader design: `docs/superpowers/specs/2026-09-18-thread-workspace-read-design.md`
- The example's own front door: `examples/software-factory/README.md`, whose section "What is joined, and what is not" is the honest statement of §4 and §5

**Standing constraints for this repo.** Never use bare `git stash`; the stack is shared across worktrees. Never run bare `biome check --write` at the repo root. `examples/code-fixer` must have no diff. Framework changes land after a release is cut, not into it.

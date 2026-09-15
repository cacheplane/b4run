# Workspace recovery prototype evidence

Status: recovery qualification and full local repository validation passed.

Implementation commit: `48987a6f` on `blove/code-fixer-app-correction`.

## Result

The test-only prototype preserves edited fixture source and the original Git
baseline across fresh host processes. Actual host kills during copying and before
publication leave unpublished storage that recovery stops and replaces. A kill
after publication reconnects the selected generation without reseeding it.

The original application defect was also reproduced using the actual
`seededProvider` and `seedFixture` helpers: reacquiring retained storage with fresh
wrapper state fails repeated setup and destroys the retained volume. The prototype
does not change that application yet.

The result supports a production design around explicit workspace creation and
reattachment. It does not justify exporting the prototype coordinator or a generic
run-once initializer. In particular, production ownership of metadata, active-run
admission, Kubernetes behavior, and retention still need a design and qualification.

## Coverage

| Evidence | Result |
|---|---|
| Canonical source and SQLite admission/records | 24 tests passed, including exact UTF-8 BOM preservation, independent-process contention, missing metadata, and transactional conflicts |
| Docker ownership and operation ordering | 7 tests passed, including inspection uncertainty, foreign ownership, failed stop, immutable ID mismatch, and inspect-before-start |
| Deterministic recovery coordinator | 24 tests passed, including lost acknowledgements, stale session pin recovery, unpublished replacement, provenance retention, interrupted deletion, and overlapping operation refusal |
| Real Docker and host-process suite | 12 tests passed in 53.87 seconds, including the original application diagnostic |
| Additional real Docker missing-storage and foreign-resource cases | 2 tests passed in 5.52 seconds; selected storage loss did not reseed, foreign storage remained untouched |
| Full repository source suite | 500 files / 6,009 tests passed; 234 intentionally gated/skipped tests |
| Release-controller suite | 3,850 tests passed; no failures |
| Changeset scope | Passed; prototype adds no user-facing package API change |
| Framework, runtime parity, and smoke harnesses | All three passed; no failures or skips |
| Full `pnpm ci:validate` | Passed, exit 0; includes lint/build/typecheck, integrity/inventory, docs, packaging and tooling checks |

The two Docker invocations together qualify 14 distinct tests. Skips in the
second invocation are the intentional test-name filter, not missing qualification
of those cases. Deterministic resource faults are distinct from actual process
kills; the former include transport uncertainty and acknowledgement loss that
would be difficult to induce reliably against the daemon.

After both invocations, checked Docker inventories filtered by
`label=b4.recovery.installation` contained **0 containers and 0 volumes**. The raw
sample artifact records both empty inventories. The original-wrapper diagnostic
also explicitly verified that its separately named retained volume was absent.

Real Docker qualification is manual for this bounded experiment. The existing CI
Docker job filters other integration files and does not execute these new recovery
files. The ordinary source-test lane includes the deterministic tests; the recovery
integration files remain gated by `B4_TEST_DOCKER=1`. No CI workflow was changed.

Each fixture exercises real host kills at `copying` (after the first file copy,
before the remaining materialization), `stopped` (before metadata
publication), and `published`, plus a clean host restart after editing an existing
source file. The worker process exits and is joined before the next process opens
the store. Whole-machine power failure and Docker daemon failure were not tested.

## Environment and provenance

- Host: Darwin arm64; Node `v24.20.0`; Docker server `27.4.0`.
- Image: `sha256:337e9f68cbb1695833e454feade694371dd93a8fa729c9d3251120c67ad9c6c8`.
- Image built from the existing code-fixer Dockerfile; layers were cached. No
  cold-build or image-pull performance claim is supported.
- cli-flags source digest: `ca2806c1b628f44485c4d5cfffa049fd6d22a3434095b871de82964ac13f29a3`.
- nullable-inputs source digest: `341a392fb0ae50ae399f9e04010b316dadc0788648cea3faed77c0ec1805e9c1`.
- Initial Git commits: cli-flags `197b8a7a46de98fdfc93cd0ea827702c311e4303`;
  nullable-inputs `6b344d53de5963d72ce94647419a3676f86a456f`.

The manifest contains visible source, visible tests, task text, and generated
ignore rules. Reference patches and independent hidden verification checks are
not materialized. These are prototype source digests, not historical fixture Git
commit IDs or published blueprint versions.

[Raw samples](/Users/blove/.codex/worktrees/6f78c71c-8e11-4fce-847d-52818cad5f97/dawn/docs/superpowers/evidence/2026-09-14-workspace-recovery-samples.json)
record matching source/image/baseline identities after each recovery case.

## Timing observations

| Fixture | Preparation plus readiness checks | Reattachment plus content/baseline checks |
|---|---:|---:|
| cli-flags | 1,834 ms | 415 ms |
| nullable-inputs | 1,758 ms | 403 ms |

These are single warm-image local observations, not distributions or service
objectives. The first interval includes creation, materialization, Git validation,
the refusal to attach while preparation is running, stop, and stopped-state
inspection. The second starts after compute release and includes attachment plus
two verification commands. Neither measures model response, a whole repair run,
cold provisioning, or Kubernetes behavior. Preparation work can be separated from
agent execution, but these samples do not establish production latency.

## Review corrections

Independent review and real execution prompted several corrections:

- Persist complete source bytes, not just their digest, for preparation recovery.
- Preserve BOM bytes during decoding and ignore the dependency symlink explicitly.
- Refuse missing state/installation metadata instead of manufacturing a new identity.
- Discover existing logical resources before treating missing workspace records as fresh creation.
- Reject overlapping lifecycle operations inside one admitted coordinator.
- Validate newly created physical containers before starting them.
- Clear a confirmed absent session's old ID before creating a replacement, so lost
  creation acknowledgement does not leave recovery stuck on the old pin.
- Keep both the primary failure and cleanup failure; retain state directories
  when destruction is incomplete so cleanup can be retried.
- Declare fixture/helper reads as Turbo cache inputs rather than allow stale test results.

These corrections illustrate why the public API should follow failure testing.
Most are lifecycle concerns that would be easy to conceal inside an initializer.

## Reproduction

Run from the repository root:

```sh
docker build -t b4-code-fixer-recovery:local examples/code-fixer/server
pnpm exec vitest run --root packages/sandbox --config vitest.config.ts test/workspace-recovery-manifest.test.ts test/workspace-recovery-store.test.ts test/workspace-recovery-docker.test.ts test/workspace-recovery.test.ts
B4_TEST_DOCKER=1 pnpm exec vitest run --root packages/sandbox --config vitest.config.ts test/workspace-recovery.integration.test.ts test/workspace-recovery-original.integration.test.ts
pnpm ci:validate
```

An optional `B4_RECOVERY_IMAGE` overrides the local image tag; the adapter resolves
it to an immutable image ID before creation. `B4_RECOVERY_EVIDENCE` can name a
JSON-lines output file for local timing/provenance samples. Neither is a public
application configuration field.

## Remaining limits

This experiment uses one admitted coordinator, two local SQLite files, and one
Docker daemon. It supports process restart and abandoned preparation containers.
It does not support a network filesystem, multiple state directories for the same
installation, multiple hosts, concurrent editing sessions, or takeover of a live
agent run. Loss of the entire state directory is outside its recovery guarantee.

No Kubernetes provider, production persistence adapter, public SDK, application
tool, approval workflow, or blueprint has changed. No model calls, PR, push, or
deployment were made. Production API design is the next step; direct promotion of
these test helpers is not the recommendation.

## Final validation record

The complete sequential validation run finished successfully on September 14,
2026 (local time). Its harness result is
[run-result.json](/Users/blove/.codex/worktrees/6f78c71c-8e11-4fce-847d-52818cad5f97/dawn/artifacts/testing/harness-2026-09-15T001836-736Z-86217/run-result.json).
The initial attempt correctly stopped at the build-cache check because the new
tests read fixtures outside their package. Declaring those inputs in `turbo.json`
resolved the failure; the subsequent full run passed.

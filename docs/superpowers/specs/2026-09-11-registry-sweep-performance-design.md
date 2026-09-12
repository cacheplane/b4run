# Concurrent read-only publisher sweeps

## Scope and evidence

Improve release speed without adding publishing steps, dependencies, credentials, configuration, timeouts, or parallel publication. Keep each package fully verified before the next mutation.

Across the four 0.8.30 publisher attempts, existing pending-event logs establish at least 26.79 minutes of accumulated registry waiting. There were 273 version-absence and 32 metadata-pending events. These counts do not attribute time precisely or establish a historical cache cause. Overlapping package propagation would change the existing stop-before-next-publication guarantee and is outside this change.

A read-only probe using the production npm reader and all 21 already released package names returned identical metadata in manifest order. Sequential sweeps took 5,647.98 ms and 1,295.69 ms; concurrent sweeps took 156.61 ms and 71.56 ms. Warm cache and network conditions differ, so these are local request timings, not a prediction of total release duration. A separate exact-proof audit comparison measured 8,960.87 ms for 21 warm individual commands versus 700.05 ms for one existing batch; audit batching is deliberately deferred to keep this change minimal.

## Design

Change only `sweepLatest` in `scripts/release/publisher.mjs` to await `Promise.all` of the existing `observeMetadata` call for each manifest entry. Each call still performs its fresh observation. Preserve manifest order in the returned array, including when responses complete in a different order. Manifest validation already restricts the exact package inventory; concurrency is bounded to the existing 21 entries, with no new queue, knob, or worker.

The caller still awaits the full successful sweep immediately before each mutation. Any rejected or ambiguous observation prevents that mutation. A newer latest value still supersedes an untouched candidate or fails a partially published candidate. Other in-flight work on rejection consists only of bounded GET requests; the existing owner deadline and cleanup stay in charge. No request cache or evidence reuse is introduced.

Initial observation, package publication, per-package convergence and auditing, final verification, recovery rules, and evidence formats remain unchanged. Update only the existing content hash for the changed publisher module; do not change workflow topology or its fixtures.

## Verification

Use deterministic deferred observations to prove the pre-mutation sweep starts all reads before awaiting the slowest, blocks publication until every observation succeeds, and retains identity/order when responses settle out of order. Test an ambiguous result and a newer latest result before any mutation and after an already verified publication. Retain all existing publication-order, concurrency-one, per-package verification, timeout, and resume tests.

Run focused publisher tests red/green, release integrity, lint, the full release-controller suite, and hosted technical checks. Review the small production diff and its content pin independently. Do not cut a measurement release or claim the registry propagation delay itself has been reduced.

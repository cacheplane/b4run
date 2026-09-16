# Publisher budget and next-release measurement

## Measured 0.8.34 outcome

[0.8.34](https://github.com/cacheplane/b4run/releases/tag/v0.8.34) became public and immutable at 2026-09-16 00:31:29 UTC. Its [candidate PR](https://github.com/cacheplane/b4run/pull/664) merged at 2026-09-15 21:35:40 UTC: 2h55m49s elapsed. The timeline includes earlier discovery failures, investigation and queueing; it is not a clean performance benchmark.

| Phase | Duration |
| --- | --- |
| Candidate merge to first npm publish step | 1h59m40s |
| First npm publish step | 25m00s |
| Timeout to resumed publish step | 15m48s |
| Resumed npm publish step | 9m34s |
| End of resumed publishing to public release | 5m47s |

[The first attempt](https://github.com/cacheplane/b4run/actions/runs/35034432108) accepted 15 packages and stopped with `npm publisher overall deadline expired`. The last accepted package, `@b4run/cli`, had waited only about 77 seconds for propagation, inside its ten-minute allowance. There were 239 registry-pending events: 191 version-absent, 19 metadata-pending, 29 audit-pending.

[The automatic continuation](https://github.com/cacheplane/b4run/actions/runs/35038612885) verified the 15 existing packages, accepted the remaining six, and passed npm reconciliation, all five smoke lanes, the independent audit and final publication. The workflow used its existing exact-tag relay; no additional manual dispatch was needed. Summed publisher-job duration, including setup/cleanup, was 34m59s across both attempts.

The latest pending elapsed value per package summed to at least 28m35s across the attempts. This is a lower bound on recorded convergence waits, not an exact decomposition of all registry, tarball and audit work.

## Budget alignment

The publisher receives a sixty-minute overall budget and its existing job gets a sixty-five-minute limit. The five-minute margin covers setup, final evidence upload and cleanup. The subprocess runner already supports the new budget. Its preparation default, the five-minute npm command timeout, the ten-minute per-package propagation limit, serial order and all evidence checks remain unchanged.

This prevents the former twenty-five-minute cutoff from interrupting otherwise healthy progress within the new bound. It does not accelerate npm propagation, guarantee a single attempt, or fix the earlier unidentified discovery exception. A longer whole-run bound can also hold the serialized release queue longer when progress is slow; individual command and package limits remain finite.

## Next ordinary release

Measure a candidate that contains this budget change. Publisher source and workflow are tied to the candidate commit; an older tag does not receive new code just because main changed. Do not cut a release solely for measurement.

Record candidate merge, first publish start, accepted/existing package counts, publisher step durations, pending reasons and elapsed values, retries and queue gaps, smoke/audit duration, and public release time. Confirm whether all packages completed in one attempt and whether elapsed time fell on the same candidate-merge-to-publication boundary. Keep incident timelines separate from ordinary runs. Do not close [#668](https://github.com/cacheplane/b4run/issues/668) until the ordinary-release result and remaining limitations are recorded.

Reducing repeated discovery reads remains a separate follow-up. Overlapping package propagation waits is deferred because it changes failure handling and publishing behavior.

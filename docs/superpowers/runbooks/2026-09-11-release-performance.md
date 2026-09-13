# Release performance: baseline and operating notes

## Baseline

B4.run 0.8.30 took approximately 3 hours 34 minutes from the candidate merge at 2026-09-10 19:55:44 UTC through [the final operational documentation merge](https://github.com/cacheplane/b4run/pull/622) at 23:29:25 UTC. That interval included candidate CI (17 minutes), a release-selection repair (26 minutes), publication and recovery (88 minutes), and follow-up dependency/documentation work (82 minutes). It is not the duration of one successful publish job.

[The timed-out publisher attempt](https://github.com/cacheplane/b4run/actions/runs/34531019102) recorded at least 21 minutes of registry-visibility waits. The timed-out attempt recorded over 5.2 minutes of visibility waiting for `@b4run/cli`. Each recovery also paid roughly 6–8 minutes for detection and hydration. The two audit-response schema failures remain unexplained because their original responses were unavailable.

See [the cutover evidence](./2026-09-09-b4-run-cutover.md) for the exact candidate, release, successful publisher run, and independent audit. Reuse completed release evidence; do not publish a test version or repeat successful transitions to measure performance.

## Operating guidance

Prepare independent changes locally, but keep full CI submissions in small batches. Account for main validation and let an active run finish before replacing its head. Performance changes are submitted one PR at a time so timing comparisons remain useful. This guidance adds no publishing gate.

Runbook-only pull requests can use the narrow prose path introduced in [#626](https://github.com/cacheplane/b4run/pull/626). Eligibility is restricted to regular, non-executable Markdown under `docs/superpowers/runbooks/`; mixed changes, executable files, symlinks, site MDX, code, and configuration retain full validation. The base revision supplies classifier code. The existing required `validate` check remains present, and main pushes keep full CI.

[The npm audit improvement](https://github.com/cacheplane/b4run/pull/627) lets known temporary npm audit transport and service failures use the publisher's existing convergence budget. Complete signatures and provenance remain required. Authentication, unknown/malformed errors, batch failures, and incomplete final verification remain fatal. No timeout, token fallback, workflow, manual prerequisite, or publishing step is added. This does not establish the cause of the historical audit failures or shorten registry propagation itself.

The full [CI validation of the prose-path implementation](https://github.com/cacheplane/b4run/actions/runs/34620340882) completed in 13 minutes 26 seconds from workflow creation through the final job. This is a full-CI comparison point, not a measurement of prose-path speed or total release duration.

## Measuring subsequent ordinary releases

Use existing GitHub job timestamps and publisher diagnostics to distinguish queue time, setup, package publication, registry convergence, verification, and follow-up work. Report end-to-end elapsed time separately from the successful publisher duration. Compare against the same workflow scope and similar CI load; do not attribute a faster run to one change without evidence.

Keep exact candidate binding, package ordering requirements, complete signature and provenance verification, the existing convergence budget, and duplicate-publication protection when investigating registry verification performance. Use existing logs and local rehearsals; do not cut a measurement release or change publication order without evidence. These are follow-up investigations, not additional release requirements.

## Registry profile and read-only sweep optimization

The four 0.8.30 publisher attempts contain at least 26 minutes 47 seconds of accumulated registry-pending intervals. This is the sum of each package's last logged elapsed time within each attempt, a lower bound that excludes the unlogged tail until successful verification or failure. The 305 pending events comprise 273 version-absence and 32 metadata-pending observations. Event counts do not attribute duration by cause, and the original failed audit responses remain unavailable.

| Publisher attempt | Accepted packages | Logged pending lower bound |
| --- | ---: | ---: |
| [First](https://github.com/cacheplane/b4run/actions/runs/34528132560) | 4 | 3m 39.56s |
| [Second](https://github.com/cacheplane/b4run/actions/runs/34530122431) | 1 | 0.41s |
| [Timed out](https://github.com/cacheplane/b4run/actions/runs/34531019102) | 13 | 20m 57.62s |
| [Completed](https://github.com/cacheplane/b4run/actions/runs/34534130844) | 3 | 2m 9.79s |

The publisher intentionally completes each package's verification before publishing the next. Overlapping propagation by uploading later packages first would change that failure boundary: a later package could already be public when verification of an earlier package fails. That change is outside this optimization.

The small optimization is limited to reading the 21 current latest-version records concurrently before each new publication. Every observation remains fresh, all successful results are required, and manifest order is preserved. Publication itself stays serial, with unchanged per-package verification, final verification, deadlines, and recovery behavior. The existing fixed manifest bounds the scan to 21 read-only requests; no queue, option, workflow, or publishing step is added.

Local read-only probes on Node 24.20.0 against already released packages returned identical records. Sequential scans took 5.65s and 1.30s; concurrent scans took 0.16s and 0.07s. These measurements show request-latency savings, not faster registry propagation or a measured improvement to an entire release. Warm-cache effects and network conditions prevent projecting the cold scan across every package.

An audit-batching probe also returned identical complete proofs for all 21 packages: warm individual audits took 8.96s across 21 commands, and the existing batch verifier took 0.70s in one command. That separate change is deferred. A current registry probe did not establish a cache workaround: the version endpoint reported dynamic delivery, and a metadata request with `Cache-Control: no-cache` still received a cache hit. Neither probe establishes the cause of the historical visibility delays.

## Recovery test experiment: rejected

The successful [main controller job before the experiment](https://github.com/cacheplane/b4run/actions/runs/34624194978/job/103345200150) spent 16 minutes 44 seconds in its test step. The 64-case recovery interruption matrix accounted for approximately 10 minutes 17 seconds. These are CI test timings, separate from publisher execution.

Local profiling on Node 24.20.0 found that fixture setup took only about 40 ms. The complete scenario made 6,950 loopback HTTP requests; idle-connection validation accounted for much of the waiting. A controlled fresh-connection comparison reduced one scenario from 14.49 seconds to 4.49 seconds with the same requests, recovery mutations, and logical outcome. This isolated result did not establish a safe matrix optimization.

An implementation using the owned test server's `maxRequestsPerSocket = 1` passed the persistent-versus-fresh equivalence regression, but failed during the complete interruption matrix. A bounded successive-pair diagnostic reproduced `EADDRNOTAVAIL` on loopback connections in its second pair after the first pair opened 14,211 connections. The fresh-connection approach exhausted available local connection addresses under sustained load. The test code was restored unchanged; no production code, workflow, timeout, concurrency, or coverage changed, and no hosted run used the experiment.

Do not adopt fresh connections based on the isolated speedup, cache negligible fixture setup, or add OS tuning, retries, longer deadlines, or platform branches to rescue this approach. Any future test optimization must pass the complete matrix and preserve persistent-connection coverage before a hosted timing comparison is useful.

## Propagation handling after 0.8.31

The 0.8.31 release exposed two false terminal failures. npm 11.17.0 returned exact-version `ETARGET` errors and attestation-endpoint `E404` errors after the version endpoint already returned HTTP 200; later audits returned complete valid evidence. Prepublication CI observation also found an active matching main CI run before its `validate` job existed.

The npm adapter now treats those two exact error summaries as pending only when they identify the validated single package and version. An attestation 404 must use the exact public npm registry URL. Known error codes are visible in bounded diagnostics, while raw output remains excluded. Authentication, integrity, malformed or unrelated errors remain fatal; batch audits and final verification still require complete evidence. The existing publisher convergence deadline, serial publication, and duplicate-publication protection remain unchanged.

The prepublication CI waiter now continues within its existing polling budget when exactly one valid active main/push CI run has no named `validate` check and no conclusion. Completed runs with missing checks and conflicting identities still fail. Neither fix adds a workflow, credential, timeout, gate, or publishing step. Regression tests establish recovery within the current budget; they do not establish a faster release. Measure the effect during the next ordinary release.

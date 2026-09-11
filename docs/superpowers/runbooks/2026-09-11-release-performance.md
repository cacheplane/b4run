# Release performance: baseline and operating notes

## Baseline

B4.run 0.8.30 took approximately 3 hours 34 minutes from the candidate merge at 2026-09-10 19:55:44 UTC through [the final operational documentation merge](https://github.com/cacheplane/b4run/pull/622) at 23:29:25 UTC. That interval included candidate CI (17 minutes), a release-selection repair (26 minutes), publication and recovery (88 minutes), and follow-up dependency/documentation work (82 minutes). It is not the duration of one successful publish job.

[The timed-out publisher attempt](https://github.com/cacheplane/b4run/actions/runs/34531019102) recorded at least 21 minutes of registry-visibility waits. The timed-out attempt recorded over 5.2 minutes of visibility waiting for `@b4run/cli`. Each recovery also paid roughly 6–8 minutes for detection and hydration. The two audit-response schema failures remain unexplained because their original responses were unavailable.

See [the cutover evidence](./2026-09-09-b4-run-cutover.md) for the exact candidate, release, successful publisher run, and independent audit. Reuse completed release evidence; do not publish a test version or repeat successful transitions to measure performance.

## Operating guidance

Prepare independent changes locally, but keep full CI submissions in small batches. Account for main validation and let an active run finish before replacing its head. Performance changes are submitted one PR at a time so timing comparisons remain useful. This guidance adds no publishing gate.

Runbook-only pull requests can use the narrow prose path introduced in [#626](https://github.com/cacheplane/b4run/pull/626). Eligibility is restricted to regular, non-executable Markdown under `docs/superpowers/runbooks/`; mixed changes, executable files, symlinks, site MDX, code, and configuration retain full validation. The base revision supplies classifier code. The existing required `validate` check remains present, and main pushes keep full CI.

Known temporary npm audit transport and service failures can use the publisher's existing convergence budget. Complete signatures and provenance remain required. Authentication, unknown/malformed errors, batch failures, and incomplete final verification remain fatal. No timeout, token fallback, workflow, manual prerequisite, or publishing step is added. This does not establish the cause of the historical audit failures or shorten registry propagation itself.

## Measuring subsequent ordinary releases

Use existing GitHub job timestamps and publisher diagnostics to distinguish queue time, setup, package publication, registry convergence, verification, and follow-up work. Report end-to-end elapsed time separately from the successful publisher duration. Compare against the same workflow scope and similar CI load; do not attribute a faster run to one change without evidence.

The next candidates are reducing repeated setup in the recovery test matrix and, only after profiling, overlapping safe registry verification work. Keep the complete interruption coverage, exact candidate binding, package ordering requirements, and duplicate-publication protection. These are follow-up investigations, not additional release requirements.

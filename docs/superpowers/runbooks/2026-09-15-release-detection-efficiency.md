# Release detection efficiency

Follow-up to [issue #668](https://github.com/cacheplane/b4run/issues/668).

## Problem and boundary

Main merges queue release-controller invocations; they do not cancel the active
publisher. The two failed 0.8.32 publisher attempts exhausted their overall
25-minute budget. Reducing detection overhead does not itself remove that limit
or npm propagation delays.

Three blocked detection runs consumed 18m39s in the 0.8.32 recovery sequence.
Two reported incomplete publisher job history. A queued first-attempt recovery
can legitimately have zero jobs, as confirmed by a live GitHub API response and
a local reproduction. The third run encountered a GitHub asset-download HTTP
500 that was later reported as a verifiable-base mismatch.

## Intended behavior

Ordinary non-version main pushes can return before global discovery when an
immutable comparison with their first parent proves release-maintenance inputs
are unchanged. Version changes, explicit dispatches, schedules, and controller
or recovery maintenance retain global candidate arbitration. Missing comparison
evidence falls back to full discovery.

A queued first attempt with a complete empty jobs response is treated as
unstarted only after fresh identity and state verification. Completed, retried,
started, or inconsistent runs still require complete publication history.

Historical release ownership remains discoverable independently of release
names, tags, or bodies. Independent inventory reads use bounded concurrency;
successful inventory results can be reused within one discovery invocation.
Mutation authorization continues to require fresh evidence.

Release-asset downloads can retry a bounded number of settled transient server
errors inside the original deadline and cumulative byte budget. Unsettled
transport errors and invalid successful content remain failures. Signed-download
requests do not receive GitHub credentials.

## Local ordinary-push check

Using the real Git and inventory readers, historical source merge
`a239527d8f52798509e77829d33f40d46880248a` returned `NO_CANDIDATE/noop` in
323 ms with zero remote-reader calls. This commit includes a changeset note and
source/doc edits. Changeset prose does not trigger release maintenance; its
configuration still does. This timing excludes workflow startup and installation.

## Local read-only inventory measurement

The baseline used the production GitHub reader against 483 releases on September
15, 2026: 483 inventory requests, one ownership-receipt download, peak concurrency
one, and 109.319 seconds elapsed. It found one durable recovery identity. The
comparison uses this saved release list, with fresh asset reads in both runs.

| Scan | Inventory requests | Ownership downloads | Peak concurrent reads | Elapsed |
| --- | ---: | ---: | ---: | ---: |
| Before | 483 | 1 | 1 | 109.319 s |
| After | 483 | 1 | 4 | 31.590 s |

Both scans returned the same durable recovery identity. The measured scan saved
77.729 seconds (71.1%) with no releases omitted. Network conditions may vary;
this is one local before/after sample, not a hosted or complete release benchmark.

## Measurement rules

Compare the same release inventory before and after with the production reader,
recording request count, peak concurrency, and elapsed time. This read-only scan
measurement excludes candidate arbitration, npm verification, CI, queueing, and
publication; it is not an end-to-end release speedup claim.

Measure the next ordinary completed release using the same candidate-merge to
public-GitHub-release boundary as the existing performance runbook. Do not count
failed, partial, or incident recoveries as clean release improvements. Publisher
deadline alignment remains separate follow-up work.

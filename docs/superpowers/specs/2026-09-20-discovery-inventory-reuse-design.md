# Reuse immutable release inventories during discovery

## Goal and evidence

Reduce repeated local Git work without changing candidate selection, publishing order,
verification requirements, or release deadlines. Issue #668 now records three completed
releases with one successful npm publishing attempt each. The 0.9.0 tag observation
still took 8m55s. A read-only local replay of 100 first-parent commits ending at
45f153c3dd985896210da398a0b318563f9635c5 requests 200 inventories for 101 distinct
commits. Initial baseline/prototype measurements were 22.433s/12.388s with identical
result digests, reducing showFile calls from 6022 to 3041 and listTree from 200 to 101.
This is an inventory microbenchmark, not a complete discovery or release speedup.

## Chosen design

Inside each resolveProductionCandidate invocation, wrap only the supplied inventory
reader in a private, bounded memoizing reader. Key by complete lowercase 40-character
commit SHA. Reuse in-flight promises and successful valid inventories between exact
candidate discovery, global arbitration, and terminal verification in that invocation.
Return deeply frozen copies so cached values cannot be changed by a consumer and the
underlying reader's objects are not frozen or mutated. Rejected reads and non-valid
results are not retained. Mutable refs and malformed refs pass directly to the original
reader, preserving its validation and fresh reads. Preserve the reader method receiver.

Keep at most 2048 entries, including in-flight entries. Once full, new keys bypass the
cache; existing keys remain reusable. This covers the bounded 1000-commit history plus
ordinary tag/terminal reads without introducing unbounded memory or eviction machinery.
The cache disappears when resolution ends. The caller's original inventory reader and
subsequent observation/authorization calls are untouched. Do not memoize Git ancestry,
branch/tag resolution, GitHub, npm, attestations, or any writes.

Alternatives: batching Git object reads needs a new process/stdin protocol and more
adapter surface; broader observation caching risks stale mutable authority. Both are
outside this small change. No workflow or public package changes are needed.

## Validation

Integration regressions through resolveProductionCandidate must cover shared exact/global
and concurrent reads; distinct SHAs; mutable refs; rejected and non-valid retry; cache
capacity; object isolation; and fresh separate invocations and original-reader calls.
Preserve existing discovery decision tests. Repeat the same real-Git inventory workload
through the resolver before/after and compare outputs and operation counts. Maintain
release content pins and their reviewed digest. Run focused observation and workflow
contracts, release integrity, and the full controller suite. Require hosted validation,
CopilotKit examples and real Vercel boundary checks before merge; monitor main afterward.
Do not dispatch a benchmark release. Measure complete hosted observation on the next
ordinary release to determine the actual total benefit.

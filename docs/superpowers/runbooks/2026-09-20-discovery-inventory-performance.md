# Discovery inventory performance — September 20, 2026

## Production context

Issue [#668](https://github.com/cacheplane/b4run/issues/668) records the latest completed
release measurements. All three releases after #678 completed publishing in one attempt:
0.8.35 (37m30s publisher step), 0.8.36 (55m15s), and 0.9.0 (49m35s).
0.8.36 had separate GitHub rate-limit and Docker startup failures; its 2h32m32s total
is not clean speedup evidence.

The [0.9.0 tag run](https://github.com/cacheplane/b4run/actions/runs/35522604500)
spent 8m55s observing after main CI had completed. Its 438 registry-pending events
include 369 version-absent, 11 metadata-pending and 58 audit-pending events. The sum
of the maximum recorded elapsed wait per package is at least 43m38.337s. Registry
convergence remains the dominant measured publishing cost. This change addresses
only repeated local inventory work, with no added publishing steps.

## Local measurement protocol

Node 24.20.0, local macOS checkout, existing Git objects. Read 100 first-parent
commits ending at the immutable 0.9.0 candidate and each first parent. This matches
the paired inventory workload in scheduled discovery. It requests 200 inventories
but only 101 distinct SHAs. Git operations use the actual production adapter;
inventories use the actual production parser/validator. The scheduled discovery
callback is injected to isolate inventory cost; it is **not** the complete production
arbitration path and performs no GitHub/npm verification. Its selection is a fixed
no-candidate fixture, so unchanged selection here is not independent decision proof;
existing discovery regression tests provide that coverage.

Before code changes, two resolver runs measured 22.191s and 22.593s, each making
6022 showFile and 200 listTree calls. A separate alternating uncached/memoized
prototype measured 22.433s/12.388s and 21.799s/12.284s. Prototype and baseline
inventory result SHA256 was
`bc7b58142945989b4ffe2bff55aa426bb3ee890c9774cd15ac43dca0603795e5`.

The final resolver implementation measured **13.799s and 14.278s**, with 3041
showFile and 101 listTree calls in each run. Both result digests match the baseline.
Mean elapsed time fell from 22.392s to 14.039s (about 37%, or 8.35 seconds in this
sample); total Git calls fell from 6222 to 3142 (about 49.5%). These are two samples
per revision on a shared developer machine, not an isolated statistical benchmark.
Operation counts and result equality are stronger evidence than the exact percentage.
The earlier alternating prototype timings are reported separately, not substituted
for the final implementation measurements.
Do not extrapolate these local timings to the full 8m55s hosted observation. Measure
that boundary on the next ordinary release; do not dispatch a benchmark release.

## Verification before submission

The six inventory regressions first failed on the missing reuse behavior (five
expected failures; the bypass behavior already passed). After implementation,
all six pass. The complete production-observation file passes 133 tests, release
integrity passes 33, and workflow contracts pass 166. Scoped Biome and whitespace
checks pass. The local workspace build passes after refreshing its dependencies.
The full controller suite and hosted merge gates are recorded in the pull request.
Independent spec review approved the implementation's freshness boundaries.

## Reproduction

Run from the repository root with dependencies installed. Execute once on the base
revision and once on the implementation; each execution prints two samples. The
fixed history revision must be present locally. This command reads Git only.

```sh
node --input-type=module <<'JS'
import { createGitReader } from "./scripts/release/adapters/git.mjs";
import { createProductionInventoryReader, resolveProductionCandidate } from "./scripts/release/observe.mjs";
import { createHash } from 'node:crypto';
const root=process.cwd();
const rawGit=createGitReader({root});
const history=await rawGit.listFirstParentHistory({ref:'45f153c3dd985896210da398a0b318563f9635c5',maxCount:100});
const pairs=await Promise.all(history.map(async ref=>[ref,await rawGit.firstParent(ref)]));
for(let attempt=0;attempt<2;attempt++) {
 const counts={};
 const git=Object.fromEntries(Object.entries(rawGit).map(([key,fn])=>[key,async(...args)=>{counts[key]=(counts[key]??0)+1;return fn(...args)}]));
 const inventory=createProductionInventoryReader({root,git});
 const start=performance.now();const results=[];
 const selection=await resolveProductionCandidate({event:{schedule:'17 * * * *'},inventory,git,github:{},marker:{},terminalRecordRef:'45f153c3dd985896210da398a0b318563f9635c5',discovery:{async discoverManagedCandidate(){throw Error('unexpected exact')},async discoverScheduledCandidate({inventory}){for(const pair of pairs) results.push(await Promise.all(pair.map(ref=>inventory.read({ref}))));return {candidate:null,state:'NO_CANDIDATE',disposition:'noop',tag:null,conflicts:[]}}}});
 console.log(JSON.stringify({label:process.argv[2],attempt,commits:pairs.length,requests:pairs.length*2,uniqueRefs:new Set(pairs.flat()).size,ms:Math.round(performance.now()-start),counts,selection,digest:createHash('sha256').update(JSON.stringify(results)).digest('hex')}));
}
JS
```

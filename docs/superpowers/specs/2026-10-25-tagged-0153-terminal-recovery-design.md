# Tag-only 0.15.3 terminal recovery

## Approved outcome

Preserve the failed candidate and all evidence while allowing the normal release
controller to advance to 0.15.4. The user approved this narrowly scoped recovery
on 2026-10-25. This is an incident-specific extension, not a general abandonment
workflow or permission to repair an immutable tag.

## Fixed identity

- Repository: `cacheplane/b4run`, numeric ID `1210070282`, default branch `main`.
- Version: `0.15.3`.
- Candidate: `2ef24c2453b031e068e99ced4cc57355f49e63d6`.
- Annotated tag object: `8221db88b2936394254847bcf220bcacb474cff7`.
- Tag: `v0.15.3`, directly targeting the candidate commit.

Preparation failed before escrow and npm publication. The immutable candidate
contains an incompatible optional LangGraph peer pin; main fixes that and contains
the ATC output-cap, replay, and request-owned client-tool store fixes. Current
arbitration selects the older unfinished tag before a newer candidate. Existing
schema-1 terminal records require an escrowed draft and cannot describe this case.

## Architecture

Extend the canonical git-resident terminal record parser with schema 2, accepted
only for the fixed identity above. Preserve schema 1 exactly. Schema 2 retains
the existing top-level record fields and canonical sorted-key bytes, but describes
`CANDIDATE_TAGGED` with an absent Release: null release ID/body/marker/artifact,
empty escrow assets, and null duplicate recovery. All 21 current package names
must occur in two exact 404/E404 absence sweeps at least 60 seconds apart. Every
candidate release-run attempt must be completed with publication never started.
The capture window remains bounded to 15 minutes.

A new read-only, incident-specific collector uses existing GitHub/npm reader
adapters. It verifies repository and authenticated operator identity, the direct
annotated-tag peel, complete workflow/run/job inventories, and no Release for the
tag. It checks every attempt of every candidate Release workflow run, requiring
exactly one completed/skipped `publish-npm` job per attempt. It refuses missing,
ambiguous, incomplete, duplicated, mismatched, active, or publishing evidence.
GitHub stamps skipped jobs with timestamps; completed/skipped, rather than a null
start timestamp, is the proof that publication did not execute.

The collector brackets the npm sweeps with matching GitHub snapshots. It rechecks
operator/repository/main/tag/release/run evidence, refuses drift, and returns exact
canonical bytes through the production parser. The CLI writes an exclusive new
output file with mode 0600. It has no GitHub writer, npm publisher, tag mutation,
Release mutation, workflow dispatch, or policy override. It accepts only reviewed
commit and output path arguments; incident identity and reason are code-owned.

The collector must run from a clean checkout at the reviewed implementation merge
SHA, proven reachable from live main. Use GitHub comparison to live main and exact
local HEAD/clean-status checks. Token input is the existing GITHUB_TOKEN environment;
never print it. Bound API pagination and refuse all non-PRESENT/non-ABSENT results.

## Integration and authorization

The existing candidate selector already binds committed records to the live tag
name/object/peel and excludes terminal candidates. Add regression coverage proving
the schema-2 record releases the 0.15.3 hold, while no record, tag drift, malformed
record, or publication evidence remains blocking. A schema-2 record must never be
accepted as an escrowed-draft tombstone; refuse any visible Release for its tag.
`abandonment.mjs` must explicitly reject schema 2 in Release tombstone/body
producers and readers, even though they share the canonical git-record parser.
Normal observer/audit consumers must understand schema 2 only as this committed,
tag-only terminal record. They must not dereference its null escrow marker.

Changing the parser is release-reachable: update its content pin and the pin-fixture
snapshot with review. Preserve workflow topology, trusted publishing, exact CI,
provenance, artifact sealing, and disabled workflow abandonment.

Land the implementation PR on complete required CI, including Vercel/CopilotKit.
Then use its reviewed merge SHA to capture fresh evidence and open a second PR
containing only the canonical `scripts/release/terminal-records/v0.15.3.json`.
Hold the operator release edit freeze. Review and merge that record on green CI,
after independently rechecking absence and all tag/Release/run evidence immediately
before merge; stop on drift. The git-resident record itself is the
terminal authority; no draft exists to stamp and none will be manufactured.
Reobserve selection, refresh the version PR, validate and merge the normal 0.15.4
candidate, then publish only through the supported controller. Never move/delete
the 0.15.3 tag or publish altered 0.15.3 bytes.

## Testing

Test first: schema-2 acceptance fails under the current parser. Cover fixed-identity
substitution, null/absent predecessor shape, unknown fields, schema-1 compatibility,
current package inventory, missing/present/ambiguous npm results, short/reversed
sweeps, stale capture, active/missing/duplicate publisher jobs, missing attempts,
wrong run source, tag/ref/repository/operator drift, visible Releases, and output
file overwrite. Drive the collector with injected readers/clock/wait to verify
proof ordering and fresh second reads without live writes. Test the CLI boundary
and canonical bytes separately. Exercise real candidate arbitration and observer
integration using fixtures; do not synthesize a production record from fixtures.
Run focused parser/collector/candidate/observer tests, release integrity and workflow
contracts, lint/docs checks, and the complete release-controller suite. Required
remote CI remains the final merge gate.

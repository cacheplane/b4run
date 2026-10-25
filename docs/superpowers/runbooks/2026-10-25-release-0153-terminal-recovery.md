# Recover the tag-only 0.15.3 candidate

This incident-specific procedure preserves `v0.15.3` and retires only candidate
`2ef24c2453b031e068e99ced4cc57355f49e63d6`, annotated tag object
`8221db88b2936394254847bcf220bcacb474cff7`, in repository `cacheplane/b4run`
(ID `1210070282`). The candidate failed immutable preparation before creating a
Release or publishing npm packages. Its pinned optional LangGraph peer makes
consumer installation fail. Main fixes that problem and includes the ATC agent
output-limit, replay, and request-owned client-tool store changes.

## Invariants

- Preserve the tag, failed runs, logs, observations, and any historical artifacts.
- Do not publish altered 0.15.3 packages or create a Release to represent evidence
  that never existed. The new schema-2 record is Git-only, never a tombstone asset.
- Keep the ordinary release workflow, exact CI, provenance and immutable payload
  gates. Workflow abandonment remains disabled.
- Hold an operator release edit freeze throughout capture, record review and merge.
  Do not dispatch reconciliation of 0.15.3 while the recovery is in progress.
- If any exact package is present, any Release exists for the tag, a publish job
  ran, a run is active, evidence is incomplete, or an identity changes: stop.

## 1. Merge reviewed code

The implementation PR must pass complete required CI, including native Vercel
and CopilotKit. Record the exact implementation merge SHA as `RECOVERY_SHA`.
Use a fresh isolated checkout at that SHA, with no local modifications. The
collector proves that this checkout is exact and clean and that the reviewed
SHA is reachable from live main. It never changes remote release state.

## 2. Capture fresh evidence

Provide `GITHUB_TOKEN` privately through the environment using the existing
operator principal. Never print the token, save it to the repository, or put it
in a command argument. Confirm the token login with `gh api user` using that same
environment. Then, from the clean repository root:

```sh
mkdir -p .b4/release-recovery
chmod 700 .b4/release-recovery
env -u NODE_OPTIONS -u NODE_PATH node scripts/release/capture-v0.15.3-terminal.mjs \
  --reviewed-commit "$RECOVERY_SHA" \
  --output .b4/release-recovery/v0.15.3-capture-01.json
```

Choose a new output name for each attempt; an existing output is never replaced.
The command takes at least 60 seconds. It verifies the numeric repository ID,
authenticated operator, live main ancestry, exact annotated tag and direct peel,
complete workflow/run/job inventories, and absent Release. Every attempt of
every candidate release run must contain exactly one completed/skipped
`publish-npm` job. GitHub timestamps skipped jobs; a null timestamp alone is not
proof that publication did not start.

The collector requests all 21 exact package versions twice, at least 60 seconds
apart, requiring exact ABSENT/404/E404 results each time. Matching fresh GitHub
snapshots bracket those sweeps. The entire capture, including the initial GitHub inventory, must fit within
15 minutes. Every release-owner run must be terminal, including coordinators on
main that could otherwise relay a tag run. Inspect the
canonical one-line sorted-key JSON, the printed SHA-256, fixed identity, operator,
reviewed commit, two package sweeps and all run attempts. The output is mode 0600.
No live production record may be built from test fixtures or hand-edited facts.

## 3. Review the record-only PR

Copy the exact captured bytes to
`scripts/release/terminal-records/v0.15.3.json` on a separate branch. Open a PR
containing only that file and record its capture hash and UTC interval. Run
release integrity/controller checks and wait for all required CI. The record
parser accepts schema 2 only for this incident and refuses Release/escrow data,
missing package evidence, attempted publication, incomplete attempts and stale
capture windows. Schema-1 escrowed recovery keeps its prior behavior.

Immediately before merging the record PR, independently repeat npm absence plus
tag, Release, and **all-attempt run/job** checks. Stop on drift; do not edit the
record to conceal it. Keep the operator edit freeze until the record is merged.
The merged Git record is the terminal authority. No Release exists to stamp and
none should be created.

## 4. Resume the ordinary release

Use the supported read-only controller observation from current main to verify
0.15.3 is terminal and no longer blocks newer candidates. A visible Release or
changed tag must remain a conflict. Refresh the 0.15.4 Version Packages PR and
confirm it contains the peer correction and both ATC compatibility fixes. Merge
only after its required CI is green. Let exact candidate CI pass, then reconcile
that exact version/SHA through `.github/workflows/release.yml` if needed.

Require npm publication, all smoke lanes, independent audit and an immutable
GitHub Release. Then install the published packages in Hashbrown and repeat its
server/browser/artifact/Postgres and lifecycle checks. Do not treat local source
results as evidence for a published package set.

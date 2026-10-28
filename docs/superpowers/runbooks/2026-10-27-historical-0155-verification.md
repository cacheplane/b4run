# Historical 0.15.5 verification and ordinary 0.15.7 recovery

This runbook implements the separately approved [historical verification design](../specs/2026-10-27-historical-0155-verification-design.md) and [execution plan](../plans/2026-10-27-historical-0155-verification.md). It supplies a procedure, not captured evidence or release authority. The code PR must leave `scripts/release/historical-publications/v0.15.5.json` and its evidence directory absent.

The historical assertion means that the original authenticated verifier reported complete verification, while fresh checks still establish the exact published bytes and remaining provenance. It does not restore or reproduce the unavailable npm keyed publish bundle. It applies only to the code-owned 0.15.5 tuple. Every ordinary 0.15.7 publication gate remains required.

## 1. Merge and qualify code without evidence

1. Independently review the parser, original evidence authentication, current observer, read-only collector, optional data inventory, sparse import closure and content pins. Complete spec review before code-quality review.
2. Run all normal repository checks from the exact proposed code head, including release integrity, workflow contracts, complete controller suite, lint, build-cache, build, typecheck, source tests, inventory, docs, package checks and harnesses. Preserve failures; do not skip tests or loosen trust checks to get a pass.
3. Open the ordinary code PR with no production historical record or supporting evidence. Verify that exact absence from its Git diff and tree. Wait for all normal CI plus real native Vercel and CopilotKit checks, then merge the exact reviewed head normally. Do not use an administrative merge or cancel release runs.
4. Confirm that the merged observer still fails closed when the historical record is absent. Code merge alone grants no historical completion authority.

## 2. Drain owners and freeze edits

1. Inspect every release owner: `publish-chart.yml`, `published-artifact-verify.yml`, `release-postpublication-audit.yml`, `release-postpublication.yml` and `release.yml`. Wait for every queued or active invocation to settle, including scheduled observers. Do not cancel them or rerun a publisher.
2. Begin an operator release edit freeze covering capture, evidence review and the immediate premerge recheck. Do not dispatch 0.15.7, edit a Release body or assets, change tags, or overlap another reconciliation. If an owner starts, wait and restart capture from a new private output location.
3. Use an exact clean checkout of the merged reviewed implementation SHA. Confirm its ancestry from live main and authenticate the intended operator and `cacheplane/b4run` repository ID `1210070282`. Keep ephemeral read credentials private; never put token values in command arguments, evidence, logs or Git.
4. Put the pinned npm `11.17.0` binary on PATH. The collector runs only the official read-only `npm audit signatures --no-package-lock --json --include-attestations` command in isolated synthetic consumers with credential-free npm homes and caches. It does not install packages or obtain publication credentials.

## 3. Capture actual service evidence

Run from that checkout, using the full reviewed merged SHA and a new absolute output directory outside the repository. The output path and its existing ancestors must be real directories, without aliases. Supply `GITHUB_TOKEN` only through the private process environment.

```sh
node scripts/release/capture-v0.15.5-historical.mjs \
  --reviewed-commit MERGED_REVIEWED_40_HEX_SHA \
  --output /private/tmp/historical-0155-capture-UNIQUE
```

The placeholders must be replaced with actual values. The command has no version, repository, record-path or retained-archive override. Initial capture requires the actual original Actions artifact metadata and successful service download. An expired or unavailable original service archive blocks initial capture; a private ZIP or test fixture cannot substitute. The runtime observer's later, independently reviewed Git evidence expiry path is a separate authority boundary.

The collector must finish within fifteen minutes and must obtain all of the following:

- Actual immutable Release manifest bytes, matching the exact code-owned sealed manifest digest, retained as `evidence/v0.15.5/manifest.json`.
- Fresh original publisher run, attempt and complete job authentication; artifact ID, name, producing run, exact binary ZIP/service digest; exactly one safe bounded `npm-evidence.json` ZIP member; and its exact canonical complete receipt, authenticated against all 21 sealed manifest entries.
- Fresh original independent audit run, attempt and complete job authentication, plus both exact immutable canonical and attempt audit receipt assets. The current editable marker must agree with those independent bindings.
- Two fresh sweeps of all 21 public registry package versions and actual tarball bytes, with exact sizes, SHA-256, SHA-512 and SRI. The sweep start times must be at least sixty seconds apart. Each sweep independently runs complete ordinary official verification for the unaffected 20 and retains the affected package's successful actual official output.
- Matching bracketed GitHub identity and state reads, including operator, main ancestry, complete Release and owner inventories, original source/tag/artifact/audit metadata and no active or queued release owner.

The affected command's raw output has no historical authority. Only after both actual sweeps and matching brackets exist does the collector construct the proposed canonical record and validate both outputs against it. Its supporting bytes contain no future record digest or invented future observations. Both sweeps must show precisely the known one-provenance/no-keyed-publish shape. If complete ordinary verification becomes available, stop historical admission and use fresh ordinary observation and global discovery instead.

Any drift, incomplete pagination, failed command, unexpected proof, alias, unsafe ZIP, byte limit, cancellation or budget exhaustion aborts. Do not edit observations to make a capture pass. Preserve any private partial output for inspection and recapture into a new directory after resolving the cause. The collector creates exclusive mode-0600 files inside mode-0700 directories and never writes admitted repository data or mutates GitHub/npm.

## 4. Review a separate evidence admission PR

1. Inspect the exact captured bytes, capture interval, two sweep starts, matching bracket digest, authenticated operator/controller, original run/job/artifact/audit bindings, all package identities and every supporting file size/hash. Independently review the original verifier assertion and its explicit unavailable fresh keyed publish proof.
2. Start a separate branch from merged main. Copy only the genuine captured record and declared supporting bytes to their exact code-owned paths under `scripts/release/historical-publications/`. Normalize files to regular mode 0644 for Git admission; do not change any evidence byte, JSON formatting, recorded time or fact. Never use fixtures or reconstructed service responses.
3. Run the strict optional data-family discovery. It must validate the incident's immutable manifest, canonical record, exact closed supporting inventory, regular file modes, absence of aliases and every actual byte digest. A missing family is allowed only when wholly absent; an incomplete existing family fails closed.
4. Update only necessary derived data content pins and the reviewed pin-file digest snapshot through the existing audited inventory procedure. This separate admission PR may contain the genuine record/support data and necessary derived pin metadata; it must not change policy, scripts, workflow permissions, gates or topology. The already merged code must accept valid admission without a source change.
5. Independently review the data PR and run full normal CI, including integrity/controller checks and the real native Vercel/CopilotKit gates. Keep the operator edit freeze in force.
6. Immediately before normal exact-head merge, independently repeat the required live original evidence, all-21 byte and official proof checks, owner drainage, exact candidate/tag and global selection checks. Compare every stable identity/digest with the reviewed capture. Capture age never waives freshness. If anything drifts, preserve the original evidence and recapture/re-review genuine new bytes rather than changing old facts.
7. Verify the PR head and normally merge only that reviewed evidence head. Preserve failed controller runs and historical assets. Do not force a merge, move tags, delete history, republish 0.15.5, mint another version, activate dormant recovery, or change production application settings.

## 5. Observe historical completion, then select 0.15.7 globally

From the exact merged trusted controller checkout, perform a fresh positive production observation of 0.15.5. Require its typed historical completion proof, authenticated original assertion, exact all-21 registry bytes and all unchanged non-npm terminal obligations: manifest and payload attestations, canonical immutable Release metadata/assets, original audit correlation, real smoke receipts, CI/inventory/source identities and no contradictory recovery or abandonment evidence. A private diagnostic report or an empty diagnostic list alone is insufficient.

Then perform the full fresh global candidate discovery/selection. Require conflict-free selection of exactly `0.15.7` at `e67a92e4dc3b0f5ffc884ecee3fa8d87d5d788c4`, with annotated `v0.15.7` object `46c8f5322cc2fdba38d1c40c5c2b1415541e2527`. Do not infer selection from a version-specific observation. If ordinary verification of 0.15.5 is available, require its normal positive completion and the same full discovery route.

Only after those fresh positive checks should the operator end the edit freeze and allow the existing ordinary controller to continue. Inspect owners first. If no owner is active/queued, the controller has settled, and reconciliation is still necessary, issue one supported ordinary `release.yml` reconciliation for the existing exact 0.15.7 candidate. Do not choose a replacement CI run ID, rerun a publisher, bypass a gate, or move the existing tag.

## 6. Independently verify ordinary 0.15.7 completion

Require the existing normal proof for every package, including both npm bundle types. Verify exact annotated tag/source, unique qualified candidate CI, immutable public Release, complete attested manifest/subject set with hosted-runner/workflow/ref identity, all 21 public package byte identities, all five real smoke receipts, and the correlated independent audit. Use registry verification only with the actual final manifest and candidate. Do not manufacture positive receipt flags before checking facts.

Report 0.15.5 as historically verified under the reviewed assertion policy, explicitly preserving the unavailable old keyed publish bundle. Report 0.15.7 completion only after its complete ordinary production proof succeeds. Keep all unrelated release and application state unchanged.

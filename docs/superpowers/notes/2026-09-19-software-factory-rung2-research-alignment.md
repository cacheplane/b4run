# Rung 2 against the field: research alignment note

Date: 2026-09-19
Subject: [rung 2 design](../specs/2026-09-19-software-factory-rung2-design.md)
Method: four parallel literature and product surveys (factory architectures;
verification and test gaming; hermetic environments and provenance; durable
execution and approval), each asked to grade the design point by point and to
be skeptical. Findings were then checked against the code before being
accepted; several reported gaps turned out to be already closed and are
recorded as such so nobody re-opens them.

## Verdict in one paragraph

The controller-owns-verification core is more rigorous than any shipping
product surveyed (Copilot coding agent, Cursor cloud agents, Ramp's Modal
agent, StrongDM's Attractor) and matches what the 2025-2026 reward-hacking
literature prescribes: hidden checks applied after the visible suite in a
separate sandbox, hash-verified artifacts recomputed outside the agent's
reach, and an inconclusive verdict that never collapses to fail. The
digest-bound approval with re-verification before export has no published
precedent, which is a point in its favour and also means no external
reference implementation exists to check it against. The real divergences are
in three places: the image identity as specified was a local image id
mislabelled as a digest, the two-symlink dependency layout would resolve
workspace siblings into the image's stub copy, and one independent check per
task is below what every oracle-strengthening study says is needed. All three
are amended in the spec. The remaining divergences are rung 3 and rung 4
concerns and are listed as such.

## Aligned, with the strongest sources

| Design point | Evidence |
|---|---|
| Application-owned state machine drives a worker over a narrow protocol | Attractor's graph engine and pluggable handlers; OpenHands' backend-to-execution-server split; Ramp's control plane versus Modal sandboxes. Same shape everywhere. |
| Builder has no channel to report a verdict; controller reads the bytes itself | Attractor admits any handler can write `status.json` with no truthfulness check; Anthropic's evaluator split exists because agents "confidently praise" mediocre work. The "hidden recomputation outside the sandbox" and "hash-based artifact validation" hardenings cut exploits 87.7% in the Reward Hacking Benchmark (arXiv 2605.02964). |
| Separate verifier container; independent checks written in after the visible suite | SWE-bench and SWE-bench Pro apply hidden tests after the patch; StrongDM stores scenarios outside the codebase; "Building to the Test" (arXiv 2606.28430) finds hidden tests essential. Copilot, Cursor and Ramp verify in the agent's own sandbox, which is the weaker side of that result. |
| Snapshot before and after each suite | Anthropic's harness relies on "strongly-worded instructions" not to remove tests; Copilot gates workflow runs because the agent can edit CI files. Mechanical detection is what OpenAI's "enforce at the system level" principle demands. |
| pass / fail / inconclusive | Denial-of-evaluation is a named exploit class; Attractor distinguishes `PARTIAL_SUCCESS` and `RETRY` from `FAIL`. Binary CI red/green is the industry norm and is worse. |
| Re-seeded historical defect with a reference patch | SWE-smith's PR-mirror construction; Anthropic's "keep a reference solution that passes all graders". |
| Two-phase command log with intent comparison | Stripe's idempotency contract (first outcome saved regardless of success; parameter mismatch is an error). Verified in `registry/commands.ts`: `begin` throws on a same-key different-intent replay. |
| Reconciliation never re-dispatches; `exporting` settled by content | OneUptime's "query by id before retrying" rule; Temporal's "reprocessing the last checkpoint must be safe". |
| Approval binds a frozen bundle digest; expiry fails closed | Temporal's document-approval pattern auto-rejects on SLA expiry. Verified in `controller/factory.ts`: an expired bundle is refused with "deny or cancel it" and the row does not move. Binding policy and spec into the digest is stricter than any source. |
| Policy or spec change while awaiting approval | OpenAI Agents SDK advises a version marker beside serialized state. Verified: `approve` compares the frozen policy, specification, baseline, destination and environment against the live values and refuses with `bundle_invalidated`. |
| Network denied; frozen install; no turbo in the container | Codex blocks network in the agent phase by default; Nix and Bazel hermeticity; the repository's own documented turbo external-input hazard. |
| Sandbox hardening | The Docker provider already applies `--network none`, a pids limit of 512, read-only root filesystem and `no-new-privileges` by default. The environment survey's checklist is met except kernel-level isolation, which is stated as an accepted risk. |
| Capture limits | The survey warned of silent truncation. Verified in `workspace/src/source-capture.ts`: the capture throws on the entry or byte limit. Fail-closed, not silent. |

## Diverges, amended in the spec

1. **Image identity.** A Docker image id is the hash of the image's config JSON, host-specific and non-reproducible without `SOURCE_DATE_EPOCH`. It is not a digest and cannot be pulled by another host. The spec now records an `image` object: the local id, named as such, plus the inputs that determine it (base image manifest digest, platform, Dockerfile sha256, lockfile sha256, pnpm version). The environment identity every bundle binds is the digest of that object, so a second host can at least verify that the same inputs were used. Pushing to a registry and binding the manifest digest is recorded as the rung 3 upgrade.
2. **Multi-arch base image.** `node:24-slim@sha256:...` names a manifest index; an arm64 laptop and an amd64 CI runner pull different images. The Dockerfile pins `--platform` and the platform is part of the image object.
3. **Workspace siblings in the dependency links.** Verified locally: `packages/devkit/node_modules/@b4run/config-typescript` is a relative symlink to `../../../config-typescript`. Inside the image that resolves to the image's copy of the sibling, which the draft spec said held only a `package.json`. The image now copies every workspace sibling in the filtered closure in full and builds it if it has a build script. For devkit the sibling is json-only.
4. **One independent check is not enough.** Every oracle-strengthening study (SWE-ABS, Probe-to-Generate, PatchDiff) found the majority of tasks have holes even with full suites, and the escalation-channel study found roughly half of hacking is hardcoding, which leaves no file trace for a snapshot to catch. The spec keeps one check for this rung's proof but adds a **task admission gate** in layer 2: the independent suite must fail on the defect-patched baseline, pass on the reference repair, and use inputs disjoint from every visible test. A check that cannot distinguish the defect from the fix is not admitted. Mutation-scoring a task against deliberately wrong repairs is recorded for rung 3, where a model produces repairs.
5. **Test-runner configuration is an attack surface.** The visible suite runs `pnpm test`, which reads `package.json` scripts and `vitest.config.ts` from the workspace. If either were an allowed source path the "immutable tests" guarantee would be hollow. The spec now requires the target's runner configuration files to be listed as immutable paths and adds a layer 1 test that a task whose allowed paths include one is refused at load.
6. **Provenance of the baseline.** The defect patch's sha256 and the capture allowlist are now part of `policyDigest`, so a changed patch or allowlist invalidates a bundle the same way a changed check does.

## Diverges, deferred with a rung named

| Gap | Source | Rung |
|---|---|---|
| No separation of duties: the requesting principal can approve | Copilot: the requester cannot approve the agent's PR; OWASP ASI03 | The authentication rung, before any external delivery |
| No liveness signal from a running verifier beyond its start-to-close deadline | Temporal heartbeat timeouts, 2-3x the heartbeat interval | Rung 3, when verifications are long enough for a wedge to matter; the 600 s deadline bounds it today |
| Hidden checks are static; a leaked suite is leaked forever | CapCode's randomised tests with a ceiling; StrongDM's external scenarios | Rung 3 |
| No behavioural or runtime verification, no model judge | Anthropic's Playwright evaluator; Spotify's LLM-judge veto; StrongDM's digital twin | Not before a second target exists |
| One attempt, no repair loop | Every production system loops; refinement loops raise overfitting (arXiv 2511.16858) | Rung 3, and the loop must not feed independent-check output back verbatim |
| No "the checker is broken" channel for the builder | Escalation-channel study cut hacking from 23.6% to 5.3% | Rung 3 |
| Pin does not advance; live pipelines track HEAD | Ramp rebuilds snapshots every 30 min | Rung 3 |
| Draft PR delivery inherits pwn-request risk | GitHub's `pull_request_target` guidance; checkout v7 defaults | Rung 4 |
| Contamination: the reference fix is a public commit a model may recall | SWE-bench Live's 43% versus 19% on post-2024 issues | Applies only when pass rates are read as capability evidence; rung 2 reads none |

## Reported gaps that were already closed

Recorded so they are not re-raised.

- Transition atomicity: `transition` runs the row update and the journal append in one SQLite transaction (`controller/factory.ts`), and the candidate, receipt and bundle writes each share a transaction with their journal line.
- Double decisions: approve is keyed by id, revision and bundle digest; deny by id and revision; a second approve returns the first outcome, and approve after deny is refused by state.
- Content compare on export: the file is named by the bundle digest and its body is deterministic JSON of the bundle and the changed files, so an EEXIST with different content is a determinism defect and is surfaced as `export_failed`, not retried.
- `--ignore-scripts`: devkit and its one sibling declare no lifecycle scripts, and the repository's `onlyBuiltDependencies` list contains only `workerd`, which is outside the closure. The prepare script asserts the install result against the lockfile anyway.
- `export-subst` and `export-ignore`: the repository's `.gitattributes` declares neither, so `git archive` of a commit is deterministic and the SHA is the pin.

## Sources consulted

Full URL lists are in the four agent reports this note distils; the ones that
carry the amendments above are:

- https://arxiv.org/html/2605.02964v1 (Reward Hacking Benchmark; environmental hardening)
- https://arxiv.org/html/2608.29460 (escalation channel; hardcoding versus tampering split)
- https://github.com/OpenAgentEval/SWE-ABS and https://arxiv.org/abs/2604.01518 (oracle strengthening)
- https://arxiv.org/abs/2606.28430 (Building to the Test)
- https://factory.strongdm.ai/ and https://github.com/strongdm/attractor
- https://www.anthropic.com/engineering/harness-design-long-running-apps
- https://docs.github.com/copilot/concepts/agents/cloud-agent/risks-and-mitigations
- https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-provenance.md
- https://github.com/moby/buildkit/blob/master/docs/build-repro.md
- https://pnpm.io/symlinked-node-modules-structure and https://pnpm.io/filtering
- https://git-scm.com/docs/git-archive
- https://docs.temporal.io/guides/reliable-document-approvals
- https://docs.stripe.com/api/idempotent_requests
- https://docs.langchain.com/oss/python/langgraph/interrupts

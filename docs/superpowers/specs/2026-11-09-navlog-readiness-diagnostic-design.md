# Read-only Navlog readiness evidence

## Observed failure and unresolved cause

PR 1139 merged as `71543329217691c1eb84b93c61cf6e23ed5543ca`, parent `603d534034118d159827868307140d432129f14a`, reviewed tree `b69d52cf3e3b1c1cd44240313e3368c2e259c0d0`. Automatic deployment run `42725703160` checked out that exact commit. At `2026-11-10T00:09:42.110Z`, the validated service had a different path and timeout 120. One environment patch returned an acknowledgement; at `.405Z`, an identity/type-valid immediate readback still did not match. Upload, rollout polling, and public probe were skipped, so no uploaded deployment ID exists. Raw log SHA256: `aa46b9dc37c0c91977d50e42a11584024c8c4b90900a30fdb61fbbd24f9ee134`.

The hypothesis is asynchronous patch application or delayed service-instance materialization. It is unconfirmed. The pinned schema exposes patch statuses APPLYING, COMMITTED, STAGED and nullable appliedAt. Neither a mutation acknowledgement nor an immediate mismatch proves persisted desired state or failure. Configuration override is another unconfirmed explanation. There is no tracked Railway JSON/TOML configuration in this source tree; fixed `.railway.json` locations in the root and Navlog directories were absent. Existing local provider credentials are unavailable and must not be extracted from Actions.

## Evidence operation

Extend the already registered `deploy-navlog.yml` diagnostic dispatch with a `readiness` boolean, default false. Invoke the reviewed branch with `diagnose=true`, `readiness=true`. Both the deploy-job condition and diagnostic-job condition recognize readiness mode, so even readiness=true without diagnose cannot reach upload or configuration mutation. The old build-log step is gated off in readiness mode; the new read-only step runs in the existing Node-only diagnostic job, with no checkout or CLI install.

GitHub explicitly supports a registered manual workflow on another branch with `--ref BRANCH`: [manual workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow). The [REST dispatch endpoint](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) accepts a branch or tag as ref. The branch head must be checked before dispatch and the actual run head verified afterward. No production merge is needed to gather this evidence.

Use the existing Actions project secret, fixed endpoint and two fixed read-only queries. First validate projectToken against project `6f45f6e2-4190-4eb3-9820-3ff307a4e7d9` and a UUID environment. Then validate environment name production/project and service name navlog-server/UUID `1b8bb6df-ebb5-4cde-b086-c97216161c51`, and read:

- Instance path/timeout plus railwayConfigFile presence (never its raw path).
- Nullable latestDeployment with id, enum status, createdAt, environmentId and serviceId; verify both target bindings before emitting selected facts.
- First ten environment patch metadata records: safe ID, matching environmentId, enum status, createdAt/updatedAt/appliedAt and only a boolean presence projection of lastAppliedError. Record pagination presence.

All field/type/nullability evidence is the saved official Railway CLI schema at `/private/tmp/navlog-railway-api-schema.json`, pinned to `railwayapp/cli@5a07ac2ae44ec2fcf892ba96e18f638402c7f8fb`. The exact queries are in the private workflow diff. No config scalar, patch JSON, variables, deployment meta, build logs or provider error text is output. The previous acknowledgement ID was not logged; these patch records are time-window candidates, not an exact correlation. The first-ten connection does not justify claiming a complete history or guaranteed ordering.

Use a shared 30-second deadline, streamed 64-KiB cap, redirect rejection, HTTP/JSON/UTF-8/GraphQL checks and static failure messages. Validate the entire response before one typed JSON record. Only `/readyz`, `/healthz` or null are emitted as paths; other paths use a fixed marker. Query errors and lastAppliedError text never enter runner output. No stage, commit, deploy, variable mutation or retry operation exists in this new step.

## Decision after observation

If current settings match and candidate patch appliedAt follows the failed immediate readback, delayed application gains direct support. If settings still differ, patch status, appliedAt, error presence and latest deployment timing narrow the next investigation. A config-file presence flag may justify a separately reviewed override investigation. Do not implement a polling fix, change provider settings, replay the previous mutation or rerun deployment without the coordinator reviewing actual evidence and granting the next action.

## Scope and verification

Six files: the workflow, its existing operational contract tests, the two exact workflow inventories, this spec and its plan. The production configuration script is unchanged. Tests execute the exact new inline script against synthetic responses only, covering diagnostic mutual exclusion, fixed read-only calls, validated bindings/types/lifecycles/pagination, bounded transport failures and safe projections. Local verification used an isolated home, scrubbed environment, child umask 022, synthetic responses and bounded owned process groups. Actual baseline RED failed because the readiness flag/step were absent; restored focus passed 25/25, full workflow contracts 325/325 and integrity 34/34. The first three-file Biome check exited 1 on the newly added readiness input descriptor’s indentation. The separately authorized five-line indentation correction preserved parsed JSON exactly; the subsequent three-file Biome check passed with no fixes, and git diff --check passed. Both formatting outcomes are preserved. No provider calls, push or dispatch have run. Fresh SPEC/QUALITY review is required before any reviewed-branch push or read-only dispatch.

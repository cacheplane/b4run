# Read-only Navlog current readiness settings

## Observed failures and limits

Production run `42725703160` checked out merged source `71543329217691c1eb84b93c61cf6e23ed5543ca`. The exact project/production/service binding and settings types validated before and after one acknowledged environment patch. At `2026-11-10T00:09:42.110Z`, the path differed and timeout was 120; at `.405Z`, immediate readback still did not match. Upload/poll/probe were skipped. No uploaded deployment ID exists. Raw log SHA256: `aa46b9dc37c0c91977d50e42a11584024c8c4b90900a30fdb61fbbd24f9ee134`.

The subsequent single read-only branch run `42729395730` checked out `87785e53b732f3c440d002a4518141e37e337d76` (tree `b357faf6dc70c2036f9d4a8be3d7169cc5e4fa05`). Deploy job and old build-log step were skipped. At `2026-11-10T00:35:10.340Z`, the new diagnostic failed with “production service identity or diagnostic fields are invalid” after its second HTTP-success/error-free GraphQL request. No typed settings record was emitted. The exact invalid field is unknown; the broad validator included optional metadata as well as the needed settings. Raw log SHA256: `7e95b9fdc11f2b86908b24a9e962e160bff8fa6e067afbd93f3e3dcc12e99263`. Both raw logs, run receipts, old source and local failures remain preserved.

Delayed patch application/materialization and overrides remain unproven explanations for the original immediate readback mismatch. This change does not identify which field caused the broad diagnostic failure or claim that desired settings are already persisted.

## Minimal current-state observation

Keep the registered workflow’s reviewed diagnose/readiness guards, existing remote project credential, fixed two-request transport and production configure/upload/poll/probe code unchanged. Keep the old log script unchanged. The readiness input description now accurately says current settings only.

First query `projectToken { projectId environmentId }`, require project `6f45f6e2-4190-4eb3-9820-3ff307a4e7d9` and a UUID environment. Then reuse verbatim the production targetQuery that already validated successfully in run 42725703160:

```graphql
query($environmentId: String!, $serviceId: String!) { environment(id: $environmentId) { id name projectId } service(id: $serviceId) { id name projectId } serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { environmentId serviceId healthcheckPath healthcheckTimeout } }
```

Require the same production environment/project, navlog-server name/UUID `1b8bb6df-ebb5-4cde-b086-c97216161c51`, matching instance binding, nullable bounded string path and nullable nonnegative GraphQL integer timeout. Use distinct static environment, service, instance, path-type and timeout-type failure messages. No provider values appear in errors.

Emit one target/settings/matchesDesired JSON record. Target IDs must be validated; settings contain nullable timeout and a path allowlist (`/readyz`, `/healthz`, null; otherwise a fixed different-path marker). matchesDesired means exactly `/readyz` and 120. No config-file, patch-history, error-text, deployment/status/date, config scalar or variable dependency remains. No provider mutation, CLI upload or automatic retry exists in the diagnostic.

The transport remains a shared 30-second deadline, streamed 64-KiB cap, redirect rejection and HTTP/UTF-8/JSON/GraphQL checks. The full current-setting response validates before any output. Existing diagnose/readiness guard combinations still exclude deployment whenever either diagnostic flag is true.

## Verification and next checkpoint

The first focused regression supplied only the known-success current-setting fields to the unchanged 8778 broad diagnostic. Actual RED exited 1 with the same aggregate validation message, rather than an import/setup failure. The settings-only implementation passed 33 focused cases, all 333 workflow contracts and all 34 integrity checks. Scoped Biome passed for three files with no fixes; git diff --check passed. Tests used only synthetic responses, a scrubbed environment, isolated home, umask 022 and bounded owned process groups; all producers joined and groups closed. No new provider call, commit, push, dispatch, production merge or unrelated build/full-CI lane was performed in this phase.

Fresh rechecks by the same SPEC then QUALITY reviewers and a separate operation grant are required before a new branch commit/push and one new read-only dispatch. That run must match the reviewed head, skip deployment and old log reading, and preserve its one actual typed record/raw hash. The coordinator must read the response before any behavior fix or further action.

GitHub supports a registered manual workflow on another branch with [--ref BRANCH](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow); the [REST dispatch endpoint](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) accepts a branch or tag. The pinned provider field schema remains `/private/tmp/navlog-railway-api-schema.json`, from `railwayapp/cli@5a07ac2ae44ec2fcf892ba96e18f638402c7f8fb`.

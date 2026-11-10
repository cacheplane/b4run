# Navlog provider readiness configuration

## Goal and authorization

Apply Railway deployment readiness for navlog-server in production: `/readyz`, with a 120-second timeout, through the existing GitHub Actions project credential. Preserve the existing deployment upload, exact deployment polling, public readiness probe, and read-only diagnostic dispatch. The user requested API implementation and approved readiness deployment wiring and followups.

## Provider operation and scope

Use `environmentPatchCommit`, bound to the environment UUID returned by `projectToken` and validated as production in the expected project. Send exactly this patch:

```json
{"services":{"1b8bb6df-ebb5-4cde-b086-c97216161c51":{"deploy":{"healthcheckPath":"/readyz","healthcheckTimeout":120}}}}
```

No persisted environment config or variables are fetched. No staged changes are read, merged, or committed. `serviceInstanceUpdate` is rejected for this work because its official schema warns that a non-fork environment can update all non-fork environments, despite the manage-services documentation describing an environment-specific operation.

Official source evidence, pinned to Railway CLI commit `5a07ac2ae44ec2fcf892ba96e18f638402c7f8fb`:

- [GraphQL definition](https://github.com/railwayapp/cli/blob/5a07ac2ae44ec2fcf892ba96e18f638402c7f8fb/src/gql/mutations/strings/EnvironmentPatchCommit.graphql) binds the supplied patch to `environmentId`; the schema description is “Commit the provided patch to the environment.” The result is `String!`.
- [Direct commit implementation](https://github.com/railwayapp/cli/blob/5a07ac2ae44ec2fcf892ba96e18f638402c7f8fb/src/commands/environment/edit.rs#L131) commits the provided patch directly, separately from staging and committing existing staged changes.
- [Healthcheck patch authoring](https://github.com/railwayapp/cli/blob/5a07ac2ae44ec2fcf892ba96e18f638402c7f8fb/src/commands/environment/changes/healthcheck.rs) writes only `services.<serviceId>.deploy.healthcheckPath` and `.healthcheckTimeout`.
- [Patch builder](https://github.com/railwayapp/cli/blob/5a07ac2ae44ec2fcf892ba96e18f638402c7f8fb/src/controllers/config/patch.rs) starts with an empty object and sets only supplied paths. [Config structures](https://github.com/railwayapp/cli/blob/5a07ac2ae44ec2fcf892ba96e18f638402c7f8fb/src/controllers/config/environment.rs) omit absent settings.
- [API authentication](https://docs.railway.com/integrations/api) supports the existing project-access-token header. [Healthchecks](https://docs.railway.com/deployments/healthchecks) gate activation; they do not continuously monitor a running deployment.

## Workflow behavior

Add one inline JavaScript step immediately before upload in the existing deploy job. Use only `RAILWAY_NAVLOG_TOKEN`, passed as `RAILWAY_TOKEN`. Existing job conditions ensure diagnostic dispatch never reaches this step.

1. Fail if the credential is absent. Query `projectToken { projectId environmentId }`; require project `6f45f6e2-4190-4eb3-9820-3ff307a4e7d9` and a UUID environment ID.
2. Query only environment identity, service identity, and service-instance identity/readiness fields. Require exact project IDs, `production`, service UUID `1b8bb6df-ebb5-4cde-b086-c97216161c51`, name `navlog-server`, and matching environment/service binding.
3. Validate nullable path/string and timeout/integer fields. If both desired values already match, log a safe unchanged outcome and skip the mutation.
4. Otherwise issue exactly one direct environment patch commit, require its bounded nonempty string result, read back the same target and settings, and require both desired values before upload.
5. Log only validated target IDs, fixed outcomes, a safe before projection (path matches/null/different and nullable integer timeout), and the exact desired after settings. Never log provider error messages, raw bodies, headers, credentials, arbitrary config, or thrown errors.

All requests use the fixed Railway endpoint, POST, redirect rejection, a shared 30-second deadline, a 64-KiB streamed response cap, fatal UTF-8 decoding, HTTP status checks, JSON validation, and GraphQL error rejection. Do not retry a mutation after any uncertain response. A direct commit may trigger a deployment with the previous image on the initial change; the existing subsequent upload creates the new deployment whose exact ID is polled and whose public `/readyz` is checked.

## Files and verification

Change only `.github/workflows/deploy-navlog.yml`, operational contract tests in `scripts/release/test/workflow-contracts.test.mjs`, and the exact audited descriptors in `workflow-entrypoints.json` and `workflow-safe-executables.json`, plus this spec and its plan. Keep the strict workflow classifier and all release credential/publication code untouched. No package production code changes or changeset are expected.

Mock the exact inline script with synthetic credentials and streamed Response objects. Cover exact binding before mutation, idempotence, exact patch payload, readback mismatch, malformed/null/incorrect types, missing credential, HTTP/GraphQL/transport/UTF-8/body-cap failures, no retries, safe output, and deploy-versus-diagnose ordering. Run focused workflow contracts and release integrity first, followed by repository-required CI when the coordinator grants the exclusive heavy lane. Fresh spec and quality reviews precede PR/merge. After merge observe the real provider configuration step, exact successful rollout, and public readiness result.

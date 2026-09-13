# Release propagation and pending CI fixes

The user continued the release-performance follow-ups after 0.8.31 completed. The scope is two false-failure cases in existing release polling, with no workflow, publishing-order, credential, timeout, gate, or user-step changes.

## npm audit convergence

Captured npm 11.17.0 responses showed exact-version HTTP 200 before audit could see the version (`ETARGET`), and an attestation endpoint returning `E404` before later successful verification. Only a single-package audit may return pending for these cases. Require a valid exact error envelope and exit code 1, and match its summary exactly to the current validated package/version:

- `ETARGET`: `No matching version found for NAME@VERSION.`
- `E404`: `Not Found - GET https://registry.npmjs.org/-/npm/v1/attestations/ESCAPED_NAME@VERSION - Not found`, where scoped names replace `/` with `%2f` as npm 11.17.0 does.

Unknown messages, other versions/packages/hosts/paths, altered URLs, authentication errors, malformed output and incomplete signature/provenance evidence remain fatal. Batch verification never treats pending as success. Existing transient transport/service codes retain their behavior. The existing publisher convergence loop consumes pending and retains its deadline and exactly-once publication behavior.

Retry eligibility is computed separately from diagnostic-code visibility; emitting a known fatal code must never make it retryable. Diagnostics may emit only a finite allowlist of known npm codes, including the new propagation codes and common fatal authentication/integrity codes. Never log arbitrary error codes, summary, detail, stderr or nested causes. Propagation errors are observable without exposing response text.

## Prepublication CI polling

The existing waiter may continue polling when there is exactly one matching main/push CI workflow with valid run/attempt/suite identity, a known pending status and null conclusion, and no named validate check yet. Successful completion still requires the exact correlated validate check. Missing checks on completed workflows, conflicting or malformed identities, duplicate correlated checks/matching workflows and failed conclusions remain fatal. Preserve existing success when unrelated PR/suite checks accompany the one exact correlated check. The new absence branch requires `namedChecks.length === 0`; unrelated named validate checks alone do not satisfy it. Existing polling attempts/delay remain unchanged.

Keep this narrow: do not refactor either waiter or introduce a shared service. The postpublication waiter already handles the corresponding absent-job case and is unchanged.

## Verification

Reproduce both failures before production edits. Cover scoped and unscoped npm names, exact positive messages, wrong identities/URLs, batch refusal, diagnostic secrecy, eventual complete proof, and the existing publisher deadline/one-publication behavior. CI tests cover absent-to-created validate success, bounded absence, terminal/malformed/conflicting refusal. Update only the two changed release source pins and the reviewed pin-file digest. Run focused tests, release integrity and full controller validation, then ordinary hosted CI including Vercel and CopilotKit. Merge on green under existing authorization. No measurement release is needed.

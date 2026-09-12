# Preserve strict smoke process exit codes

## Problem and evidence

The 0.8.31 release published all 21 packages with verified signatures and provenance. Four consumer smoke lanes passed. The metadata lane failed for every package with `npm-audit-diagnostic` classification `invalid-exit` in run 34674215423, attempt 4, job 103507425377.

`createStrictSmokeProcessRunner` validates the containment result's integer `exitCode` and enforces the caller's accepted exit codes, but returns only stdout and stderr. The metadata lane passes this runner directly to `createNpmAuditVerifier`. Since the audit error classification change, that verifier requires the actual exit code. The process returned an accepted exit code, which the runner discarded. The audit invocation accepts both 0 and 1, so the diagnostic alone does not establish which occurred.

## Repair

Return the validated, actual `exitCode` alongside stdout and stderr from the strict smoke runner. Preserve capability probing, containment, command options, accepted exit codes, cleanup, cancellation, deadlines, and output limits. Do not infer success or weaken the audit verifier. An explicitly accepted exit code 1 must remain 1, so a success-shaped response with a failing exit remains an error.

Add a regression that connects the real strict runner and the real npm audit verifier using the existing deterministic audit fixture and a controlled containment adapter. Cover successful verification, accepted nonzero audit output, and rejection of inconsistent exit/evidence. Update the existing runner result assertions and both release pin layers. No workflow, publishing step, credential, dependency, timeout, or package version changes are required.

## Frozen candidate recovery

The published 0.8.31 tarballs and annotated tag remain unchanged. The candidate's metadata smoke code is immutable and will fail identically on retry. After this repair is reviewed and verified, prepare the existing candidate-specific smoke adjudication record for an explicit operator decision. Record the metadata lane as failed, the other four lanes as passed, and retain the independent audit. Do not apply that record or claim that the original metadata lane passed before the operator approves.

## Verification

First reproduce the adapter failure with the integration regression. After the repair, run npm audit and strict runner tests, published-artifact tests, release integrity, workflow contracts, and the repository CI lane. A live read-only verification of the already published 21 packages has separately confirmed exact original tarball hashes, `latest: 0.8.31`, and provenance metadata. Preserve the original failed smoke receipt.

# Prose-only CI performance

The approved performance work starts with narrowly scoped CI, smaller submission batches, and npm failure classification. This change covers CI and submission guidance; npm work is a separate subsequent PR. No release workflow, artifact, authentication, timeout, or publishing prerequisite changes.

## Behavior

Extend the existing PR scope classifier with a distinct prose-only result. Only nonempty changes consisting entirely of regular Markdown files under `docs/superpowers/runbooks/` qualify. Renames must account for both paths. Non-Markdown files, symlinks, executable modes, mixed changes, malformed Git output, or unknown paths must not qualify. Source, dependency, workflow, package, generated site, and release changes retain full verification. Push events retain full verification.

The existing metadata-scope job computes both existing metadata-only and new prose-only outputs, and runs whitespace validation against the exact PR diff for prose-only changes. It does not install the workspace or execute edited Markdown. Keep the required `validate` job always present. For prose PRs it requires successful classification/validation and all four full lanes to be skipped deliberately. For other changes it requires the existing four successful full lanes, and a successful classifier on PRs. Missing/failed classification cannot grant the fast path.

Gate the existing source/controller/package/harness lanes and auxiliary CI jobs on the prose-only result, preserving other job conditions and the existing generated-metadata exception. Keep separate CodeQL and Kubernetes Compatibility policies unchanged; the latter already scopes runbooks out. The optimization PR itself changes code/workflows and must pass full CI.

Add contributor guidance: prepare independent changes concurrently, but normally submit at most two full CI PRs at a time, and one performance PR at a time during this work. Wait for active runs before pushing follow-ups; do not cancel releases or globally serialize repository workflows. This is working guidance, not an automated gate.

## Validation

Regression tests use real Git repositories for allowed prose edits, mixed paths, rename/delete cases, modes and malformed output. Workflow contract tests cover full/prose/push/failed/cancelled/missing-output gate behavior and preserved jobs. Run baseline and failing regressions before implementation, focused tests afterward, then the repository-required validation and independent reviews before PR/merge. Measure the fast path on a real useful runbook update after integration; no throwaway release or unrelated edit is required.


The scope job extracts the dependency-free classifier from the exact trusted PR
base commit into a private temporary directory. Both scope decisions use that
copy; edited classifier code in the PR is never executed for classification.
If the base classifier predates the prose export, prose is false and normal
validation remains required, preserving the separate metadata exception. Missing
base code, invalid outputs, import failures, or classification failures remain
fatal. The temporary directory is removed on success and failure.

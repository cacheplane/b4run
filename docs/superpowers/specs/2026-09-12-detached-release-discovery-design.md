# Detached release discovery

Approved scope: [issue #636](https://github.com/cacheplane/b4run/issues/636), continued by the user.

The production checkout fetches remote main and checks out an exact SHA detached. Once managed releases are terminal, `discoverScheduledCandidate` scans local `main`, which does not exist. The preserved observation from run 34733143200 reports `REF_NOT_FOUND` and no mutations.

Use the existing `PRODUCTION_MAIN_REF` (`refs/remotes/origin/main`) in the first-parent history scan, matching the existing candidate ancestry check. Keep the current history bound, marker epoch rules, terminal verification, and candidate arbitration. A missing canonical ref remains fatal. Do not add a local branch, HEAD fallback, workflow step, credential, timeout, or publishing requirement.

Real Git regressions must reproduce detached HEAD with remote main and no local main: a verified completed release yields no candidate; a subsequent valid fixed-group version commit is selected; a missing canonical ref remains an error even if a local main branch exists. The fixture must use the real Git reader for ref/history operations and mock only remote release authority and inventory contents. Refresh the source pin/digest and verify ordinary main detection after merge without cutting a new release.

Fixture preconditions explicitly assert detached HEAD and no local main branch. The no-op case asserts completed-release verifier invocation. The missing-canonical-ref case uses no managed tags/releases so the rejection is attributable to the scheduled history scan, not an earlier ancestry check.

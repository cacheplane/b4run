# Normal audit controller repair

Goal: finish the already published npm v0.8.26 candidate through its existing audit and immutable release publication, and fix draft discovery for future candidates.

The payload remains candidate 470c871f258f5cd248904208bff6a89acbf3a56c with manifest 15c3afa7eea9e552d83c10e0e8bdd8ec6d9d4a6ac0b2a87e8e4ac09f5511306b. No package rebuild, tag mutation, smoke waiver, receipt fabrication, or recovery adoption is permitted.

1. Fix independent auditor draft reads using complete-list uniqueness and exact-ID reread, retaining all marker checks.
2. Add one shared executor authorizer. Legacy candidate/tag execution remains strict. Main execution requires an explicit candidate/manifest/workflow/source binding read from the actual immutable executor commit, exact successful main CI and merged-main ancestry. Validate actual Actions run and artifact identities against that separately authorized executor. Receipt payload identity remains the candidate.
3. Allow the existing audit workflow to run the authorized controller from its actual main SHA. Preserve coordinator, audit checks, job names and artifact protocol. Use the reviewed controller CLI to dispatch, record, correlate and publish the frozen candidate. Future source consumers verify historical executor authorization using the run's actual SHA.
4. Test authority rejection, legacy compatibility, real draft lookup behavior, artifact identity and unchanged payload checks. Refresh normal content pins and existing v0.8.24 verifier binding if shared closure changes. Run required CI and independently review before normal merge.
5. Execute real audit, correlate its unmodified canonical result, publish using existing guarded writer, verify immutable assets/tag/npm bytes and fresh no-write terminal observation. Retain laboratory artifacts for manual deletion by the user.

Independent subtasks are limited to draft lookup, consumer integration, and review; the root owns the shared authority and workflow.

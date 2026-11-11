# Linked dist invalidation through filesystem aliases

Use the existing subagent-driven development workflow. The primary executor owns all builds, native tests, resource qualification, PR submission, and merge decisions. Source work stays on the pinned branch for this change.

The first CLI regression recorded emitted value 2 while reused readers still observed 1. The preparation helper and controlled driver are unchanged from main at 08770152. On macOS, logical temporary paths can differ from Vite's canonical module-graph keys. Source review establishes a testable hypothesis; it does not establish the cause of every CLI failure.

- [x] Add one controlled real-Vitest alias-path regression before changing preparation behavior. Use an explicitly owned directory alias, unchanged default worker isolation, the existing two-project/four-reader fixture, and programmatic reruns. Preserve all existing cases and assertions. No private watcher mutation, timing assumption, timeout increase, or external service.
- [x] The primary executor installs the frozen dependencies offline, builds the linked closure, then runs the new case once. Record the actual causal assertion failure and normal owned-fixture/process closure. Setup or controller failure is not a semantic RED.
- [x] After that RED, collect logical and canonical file identities while each output exists. Retain both in the existing previous/current union so removed outputs can still be invalidated. Continue using the public invalidation API and existing writer/reader admission rules.
- [x] Run the alias case and the existing preparation regressions against the change; retain original failure evidence. Verify relevant typecheck, lint, cache declarations, and documentation.
- [x] Request independent source review. The final review found no blocking correctness or quality issues in the bounded alias fix.
- [ ] Open a PR with concrete validation and remaining limitations; merge after the required checks are green. Keep release publication and protocol activation held.

Only preparation test infrastructure, its regression fixtures, and this plan belong in this branch. Do not change journal runtime behavior, dependency versions, frozen migrations, existing timeout limits, or unrelated checkouts. The remaining CLI and PostgreSQL failures stay open until individually resolved or qualified.

Local evidence: the unchanged helper produced the intended real stale-reader failure (writer 2, four readers 1) with normal fixture closure. The normalization then passed all 43 preparation tests and the CLI typecheck. Existing case and driver time limits were preserved. Full repository CI and review remain required before merge; this does not qualify the separate journal release.

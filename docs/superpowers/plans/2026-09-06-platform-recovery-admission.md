# Platform recovery admission implementation plan

Goal: implement the bounded platform-nonwriter variant described in the matching spec, without admitting production.

1. Extend existing fence fixtures with the two exact platform identities and a digest-bound review/configuration fixture. Add failing success and drift regressions in scripts/release/test/recovery-fence.test.mjs (or a focused adjacent test).
2. Implement the smallest parser/runtime addition in scripts/release/recovery/fence.mjs; use a small adjacent module only if it materially improves clarity. Preserve YAML contract parsing and exact workflow-ID disable/drain checks. Permit explicitly bound historical-only sources for auxiliary fenced writers, while both mandatory release writers retain candidate-source binding. Test historical-only success and missing history, byte/input drift, active workflow, and all-SHA nonterminal run rejection. Add the Git tree boundary only when platform entries require it, preserving YAML-only adapter callers.
3. Verify focused tests, relevant policy/integrity tests and actual source pins. Update closure inventory only if a module is added. Run full controller tests with pinned pnpm10.33.0; preserve complete CI validation on the eventual PR.
4. Independently review spec compliance and code quality. Production evidence, admission record, publication proof, activation and dispatch remain parent follow-up work.

Use TDD, scoped formatting, no external paid review, and no unrelated changes. Branch is pinned to blove/release-platform-admission at main0da9914c. Commit the implementation locally; do not push or perform remote writes.

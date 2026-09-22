# Audit cache freshness implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and independently review this plan.

**Goal:** Prevent signature-audit retries from reusing stale npm metadata.
**Architecture:** One explicit option in the existing isolated audit environment.
**Tech Stack:** Node ESM, npm 11.17.0, node:test.

- [ ] In scripts/release/test/npm-audit.test.mjs, add/extend meaningful environment-boundary and retry tests: audit requests force online revalidation despite hostile ambient settings, original environment is untouched, publishing receives no new option, ETARGET remains pending and a later verified response still requires all evidence.
- [ ] Run focused test and observe missing-option assertion failure before implementation.
- [ ] In scripts/release/npm-audit.mjs, add additionalEnvironment: { npm_config_prefer_online: "true" } only to auditEnvironment construction, with a short cache-freshness comment. Do not alter the common environment builder or publication path.
- [ ] Run full npm-audit and publisher test files. Refresh only npm-audit.mjs SHA256 in scripts/release/test/fixtures/release-script-hashes.json and the fixture digest snapshot in workflow-contracts.test.mjs.
- [ ] Run scoped Biome, pnpm test:release-integrity and workflow contracts, then full controller suite. Document standalone actual-pacote cache reproduction in the runbook, not a production dependency.
- [ ] Independent spec and code review. Record 0.10.0 timings and attribution limits in docs/superpowers/runbooks/2026-09-22-release-010-performance.md and issue668.
- [ ] Submit one performance PR, merge on exact-head green including CopilotKit and real Vercel checks, monitor main. Do not cancel or dispatch release runs.

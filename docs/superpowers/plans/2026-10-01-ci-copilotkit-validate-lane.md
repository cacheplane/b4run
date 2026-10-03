# CopilotKit runtime step as the fifth `validate` lane — Implementation Plan (PR 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The `dependency-security-browser` job (the only end-to-end CopilotKit → B4.run check) blocks merge: the required `validate` job requires it as a fifth lane.

**Architecture:** `validate` already aggregates four lanes through `LANE_0..3` env vars and a shell loop; this adds `LANE_4` from `needs.dependency-security-browser.result`. The job's own `if` already yields `skipped` on prose-only PRs and `success` otherwise, which is what the loop expects in each case. Every step change to `ci.yml` is content-pinned: the two audited fixtures are hand-transcribed in the same commit.

**Tech Stack:** GitHub Actions YAML, the release-integrity fixtures (`scripts/release/test/fixtures/*.json`), `pnpm test:release-integrity`, `pnpm test:release-controller`.

**Spec:** `docs/superpowers/specs/2026-10-01-ag-ui-transport-capabilities-design.md` §4.

**Branch:** `blove/ci-copilotkit-validate-lane` from `origin/main`. Node 24, repo root. No changeset (CI only). Submit only when at most one other maintainer-managed PR has full CI active (AGENTS.md "Limit simultaneous full CI submissions").

---

### Task 1: The workflow change

**Files:**
- Modify: `.github/workflows/ci.yml:182-223`

- [ ] **Step 1: Branch**

```bash
git fetch origin main
git checkout -b blove/ci-copilotkit-validate-lane origin/main
```

- [ ] **Step 2: Edit `validate`**

In `.github/workflows/ci.yml`, change line 183:

```yaml
    needs: [metadata_scope, source-validate, release-controller, pack-smoke, harness-verify, dependency-security-browser]
```

After the `LANE_3:` line (line 197) add:

```yaml
          LANE_4: ${{ needs.dependency-security-browser.result }}
```

Change the loop line:

```yaml
          for result in "$LANE_0" "$LANE_1" "$LANE_2" "$LANE_3" "$LANE_4"; do
```

Update the comment that follows the job (lines ~221–222):

```yaml
  # Each lane verifies the same commit independently. The stable validate check
  # requires success from source, controller, packaging, harness, and the
  # CopilotKit runtime (dependency-security-browser) verification.
```

- [ ] **Step 3: Confirm the audit now fails (the pins are stale)**

Run: `pnpm test:release-integrity`
Expected: FAIL naming `validate` in `workflow-entrypoints.json` and/or `workflow-safe-executables.json` as not matching `ci.yml`. (That failure is the proof the pins cover this step; the next task repairs them.)

---

### Task 2: Transcribe the pins

**Files:**
- Modify: `scripts/release/test/fixtures/workflow-entrypoints.json:1704-1732`
- Modify: `scripts/release/test/fixtures/workflow-safe-executables.json:200-205`

- [ ] **Step 1: `workflow-entrypoints.json`**

In the `"id": "validate"` descriptor, the `needs` array becomes:

```json
            "needs": [
              "metadata_scope",
              "source-validate",
              "release-controller",
              "pack-smoke",
              "harness-verify",
              "dependency-security-browser"
            ],
```

In the step's `env` object (keys are sorted alphabetically in the fixture — keep that), add after `"LANE_3"`:

```json
                  "LANE_4": "${{ needs.dependency-security-browser.result }}",
```

In the step's `"run"` string, replace the substring

```
for result in \"$LANE_0\" \"$LANE_1\" \"$LANE_2\" \"$LANE_3\"; do
```

with

```
for result in \"$LANE_0\" \"$LANE_1\" \"$LANE_2\" \"$LANE_3\" \"$LANE_4\"; do
```

The rest of the string is byte-identical to the YAML's `run:` block with the leading two-space indentation removed and `\n` line endings — do not re-wrap it.

- [ ] **Step 2: `workflow-safe-executables.json`**

The entry `"job": "validate", "stepIndex": 0, "step": "Require every validation lane"` has the same `"run"` string under `"value"`; make the identical `$LANE_4` substitution there.

- [ ] **Step 2b: The non-release pins (found in execution)**

Three test files outside the release suite also hard-code the lane set and are run by `pnpm test` (source-validate), not by `pnpm test:release-integrity`:
- `scripts/release/test/release-integrity.test.mjs` — the `required` array in "required validate aggregates independent complete lanes and fails closed" gains `"dependency-security-browser"`; `checkout.with.ref` becomes `checkout.with?.ref` (the new job's Checkout has no `with:` block; the guard — no `ref` override — is unchanged).
- `test/k8s-compat/ci-scope.test.ts` — the `jobs.validate?.needs` expectation gains `"dependency-security-browser"` last.
- `test/k8s-compat/ci-prose-scope.test.ts` — `full` and `light` gain `LANE_4` (`"success"` / `"skipped"`), and the per-lane loop lists `"LANE_4"`; without it the gate script's `set -u` exits 2 on the unset variable.

Run: `pnpm exec vitest --run --config test/k8s-compat/vitest.config.ts test/k8s-compat/ci-scope.test.ts test/k8s-compat/ci-prose-scope.test.ts` → PASS.

- [ ] **Step 3: Verify the pins agree with the workflow**

Run: `pnpm test:release-integrity && node --test scripts/release/test/workflow-contracts.test.mjs`
Expected: PASS. (The inline pin in `workflow-contracts.test.mjs` is for the `dependency-security-browser` descriptor, which did not change; there is no inline pin for `validate`, so no snapshot there moves. If the contracts test reports a digest mismatch anyway, the failure text names the fixture and the expected digest — update that one snapshot and nothing else.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml scripts/release/test/fixtures/workflow-entrypoints.json scripts/release/test/fixtures/workflow-safe-executables.json
git commit -m "ci: require the CopilotKit runtime check as the fifth validate lane

dependency-security-browser is the only end-to-end CopilotKit -> B4.run
check; #888 showed the wire can drift under a green validate. Its if
already skips on prose-only PRs, which is what validate expects there.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The prose

**Files:**
- Modify: `AGENTS.md:110-118`
- Modify: `CONTRIBUTORS.md:67`

- [ ] **Step 1: `AGENTS.md`**

Replace the paragraph at lines 110–112:

```md
The required `validate` job in `.github/workflows/ci.yml` aggregates five
independent lanes for code and release-bearing changes and succeeds only when all
five succeed. Failure, cancellation, or an unexpected skipped lane blocks it.
```

In the next paragraph (line ~117) change "and all four heavy lanes to be deliberately skipped" to "and all five heavy lanes to be deliberately skipped".

After the `source-validate` gate list and the paragraph describing the `release-controller`, `pack-smoke` and `harness-verify` lanes (the paragraph ending "These gates remain part of repository validation."), insert:

```md
The `dependency-security-browser` lane installs dependencies and Chromium,
builds `@b4run/ag-ui`, runs the CopilotKit v2 runtime against B4.run
(`test/security-dependencies/copilotkit-v2-runtime.test.ts`) — the only
end-to-end CopilotKit → B4.run check — and then the dependency-security
browser regressions.
```

- [ ] **Step 2: `CONTRIBUTORS.md`**

Line 67 becomes:

```md
- `pnpm ci:validate` runs the full repository validation sequence locally. CI runs source, controller, packaging, harness, and CopilotKit-runtime checks concurrently; the required `validate` check succeeds only when all five lanes succeed.
```

- [ ] **Step 3: Docs check and commit**

Run: `node scripts/check-docs.mjs`
Expected: PASS (`AGENTS.md` is outside its scan set; `CONTRIBUTORS.md` is inside).

```bash
git add AGENTS.md CONTRIBUTORS.md
git commit -m "docs: validate aggregates five lanes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Verification and the PR

- [ ] **Step 1: The release-controller suite**

Run: `pnpm test:release-controller`
Expected: PASS.

- [ ] **Step 2: Push and open**

```bash
git push -u origin blove/ci-copilotkit-validate-lane
gh pr create --repo cacheplane/b4run --base main --title "ci: require the CopilotKit runtime check as the fifth validate lane" --body-file - <<'EOF'
Part of #887 (decision c). Spec: `docs/superpowers/specs/2026-10-01-ag-ui-transport-capabilities-design.md` §4.

`dependency-security-browser` (~80s, green on main) is the only end-to-end CopilotKit → B4.run check and #888 showed the wire can drift under a green `validate`. It becomes `LANE_4`. Its existing `if` yields `skipped` on prose-only PRs, which the step already expects there.

Both audited fixtures are hand-transcribed; `workflow-contracts.test.mjs` has no inline pin for `validate`. AGENTS.md / CONTRIBUTORS.md say five lanes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 3: Bind the PR and read CI**

Use the `ccd_pr` tools (`get_status`, then `bind_pr` if needed). The proof this PR works is its own `validate` run showing five lanes; report that, do not poll.

---

## Self-review against the spec §4

- `needs` + `LANE_4` + loop → Task 1. Fixtures → Task 2. Prose → Task 3. Proof commands → Tasks 2.3 and 4.1. No changeset, `copilotkit-examples-e2e` untouched → stated in the header and PR body.

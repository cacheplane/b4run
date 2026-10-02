# `@copilotkit/react-core` peer floor `>=1.76.0` — Implementation Plan (PR 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@b4run/ag-ui` declares `@copilotkit/react-core >=1.76.0` as its optional peer, so the install-time signal matches the wire: 1.76 is the first CopilotKit whose runtime speaks AG-UI 1.0.

**Architecture:** One range in `packages/ag-ui/package.json`, the pin that guards it in `test/security-dependencies/dependency-resolution.test.ts`, one clause in the README and the docs page, and a `patch` changeset. No code: `@b4run/ag-ui/react` imports only the `ReactActivityMessageRenderer` type from `@copilotkit/react-core/v2`.

**Tech Stack:** pnpm manifests, vitest, changesets.

**Spec:** `docs/superpowers/specs/2026-10-01-ag-ui-transport-capabilities-design.md` §5.

**Branch:** `blove/agui-react-core-peer-floor` from `origin/main`. Node 24, repo root.

---

### Task 1: The range and its pin

**Files:**
- Modify: `test/security-dependencies/dependency-resolution.test.ts:694`
- Modify: `packages/ag-ui/package.json:63`

- [ ] **Step 1: Branch**

```bash
git fetch origin main
git checkout -b blove/agui-react-core-peer-floor origin/main
```

- [ ] **Step 2: Move the pin first (failing test)**

In `test/security-dependencies/dependency-resolution.test.ts`, line 694:

```ts
    ).toBe(">=1.76.0")
```

Run: `pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts`
Expected: FAIL — expected `">=1.76.0"`, received `">=1.66.0"`.

- [ ] **Step 3: Raise the floor**

In `packages/ag-ui/package.json`, line 63:

```json
    "@copilotkit/react-core": ">=1.76.0",
```

Run: `pnpm install --frozen-lockfile`
Expected: completes without a lockfile change (a peer range is not recorded in the lockfile's resolution; `git status` shows only the two edited files). If pnpm reports the lockfile is out of date, run `pnpm install` and commit the lockfile with the manifest.

- [ ] **Step 4: Verify**

Run: `pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/dependency-resolution.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/package.json test/security-dependencies/dependency-resolution.test.ts
git commit -m "feat(ag-ui): require @copilotkit/react-core >=1.76.0, the first to speak AG-UI 1.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Say why, in the README, the docs page and the changeset

**Files:**
- Modify: `packages/ag-ui/README.md:88`
- Modify: `apps/web/content/docs/ag-ui.mdx:342`
- Create: `.changeset/agui-react-core-peer-floor.md`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: README**

`packages/ag-ui/README.md` line 88 becomes:

```md
`react` and `@copilotkit/react-core` (`>=1.76.0`) are optional peer dependencies used only by this subpath. Importing the root or `./sse` entry never loads it, so a server-only consumer installs nothing extra. The floor is the wire: 1.76.0 is the first CopilotKit whose runtime speaks AG-UI 1.0 — the protocol B4.run serves, with the approval grant at `metadata.grant` and a cancelled run ending in the cancelled outcome — and every earlier release resolves `@ag-ui/*` 0.0.59.
```

- [ ] **Step 2: `ag-ui.mdx`**

`apps/web/content/docs/ag-ui.mdx` line 342 — replace its first sentence so it reads:

```md
React and `@copilotkit/react-core` `>=1.76.0` are optional peer dependencies, so a server-only consumer of the root or `/sse` entry installs nothing extra; 1.76.0 is the first CopilotKit whose runtime speaks AG-UI 1.0, the protocol B4.run serves, and earlier releases resolve `@ag-ui/*` 0.0.59. The `/react` subpath also exports the two renderers individually, the card components, and the content schemas, for a client that presents the activities its own way.
```

- [ ] **Step 3: Changeset**

Create `.changeset/agui-react-core-peer-floor.md`:

```md
---
"@b4run/ag-ui": patch
---

`@b4run/ag-ui`'s optional `@copilotkit/react-core` peer range is now `>=1.76.0`. 1.76.0 is the first CopilotKit whose runtime speaks AG-UI 1.0, the protocol B4.run serves since 0.13.0; every earlier release resolves `@ag-ui/*` 0.0.59 and cannot talk to the endpoint. The `/react` renderers are unchanged. pnpm and npm warn, rather than fail, on an unmet optional peer, so an existing app on 1.70 still installs and is told why its host should move.
```

- [ ] **Step 4: Docs check, commit, lastmod**

Run: `node scripts/check-docs.mjs && node scripts/check-changesets.mjs`
Expected: PASS.

```bash
git add packages/ag-ui/README.md apps/web/content/docs/ag-ui.mdx .changeset/agui-react-core-peer-floor.md
git commit -m "docs(ag-ui): the react-core peer floor is the first CopilotKit on AG-UI 1.0

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit --amend --no-edit
```

Run: `pnpm --dir apps/web seo:lastmod:check`
Expected: PASS.

---

### Task 3: Verification and the PR

- [ ] **Step 1: The gates this change can touch**

Run: `pnpm lint && pnpm build && pnpm typecheck && pnpm --filter @b4run/ag-ui test && pnpm --dir apps/web exec vitest --run app/seo && pnpm pack:check`
Expected: PASS.

- [ ] **Step 2: Push and open**

```bash
git push -u origin blove/agui-react-core-peer-floor
gh pr create --repo cacheplane/b4run --base main --title "feat(ag-ui): require @copilotkit/react-core >=1.76.0" --body-file - <<'EOF'
Part of #887 (decision d). Spec: `docs/superpowers/specs/2026-10-01-ag-ui-transport-capabilities-design.md` §5.

The peer range is the only install-time signal that a <1.76 CopilotKit cannot talk to a B4.run that speaks AG-UI 1.0 (grant at `metadata.grant`, cancelled outcome, nominal `AbstractAgent`). The renderers compile against either; no code change. pnpm/npm warn rather than fail on the unmet optional peer.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 3: Bind the PR and read CI**

Use the `ccd_pr` tools (`get_status`, then `bind_pr` if needed). Report lane results; do not poll.

---

## Self-review against the spec §5

- Range → Task 1.3. Test pin → Task 1.2. README/docs clause → Task 2.1–2.2. Changeset with the warn-not-fail note → Task 2.3. No code change → header. lastmod → Task 2.4.

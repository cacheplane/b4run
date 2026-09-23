# Software factory first live issue (sub-project 4): plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Run the factory end to end on a real issue with real models, and grade what it produces against a known right answer. Write the framework spec (what should not be the developer's job) alongside, fed by what the live run exposes.

**The issue: #714, replayed.** "A route returning undefined makes `POST /threads/:id/runs/wait` answer 500." Chosen for outcome certainty: a precise, deterministic reproduction in the issue body; a one-file fix of 29 lines in `packages/cli/src/lib/dev/runtime-fetch-core.ts` (b090ad42, #718, merged 2026-09-18); and a 202-line reference test, `packages/cli/test/runs-wait-output.test.ts`, shipped with the fix. The factory runs at **pin 765e6e16** (b090ad42^, the commit before the fix), so neither the drafter nor the builder can see the answer, and afterwards the reference test grades the factory's candidate independently of anything the factory produced. Rejected: #778 (open, needs a `testing` target, no known answer), #774 (possibly stale build output), #787's fix (no issue), and larger fixes (#689, #754: multi-package).

**What this costs, on purpose:** a `cli` target. `@b4run/cli` depends on nine workspace packages (ag-ui, core, langchain, langgraph, memory, permissions, sdk, sqlite-storage, workspace) and has 177 test files. Building it by hand is the "a lot of work" the walkthrough named; the plan records every hour of it as evidence for the spec.

**Two tracks.** Track A is the live run (Tasks 1 to 4). Track B is the spec (Task 5), started now and appended with each finding from Track A.

**Standing rules:** as the 3b plan. Worktree `.claude/worktrees/factory-live`, branch `blove/software-factory-live` off main 7c7ad3c2. No new devDependencies in example packages (a lockfile peer re-key broke `@b4run/cli` tests once). The OpenAI key is sourced from the repository's gitignored `.env` into the worker processes only; it is never printed, logged or committed.

---

### Task 1: Replay an issue at a pin

`factory create --issue <n> --pin <sha>` pins the work order at a given commit instead of `origin/main`: the replay mode for a fixed issue. The CLI still fetches the issue with `gh`; `resolvePin` is skipped; the pin must be a commit in the object store (`ensurePin` fetches it by sha when shallow), refused before the route otherwise. The row, the journal and the bundle record it like any pin. README and spec §6.3 as-landed. Tests: CLI with the gh stub and the offline repo (pin = a non-HEAD commit; `origin/main` not consulted); a pin not in the store with `FACTORY_NO_FETCH=1` refused.

### Task 2: The `cli` target, prepared at the replay pin

`controller/targets/cli/target.json` + `Dockerfile`, modelled on `devkit`, at default pin 765e6e16.
- **Capture:** root manifests; `packages/config-typescript`; for `cli` and each of its nine workspace dependencies: `package.json`, `tsconfig*.json`, `src`, and for `cli` also `test` and its vitest config. Exclude nothing the build needs; measure the capture's size.
- **Image:** installs the workspace dependencies for `@b4run/cli...` into `/opt/targets/cli`, as devkit's does; `imageAssertResolves` for vitest, typescript and the node types.
- **Commands:** `build` builds the dependency graph in order (`pnpm -r --filter @b4run/cli... run build`, or `tsc -b` over project references if the packages declare them: pick what works offline in the image); `test` runs a **scoped** set of `packages/cli/test` files that are hermetic and fast (the dev runtime's route and run tests, e.g. `runs-wait*`, `run-cancellation`, `runtime-fetch*`, `execute-route`), with the exclusions listed and the reason recorded. The builder's visible suite is this command; keep it under two minutes in the image.
- **Resources:** measured, not guessed (cgroup `memory.peak`, wall clock), with headroom.
- **Proof (Docker lane `target-cli.integration.test.ts`):** at pin 765e6e16 the build succeeds and the scoped suite passes; the reference test from b090ad42 (`runs-wait-output.test.ts`, applied as a file) FAILS on the pin and PASSES with the reference fix applied. That is the grading harness for Task 4.
- Record in the plan: hours spent, every trap, every field that had to be hand-derived. That list is Track B's evidence.

### Task 3: The live run

Bring up four processes (controller, drafter, one `cli` builder at pin 765e6e16, verifier via Docker) from the README, with the key from `.env`. Then, as operator:

```
factory create --issue 714 --pin 765e6e16...
factory intake <id>                  # the drafter drafts; the controller proves the oracle
# review the draft on disk: record the review (what was checked, why it is an oracle) in the work order
factory approve-intake <id> --revision <n> --digest <sha>     # or reject-intake --note
factory dispatch <id>
factory evidence <id>
factory approve <id> --revision <n> --bundle <sha>            # or deny
```

The human gates are exercised by the session operating the run, which records its review reasoning as a journal note; the user is told it acted as the approver. Every command's output, and every surprise, is recorded as evidence in the work order (journal, evidence store) and summarised in the plan. A failure of the factory is a finding, not something to route around: fix only what blocks the run, and file everything else.

### Task 4: Grade the outcome

Apply the exported candidate at pin 765e6e16 in a scratch worktree and run the reference test (`runs-wait-output.test.ts` from b090ad42) plus the scoped suite. Record: did the drafter's check express the issue (compare with the reference test's cases); did the candidate pass the reference test; how does it differ from b090ad42's fix; token and wall-clock cost per phase; every operator step that required knowledge not in the README.

### Task 5: The framework spec (Track B, parallel)

`docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md`: the items that should not be the developer's job, each with the current cost, the B4 or controller change that removes it, and a proof. Seeded from the walkthrough of 2026-09-23 (per-thread sandbox image, policy and permissions; workspace handoff over the Agent Protocol; a remote workspace read; managed image builds; a target generator; CLI approvals that show then approve). Appended with each finding from Tasks 1 to 4. Ends with a proposed order and which item removes the most quickstart steps.

---

## Follow-ups, not in scope

Opening a pull request (rung 4). A second live issue at `origin/main` (not a replay). The `testing` target for #778.

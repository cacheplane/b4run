# Factory `up` and `run` Implementation Plan

> **Amended after review (2026-09-28).** An independent review found the gates hold and the plan executable after amendments: one Critical (children in `up`'s process group die by default action on a second signal mid-close; they are now detached and stopped by `up` alone, D11), seven Important and a list of minors, each applied in place and listed with where in "Review amendments (2026-09-28)" at the end. Three decisions were added (D23 test isolation, D24 the approval window, D25 the guarded test seam) and D6, D11, D12, D13, D14, D16, D18, D20 and D22 amended.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One command starts the software factory and one command carries an issue from intake to export, stopping at the two gates where a person decides: `pnpm factory up` starts the controller, the builder and the drafter on loopback with a shared, generated worker token, waits until each is ready, reconciles the registry and multiplexes their logs; `pnpm factory run --issue 714 [--pin <sha>]` creates (or resumes) the issue's work order, runs intake, **stops at the draft for a person**, dispatches, and **stops at the bundle for a person**, following each long step through the journal. `run` never approves anything: at each gate it shows exactly what `factory review` shows and either takes the person's typed digest prefix at a terminal or exits with the command a person runs.

**Architecture:** Example-level glue in `examples/software-factory/controller`, no framework change. A committed `examples/software-factory/factory.config.ts` (a plain object, validated at load by a strict zod schema that fails closed on near-misses) names the state directory and the three ports. `up` (`src/lib/operator/up.ts`) runs a preflight (config, conflicting environment, model key, ports, Docker, the drafter's base image, locks on the state directory and the checkout), spawns each app **detached** with `b4 start --host 127.0.0.1 --port <p>` in its own app root, waits for `/readyz` on all three, calls the controller's existing `/reconcile#workflow` route, and on `SIGINT`, `SIGTERM` or `SIGHUP` sends each child exactly one `SIGTERM`, the controller first and the workers second, escalating to `SIGKILL` of the child's group and verifying that every child exited with code 0. `run` is a loop in `src/cli.ts` over a pure step table (`src/lib/operator/run-steps.ts`, `nextStep(row, events)`) whose step type has no approval member: it reuses the CLI's `awaiting`/`followRow` machinery for intake and dispatch, a journal follower for work it did not start, and `factory review`'s own display-and-prompt (refactored to return its outcome instead of printing it) at the gates. The CLI's two variables (`FACTORY_CONTROLLER_URL`, `FACTORY_STATE_DIR`) default from the config, so no `export` and no alias remain.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), zod 4, `node:child_process`, `node:net`, `node:readline`, vitest 4, the B4 runtime's `b4 start`, Docker CLI (`docker info`, `docker image inspect`; nothing destructive).

**Spec:** [`2026-09-23-software-factory-framework-gaps-design.md`](../specs/2026-09-23-software-factory-framework-gaps-design.md) §7 (the quickstart and its table), §8 item 7, §9 findings 4, 5, 7, 8, 17, 21; [rung 3](../specs/2026-09-21-software-factory-rung3-design.md) §4.2, §4.5 (no boot hook), §6.1 and §6.6 (the two gates).

**Base:** `main` at `17f16ea6` (after #858, `target:init`). PR #859 (`target:measure`, item 5 PR 2) is open and touches `examples/software-factory/README.md`, the spec and `controller/package.json`, none of the modules this plan adds; rebase over it when it lands (Trap 17). Paths and lines below were read at `17f16ea6`.

---

## Decisions

**Decided 2026-09-29: Brian accepted every recommendation below, as amended by the independent review (D6, D11 reversed to detached children, D12, D18, D22) and including the decisions it added (D23 test isolation, D24 approval window, D25 guarded test seam).** "*Decided:*" now reads as "*Decided:*"; the tasks implement exactly these.

**D1. Where the config lives, and its format.** *Decided:* `examples/software-factory/factory.config.ts`, as the spec says: a default-exported plain object `satisfies FactoryUpConfig` (a type-only import from the controller), loaded with `import()` under tsx and validated by a strict zod schema before anything uses it. The controller's `tsconfig.json` includes `../factory.config.ts`, so `pnpm typecheck` checks it; a unit test loads the committed file through the loader, so CI checks it at run time too. Biome does not lint it (it is outside every package's Biome root); it is ten lines. *Not recommended:* JSON (no comments, and the spec and `b4.config.ts` set the convention), or a file inside `controller/` (its default state directory would then sit under an app root, spec §9 finding 4).

**D2. The config's shape.** *Decided:*

```ts
export default {
  state: ".factory", // relative to this file, or absolute
  controller: { port: 4300 },
  builder: { port: 4100 },
  drafter: { port: 4200 },
} satisfies FactoryUpConfig
```

Every object is `.strict()`: a misspelt or unknown key refuses, naming its path. Ports are integers in 1024..65535 and pairwise distinct. The state directory may not resolve inside any of the three app roots. No `host` key (every process binds `127.0.0.1`: the controller has no authorization, README:163-166), no `url` (derived from the port) and no token (D5). The spec's `worker` key, and `token` and `host`, are refused with a message naming what replaced them, not just "unrecognized key". This is the repository's rule for config-like objects: a near-miss must fail closed, never be read as "unset".

**D3. Two worker apps, not one: `up` starts three processes.** *Decided:* keep the builder and the drafter as separate apps. The spec's "one worker app" assumed item 1's optional fold; it was not done, and it is not glue: the drafter's sandbox is app-level (a fixed base image pinned by digest, its own provider scope, an app-level bash allow-list, 1 GiB/1 CPU; `drafter/b4.config.ts:14-57`), the builder's is per thread from a handoff (`images: isFactoryImageId`, `sandbox.thread`; `server/b4.config.ts:11-50`). Folding them puts both policies behind one token-holding process and one set of app-level ceilings, a trust-surface change with its own review. The config carries three ports; `up` derives `FACTORY_WORKER_URL` and `FACTORY_DRAFTER_URL`. Follow-up, not this plan.

**D4. `b4 start`, not `b4 dev`.** *Decided:* `up` spawns `process.execPath <appRoot>/node_modules/@b4run/cli/bin/b4.js start --host 127.0.0.1 --port <port>` with the app root as its working directory. `b4 start` serves the source tree without a file watcher (spec §9 findings 4 and 21: `b4 dev` restarted the controller mid-`intake` on its own staging writes, and every service on `.turbo/*.log` writes), does not load a `.env` (`b4 dev` loads `./.env`, `packages/cli/src/commands/dev.ts:16-19`), and handles `SIGTERM`/`SIGINT` itself (`start.ts:47`). Spawning `b4.js` with `up`'s own Node (not the shell shim, not `pnpm --filter … dev`) keeps every child on the Node 24 `up` runs on, and puts no `pnpm` between `up` and its children. The cost: no hot reload, so a developer editing a worker restarts `up`. Verified by a spike (Today, row 6).

**D5. The worker token.** *Decided:* generated per `up` (`randomBytes(32).toString("hex")`), held in memory, and given only to the three children through their environment; never printed, logged, journalled or written (the lock file holds pids and ports, not the token). When `FACTORY_WORKER_TOKEN` is already set, `up` uses it after the same checks the workers make (at least 32 characters, no whitespace), so an operator who runs a worker by hand beside `up` can share it. Nothing needs the token to outlive `up`: the CLI never talks to a worker, only to the controller (README:464-467), and a worker's threads and uploads are not bound to a token value (uploads are stamped `controller`, `server/src/thread-access.ts:56-70`), so a restart under a new token keeps every thread reachable.

**D6. The model key.** *Decided (amended):* `OPENAI_API_KEY` from `up`'s environment, else the one `OPENAI_API_KEY=` line of the first `.env` that exists among: the `.env` at the git toplevel of `EXAMPLE_ROOT` (`git -C examples/software-factory rev-parse --show-toplevel`), then the main worktree's (`dirname` of `git rev-parse --path-format=absolute --git-common-dir`), because a linked worktree has no `.env` of its own (this one does not; `/Users/blove/repos/dawn/.env` does). `FACTORY_REPO_ROOT` is ignored for this: it names the *target* repository, which may be a copy. Nothing else in the file is read. The key goes to the builder and the drafter only; `up` deletes it from the controller's environment (README:525-531). `up` refuses to start without it: both workers boot without a key and fail at their first model call (README:527), which costs a drafter turn and, on the builder, a candidate attempt. `up` prints where the key came from ("from the environment" or the file's path), never the value. The Docker lane passes a dummy literal.

**D7. The children's environment.** *Decided:* each child inherits `up`'s environment (so `PATH`, `HOME`, `DOCKER_HOST`/`DOCKER_CONTEXT` and the `FACTORY_*` knobs such as `FACTORY_MAX_ACTIVE_MS` pass through) minus `OPENAI_API_KEY`, `FACTORY_WORKER_TOKEN`, `HOST` and `PORT` (which `serveRuntime` reads as fallbacks, `serve-runtime.ts:94-95`), plus what `up` sets: all three get the token; the controller gets `FACTORY_WORKER_URL`, `FACTORY_DRAFTER_URL` and `FACTORY_STATE_DIR`; the workers get the key. `up` refuses, before spawning anything, when `B4_PERMISSIONS_MODE` is set (it would override both workers' `non-interactive` mode, README:414-416, 425-427) and when any of `FACTORY_STATE_DIR`, `FACTORY_CONTROLLER_URL`, `FACTORY_WORKER_URL`, `FACTORY_DRAFTER_URL` is exported with a value other than the one the config implies (a stale `export` from the manual runbook would otherwise point later CLI commands in the same shell at another registry). Retired variables need no check here: every app refuses them by name at boot (`config.ts:138-157`, loaded at `:164-168`, `server/src/builder-handoff.ts:139-148`), and `up` reports a child that exits before it is ready with its last output lines. *As landed (Task 7 review):* the controller's environment also drops every `*_API_KEY`, `OPENAI_*`, `ANTHROPIC_*` and `AWS_*` variable and `GH_TOKEN`/`GITHUB_TOKEN` (it calls no model and no cloud). The rule is a deny-list by design: the builder and the drafter still inherit every other variable of the operator's environment (their own model and cloud settings among them), and so does the controller apart from those. `up`'s own subprocesses (`git`, `ps`, `docker`) run without `OPENAI_API_KEY` and `FACTORY_WORKER_TOKEN`.

**D8. Preflight refusals.** *Decided:* `up` checks everything it can before it spawns anything and reports every problem in one message: the config; D7's environment; the key (D6); each app's built `@b4run/cli` present (`node_modules/@b4run/cli/dist/index.js`; the committed `bin/b4.js` exists before any build, Trap 25); each port free on `127.0.0.1` (a listen attempt, and a connect attempt for a process bound to the wildcard address); `docker info` answering within 15 s; the drafter's base image on the daemon (`docker image inspect -- <ref>`, the reference read from `drafter/src/drafter-image.ts` the way CI's `sandbox-docker` job reads it, `ci.yml:473`, or `FACTORY_DRAFTER_IMAGE` when set), refusing with the exact `docker pull` command. `up` never pulls (base-image pulls have wedged Docker Desktop before; the operator runs it once) and never removes anything from the daemon. Reading the drafter's image reference as text is not an import: the controller still shares no source with a worker.

**D9. Readiness, and reconcile at boot.** *Decided:* yes, `up` reconciles. The controller app has no boot hook (rung 3 §4.5); its Factory opens (and runs `reconcileAll`, `factory.ts:1976-1979`) in middleware `setup` on the first route request (`middleware.ts:9-17`), so `/readyz` answering 200 says only that the stores answer. `up` polls `GET /readyz` on all three (250 ms, 120 s bound each, failing at once if that child exits), then sends the reconcile route once (`createControllerClient(url).reconcile()`, `client.ts:78`), which opens the Factory, reconciles, and proves the controller's own configuration loads. Workers are ready before the reconcile because reconciling reattaches to their threads. `up` says "ready" only after the reconcile answers `ok: true`; a 500 from `setup` (an invalid controller environment) stops everything with its message. This is the supervisor the README already names ("nothing walks the registry after a restart unless an operator or a supervisor asks it to", README:307-308), so the §7 row "`factory reconcile` after a controller restart" is removed for a controller `up` manages; the app still has no boot hook.

**D10. Logs.** *Decided:* every child line goes to `up`'s stdout as `<app, padded> │ <line>` and is appended to `<state>/logs/<app>.log` with a header line per start; `up`'s own lines are `${UP} …`. `up`'s stdout is a log stream, not the CLI's JSON contract (every other command keeps it). No colour, no rotation (the logs are for post-mortems like finding 8's). *As landed (Task 8):* `up`'s own lines (from the lock on) are also appended to `<state>/logs/up.log`, so the ready line, each exit and the stop line survive a closed stdout.

**D11. Signals, shutdown and failure.** *Decided (reversed after review, C1):* children are spawned **detached** (`detached: true`: each its own process group), with stdin ignored, and `up` alone decides when and how they stop. The first draft put them in `up`'s group so a terminal's Ctrl-C reached them directly; that kills them. `b4 start` installs `process.once` handlers for `SIGINT` and `SIGTERM`, and its `close()` removes both (`packages/cli/src/lib/dev/serve-runtime.ts:116-137`), so a child that took the terminal's `SIGINT` and is still closing dies by default action on `up`'s follow-up `SIGTERM` (the reviewer's spike: exit `null`, signal `SIGTERM`), mid-close, before the controller's Factory has closed its registry. Detached, a child gets exactly one signal, from `up`: on `SIGINT`, `SIGTERM` or `SIGHUP` (a closed terminal) `up` stops the controller first (so it issues nothing more to the workers; its Factory's close is bounded at 10 s, `factory.ts:1961-1971`) and then both workers, each with one `SIGTERM` to the child's pid and a 20 s grace, then `SIGKILL` to the child's whole process group, and verifies every child is gone. Each child's exit is logged as `<app> exited with code <n>` or `… by signal <sig>`; a clean stop is every child exiting with code 0. A second signal more than one second after the first sends `SIGKILL` to every group at once (a single Ctrl-C can arrive twice through `pnpm → tsx → node`). A `SIGKILL` of `up` itself leaves the detached children running: D12's orphan check names them at the next `up`. `up` survives a closed stdout (`up | head`): an `EPIPE` on stdout switches its output to the log files only and never ends supervision, so a pipe cannot orphan the children. A child that exits on its own stops the others and `up` exits 1: no automatic restart in this plan (restarting a controller safely means reconciling again, and restarting a worker mid-turn meets finding 7's persisted `busy`; a restarting supervisor is a follow-up). Stopping `up` while a work order is mid-turn is not free: at the next `up`'s reconcile a drafter or builder thread that stopped mid-turn reads as a turn that ended (`reattach_not_live`, README:533-539), so a partial draft spends an intake attempt and a partial candidate is verified and usually spends a candidate attempt. `up`'s stop line lists the work orders in active states (read-only from the registry) so the person sees what that stop costs; prefer stopping between gates. *As landed (Task 8):* the supervise body returns its code and the ordered stop runs after it (a `finally` cannot change a code already returned, so the draft's `return (code = 0)` would have reported a killed child as a clean 0); a second signal SIGKILLs every group still running at once; any error on stdout (not only `EPIPE`) switches it off; `up` refuses any option but `--config` and any positional argument. The signal and stdout handling live in `up.ts` (`stopOnSignals`, `lineWriter`) so they are unit-tested.

**D12. A lock on the state directory and on the checkout.** *Decided (amended):* two lock files with one record: `<state>/up.lock` (the registry takes no process lock, rung 3 §4.3, §4.5, so two controllers on one state directory would otherwise be possible) and `examples/software-factory/.up.lock` (each app's runtime stores, its `.b4/` threads, checkpoints and workspaces, live in its app root, so two `up`s in one checkout would share the workers' stores whatever their state directories: one `up` per checkout). Each is created exclusively (`wx`) and holds `up`'s pid, its command line and start time, the ports and, once spawned, each child's pid and command line; both are removed on a clean exit. A lock is **held** when its pid is alive *and* `ps -p <pid> -o command=` still shows the recorded command (a reused pid is not a holder). A held lock refuses ("factory up is already running"). A stale lock whose recorded children are still alive and still show their recorded `b4.js start … --port <p>` command refuses, naming them and the `ps` check to run before `kill`; `up` never kills them itself. Any other stale lock is taken over by `rename` to `up.lock.stale-<pid>` (atomic: of two `up`s racing, one rename wins and the other gets `ENOENT` and retries `wx`, which then finds the winner's lock held), never by remove-then-create. The checkout lock also means the Docker lane (Task 9) refuses beside a live `up` in the same checkout rather than sharing its stores. *As landed (Task 7 review):* a lock is created by writing a temporary file and hard-linking it into place (whole, and never over an existing file); a stale lock is taken over only under a `<lock>.takeover` mutex (created the same way; one a crashed `up` left behind is judged by its pid and command like the lock and taken over by rename), re-judged under it, and replaced by renaming a whole record over it. Takeovers of one lock are serialized so three `up`s racing cannot each replace the other's new lock. A live takeover by another `up` is waited for one second, then refused. A non-`EEXIST` failure on the checkout lock releases the state lock already taken. The lock's siblings (`.up.lock.takeover`, `.up.lock.new-*`, `.up.lock.stale-*`) need the `.gitignore` pattern `.up.lock*` (Task 10).

**D13. `run` never approves.** *Decided (amended):* the hard requirement, by construction and by test. `run` accepts no approval input: `--approve`, `--reject`, `--digest`, `--note`, `--revision`, `--bundle` are refused by name, and there is no `--yes`/`--auto-approve` (the CLI's `parseArgs` is strict, so an unknown option already throws). The step table's type has no approval member. At `awaiting_intake_approval` and `awaiting_approval`, `run` calls the same function `factory review <id>` calls, with no digest and no approval flag: it prints the same display to stderr, and asks for the digest's first eight hex digits only when **both stdin and stderr are TTYs** (a person reading the display at a terminal), then sends the revision and digest it displayed, exactly as `review` does; otherwise, or on no answer or a wrong prefix, it sends nothing and exits 3 (D16) with the commands a person runs. The printed **next commands** are digest-free: `pnpm factory review <id>` (which shows it again and asks), `pnpm factory review <id> --reject --note "…"`, then `pnpm factory run <id>`; the scripting form is named ("`--approve --digest <the digest shown above>`") but not filled in. (The outcome JSON's `row` does carry `taskDigest`/`bundleDigest`, as `show` always has; approving still needs a person to run a review.) `--allow-missing-evidence` is forwarded to **both** gates' reviews (it cannot be scoped to one): it approves nothing (the prefix is still typed) and only lets a review show a draft or bundle whose evidence a fake verifier never wrote, with its loud warning. The test seam is guarded (D25).

**D14. Which work order `run` works on, and resuming.** *Decided:* `run <workOrderId>` works on that work order. `run --issue <n> [--repo o/n] [--pin <sha>]` first reads the registry (no `gh` call, no fetch): among the issue's work orders (same repository and number, and the same pin when `--pin` is given), exactly one non-terminal work order is resumed (and `run` says which, with its pin and state); more than one refuses and lists them; none, with the newest `exported`, prints it and exits 0; otherwise it creates one. `--new` always creates (with a warning if one is still live). A create uses the operation key `factory-run:issue:<repo>#<n>@<pin>:<g>`, where `g` is the number of the issue's work orders at that pin already in the registry, so two `run`s racing to create land on one row (`insertWorkOrder` derives the id from the key, `factory.ts:843-853`) and a later `--new` gets a fresh key. So Ctrl-C and `run` again (with the same arguments or the id) resumes the same work order: a row in an active state is followed, not re-sent. `run --task <id>` does the same for a catalog task (D19). A pinless `run --issue <n>` matches the issue's work orders at **every** pin, a replay's included: after `run --issue 714 --pin 765e6e16…` was exported, a pinless `run --issue 714` answers "already exported" with the replay's row (it cannot tell a replay pin from an `origin/main` pin); `--new` starts a live run at `origin/main`. The README says so.

**D15. `run` stops at a block; it never retries or cancels.** *Decided:* a `blocked` row stops `run` with exit 1, its reason and the next commands: for a retryable candidate block with attempts left (`RETRYABLE_BLOCKED_REASONS`, `states.ts`), `pnpm factory retry <id>` then `pnpm factory run <id>`; otherwise `pnpm factory events <id>` and `pnpm factory cancel <id>`. A retry spends a candidate attempt and budget; that is the person's call. `denied`, `cancelled` and `failed` stop with the `run … --new` command. `run` resumes a `received` row after a person's `retry` by dispatching it, since the retry was the decision.

**D16. Exit codes.** *Decided:* `run` exits **0** only when the work order is `exported`; **3** when it stopped at a gate and nothing was approved (no terminal, no answer, a wrong or short prefix): "waiting on a person", distinct so a script never reads it as either success or breakage; **130** on Ctrl-C (the work goes on in the controller; `run` prints how to resume and how to cancel); **1** for everything else (a refusal, a review that refuses what it displayed, a block, a terminal state, an expired bundle (D24), a follow that outlived its bound). Through `pnpm --silent` (D18) the code reaches the shell unchanged (the reviewer's spike: 3 propagates). `up` exits 0 after a requested stop in which every child exited with code 0, and 1 when it refused to start, a child failed to become ready, a child exited on its own, or a child had to be killed or survived `SIGKILL`.

**D17. The CLI reads the config.** *Decided:* every `factory` command except `up` fills `FACTORY_CONTROLLER_URL` and `FACTORY_STATE_DIR` from the config when the environment leaves them unset; the environment wins when set, and a disagreement prints one `stderr` line naming both values. The config is `--config <path>`, else `FACTORY_CONFIG`, else `examples/software-factory/factory.config.ts` when it exists; `FACTORY_CONFIG=none` reads none (the existing CLI tests set it, so the committed file never leaks into them); a named file that is missing or invalid refuses. `up` does not fill: it refuses a disagreement (D7). This removes the §7 row "export of URL and state dir, an alias", with D18's script.

**D18. How `pnpm factory` is spelled.** *Decided (amended):* a new orchestration-only `examples/software-factory/package.json` (`private: true`, not a workspace member, the precedent of `examples/chat` and `examples/research`) whose `factory` script is `pnpm --silent --filter @b4-example/software-factory-controller factory`. `--silent` matters: without it pnpm prints its `> … factory` banner onto stdout ahead of the JSON and an `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` block on any non-zero exit (the reviewer's spike). So from `examples/software-factory`, `pnpm factory up` and `pnpm factory run …` are exactly the spec's commands, and from the repository root `pnpm --dir examples/software-factory factory …`. Not a root `package.json` script: the root scripts feed the release-owner reachability analysis (AGENTS.md, "Every final-workflow-reachable release script is content-pinned") and gain nothing here. The state directory `examples/software-factory/.factory` and the checkout lock `.up.lock` get a new `.gitignore` (the repository root's `.factory`, which the manual runbook creates, is not ignored today: Today, row 8), and so does `factory.config.local.ts`: two checkouts (worktrees) on one host need different ports, and the README tells the second to copy the config there and point `FACTORY_CONFIG` at it.

**D19. `run --task <id>`.** *Decided:* include it. A catalog work order skips intake (rung 3 §6.1), so it is the same loop with one gate, and it is how the export gate, resuming and the "done" answer are tested against the served controller without a devkit build. Cost: a dozen lines.

**D20. A budget warning at the intake gate.** *Decided:* `factory review` (and so `run`) prints a loud warning at an intake review when the work order's remaining active budget is below twice its drafted target's `verifierDeadlineMs`: `dispatch` will refuse that work order after the person approves (`factory.ts:488-531`), and an issue work order learns its target only at intake, so `create` cannot warn (it journals the shortfall for catalog tasks only). The quickstart's own issue is the case: the `cli` target verifies for up to an hour, so a default 20-minute budget is refused at dispatch after a person spent a review on the draft. The rule is extracted from `factory.ts` into `budget.ts` (`budgetShortfallFor`) so both use one function. A warning, not a refusal: approving is still the person's call. Its remedy reads "reject or cancel it, restart `pnpm factory up` with `FACTORY_MAX_ACTIVE_MS=<n>` or more, and run it again with `--new`" (the budget is the controller's, fixed on the row at create). `up` does not set `FACTORY_MAX_ACTIVE_MS`; the README's quickstart sets it for the `cli` target.

**D21. One PR.** *Decided:* one PR, `blove/factory-up-run`, Tasks 1-11 (M: two new modules and a CLI command in one package, plus docs). It could split after Task 6 (`run` without `up`, the config and the CLI defaults) if review prefers; the halves share only the config module.

**D22. A live replay before merge.** *Decided (amended):* yes, by hand (Task 12): `pnpm factory up` with `FACTORY_MAX_ACTIVE_MS=18000000` and `FACTORY_APPROVAL_TTL_MS=86400000` (D24), then `pnpm factory run --issue 714 --pin 765e6e16fec86bba0859d3f85edf7136f663f720`, **Brian at both gates**. It costs one drafter intake and one builder turn of model tokens (finding 27's run was 17 builder calls; findings 11 and 15 put a drafter attempt at up to ~1.5M input tokens) and about an hour of verification, and it is the only proof that the quickstart the spec promises works as typed. An agent executing Task 12 stops at each gate and shows Brian the display; it never approves (Trap 4). It must not share a checkout with another live `up` (D12).

**D23. Test-environment isolation.** *Decided (added after review):* both controller vitest configs set `test.env: { FACTORY_CONFIG: "none" }`, so no test process, and no CLI a test spawns (they inherit the worker's environment), ever reads the committed `factory.config.ts`. `boot`'s own `FACTORY_CONFIG: "none"` alone was not enough: the `builder-handoff` tests (`test/cli.test.ts:~1183`, `~1280`) spawn the CLI without `FACTORY_STATE_DIR` on purpose, and the committed config would fill it and stage captures into the developer's live `examples/software-factory/.factory`. A test that wants a config names one (`FACTORY_CONFIG=<temp file>`), as Task 3's and Task 9's do.

**D24. The export bundle's approval window.** *Decided (added after review):* a frozen bundle expires `FACTORY_APPROVAL_TTL_MS` after it parked (default 15 minutes; `approve` refuses "Review bundle has expired; deny or cancel it", `factory.ts:1525-1528`), and there is no re-freeze (README:630-634). A person who steps away from `run` for 16 minutes loses a verified candidate. So: the quickstart and Task 12 set `FACTORY_APPROVAL_TTL_MS=86400000` beside `FACTORY_MAX_ACTIVE_MS` (waiting on a person is not active time, so a long window costs no budget); `up` records the controller's effective `approvalTtlMs` and `maxActiveMs` (the environment's value or the controller's default; no secrets) in its lock, where `run` reads them; the export gate prints when the bundle parked (`awaitingSince`) and when it expires (or "the controller's window is unknown; its default is 15 minutes" without a lock); and `run` never prompts for an expired bundle: `nextStep` answers `stop` with the deny and cancel commands when the known window has passed, and an approval refused as expired (a window `run` did not know) stops the same way instead of prompting again.

**D25. The interactive test seam is guarded.** *Decided (added after review):* `interactive()` (shared by `review` and `run`) is true when stdin **and stderr** are TTYs; `FACTORY_CLI_INTERACTIVE=1` makes it true only when `VITEST` is also set (vitest sets it in its workers, and the CLI children the tests spawn inherit it), and then the CLI prints `!!! TEST SEAM: FACTORY_CLI_INTERACTIVE answers the approval prompt from a pipe !!!` on stderr. So an exported `FACTORY_CLI_INTERACTIVE=1` in an operator's shell cannot turn a piped `run` into one that reads an approval from a script.

## Today, verified

Each §7 claim, and each fact `up` and `run` rest on, re-located at `17f16ea6`. Paths are relative to `examples/software-factory/` unless they start with `packages/`, `docs/` or `.github/`.

| # | Claim or fact | Where it is now | Holds? |
|---|---|---|---|
| 1 | "Four terminals, `export` of URL and state dir, an alias" | README:392-472: builder (terminal 1, `export TOKEN=$(openssl rand -hex 32)` at :398), drafter (2), controller (3), driving (4) with `export FACTORY_CONTROLLER_URL`, `export FACTORY_STATE_DIR` and `alias factory=…` at :469-471. The CLI reads the two variables at `controller/src/cli.ts:178-188` | Yes, plus a token exported in three terminals |
| 2 | "controller + one worker app" | Two worker apps: `server/b4.config.ts` (builder: `dockerSandbox({ scope: "software-factory-builder", images: isFactoryImageId })`, `sandbox.thread`, per-thread permissions from the handoff) and `drafter/b4.config.ts` (fixed `DRAFTER_IMAGE`, scope `software-factory-drafter`, app-level `allow.bash`, `resources`). The controller requires `FACTORY_WORKER_URL` (`controller/src/lib/config.ts:179`) and reads `FACTORY_DRAFTER_URL` for intake (`:67`, `:184-188`) | No: three processes (D3) |
| 3 | `worker: { url, token: { env } }` | The token is only a bearer check: workers require `FACTORY_WORKER_TOKEN` (≥ 32 characters, no whitespace; `server/src/thread-access.ts:26-37`, same copy in `drafter/`), the controller the same (`config.ts:75-80`). Uploads are stamped `controller`, not by token value. The CLI talks only to the controller, which has no authorization (README:163-166) | Yes; nothing needs a persisted token (D5) |
| 4 | "`factory reconcile` after a controller restart (no boot hook): not removed" | No boot hook (`controller/src/app/reconcile/index.ts:5`); `setup` opens the Factory on the first route request (`controller/src/middleware.ts:9-17`, `lib/runtime.ts:78-82`), and opening runs `reconcileAll` (`factory.ts:1976-1979`); the route runs it again (`reconcile/index.ts:6-17`). README:533-539 tells the operator to run it after a restart | Yes for the app; `up` removes the operator step (D9) |
| 5 | Items 1-3 landed ("possible only once items 1 to 3 land") | README:28-33 (one builder for every target and pin), :43-51 (staged workspaces over the worker's port), :244-254 (`sandbox.workspaceRead: "http"`); retired variables refused by name (`config.ts:138-157`, loaded at `:164-168`). Spec §1-§3 carry no "As landed" note; the README is the record | Yes |
| 6 | `b4 start` can serve each app | `packages/cli/src/commands/start.ts:15-17` (binds `0.0.0.0:8000` by default), `:44-51` (`serveRuntime`, `installSignalHandlers: true`); `serve-runtime.ts:94-95` (`HOST`/`PORT` fallbacks); no `.env` loading (`b4 dev` loads one, `dev.ts:16-19`). **Spike at `17f16ea6`:** each app started with `node_modules/.bin/b4 start --host 127.0.0.1 --port <p>` from its root; `/readyz` answered 200 with `checkpointer`, `permissionsStore`, `threadsStore` ok on all three; the builder booted without `FACTORY_BUILDER_LANE`; the drafter answered 403 to an unauthenticated `POST /threads`; `POST /threads/controller/runs/wait {"route":"/reconcile#workflow"}` answered `{"ok":true,"message":"Reconciled"}` and created `registry.sqlite` and `images.sqlite`; after `SIGTERM` the drafter and builder exited within 2 s and the controller in about 6 to 7 s; no process or listener survived. The controller's `.b4/` held only its stores (no `build/`) and `b4 start` served it: it reads source, not build output (`apps/web/content/docs/cli.mdx:125`), so no `b4 build` is needed; a checkout with no `.b4/` at all was not tried (Task 9 Step 3). The spike sent SIGTERM only; the review then showed a SIGINT followed by a SIGTERM kills a closing child (Trap 8) | Yes |
| 7 | Liveness and readiness | `GET /healthz` touches no store; `GET /readyz` probes the durable stores (`packages/cli/src/lib/dev/runtime-fetch-core.ts:1456-1485`). The controller's Factory is not opened by either | Yes (so D9 sends the reconcile) |
| 8 | The state directory | README:435 and :470 use `$PWD/.factory` from the repository root; `git check-ignore .factory` finds no rule at the root. Only `controller/.gitignore`, `server/.gitignore`, `drafter/.gitignore` ignore `.factory/` | Gap: the manual runbook's state is untracked-but-not-ignored (D18) |
| 9 | `pnpm factory` | No `factory` script at the root (`package.json:20-69`); the controller's `factory` script is `tsx src/cli.ts` (`controller/package.json:12`). `examples/chat/package.json` and `examples/research/package.json` are orchestration-only and not workspace members (`pnpm-workspace.yaml`: `examples/*/*`) | No root script (D18) |
| 10 | The CLI's long-wait machinery | `awaiting` (`cli.ts:366-403`) tails the journal (`tailEvents`, `:238-251`) and falls back to `followRow` (`:434-505`, `pollRow` `:410-423`) on a transport failure; dispatch's `FollowEvents` (`:925-938`, `dispatchPreparing`/`imageWaitBoundMs` from `lib/controller/images.ts:63-93`); `approveExport` (`:693-704`) follows by `approve_started`/`approve_refused` | Yes; `run` reuses it |
| 11 | The review gate | `review` (`cli.ts:722-823`) builds the display (`buildReview`, `:657-690`), prints it to stderr, refuses on `problems`, asks through `ask` (`:639-650`) only when `interactive()` (`:634-636`: a TTY or the test seam), and sends `approveIntake`/`approveExport` with the revision and digest it displayed. It prints its own outcome JSON at every exit (`refuse`, `:746-749`; `:813-822`) | Yes; it must return its outcome for `run` (Task 4) |
| 12 | `cli.ts` is not importable | `main(process.argv.slice(2))` runs at module load (`cli.ts:1047-1053`); every CLI test spawns it (`test/cli.test.ts:66-87`) | Yes: pure logic goes in `src/lib/operator/` |
| 13 | Idempotent create | `insertWorkOrder`: the id is `wo-` + the key's sha256 prefix (`factory.ts:843-845`); a spent key whose row exists returns it (`:848-853`); `create:` + key is the controller thread (`client.ts:51-52`). `RegistryReader.list()` returns every row ordered by `created_at` (`lib/registry/work-orders.ts:189-192`); rows carry `origin` and `pin` (`lib/domain/work-order.ts:53-58`). `openRegistryReader` throws when the file does not exist (`lib/registry/reader.ts:40-41`) | Yes (D14) |
| 14 | The states `run` walks | `approve_intake: awaiting_intake_approval → received` with `taskDigest` set (`states.ts:162`), `retry: blocked → received` (`:166`); terminal `exported`, `denied`, `cancelled`, `failed` (`:20-25`); `RETRYABLE_BLOCKED_REASONS` (`:81-88`); `intake` refuses a `received` row that already holds a task digest (rung 3 §6.6 as landed) | Yes |
| 15 | Work the CLI did not start | A dispatch waits in `received` while its image builds (README:386-390); `dispatchPreparing` tracks it across a restart (`image_prepare_aborted`, reason `restart`). An approval re-verifies with the row at `awaiting_approval` (README:546-551); its journal marks are `approve_started`/`approve_refused` (`factory.ts:1512-1514`); after a restart, reconcile completes an open command intent without a journal line (`reconcile.ts:23-60`), so "an `approve_started` with no end" can be stale forever | Yes: `run` treats a 409 `run_in_flight` as "follow", not a journal guess (Trap 13) |
| 16 | The budget and a `cli`-target issue | `FACTORY_MAX_ACTIVE_MS` default 1,200,000, fixed at create (`config.ts:207`); dispatch and retry refuse a remainder below twice the target's `verifierDeadlineMs` (`factory.ts:488-531`); `targets/cli/target.json:164` is 3,600,000, so a `cli` issue needs at least 7,200,000 left at dispatch (README:143-148 sizes it at 18,000,000). The target is known only after intake (`row.targetId`) | Yes (D20) |
| 17 | Where the key goes | README:525-531: the builder and drafter, not the controller or the CLI | Yes (D6) |
| 18 | The drafter's base image | Pinned in `drafter/src/drafter-image.ts`; pulled by hand (README:772) and by CI (`.github/workflows/ci.yml:473`); nothing in `packages/sandbox/src/docker/` pulls | Yes (D8) |
| 19 | The controller never reads a worker's filesystem | Pinned by `controller/test/no-worker-filesystem.test.ts` (patterns over `src/`) | Yes; `up` spawns processes by app root and reads no worker store (Task 7 adds a pin that the controller app never imports `lib/operator/`) |

## Spec corrections

1. **§7 "controller + one worker app"**: three processes. The builder and the drafter are still two apps (Today, row 2); folding them is not glue (D3).
2. **§7's config shape**: `worker: { url, token: { env: … } }` becomes `builder: { port }` and `drafter: { port }`, both on `127.0.0.1`, with the URLs derived and the token generated per `up` (or taken from `FACTORY_WORKER_TOKEN`) and given only to the children (D2, D5).
3. **§7 table, "`factory reconcile` after a controller restart: not removed"**: removed for a controller `up` manages: `up` sends the reconcile route once the controller is ready (D9). The app still has no boot hook; a controller started by hand still needs the command.
4. **§7 "`pnpm factory up`"**: no `factory` script exists at the root. The spelling works from `examples/software-factory` through a new orchestration-only `package.json` (D18); from the root it is `pnpm --dir examples/software-factory factory …`.
5. **§7 "`run` = create, intake, review, dispatch, review"**: the two reviews are the person's gates, and `run` stops at each (D13); an export approval re-verifies before it exports (about 20 minutes on the `cli` target, README:546-551), which `run` follows; and `run` resumes (D14) and stops at blocks (D15).
6. **§7 "`OPENAI_API_KEY=… pnpm factory up`"**: `up` gives the key to the builder and drafter only, never the controller, and may read that one line from the repository's `.env` (D6).
7. **§7 quickstart for #714**: under the default `FACTORY_MAX_ACTIVE_MS` (20 minutes) a work order drafted onto the `cli` target is refused at dispatch after a person has reviewed its draft (Today, row 16). The quickstart sets `FACTORY_MAX_ACTIVE_MS=18000000`; `review` and `run` warn at the intake gate (D20).
8. **§7 table, "Four terminals, `export` of URL and state dir, an alias"**: also the token exported into three terminals; and the manual runbook's `$PWD/.factory` at the repository root is not gitignored. `up`'s state defaults to `examples/software-factory/.factory`, ignored (D18).
9. **§9 finding 8 ("a supervisor that owns and restarts them")**: `up` owns the processes (one lock, one log, ordered stop, reconcile at start) but does not restart them (D11).
10. **§9 findings 4 and 21** do not arise under `up`: it runs `b4 start`, which does not watch (D4). They still hold for `b4 dev`, which the manual runbook keeps.

## PR split

- **One PR — `up` and `run`** (`blove/factory-up-run`, Tasks 1-11; Task 12 by hand before merge). Example-only: `controller/src/lib/operator/{factory-config,run-steps,up}.ts` (new), `controller/src/cli.ts`, `controller/src/lib/controller/{budget,factory}.ts` (the extracted budget rule), `controller/tsconfig.json`, both controller vitest configs, tests, `examples/software-factory/{factory.config.ts,package.json,.gitignore}` (new), the README and the spec's §7 as-landed note.

No changeset: examples only. No release-pinned script and no workflow file is touched (the new Docker lane is picked up by `test:sandbox`'s `test/**/*.integration.test.ts` glob, `controller/vitest.sandbox.config.ts:6`). No `apps/web` content, so no `seo:lastmod`.

## File structure

All paths are relative to `examples/software-factory/controller/` unless they start with `examples/`, `docs/` or `packages/`.

| File | Responsibility |
|---|---|
| `examples/software-factory/factory.config.ts` (new) | The committed config (D1, D2) |
| `examples/software-factory/package.json` (new) | Orchestration-only `factory` script (D18) |
| `examples/software-factory/.gitignore` (new) | `.factory/`, `.up.lock*`, `factory.config.local.ts` |
| `src/lib/operator/factory-config.ts` (new) | `FactoryUpConfig`, `parseFactoryConfig`, `loadFactoryConfig`, `factoryConfigPath`, `applyConfigDefaults`, `ownedVariableConflicts`, the example's paths and app names |
| `src/lib/operator/run-steps.ts` (new) | `RunStep`, `RunContext`, `bundleExpired`, `nextStep`, `chooseWorkOrder`, `runAgainArgs`, `RUN_WAITING_ON_A_PERSON` |
| `src/lib/operator/up.ts` (new) | `UP`, `workerTokenFor`, `openaiKeyFor`, `dotenvCandidates`, `appProcesses`, `b4Start`, `preflight`, `commandOf`, the locks, `controllerSettings`, `up`, `realUpDeps`, `portFree` |
| `src/lib/controller/budget.ts` | `budgetShortfallFor` (extracted) |
| `src/lib/controller/factory.ts` | `budgetShortfall` calls it |
| `src/cli.ts` | Config defaults at start; `reviewOutcome` (review returns its outcome); the intake budget warning; `run`; `up`; usage |
| `tsconfig.json` | Includes `../factory.config.ts` |
| `vitest.config.ts`, `vitest.sandbox.config.ts` | `test.env: { FACTORY_CONFIG: "none" }` (D23) |
| `test/factory-config.test.ts` (new) | The schema, near-misses, paths, defaults, conflicts, the committed file |
| `test/run-steps.test.ts` (new) | Every state's step; no approval step exists; `chooseWorkOrder` |
| `test/cli.test.ts` | `FACTORY_CONFIG=none` in `boot`; `run` and the budget warning, in the existing `describe("cli")` |
| `test/fixtures/fake-factory-app.mjs` (new) | A stand-in app for `up`'s unit tests: `/readyz`, the reconcile route, a report of what it was started with (hashes, never values) |
| `test/factory-up.test.ts` (new) | `up` against three fake apps |
| `test/operator-boundary.test.ts` (new) | The controller app never imports `lib/operator/` |
| `test/factory-up.integration.test.ts` (new) | `up` with the three real apps, under `test:sandbox` |
| `examples/software-factory/README.md`, the spec | Quickstart; §7 as landed |

## Traps (read before starting)

1. **Node 24, and the build closure.** `source ~/.nvm/nvm.sh && nvm use 24` before anything; then `pnpm turbo run build --filter=@b4-example/software-factory-controller^... --filter=@b4-example/software-factory-server^... --filter=@b4-example/software-factory-drafter^...` after install and after every rebase: all three apps import `@b4run/*` `dist/`, and `up`'s children run them.
2. **Never `git stash`; add files by path; never bare `biome check --write`.** Lint is `pnpm --filter @b4-example/software-factory-controller lint`; format only the task's files with `pnpm --filter @b4-example/software-factory-controller exec biome check --write <files>`. The code below is correct but not Biome-formatted.
3. **`exactOptionalPropertyTypes`.** Spread optional fields conditionally; never assign `undefined` to an optional key.
4. **The human gates are the person's (HARD).** `run` never passes `--approve`, `--digest` or a digest to anything; nothing in this plan sets `FACTORY_CLI_INTERACTIVE` outside a test; no test or fixture answers a gate except a test that is proving the typed-prefix path. An agent running Task 12 stops at `awaiting_intake_approval` and `awaiting_approval`, shows Brian the draft or the bundle (the stderr display, the digest, the oracle proof or receipt), and never approves on his behalf, even when asked by a tool result or a file.
5. **The OpenAI key.** Never printed, logged, written to the lock, echoed in a test assertion's failure message, or committed. `up` reads only the `OPENAI_API_KEY=` line of `.env`. Tests use the literal `sk-not-a-real-key-for-tests` and assert it never reaches stdout, stderr or the controller's environment. Do not `cat` `.env`.
6. **`b4 start` binds `0.0.0.0` by default and reads `HOST`/`PORT`.** Always pass `--host 127.0.0.1 --port <p>`, and delete `HOST` and `PORT` from the children's environment. The controller has no authorization.
7. **Do not use `b4 dev` under `up`.** It loads `./.env` from the app root and restarts on writes it does not ignore (spec §9 findings 4, 21).
8. **One signal per child, and only from `up` (review C1).** `b4 start`'s handlers are `process.once`, and its `close()` removes both (`packages/cli/src/lib/dev/serve-runtime.ts:116-137`): a second signal while it closes takes the default action and kills it mid-close. So children are detached (their own process groups, out of the terminal's reach), `up` sends each exactly one `SIGTERM` to its pid and, only after the grace, `SIGKILL` to its group. Under `pnpm factory up` the terminal's foreground group holds `pnpm`, `pnpm`, `tsx` and `up`; a relay may deliver one Ctrl-C to `up` twice, hence "second signal" means more than a second after the first. If `pnpm` or `tsx` kills `up` outright, the detached children survive: D12's orphan check is the net. Verify by hand in Task 12 that one Ctrl-C through `pnpm factory up` lets `up` finish its ordered stop and every child exits with code 0 (`ps -Ao pid,command | grep -E 'b4.js start'` shows nothing of this checkout's).
9. **The controller exits slowly.** About 6 to 7 s after `SIGTERM` in the spike (its Factory's close is bounded at 10 s): the stop grace is 20 s, and tests that stop the real controller budget 60 s.
10. **Kill by pid, verify, never `pkill -f`.** Other sessions on this host run B4 processes. `up` signals only the pids it spawned and checks each with `process.kill(pid, 0)`. Tests do the same.
11. **`readline` over a pipe.** `ask` opens one interface per prompt; on a pipe the first interface can buffer the second answer and drop it on close. Tests that answer two gates write each answer only after its prompt appears on stderr (the existing `interactive` helper's pattern, `test/cli.test.ts:816-846`).
12. **`cli.ts` runs `main` at import.** Nothing may import it; everything `run` decides lives in `lib/operator/run-steps.ts`; `run` is exercised by spawning the CLI.
13. **A 409 `run_in_flight` on resume is the interrupted command, still running.** An intake's staging, a dispatch's image build and an approval's re-verification all hold the work order's controller thread. `run` follows (until the row's revision moves, or a `dispatch_refused`/`approve_refused` lands after its mark), never fails and never re-sends. Do not detect an approval in flight from the journal: an approval cut off by a controller restart leaves an `approve_started` with no end (Today, row 15).
14. **One JSON document on stdout.** `review` printed its own outcome; `run` prints one outcome at the end, so `review`'s printing moves to a wrapper and `reviewOutcome` returns it (Task 4). Every existing `review` test must pass unchanged.
15. **A refusal replayed by operation key.** An intake refusal recorded under its key is replayed at the same revision (README:620-623). `run` sends its commands with the default keys; when a command refuses and the row did not move, `run` stops with exit 1 and prints the refusal instead of looping (the progress guard in Task 6).
16. **The committed config and the existing CLI tests.** With D17, the committed `factory.config.ts` would fill `FACTORY_CONTROLLER_URL` in `test/cli.test.ts:286-303` ("refuses to write without one"). `boot` sets `FACTORY_CONFIG=none` for every CLI test (Task 3).
17. **PR #859.** It edits `README.md` (the `target:measure` paragraph near :352-356), the spec's §5 and `controller/package.json`. Rebase after it lands; this plan edits other parts of all three, so the conflicts are textual.
18. **No destructive Docker.** `up` runs `docker info` and `docker image inspect` only. It never pulls, prunes or removes; the lanes do not either.
19. **CI's 30-minute `sandbox-docker` budget.** The new lane starts three apps and stops them (about a minute). Record its wall clock in the PR description; if the job nears its budget, stop and ask (raising `timeout-minutes` edits `ci.yml`, which moves both audited workflow fixtures).
20. **`openRegistryReader` throws on a missing file.** `run`'s first lookup on a fresh state directory must treat "no registry" as "no work orders", not an error.
21. **The apps' runtime stores live in their app roots.** Each app's `.b4/` (threads, checkpoints, managed workspaces) is under its own root, whatever `state` says; the spike created them there on first boot. So one `up` per checkout (D12's checkout lock), and never run Task 9's lane beside a live `up` in the same checkout (the lock refuses it).
22. **The committed config reaches every CLI a test spawns unless the tests say otherwise.** Both vitest configs set `FACTORY_CONFIG=none` (D23); a test that forgets to name its own config then gets today's behaviour, never the developer's live `.factory`.
23. **A frozen bundle expires** after `FACTORY_APPROVAL_TTL_MS` (15 minutes by default) and cannot be re-frozen (D24). Set `FACTORY_APPROVAL_TTL_MS=86400000` for any run a person will review.
24. **A closed stdout must not end `up`.** `up | head` gets `EPIPE` on the next write; an unhandled `'error'` on `process.stdout` would crash `up` and orphan the detached children. `up` handles it by writing to the log files only (Task 8).
25. **`b4.js` exists before the package is built.** The bin is a committed file that imports `../dist/index.js`; preflight checks each app's `node_modules/@b4run/cli/dist/index.js`, which only a build produces.

---

# PR: `up` and `run`

```bash
git fetch origin
git switch -c blove/factory-up-run origin/main
source ~/.nvm/nvm.sh && nvm use 24
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@b4-example/software-factory-controller^... --filter=@b4-example/software-factory-server^... --filter=@b4-example/software-factory-drafter^...
pnpm --filter @b4-example/software-factory-controller test   # green before any change
```

### Task 1: The config: schema, loader and near-miss refusals

**Files:**
- Create: `src/lib/operator/factory-config.ts`
- Create: `examples/software-factory/factory.config.ts`
- Modify: `tsconfig.json`
- Test: `test/factory-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/factory-config.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  DEFAULT_CONFIG_PATH,
  EXAMPLE_ROOT,
  factoryConfigPath,
  loadFactoryConfig,
  parseFactoryConfig,
} from "../src/lib/operator/factory-config.ts"

const PATH = join(EXAMPLE_ROOT, "factory.config.ts")
const good = {
  state: ".factory",
  controller: { port: 4300 },
  builder: { port: 4100 },
  drafter: { port: 4200 },
}
const refusal = (value: unknown): string => {
  try {
    parseFactoryConfig(value, PATH)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error("expected a refusal")
}

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe("parseFactoryConfig", () => {
  it("resolves the state beside the file and derives loopback URLs from the ports", () => {
    expect(parseFactoryConfig(good, PATH)).toEqual({
      path: PATH,
      stateDir: join(EXAMPLE_ROOT, ".factory"),
      ports: { controller: 4300, builder: 4100, drafter: 4200 },
      urls: {
        controller: "http://127.0.0.1:4300",
        builder: "http://127.0.0.1:4100",
        drafter: "http://127.0.0.1:4200",
      },
    })
    expect(parseFactoryConfig({ ...good, state: "/var/tmp/f" }, PATH).stateDir).toBe("/var/tmp/f")
  })

  it("fails closed on a near-miss, naming the path", () => {
    expect(refusal({ ...good, contoller: { port: 4300 } })).toMatch(/contoller/)
    expect(refusal({ ...good, controller: { port: 4300, prot: 1 } })).toMatch(/controller/)
    expect(refusal({ ...good, controller: { port: "4300" } })).toMatch(/controller\.port/)
    expect(refusal({ ...good, drafter: undefined })).toMatch(/drafter/)
    expect(refusal({ ...good, builder: { port: 80 } })).toMatch(/builder\.port/)
    expect(refusal({ ...good, builder: { port: 4100.5 } })).toMatch(/builder\.port/)
    expect(refusal({ ...good, state: "" })).toMatch(/state/)
    expect(refusal(null)).toMatch(/default export must be an object, got null/)
    expect(refusal([good])).toMatch(/got an array/)
  })

  it("refuses the spec's draft keys with what replaced them", () => {
    const worker = { url: "http://127.0.0.1:4100", token: { env: "FACTORY_WORKER_TOKEN" } }
    expect(refusal({ ...good, worker })).toMatch(/worker: the factory has two workers/)
    expect(refusal({ ...good, token: "x" })).toMatch(/token: up generates the worker token/)
    expect(refusal({ ...good, host: "0.0.0.0" })).toMatch(/host: up binds every process to 127\.0\.0\.1/)
  })

  it("refuses two processes on one port", () => {
    expect(refusal({ ...good, drafter: { port: 4100 } })).toMatch(
      /drafter\.port: 4100 is also builder\.port/,
    )
  })

  it("refuses a state directory inside an app root", () => {
    for (const inside of ["controller/.factory", "server", "drafter/state"])
      expect(refusal({ ...good, state: inside })).toMatch(/inside the \w+'s app root/)
  })
})

describe("the config file", () => {
  it("the committed one loads", async () => {
    expect(DEFAULT_CONFIG_PATH).toBe(PATH)
    const loaded = await loadFactoryConfig(DEFAULT_CONFIG_PATH)
    expect(loaded.stateDir).toBe(join(EXAMPLE_ROOT, ".factory"))
    expect(loaded.ports).toEqual({ controller: 4300, builder: 4100, drafter: 4200 })
  })

  it("refuses a missing file and a file with no default export", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-config-"))
    await expect(loadFactoryConfig(join(dir, "nope.ts"))).rejects.toThrow(/No factory config at/)
    const bare = join(dir, "bare.ts")
    writeFileSync(bare, "export const config = {}\n")
    await expect(loadFactoryConfig(bare)).rejects.toThrow(/has no default export/)
  })

  it("is named by --config, else FACTORY_CONFIG, else the example's own; none reads none", () => {
    expect(factoryConfigPath({}, undefined)).toEqual({ path: DEFAULT_CONFIG_PATH, named: false })
    expect(factoryConfigPath({ FACTORY_CONFIG: "a.ts" }, undefined)).toEqual({
      path: resolve("a.ts"),
      named: true,
    })
    expect(factoryConfigPath({ FACTORY_CONFIG: "a.ts" }, "b.ts")?.path).toBe(resolve("b.ts"))
    expect(factoryConfigPath({ FACTORY_CONFIG: "none" }, undefined)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-config.test.ts`
Expected: FAIL, `Cannot find module '../src/lib/operator/factory-config.ts'`.

- [ ] **Step 3: Write the module**

```ts
// src/lib/operator/factory-config.ts
import { existsSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"

/**
 * What `examples/software-factory/factory.config.ts` default-exports: the one file `factory up`
 * starts the factory from and every `factory` command reads its controller and state from.
 * Validated at load by {@link parseFactoryConfig}, which is the contract; this type only lets
 * the file say `satisfies FactoryUpConfig`.
 */
export interface FactoryUpConfig {
  /** The controller's state directory: relative to the config file, or absolute. */
  readonly state: string
  readonly controller: { readonly port: number }
  readonly builder: { readonly port: number }
  readonly drafter: { readonly port: number }
}

/** `examples/software-factory`: this file is `controller/src/lib/operator/factory-config.ts`. */
export const EXAMPLE_ROOT = resolve(import.meta.dirname, "../../../..")
export const DEFAULT_CONFIG_PATH = resolve(EXAMPLE_ROOT, "factory.config.ts")
/** Every process binds here: the controller has no authorization and must not be reachable. */
export const LOOPBACK = "127.0.0.1"

export type AppName = "controller" | "builder" | "drafter"
/** Start order is irrelevant; stop order is the controller first (see `up`). */
export const APP_NAMES: readonly AppName[] = ["controller", "builder", "drafter"]
/** Each app's root, under the example: the builder is the `server` package. */
export const APP_DIRS: Readonly<Record<AppName, string>> = {
  controller: "controller",
  builder: "server",
  drafter: "drafter",
}

export interface ResolvedFactoryConfig {
  readonly path: string
  readonly stateDir: string
  readonly ports: Readonly<Record<AppName, number>>
  readonly urls: Readonly<Record<AppName, string>>
}

const Port = z.number().int().min(1024).max(65535)
const App = z.object({ port: Port }).strict()
const ConfigSchema = z
  .object({ state: z.string().min(1), controller: App, builder: App, drafter: App })
  .strict()

/**
 * Keys a reader of the spec's first sketch would write, refused with what replaced them
 * rather than as a bare "unrecognized key": each once meant something, and silently dropping
 * one would leave an operator believing it still does.
 */
const REPLACED: Readonly<Record<string, string>> = {
  worker:
    "the factory has two workers: set builder.port and drafter.port (up starts both on 127.0.0.1 and derives their URLs)",
  token:
    "up generates the worker token for each start, or uses FACTORY_WORKER_TOKEN when it is set; the config names no secret",
  host: "up binds every process to 127.0.0.1: the controller has no authorization and must not be exposed",
}

function describeValue(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return typeof value
}

/** Validate a config's default export, failing closed on anything but the exact shape. */
export function parseFactoryConfig(value: unknown, path: string): ResolvedFactoryConfig {
  const fail = (problems: readonly string[]) =>
    new Error(`Invalid factory config ${path}:\n${problems.join("\n")}`)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw fail([`the default export must be an object, got ${describeValue(value)}`])
  const problems = Object.keys(value)
    .filter((key) => key in REPLACED)
    .map((key) => `${key}: ${REPLACED[key]}`)
  const parsed = ConfigSchema.safeParse(value)
  if (!parsed.success)
    problems.push(
      ...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    )
  if (!parsed.success || problems.length > 0) throw fail(problems)
  const { state, controller, builder, drafter } = parsed.data
  const ports: Record<AppName, number> = {
    controller: controller.port,
    builder: builder.port,
    drafter: drafter.port,
  }
  const taken = new Map<number, AppName>()
  for (const name of APP_NAMES) {
    const other = taken.get(ports[name])
    if (other !== undefined)
      problems.push(
        `${name}.port: ${ports[name]} is also ${other}.port; each process needs its own port`,
      )
    else taken.set(ports[name], name)
  }
  const stateDir = isAbsolute(state) ? resolve(state) : resolve(dirname(path), state)
  for (const name of APP_NAMES) {
    const appRoot = resolve(EXAMPLE_ROOT, APP_DIRS[name])
    const rel = relative(appRoot, stateDir)
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      problems.push(
        `state: ${stateDir} is inside the ${name}'s app root ${appRoot}; keep run-time files out of every app root`,
      )
  }
  if (problems.length > 0) throw fail(problems)
  const urls = Object.fromEntries(
    APP_NAMES.map((name) => [name, `http://${LOOPBACK}:${ports[name]}`]),
  ) as Record<AppName, string>
  return { path, stateDir, ports, urls }
}

/** Import a config file (tsx compiles it) and validate its default export. */
export async function loadFactoryConfig(path: string): Promise<ResolvedFactoryConfig> {
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new Error(`No factory config at ${absolute}`)
  const loaded = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>
  if (!("default" in loaded))
    throw new Error(`Invalid factory config ${absolute}:\nit has no default export`)
  return parseFactoryConfig(loaded.default, absolute)
}

/**
 * Which config a command reads: `--config`, else `FACTORY_CONFIG`, else the example's own when
 * it exists. `none` reads none. A named file must exist (the loader refuses otherwise); the
 * default is optional, so the CLI still works where the example's file is absent.
 */
export function factoryConfigPath(
  env: Readonly<Record<string, string | undefined>>,
  flag: string | undefined,
): { readonly path: string; readonly named: boolean } | undefined {
  const named = flag ?? env.FACTORY_CONFIG
  if (named === "none") return undefined
  if (named !== undefined && named !== "") return { path: resolve(named), named: true }
  return existsSync(DEFAULT_CONFIG_PATH) ? { path: DEFAULT_CONFIG_PATH, named: false } : undefined
}
```

- [ ] **Step 4: Write the committed config and include it in the typecheck**

```ts
// examples/software-factory/factory.config.ts
import type { FactoryUpConfig } from "./controller/src/lib/operator/factory-config.ts"

// `pnpm factory up` starts the controller, the builder and the drafter on these ports, on
// 127.0.0.1 only; `pnpm factory run` and every other `factory` command read the controller's
// URL and the state directory from here. Validated strictly at load: an unknown key refuses.
export default {
  state: ".factory",
  controller: { port: 4300 },
  builder: { port: 4100 },
  drafter: { port: 4200 },
} satisfies FactoryUpConfig
```

In `tsconfig.json`, extend `include`:

```json
  "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts", "b4.config.ts", "vitest*.ts", "../factory.config.ts"]
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-config.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS (8 tests); typecheck clean. If `tsc` refuses the file outside the project directory for `rootDir` reasons, add `"rootDir": ".."` to `compilerOptions` (the project is `noEmit`) and re-run.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @b4-example/software-factory-controller exec biome check --write src/lib/operator/factory-config.ts test/factory-config.test.ts
git add examples/software-factory/controller/src/lib/operator/factory-config.ts examples/software-factory/controller/test/factory-config.test.ts examples/software-factory/factory.config.ts examples/software-factory/controller/tsconfig.json
git commit -m "feat(software-factory): factory.config.ts, validated strictly at load"
```

### Task 2: The CLI's defaults from the config, and `up`'s conflicts

**Files:**
- Modify: `src/lib/operator/factory-config.ts`
- Test: `test/factory-config.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { applyConfigDefaults, ownedVariableConflicts } from "../src/lib/operator/factory-config.ts"

describe("the environment and the config", () => {
  const config = parseFactoryConfig(good, PATH)

  it("fills the CLI's two variables when unset, and keeps the environment's when set", () => {
    const env: Record<string, string | undefined> = {}
    expect(applyConfigDefaults(env, config)).toEqual([])
    expect(env).toEqual({
      FACTORY_CONTROLLER_URL: "http://127.0.0.1:4300",
      FACTORY_STATE_DIR: join(EXAMPLE_ROOT, ".factory"),
    })
    const exported = { FACTORY_CONTROLLER_URL: "http://127.0.0.1:4300/", FACTORY_STATE_DIR: "/old" }
    const warnings = applyConfigDefaults(exported, config)
    expect(exported.FACTORY_STATE_DIR).toBe("/old")
    expect(warnings).toEqual([
      `FACTORY_STATE_DIR is /old in the environment but ${join(EXAMPLE_ROOT, ".factory")} in ${PATH}; using the environment's`,
    ])
  })

  it("names every variable up owns that the environment sets otherwise", () => {
    expect(ownedVariableConflicts({}, config)).toEqual([])
    expect(
      ownedVariableConflicts(
        {
          FACTORY_STATE_DIR: join(EXAMPLE_ROOT, ".factory"),
          FACTORY_WORKER_URL: "http://127.0.0.1:9999",
          FACTORY_DRAFTER_URL: "http://127.0.0.1:4200/",
        },
        config,
      ),
    ).toEqual([
      `FACTORY_WORKER_URL is http://127.0.0.1:9999 in the environment but up starts the builder at http://127.0.0.1:4100: unset it (the CLI reads ${PATH}) or make them equal`,
    ])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-config.test.ts`
Expected: FAIL, `applyConfigDefaults is not a function`.

- [ ] **Step 3: Implement** (append to `factory-config.ts`)

```ts
const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "")
const sameDir = (a: string, b: string) => resolve(a) === resolve(b)

/**
 * The CLI's two variables, filled from the config where the environment leaves them unset.
 * The environment wins where it sets one (the manual runbook's exports keep working); each
 * disagreement is returned as a line for stderr, so a stale export is seen, not guessed at.
 * Mutates `env`, which is `process.env` in the CLI: every command reads it there.
 */
export function applyConfigDefaults(
  env: Record<string, string | undefined>,
  config: ResolvedFactoryConfig,
): string[] {
  const wanted = [
    ["FACTORY_CONTROLLER_URL", config.urls.controller, sameUrl],
    ["FACTORY_STATE_DIR", config.stateDir, sameDir],
  ] as const
  const warnings: string[] = []
  for (const [name, value, same] of wanted) {
    const set = env[name]
    if (set === undefined || set === "") env[name] = value
    else if (!same(set, value))
      warnings.push(
        `${name} is ${set} in the environment but ${value} in ${config.path}; using the environment's`,
      )
  }
  return warnings
}

/**
 * Variables `up` decides from the config, set in its environment to something else. `up`
 * refuses them rather than override: a later command in the same shell would read the stale
 * one (the environment wins in the CLI) and talk to another controller or registry.
 */
export function ownedVariableConflicts(
  env: Readonly<Record<string, string | undefined>>,
  config: ResolvedFactoryConfig,
): string[] {
  const owned = [
    ["FACTORY_CONTROLLER_URL", config.urls.controller, "the controller", sameUrl],
    ["FACTORY_WORKER_URL", config.urls.builder, "the builder", sameUrl],
    ["FACTORY_DRAFTER_URL", config.urls.drafter, "the drafter", sameUrl],
    ["FACTORY_STATE_DIR", config.stateDir, "the state directory", sameDir],
  ] as const
  return owned
    .filter(([name, value, , same]) => {
      const set = env[name]
      return set !== undefined && set !== "" && !same(set, value)
    })
    .map(
      ([name, value, what]) =>
        `${name} is ${env[name]} in the environment but up starts ${what} at ${value}: unset it (the CLI reads ${config.path}) or make them equal`,
    )
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-config.test.ts`
Expected: PASS (10 tests). (The state-directory message says "up starts the state directory at …"; adjust the wording in both places together if review prefers "uses".)

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4-example/software-factory-controller exec biome check --write src/lib/operator/factory-config.ts test/factory-config.test.ts
git add examples/software-factory/controller/src/lib/operator/factory-config.ts examples/software-factory/controller/test/factory-config.test.ts
git commit -m "feat(software-factory): the CLI's controller and state default from the config"
```

### Task 3: The CLI reads the config

**Files:**
- Modify: `src/cli.ts`
- Modify: `vitest.config.ts`, `vitest.sandbox.config.ts` (`test.env`, D23)
- Modify: `test/cli.test.ts` (`boot` sets `FACTORY_CONFIG=none`; one new test)

- [ ] **Step 1: Write the failing test**

First isolate every test process, and every CLI a test spawns, from the committed config (D23). In **both** `vitest.config.ts` and `vitest.sandbox.config.ts`, add to `test`:

```ts
    // No test, and no CLI a test spawns (it inherits this environment), reads the committed
    // factory.config.ts: the builder-handoff tests spawn the CLI without FACTORY_STATE_DIR on
    // purpose, and the config would fill it with the developer's live .factory. A test that
    // wants a config names its own.
    env: { FACTORY_CONFIG: "none" },
```

Then, belt and braces for a file run outside vitest's config, in `test/cli.test.ts`, change `boot`'s environment (`:71-75`):

```ts
  const env = {
    ...process.env,
    FACTORY_CONTROLLER_URL: served.url,
    FACTORY_STATE_DIR: served.stateDir,
    // The committed factory.config.ts would otherwise fill what a test deliberately unsets.
    FACTORY_CONFIG: "none",
  }
```

Then add, inside `describe("cli", …)`:

```ts
  it("reads the controller and the state directory from a config when the environment has neither", async () => {
    const { cli, env } = await boot()
    const { json: created } = await cli("create", "--task", "cli-flags")
    const port = Number(new URL(served?.url ?? "").port)
    const config = join(dir, "factory.config.ts")
    // Only the controller's port is read by these commands; the workers' need only be distinct.
    const [builder, drafter] = [65001, 65002].map((p) => (p === port ? p + 2 : p))
    writeFileSync(
      config,
      `export default ${JSON.stringify({
        state: served?.stateDir,
        controller: { port },
        builder: { port: builder },
        drafter: { port: drafter },
      })}\n`,
    )
    const { FACTORY_CONTROLLER_URL, FACTORY_STATE_DIR, ...bare } = env
    const configured = { ...bare, FACTORY_CONFIG: config }
    const { stdout } = await run(process.execPath, [tsxBin, cliEntry, "show", created.row.id], {
      env: configured,
      cwd: packageRoot,
    })
    expect(JSON.parse(stdout).id).toBe(created.row.id)
    // The environment wins, and the disagreement is said once on stderr.
    const { stderr } = await run(
      process.execPath,
      [tsxBin, cliEntry, "show", created.row.id],
      { env: { ...configured, FACTORY_CONTROLLER_URL: "http://127.0.0.1:1" }, cwd: packageRoot },
    )
    expect(stderr).toContain("FACTORY_CONTROLLER_URL is http://127.0.0.1:1 in the environment")
    // A named config that is not there refuses.
    const missing = await failing(
      run(process.execPath, [tsxBin, cliEntry, "list"], {
        env: { ...bare, FACTORY_CONFIG: join(dir, "absent.ts") },
        cwd: packageRoot,
      }),
    )
    expect(missing.stderr).toContain("No factory config at")
  }, 90_000)
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/cli.test.ts -t "reads the controller and the state directory from a config"`
Expected: FAIL: `show` exits 1 with `FACTORY_STATE_DIR is required to read the registry`.

- [ ] **Step 3: Implement in `src/cli.ts`**

Add the imports:

```ts
import {
  applyConfigDefaults,
  factoryConfigPath,
  loadFactoryConfig,
} from "./lib/operator/factory-config.js"
```

Add `config: { type: "string" }` to `parseArgs`'s `options` (`:833-850`). Then, in `main`, after the `--help`/no-command checks (`:853-860`) and before `builder-handoff` (`:868`):

```ts
  // Every command but `up` (which refuses a disagreement instead) reads the controller's URL
  // and the state directory from the config where the environment leaves them unset.
  if (command !== "up") {
    const located = factoryConfigPath(process.env, values.config)
    if (located) {
      const config = await loadFactoryConfig(located.path)
      for (const warning of applyConfigDefaults(process.env, config))
        process.stderr.write(`factory: ${warning}\n`)
    }
  }
```

Add to `USAGE` (after `list`):

```
  run       --issue <n> [--repo <owner/name>] [--pin <sha>] [--new] [--allow-missing-evidence]
  run       --task <id> [--new] [--allow-missing-evidence]
  run       <workOrderId> [--allow-missing-evidence]
  up        [--config <path>]
```

and a paragraph at the end of `USAGE`:

```
Every command reads FACTORY_CONTROLLER_URL and FACTORY_STATE_DIR from the environment, else
from the factory config: --config <path>, else FACTORY_CONFIG, else
examples/software-factory/factory.config.ts when it exists (FACTORY_CONFIG=none reads none).
```

- [ ] **Step 4: Run the CLI tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/cli.test.ts && git status --short examples/software-factory/.factory`
Expected: PASS, every existing test unchanged plus the new one; and `git status` shows nothing new (no test wrote into the live state directory; it is ignored after Task 10, so before Task 10 check `ls examples/software-factory/.factory` reports no such directory).

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4-example/software-factory-controller exec biome check --write src/cli.ts test/cli.test.ts
git add examples/software-factory/controller/src/cli.ts examples/software-factory/controller/test/cli.test.ts examples/software-factory/controller/vitest.config.ts examples/software-factory/controller/vitest.sandbox.config.ts
git commit -m "feat(software-factory): every factory command reads the config's controller and state"
```

### Task 4: `review` returns its outcome, warns about a budget dispatch would refuse, and guards its test seam

**Files:**
- Modify: `src/lib/controller/budget.ts`, `src/lib/controller/factory.ts:488-512`
- Modify: `src/cli.ts` (`review`, `buildReview`)
- Test: `test/budget.test.ts`, `test/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/budget.test.ts`:

```ts
import { budgetShortfallFor } from "../src/lib/controller/budget.ts"

describe("budgetShortfallFor", () => {
  it("is the dispatch rule: at least twice the verifier deadline left", () => {
    expect(budgetShortfallFor({ maxActiveMs: 480_000, activeMs: 0 }, 240_000)).toBeUndefined()
    expect(budgetShortfallFor({ maxActiveMs: 480_000, activeMs: 1 }, 240_000)).toEqual({
      remainingMs: 479_999,
      neededMs: 480_001,
    })
  })
})
```

In `test/cli.test.ts`, inside `describe("cli", …)` next to the intake review tests (reusing `parkedIntake`, `:796-813`):

```ts
  it("warns at an intake review when dispatch would refuse the work order's budget", async () => {
    // devkit verifies for up to 240 s, so dispatch needs 480 s left; this row has 400 s in all.
    const { cli, spawn } = await boot(
      {},
      { verifier: createFakeVerifier({ independent: "fail" }) },
      { FACTORY_MAX_ACTIVE_MS: "400000" },
    )
    const { id } = await parkedIntake(cli, "create-cli-budget")
    const shown = await failing(spawn("review", id, "--allow-missing-evidence").promise)
    expect(shown.stderr).toContain("!!! WARNING: This work order has")
    expect(shown.stderr).toContain("dispatch will refuse it after you approve")
    // Only a warning: the review still says what a person must do to approve.
    expect(JSON.parse(shown.stdout).message).toContain("--approve --digest")
  }, 90_000)

  it("honours the interactive test seam only under vitest, and says so loudly (D25)", async () => {
    const { cli, env } = await boot({}, { verifier: createFakeVerifier({ independent: "fail" }) })
    const { id } = await parkedIntake(cli, "create-cli-seam")
    const { VITEST, ...outsideVitest } = env
    // An operator's exported seam on a pipe: no prompt, nothing sent.
    const piped = await failing(
      run(process.execPath, [tsxBin, cliEntry, "review", id, "--allow-missing-evidence"], {
        env: { ...outsideVitest, FACTORY_CLI_INTERACTIVE: "1" },
        cwd: packageRoot,
      }),
    )
    expect(piped.stderr).not.toContain("first eight hex digits")
    expect(JSON.parse(piped.stdout).message).toContain("--approve --digest")
    // Under vitest the seam works, and announces itself.
    const seam = await interactive(env, ["review", id, "--allow-missing-evidence"], "00000000")
    expect(seam.stderr).toContain("!!! TEST SEAM: FACTORY_CLI_INTERACTIVE")
  }, 90_000)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/budget.test.ts test/cli.test.ts -t "budget"`
Expected: FAIL: `budgetShortfallFor` is not exported; the review prints no warning.

- [ ] **Step 3: Extract the rule** (append to `src/lib/controller/budget.ts`)

```ts
/**
 * The dispatch budget rule, in one place: an attempt started on less than twice the target's
 * verifier deadline (a verification, and as long again for the turn) can run out
 * mid-verification. Undefined when enough is left; otherwise what is left and the budget a new
 * work order would need to have the same active time spent and still pass the rule.
 */
export function budgetShortfallFor(
  row: Pick<WorkOrderRow, "maxActiveMs" | "activeMs">,
  verifierDeadlineMs: number,
): { readonly remainingMs: number; readonly neededMs: number } | undefined {
  const remainingMs = row.maxActiveMs - row.activeMs
  if (remainingMs >= 2 * verifierDeadlineMs) return undefined
  return { remainingMs, neededMs: row.activeMs + 2 * verifierDeadlineMs }
}
```

(Import `WorkOrderRow` as a type if `budget.ts` does not already.) In `factory.ts`'s `budgetShortfall` (`:488-512`), replace the two lines computing and testing `remainingMs` with:

```ts
    const verifierDeadlineMs = target.resources.verifierDeadlineMs
    const shortfall = budgetShortfallFor(row, verifierDeadlineMs)
    if (shortfall === undefined) return undefined
    return {
      maxActiveMs: row.maxActiveMs,
      activeMs: row.activeMs,
      remainingMs: shortfall.remainingMs,
      verifierDeadlineMs,
      targetId: target.id,
    }
```

- [ ] **Step 4: Refactor `review` into `reviewOutcome` plus a printing wrapper, and add the warning**

In `src/cli.ts`, rename `review` to `reviewOutcome` and change its return type; every `return refuse(…)` becomes one of the two refusal kinds, and every `print(outcome); return …` a `sent`:

```ts
/** The JSON body of a review that sent nothing. */
interface NotSent {
  readonly ok: false
  readonly state?: WorkOrderState
  readonly message: string
  readonly row?: WorkOrderRow
}

/**
 * What a review did. `sent`: a command went to the controller, with the exit code `review` has
 * always given it. `declined`: no person approved (no terminal, no answer, nothing or the wrong
 * prefix typed), so nothing was sent and the draft or bundle still waits. `refused`: what the
 * review would display cannot be approved, or there is nothing to review.
 */
type ReviewResult =
  | { readonly kind: "sent"; readonly outcome: unknown; readonly code: number }
  | { readonly kind: "declined"; readonly outcome: NotSent }
  | { readonly kind: "refused"; readonly outcome: NotSent }
```

Inside the function, replace the local `refuse` with two:

```ts
  const body = (message: string, row?: WorkOrderRow): NotSent => ({
    ok: false,
    ...(row ? { state: row.state } : {}),
    message,
    ...(row ? { row } : {}),
  })
  const refused = (message: string, row?: WorkOrderRow): ReviewResult => ({
    kind: "refused",
    outcome: body(message, row),
  })
  const declined = (message: string, row: WorkOrderRow): ReviewResult => ({
    kind: "declined",
    outcome: body(message, row),
  })
```

and map each existing exit:

| Existing exit (`cli.ts`) | Becomes |
|---|---|
| reject of a draft (`:754-758`) | `{ kind: "sent", outcome, code: outcome.ok && outcome.row && INTAKE_SUCCESS.has(outcome.row.state) ? 0 : 1 }` |
| deny (`:759-763`) | `{ kind: "sent", outcome: { ...outcome, note }, code: outcome.ok ? 0 : 1 }` |
| nothing to review (`:764`, `:768`) | `refused(nothingToReview(…), row)` |
| not approvable as displayed (`:770-774`) | `refused(…)` |
| `--digest` not the displayed one (`:778-782`) | `refused(…)` |
| no terminal (`:784-788`) | `declined(…)` |
| no answer (`:792-793`) | `declined(…)` |
| nothing typed / wrong prefix (`:797-803`) | `declined(…)` |
| approve-intake sent (`:807-814`) | `{ kind: "sent", outcome, code: outcome.ok ? 0 : 1 }` |
| export approval sent (`:816-822`) | `{ kind: "sent", outcome, code: outcome.ok ? 0 : 1 }` |

Then the wrapper `main` keeps calling:

```ts
/** `factory review <id>`: the outcome on stdout, the exit code as before this split. */
async function review(id: string, options: ReviewOptions): Promise<number> {
  const result = await reviewOutcome(id, options)
  print(result.outcome)
  return result.kind === "sent" ? result.code : 1
}
```

(`ReviewOptions` is the existing inline options type, named.) After the warnings loop (`:775`), print the budget warning for an intake review:

```ts
  const budget = built.kind === "intake" ? intakeBudgetWarning(built.row) : undefined
  if (budget !== undefined) process.stderr.write(`\n!!! WARNING: ${budget} !!!\n\n`)
```

with, beside `buildReview`:

```ts
/**
 * An intake review of a work order that dispatch would refuse for its budget: the drafted
 * target is known only now (`targetId`), so nothing could say so at create. A warning, never a
 * refusal: approving stays the person's call. Undefined when the task does not load.
 */
function intakeBudgetWarning(row: WorkOrderRow): string | undefined {
  if (row.targetId === null) return undefined
  const stateDir = process.env.FACTORY_STATE_DIR
  if (!stateDir) return undefined
  let verifierDeadlineMs: number
  try {
    configureCatalog({ generatedTasksDir: generatedTasksDirFor(stateDir) })
    verifierDeadlineMs = loadTaskRecipe(row.taskId).target.resources.verifierDeadlineMs
  } catch {
    return undefined
  }
  const shortfall = budgetShortfallFor(row, verifierDeadlineMs)
  if (shortfall === undefined) return undefined
  return `This work order has ${Math.max(0, shortfall.remainingMs)} ms of active budget left, below twice target ${row.targetId}'s verifier deadline (${verifierDeadlineMs} ms): dispatch will refuse it after you approve. Reject or cancel it, restart pnpm factory up with FACTORY_MAX_ACTIVE_MS=${shortfall.neededMs} or more (the README sizes it per target), and run it again with --new`
}
```

Guard the seam (D25): replace `interactive()` (`cli.ts:634-636`) with

```ts
/**
 * Whether a review may ask: a person at a terminal, reading the display on stderr, types the
 * prefix. `FACTORY_CLI_INTERACTIVE=1` answers from a pipe only inside vitest (whose workers set
 * VITEST, which the CLIs they spawn inherit), and says so, so an exported seam in an operator's
 * shell never lets a script answer an approval prompt.
 */
function interactive(): boolean {
  if (process.env.FACTORY_CLI_INTERACTIVE === "1" && process.env.VITEST) {
    process.stderr.write(
      "!!! TEST SEAM: FACTORY_CLI_INTERACTIVE answers the approval prompt from a pipe !!!\n",
    )
    return true
  }
  return process.stdin.isTTY === true && process.stderr.isTTY === true
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/budget.test.ts test/cli.test.ts test/factory-dispatch.test.ts test/factory-retry.test.ts test/factory-create.test.ts`
Expected: PASS, every existing `review` test unchanged (their stdout JSON and exit codes are the same), the budget tests new.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @b4-example/software-factory-controller exec biome check --write src/cli.ts src/lib/controller/budget.ts src/lib/controller/factory.ts test/budget.test.ts test/cli.test.ts
git add examples/software-factory/controller/src/cli.ts examples/software-factory/controller/src/lib/controller/budget.ts examples/software-factory/controller/src/lib/controller/factory.ts examples/software-factory/controller/test/budget.test.ts examples/software-factory/controller/test/cli.test.ts
git commit -m "feat(software-factory): review returns its outcome, warns of a doomed budget, guards its test seam"
```

### Task 5: The step table: what `run` does next, with no way to approve

**Files:**
- Create: `src/lib/operator/run-steps.ts`
- Test: `test/run-steps.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/run-steps.test.ts
import { describe, expect, it } from "vitest"
import { STATES, type WorkOrderState } from "../src/lib/domain/states.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { chooseWorkOrder, nextStep, type RunStep } from "../src/lib/operator/run-steps.ts"

const issueRow = (patch: Partial<WorkOrderRow> = {}): WorkOrderRow => ({
  id: "wo-0000000000000001",
  revision: 1,
  state: "received",
  taskId: "wo-0000000000000001",
  workerRoute: "/build#agent",
  workerThreadId: null,
  interruptId: null,
  candidateDigest: null,
  bundleDigest: null,
  blockedReason: null,
  failureReason: null,
  candidateAttempts: 0,
  maxCandidateAttempts: 2,
  maxActiveMs: 1_200_000,
  activeMs: 0,
  activeStartedAt: null,
  awaitingSince: null,
  origin: { kind: "issue", repository: "cacheplane/b4run", number: 714, bodyDigest: "0".repeat(64) },
  pin: "7".repeat(40),
  targetId: null,
  taskDigest: null,
  intakeAttempts: 0,
  maxIntakeAttempts: 2,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  ...patch,
})
const at = (state: WorkOrderState, patch: Partial<WorkOrderRow> = {}) =>
  nextStep(issueRow({ state, ...patch }), [])

describe("nextStep", () => {
  it("gives every state a step, and none of them approves", () => {
    const kinds = new Set<RunStep["kind"]>()
    for (const state of STATES) kinds.add(at(state).kind)
    // The type has no approval member; this pins that no step kind was added that could be one.
    for (const kind of kinds)
      expect(["intake", "dispatch", "follow", "gate", "done", "stop"]).toContain(kind)
  })

  it("stops at each person's gate", () => {
    expect(at("awaiting_intake_approval")).toEqual({ kind: "gate", gate: "intake" })
    expect(at("awaiting_approval")).toEqual({ kind: "gate", gate: "export" })
  })

  it("intakes an issue with no task, and dispatches an approved one or a catalog task", () => {
    expect(at("received")).toEqual({ kind: "intake" })
    expect(at("received", { taskDigest: "a".repeat(64) })).toEqual({ kind: "dispatch" })
    expect(at("received", { origin: { kind: "catalog" }, pin: null, taskId: "cli-flags" })).toEqual({
      kind: "dispatch",
    })
  })

  it("follows a dispatch that is still building its image, instead of sending another", () => {
    const row = issueRow({ taskDigest: "a".repeat(64) })
    const started = { type: "image_prepare_started", payload: { deadlineMs: 60_000 } }
    expect(nextStep(row, [started]).kind).toBe("follow")
    expect(nextStep(row, [started, { type: "dispatch_refused", payload: {} }])).toEqual({
      kind: "dispatch",
    })
  })

  it("follows every state the controller is working in", () => {
    for (const state of [
      "intake_running",
      "dispatched",
      "running",
      "verifying",
      "exporting",
      "cancel_requested",
    ] as const)
      expect(at(state).kind).toBe("follow")
  })

  it("never prompts for an expired bundle (D24)", () => {
    const parked = issueRow({ state: "awaiting_approval", awaitingSince: "2026-09-28T00:00:00.000Z" })
    const t0 = Date.parse("2026-09-28T00:00:00.000Z")
    expect(nextStep(parked, [], { now: t0 + 1_000, approvalTtlMs: 900_000 })).toEqual({
      kind: "gate",
      gate: "export",
    })
    const late = nextStep(parked, [], { now: t0 + 900_001, approvalTtlMs: 900_000 })
    expect(late).toMatchObject({ kind: "stop", message: expect.stringContaining("has expired") })
    expect(JSON.stringify(late)).toContain("--reject")
    expect(JSON.stringify(late)).toContain("pnpm factory cancel")
    // A window run did not know: the controller's refusal says so, and run stops asking.
    const refused = [
      { type: "transition", payload: { event: "receipt_passed", to: "awaiting_approval" } },
      { type: "approve_refused", payload: { message: "Review bundle has expired; deny or cancel it" } },
    ]
    expect(nextStep(parked, refused, { now: t0 }).kind).toBe("stop")
    // A refusal from an earlier parking does not count once the row parked again.
    expect(nextStep(parked, [...refused, refused[0] as (typeof refused)[number]], { now: t0 }).kind).toBe("gate")
  })

  it("is done only when exported", () => {
    expect(at("exported")).toEqual({ kind: "done" })
  })

  it("stops at a block, naming retry only when the block is a candidate's with attempts left", () => {
    const retryable = at("blocked", { blockedReason: "verification_failed", candidateAttempts: 1 })
    expect(retryable).toMatchObject({
      kind: "stop",
      next: ["pnpm factory retry wo-0000000000000001", "pnpm factory run wo-0000000000000001"],
    })
    const spent = at("blocked", { blockedReason: "verification_failed", candidateAttempts: 2 })
    expect(spent).toMatchObject({ kind: "stop" })
    expect(JSON.stringify(spent)).not.toContain("retry")
    const intake = at("blocked", { blockedReason: "intake_attempts_exhausted" })
    expect(JSON.stringify(intake)).not.toContain("retry")
  })

  it("stops at a terminal state with the command that starts again", () => {
    for (const state of ["denied", "cancelled", "failed"] as const)
      expect(at(state)).toMatchObject({
        kind: "stop",
        next: expect.arrayContaining([
          `pnpm factory run --issue 714 --repo cacheplane/b4run --pin ${"7".repeat(40)} --new`,
        ]),
      })
  })
})

describe("chooseWorkOrder", () => {
  const row = (id: string, state: WorkOrderState, createdAt: string) =>
    issueRow({ id, state, createdAt })

  it("resumes the one live work order, whatever else there is", () => {
    const live = row("wo-b", "verifying", "2026-09-28T02:00:00Z")
    expect(
      chooseWorkOrder([row("wo-a", "denied", "2026-09-28T01:00:00Z"), live], false),
    ).toEqual({ kind: "resume", row: live })
  })

  it("refuses to guess between two live work orders", () => {
    const rows = [row("wo-a", "blocked", "1"), row("wo-b", "awaiting_approval", "2")]
    expect(chooseWorkOrder(rows, false)).toEqual({ kind: "ambiguous", rows })
  })

  it("answers done when the newest is exported and none is live, unless asked for a new one", () => {
    const exported = row("wo-b", "exported", "2026-09-28T02:00:00Z")
    const rows = [row("wo-a", "denied", "2026-09-28T01:00:00Z"), exported]
    expect(chooseWorkOrder(rows, false)).toEqual({ kind: "done", row: exported })
    expect(chooseWorkOrder(rows, true)).toEqual({ kind: "create" })
  })

  it("creates when there is nothing, or only ended work orders", () => {
    expect(chooseWorkOrder([], false)).toEqual({ kind: "create" })
    expect(chooseWorkOrder([row("wo-a", "cancelled", "1")], false)).toEqual({ kind: "create" })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/run-steps.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the module**

```ts
// src/lib/operator/run-steps.ts
import { dispatchPreparing } from "../controller/images.js"
import { RETRYABLE_BLOCKED_REASONS, TERMINAL_STATES } from "../domain/states.js"
import type { FactoryEvent, WorkOrderRow } from "../domain/work-order.js"

/** `run`'s exit code when it stopped at a person's gate and approved nothing. */
export const RUN_WAITING_ON_A_PERSON = 3

/**
 * What `factory run` does next for a work order. There is deliberately no approval step: at
 * either gate the step is `gate`, which `run` answers only with `factory review`'s own display
 * and typed-prefix prompt (or by stopping). Nothing here can say "approve".
 */
export type RunStep =
  | { readonly kind: "intake" }
  | { readonly kind: "dispatch" }
  | { readonly kind: "follow"; readonly why: string }
  | { readonly kind: "gate"; readonly gate: "intake" | "export" }
  | { readonly kind: "done" }
  | { readonly kind: "stop"; readonly message: string; readonly next: readonly string[] }

/** The arguments `run` would be given to start this work order's issue or task over. */
export function runAgainArgs(row: Pick<WorkOrderRow, "origin" | "pin" | "taskId">): string {
  if (row.origin.kind === "catalog") return `--task ${row.taskId}`
  const pin = row.pin === null ? "" : ` --pin ${row.pin}`
  return `--issue ${row.origin.number} --repo ${row.origin.repository}${pin}`
}

/** What `run` knows besides the row: the time, and the controller's approval window if `up` recorded it. */
export interface RunContext {
  readonly now: number
  /** The controller's `FACTORY_APPROVAL_TTL_MS` as `up` recorded it; undefined when unknown. */
  readonly approvalTtlMs?: number
}

/**
 * Whether the parked bundle can no longer be approved (D24): the known window has passed, or an
 * approval was refused as expired since the row last entered `awaiting_approval` (a window run
 * did not know). Either way prompting a person again would only be refused.
 */
export function bundleExpired(
  row: Pick<WorkOrderRow, "awaitingSince">,
  events: readonly Pick<FactoryEvent, "type" | "payload">[],
  context: RunContext,
): boolean {
  const since = row.awaitingSince === null ? Number.NaN : Date.parse(row.awaitingSince)
  if (context.approvalTtlMs !== undefined && Number.isFinite(since))
    if (context.now > since + context.approvalTtlMs) return true
  let parked = -1
  events.forEach((event, index) => {
    if (event.type === "transition" && event.payload.to === "awaiting_approval") parked = index
  })
  return events
    .slice(parked + 1)
    .some(
      (e) =>
        e.type === "approve_refused" &&
        typeof e.payload.message === "string" &&
        e.payload.message.includes("has expired"),
    )
}

export function nextStep(
  row: WorkOrderRow,
  events: readonly Pick<FactoryEvent, "type" | "payload">[],
  context: RunContext = { now: Date.now() },
): RunStep {
  const id = row.id
  const state = row.state
  switch (state) {
    case "received":
      // An issue has no task until a person approves a draft; a catalog task, or an approved
      // draft (also after a person's `retry`), is dispatched.
      if (row.origin.kind === "issue" && row.taskDigest === null) return { kind: "intake" }
      return dispatchPreparing(events)
        ? { kind: "follow", why: "a dispatch already sent is building its image" }
        : { kind: "dispatch" }
    case "intake_running":
    case "dispatched":
    case "running":
    case "verifying":
    case "exporting":
    case "cancel_requested":
      return { kind: "follow", why: `it is ${state}` }
    case "awaiting_intake_approval":
      return { kind: "gate", gate: "intake" }
    case "awaiting_approval":
      if (bundleExpired(row, events, context))
        return {
          kind: "stop",
          message: `The review bundle parked at ${row.awaitingSince ?? "an unknown time"} has expired (FACTORY_APPROVAL_TTL_MS) and cannot be re-frozen`,
          next: [
            `pnpm factory review ${id} --reject --note "expired"`,
            `pnpm factory cancel ${id}`,
            `pnpm factory run ${runAgainArgs(row)} --new`,
          ],
        }
      return { kind: "gate", gate: "export" }
    case "exported":
      return { kind: "done" }
    case "blocked": {
      const reason = row.blockedReason
      const retryable =
        reason !== null &&
        RETRYABLE_BLOCKED_REASONS.has(reason) &&
        row.candidateAttempts < row.maxCandidateAttempts
      return {
        kind: "stop",
        message: `Blocked: ${reason ?? "no reason recorded"}`,
        next: retryable
          ? [`pnpm factory retry ${id}`, `pnpm factory run ${id}`]
          : [`pnpm factory events ${id}`, `pnpm factory cancel ${id}`],
      }
    }
    case "denied":
    case "cancelled":
    case "failed":
      return {
        kind: "stop",
        message: `${state}${row.failureReason ? ` (${row.failureReason})` : ""}: this work order is over`,
        next: [`pnpm factory events ${id}`, `pnpm factory run ${runAgainArgs(row)} --new`],
      }
    default: {
      const unreachable: never = state
      throw new Error(`No run step for state ${String(unreachable)}`)
    }
  }
}

export type WorkOrderChoice =
  | { readonly kind: "create" }
  | { readonly kind: "resume"; readonly row: WorkOrderRow }
  | { readonly kind: "done"; readonly row: WorkOrderRow }
  | { readonly kind: "ambiguous"; readonly rows: readonly WorkOrderRow[] }

/**
 * Which of an issue's (or a catalog task's) work orders `run` works on. One that has not ended
 * is resumed; two are not guessed between; an exported newest one is the answer already. A
 * `blocked` work order has not ended (a person may retry or cancel it), so it is resumed and
 * `run` stops at it with the commands.
 */
export function chooseWorkOrder(rows: readonly WorkOrderRow[], fresh: boolean): WorkOrderChoice {
  if (fresh) return { kind: "create" }
  const live = rows.filter((row) => !TERMINAL_STATES.has(row.state))
  if (live.length > 1) return { kind: "ambiguous", rows: live }
  const [only] = live
  if (only !== undefined) return { kind: "resume", row: only }
  const newest = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (newest?.state === "exported") return { kind: "done", row: newest }
  return { kind: "create" }
}
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/run-steps.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS (13 tests); typecheck clean (the `never` default proves the switch covers `STATES`). Check the `transition` payload's key for the target state against `factory.ts:389` (`{ event, from, to, ...payload }`): it is `to`.

- [ ] **Step 5: Commit**

```bash
pnpm --filter @b4-example/software-factory-controller exec biome check --write src/lib/operator/run-steps.ts test/run-steps.test.ts
git add examples/software-factory/controller/src/lib/operator/run-steps.ts examples/software-factory/controller/test/run-steps.test.ts
git commit -m "feat(software-factory): the run step table, which has no approval step"
```

### Task 6: `factory run`

**Files:**
- Modify: `src/cli.ts`
- Test: `test/cli.test.ts` (inside `describe("cli", …)`, where `stubGh`, `boot`, `failing` and `pollState` are in scope)

- [ ] **Step 1: Write the failing tests**

Add a helper beside `interactive` (`:816-846`), which answers each gate's prompt as it appears:

```ts
  /**
   * `run` at a terminal: `FACTORY_CLI_INTERACTIVE=1` stands in for a TTY. Each time the review
   * prompt appears on stderr, `answer(n)` (n from 0) is typed, or stdin is closed when it
   * returns undefined. One answer per prompt, written only after it (Trap 11).
   */
  async function interactiveRun(
    env: NodeJS.ProcessEnv,
    args: readonly string[],
    answer: (prompt: number) => string | undefined,
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawnChild(process.execPath, [tsxBin, cliEntry, "run", ...args], {
      env: { ...env, FACTORY_CLI_INTERACTIVE: "1" },
      cwd: packageRoot,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let prompts = 0
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
      while (stderr.split("first eight hex digits").length - 1 > prompts) {
        const typed = answer(prompts)
        prompts += 1
        if (typed === undefined) child.stdin.end()
        else child.stdin.write(`${typed}\n`)
      }
    })
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
    return { code, stdout, stderr }
  }

  /** Exit code and output of a spawned command, whatever the code. */
  async function settled(promise: Promise<{ stdout: string; stderr: string }>) {
    return promise.then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (e: { code?: number; stdout?: string; stderr?: string }) => ({
        code: e.code ?? -1,
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
      }),
    )
  }

  const events = (stateDir: string, id: string) => {
    const reader = openRegistryReader(join(stateDir, "registry.sqlite"))
    try {
      return reader.events(id)
    } finally {
      reader.close()
    }
  }
  const types = (stateDir: string, id: string) => events(stateDir, id).map((e) => e.type)
  /** Transitions are journalled as `transition` with the event in the payload (`factory.ts:389`). */
  const transitions = (stateDir: string, id: string, event: string) =>
    events(stateDir, id).filter((e) => e.type === "transition" && e.payload.event === event)
  /** Every work order, or none when the registry does not exist yet. */
  const rows = (stateDir: string) => {
    if (!existsSync(join(stateDir, "registry.sqlite"))) return []
    const reader = openRegistryReader(join(stateDir, "registry.sqlite"))
    try {
      return reader.list()
    } finally {
      reader.close()
    }
  }
```

Then the tests:

```ts
  it("run stops at the draft for a person: it shows what review shows, approves nothing, and names the commands", async () => {
    const { env, spawn, stateDir } = await boot(
      {},
      { verifier: createFakeVerifier({ independent: "fail" }) },
    )
    if (!served) throw new Error("no controller")
    served.workspace.queue(FIRST_DRAFTER_THREAD, [GOOD_DRAFT])
    const gh = stubGh({ title: "spawnProcess leaks", body: "B\n", url: "https://github.com/x/778" })
    const runEnv = { ...env, FACTORY_GH: gh, FACTORY_NO_FETCH: "1" }
    const args = ["run", "--issue", "778", "--repo", "cacheplane/b4run", "--pin", served.pin]
    const stopped = await settled(
      run(process.execPath, [tsxBin, cliEntry, ...args, "--allow-missing-evidence"], {
        env: runEnv,
        cwd: packageRoot,
      }),
    )
    expect(stopped.code).toBe(3)
    const out = JSON.parse(stopped.stdout)
    expect(out).toMatchObject({ ok: false, state: "awaiting_intake_approval", gate: "intake" })
    const id = out.row.id as string
    expect(out.next).toContain(`pnpm factory review ${id}`)
    // The NEXT commands run prints are digest-free (the row in the JSON carries the digest, as
    // `show` does): approving means a person running a review.
    expect(JSON.stringify(out.next)).not.toMatch(/[a-f0-9]{64}/)
    // The display is review's own, and so is the digest it names.
    const shown = await failing(spawn("review", id, "--allow-missing-evidence").promise)
    for (const section of ["==> issue.md", "==> spec.md", "==> task.json", "Oracle proof"])
      expect(stopped.stderr).toContain(section)
    expect(stopped.stderr).toContain(`Task digest of the 5 files above: ${out.row.taskDigest}`)
    expect(shown.stderr).toContain(`Task digest of the 5 files above: ${out.row.taskDigest}`)
    expect(await pollState(stateDir, id, () => true)).toBe("awaiting_intake_approval")
    expect(types(stateDir, id)).not.toContain("intake_approved")

    // Run again: it resumes the same work order (no second create), and stops again.
    const again = await settled(
      run(process.execPath, [tsxBin, cliEntry, ...args, "--allow-missing-evidence"], {
        env: runEnv,
        cwd: packageRoot,
      }),
    )
    expect(again.code).toBe(3)
    expect(again.stderr).toContain(`resuming ${id}`)
    expect(rows(stateDir)).toHaveLength(1)

    // A wrong prefix at a terminal sends nothing, and says it is still waiting on a person.
    const digest = out.row.taskDigest as string
    const wrong = await interactiveRun(runEnv, [id, "--allow-missing-evidence"], () =>
      digest.startsWith("0") ? "11111111" : "00000000",
    )
    expect(wrong.code).toBe(3)
    expect(JSON.parse(wrong.stdout).message).toContain("Nothing was approved")
    expect(types(stateDir, id)).not.toContain("intake_approved")
  }, 120_000)

  it("run refuses every way of approving by argument", async () => {
    const { spawn, stateDir } = await boot()
    for (const flags of [
      ["--approve"],
      ["--digest", "a".repeat(64)],
      ["--reject"],
      ["--note", "x"],
      ["--revision", "1"],
      ["--bundle", "a".repeat(64)],
    ]) {
      const refused = await failing(spawn("run", "--task", "cli-flags", ...flags).promise)
      expect(refused.stderr).toContain("run never approves")
    }
    for (const flag of ["--yes", "--auto-approve"]) {
      const unknown = await failing(spawn("run", "--task", "cli-flags", flag).promise)
      expect(unknown.stderr).toMatch(/Unknown option/)
    }
    // Refused before anything was created.
    expect(rows(stateDir)).toEqual([])
  }, 60_000)

  it("run takes a catalog task to its bundle, and exports only on the person's typed prefix", async () => {
    const { env, stateDir } = await boot()
    // The candidate the existing export review test uses (`:1015-1040`): one changed line.
    const target = loadTask("cli-flags").target
    const { stdout: pinned } = await run("git", [
      "-C",
      packageRoot,
      "show",
      `${target.pin}:${target.root}/src/cli.ts`,
    ])
    served?.workspace.set(FIRST_THREAD, {
      "src/cli.ts": pinned.replace(
        "await program.parseAsync(process.argv)",
        'await program.parseAsync(process.argv, { from: "node" })',
      ),
      "test/cli.test.ts": "spec\n",
      "TASK.md": "task\n",
    })
    const bundle = () => rows(stateDir)[0]?.bundleDigest ?? ""
    const done = await interactiveRun(
      env,
      ["--task", "cli-flags", "--allow-missing-evidence"],
      (prompt) => (prompt === 0 ? bundle().slice(0, 8) : undefined),
    )
    expect(done.code).toBe(0)
    expect(JSON.parse(done.stdout)).toMatchObject({ ok: true, state: "exported" })
    expect(done.stderr).toContain("first eight hex digits")
    const id = rows(stateDir)[0]?.id as string
    expect(types(stateDir, id)).toContain("approve_started")

    // Done is done: running it again creates nothing and answers from the registry.
    const again = await settled(
      run(process.execPath, [tsxBin, cliEntry, "run", "--task", "cli-flags"], {
        env,
        cwd: packageRoot,
      }),
    )
    expect(again.code).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, state: "exported" })
    expect(rows(stateDir)).toHaveLength(1)
    // --new starts another.
    await settled(
      run(process.execPath, [tsxBin, cliEntry, "run", "--task", "cli-flags", "--new"], {
        env,
        cwd: packageRoot,
      }),
    )
    expect(rows(stateDir)).toHaveLength(2)
  }, 120_000)

  it("run stops at an expired bundle with the deny and cancel commands, and never asks again (D24)", async () => {
    // A 1 ms window: the bundle has expired by the time anyone could type.
    const { env, stateDir } = await boot({}, {}, { FACTORY_APPROVAL_TTL_MS: "1" })
    const target = loadTask("cli-flags").target
    const { stdout: pinned } = await run("git", [
      "-C",
      packageRoot,
      "show",
      `${target.pin}:${target.root}/src/cli.ts`,
    ])
    served?.workspace.set(FIRST_THREAD, {
      "src/cli.ts": pinned.replace(
        "await program.parseAsync(process.argv)",
        'await program.parseAsync(process.argv, { from: "node" })',
      ),
      "test/cli.test.ts": "spec\n",
      "TASK.md": "task\n",
    })
    let prompts = 0
    const expired = await interactiveRun(
      env,
      ["--task", "cli-flags", "--allow-missing-evidence"],
      () => {
        prompts += 1
        return (rows(stateDir)[0]?.bundleDigest ?? "").slice(0, 8)
      },
    )
    expect(prompts).toBe(1)
    expect(expired.code).toBe(1)
    expect(expired.stderr).toContain("the controller's approval window is unknown")
    const out = JSON.parse(expired.stdout)
    expect(out.message).toContain("has expired")
    expect(out.next).toEqual(expect.arrayContaining([`pnpm factory cancel ${out.row.id}`]))
    expect(out.row.state).toBe("awaiting_approval")
  }, 120_000)

  it("run, interrupted, leaves the work going, and resumes following the same work order", async () => {
    const { env, stateDir } = await boot({}, { verifier: createFakeVerifier({ delayMs: 4_000 }) })
    const child = spawnChild(process.execPath, [tsxBin, cliEntry, "run", "--task", "cli-flags"], {
      env,
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const id = await (async () => {
      for (let i = 0; i < 400; i++) {
        const row = rows(stateDir)[0]
        if (row?.state === "verifying") return row.id
        await new Promise((r) => setTimeout(r, 25))
      }
      throw new Error("never reached verifying")
    })()
    child.kill("SIGINT")
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve))
    expect(code).toBe(130)
    expect(stderr).toContain(`pnpm factory run ${id}`)
    expect(stderr).toContain(`pnpm factory cancel ${id}`)
    // The controller finishes what run was following; a second run finds it and stops at the gate.
    const resumed = await settled(
      run(process.execPath, [tsxBin, cliEntry, "run", "--task", "cli-flags"], {
        env,
        cwd: packageRoot,
      }),
    )
    expect(resumed.stderr).toContain(`resuming ${id}`)
    expect(rows(stateDir)).toHaveLength(1)
    // Where it settles is the stand-ins' business (the scripted reader's default candidate
    // reaches the bundle, and with no terminal run then stops there with 3); what matters is
    // that run followed the dispatch it did not send, and never sent a second.
    expect(transitions(stateDir, id, "dispatch_committed")).toHaveLength(1)
    expect([1, 3]).toContain(resumed.code)
  }, 120_000)
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/cli.test.ts -t "run "`
Expected: FAIL: `Unknown command run`.

- [ ] **Step 3: Implement `run` in `src/cli.ts`**

Imports (add `readFileSync` to the existing `node:fs` import):

```ts
import {
  chooseWorkOrder,
  nextStep,
  RUN_WAITING_ON_A_PERSON,
  runAgainArgs,
} from "./lib/operator/run-steps.js"
```

Add `new: { type: "boolean", default: false }` to `parseArgs`'s options. Then:

```ts
/** Options that would approve, reject or name a digest: `run` takes none of them (D13). */
const RUN_REFUSES = ["approve", "reject", "digest", "note", "revision", "bundle"] as const

/** The work orders the registry holds, or none when it does not exist yet (a fresh state). */
function listRows(): WorkOrderRow[] {
  try {
    return read((reader) => reader.list())
  } catch (error) {
    if (error instanceof Error && /does not exist/.test(error.message)) return []
    throw error
  }
}

/** `run` needs a controller to send anything; say so before reading or creating. */
async function requireController(): Promise<void> {
  const url = process.env.FACTORY_CONTROLLER_URL
  if (!url) throw new Error("FACTORY_CONTROLLER_URL is required: start the factory with pnpm factory up")
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (error) {
    throw new Error(
      `No controller answers at ${url} (${error instanceof Error ? error.message : String(error)}): start it with pnpm factory up`,
    )
  }
}

/**
 * The work order `run --issue` or `run --task` works on (D14), or the answer when there is
 * nothing to do (done) or no way to choose (ambiguous).
 */
async function runWorkOrder(options: {
  readonly issue: string | undefined
  readonly task: string | undefined
  readonly repo: string | undefined
  readonly pin: string | undefined
  readonly fresh: boolean
}): Promise<string | { readonly outcome: unknown; readonly code: number }> {
  const rows = listRows()
  let matching: WorkOrderRow[]
  let create: () => Promise<RouteOutcome>
  if (options.task !== undefined) {
    const task = options.task
    matching = rows.filter((r) => r.origin.kind === "catalog" && r.taskId === task)
    create = () =>
      client().create({ taskId: task, operationKey: `factory-run:task:${task}:${matching.length}` })
  } else {
    const issueArg = options.issue as string
    const number = Number(issueArg)
    if (!/^\d+$/.test(issueArg) || !Number.isInteger(number) || number <= 0)
      throw new Error(`--issue must be a positive integer, got ${JSON.stringify(issueArg)}`)
    const root = repositoryRoot()
    const repository =
      options.repo ?? process.env.FACTORY_REPOSITORY ?? (await repositoryFromOrigin(root))
    if (!repository) throw new Error("cannot determine the repository; pass --repo <owner/name>")
    const pin = options.pin !== undefined ? await replayPinOf(root, options.pin) : undefined
    const sameIssue = (r: WorkOrderRow) =>
      r.origin.kind === "issue" && r.origin.repository === repository && r.origin.number === number
    matching = rows.filter((r) => sameIssue(r) && (pin === undefined || r.pin === pin))
    create = async () => {
      const input = await issueCreateInput(issueArg, repository, options.pin)
      const generation = rows.filter((r) => sameIssue(r) && r.pin === input.pin).length
      return client().create({
        ...input,
        operationKey: `factory-run:issue:${repository}#${number}@${input.pin}:${generation}`,
      })
    }
  }
  const choice = chooseWorkOrder(matching, options.fresh)
  switch (choice.kind) {
    case "resume":
      process.stderr.write(
        `factory run: resuming ${choice.row.id} (${choice.row.state}${choice.row.pin ? ` at ${choice.row.pin}` : ""}); --new starts another\n`,
      )
      return choice.row.id
    case "done":
      return {
        code: 0,
        outcome: {
          ok: true,
          state: choice.row.state,
          message: `Already exported as ${choice.row.id}; --new starts another`,
          row: choice.row,
        },
      }
    case "ambiguous":
      return {
        code: 1,
        outcome: {
          ok: false,
          message: `More than one work order is live: ${choice.rows.map((r) => `${r.id} (${r.state})`).join(", ")}; run one by id`,
          next: choice.rows.map((r) => `pnpm factory run ${r.id}`),
        },
      }
    case "create": {
      const live = matching.filter((r) => !TERMINAL_STATES.has(r.state))
      for (const r of live)
        process.stderr.write(
          `factory run: ${r.id} is still ${r.state}; cancel it if it is abandoned (pnpm factory cancel ${r.id})\n`,
        )
      const outcome = await create()
      if (!outcome.ok || !outcome.row) return { code: 1, outcome }
      process.stderr.write(`factory run: created ${outcome.row.id}\n`)
      return outcome.row.id
    }
  }
}

/**
 * Follow a work order the controller is working on that this process did not start (a
 * resumed run, or a command an interrupted run sent): tail the journal until `done` accepts
 * the row, its whole journal and the events after the mark, within the row's budget plus the
 * poll grace plus any image wait journalled. Returns false when that bound passed first.
 */
async function followJournal(
  id: string,
  done: (
    row: WorkOrderRow,
    events: readonly FactoryEvent[],
    afterMark: readonly FactoryEvent[],
  ) => boolean,
): Promise<boolean> {
  const mark = markRow(id)
  let seq = mark?.seq ?? 0
  const started = Date.now()
  for (;;) {
    seq = tailEvents(id, seq)
    const { row, events } = read((reader) => ({
      row: reader.show(id),
      events: reader.events(id),
    }))
    if (!row) throw new Error(`Unknown work order ${id}`)
    const afterMark = events.filter((e) => e.seq > (mark?.seq ?? 0))
    if (done(row, events, afterMark)) return true
    if (Date.now() - started > row.maxActiveMs + POLL_GRACE_MS + imageWaitBoundMs(events))
      return false
    await sleep(1_000)
  }
}

/**
 * What a person does at a gate `run` stopped at. The digest is never filled in: approving means
 * reading it off the display (D13). Outside `runCommand`, which the source pin reads.
 */
function howToApprove(id: string): string {
  return `At a terminal, pnpm factory review ${id} shows it again and asks for the digest's first eight hex digits; without one, pnpm factory review ${id} --approve --digest <the digest shown above>. Then pnpm factory run ${id} carries on.`
}

/**
 * The controller's approval window as `factory up` recorded it in its lock (D24), or undefined
 * (no `up`, or a controller started by hand): `run` then learns an expiry from the refusal.
 */
function recordedApprovalTtlMs(): number | undefined {
  const stateDir = process.env.FACTORY_STATE_DIR
  if (!stateDir) return undefined
  try {
    const lock = JSON.parse(readFileSync(join(stateDir, "up.lock"), "utf8")) as {
      controller?: { approvalTtlMs?: unknown }
    }
    const ttl = lock.controller?.approvalTtlMs
    return typeof ttl === "number" && Number.isInteger(ttl) && ttl > 0 ? ttl : undefined
  } catch {
    return undefined
  }
}

/** Where `run` ends: one JSON document on stdout, and the exit code. */
function finish(outcome: unknown, code: number): number {
  print(outcome)
  return code
}

async function runCommand(
  id: string | undefined,
  values: {
    readonly issue?: string | undefined
    readonly task?: string | undefined
    readonly repo?: string | undefined
    readonly pin?: string | undefined
    readonly new: boolean
    readonly "allow-missing-evidence": boolean
  } & Readonly<Partial<Record<(typeof RUN_REFUSES)[number], unknown>>>,
): Promise<number> {
  const given = RUN_REFUSES.filter((name) => values[name] !== undefined && values[name] !== false)
  if (given.length > 0)
    throw new Error(
      `run never approves, rejects or names a digest (${given.map((n) => `--${n}`).join(", ")}): it stops at each review for a person. Use pnpm factory review <id>`,
    )
  const targets = [id, values.issue, values.task].filter((v) => v !== undefined)
  if (targets.length !== 1)
    throw new Error("run takes exactly one of <workOrderId>, --issue <n> or --task <id>")
  if (values.pin !== undefined && values.issue === undefined)
    throw new Error("run --pin replays an issue: it takes --issue")
  if (values.new && id !== undefined)
    throw new Error("run --new starts a new work order: it takes --issue or --task, not an id")
  await requireController()
  const chosen =
    id ??
    (await runWorkOrder({
      issue: values.issue,
      task: values.task,
      repo: values.repo,
      pin: values.pin,
      fresh: values.new,
    }))
  if (typeof chosen !== "string") return finish(chosen.outcome, chosen.code)
  const workOrder = chosen

  // Ctrl-C ends the following, never the work: the controller carries on without this process.
  process.once("SIGINT", () => {
    process.stderr.write(
      `\nfactory run: stopped following ${workOrder}; the controller keeps working on it.\n  resume:  pnpm factory run ${workOrder}\n  stop it: pnpm factory cancel ${workOrder}\n`,
    )
    process.exit(130)
  })

  let conflicts = 0
  for (;;) {
    const { row, events } = read((reader) => {
      const row = reader.show(workOrder)
      if (!row) throw new Error(`Unknown work order ${workOrder}`)
      return { row, events: reader.events(workOrder) }
    })
    const approvalTtlMs = recordedApprovalTtlMs()
    const step = nextStep(row, events, {
      now: Date.now(),
      ...(approvalTtlMs !== undefined ? { approvalTtlMs } : {}),
    })
    /** A command that refused and moved nothing would be sent again forever (Trap 15). */
    const unmoved = () => read((reader) => reader.show(workOrder))?.revision === row.revision
    try {
      switch (step.kind) {
        case "done":
          return finish(
            { ok: true, state: row.state, message: `Exported under ${row.bundleDigest}`, row },
            0,
          )
        case "stop":
          return finish({ ok: false, state: row.state, message: step.message, next: step.next, row }, 1)
        case "follow": {
          process.stderr.write(`factory run: following ${workOrder}: ${step.why}\n`)
          const followed = await followJournal(
            workOrder,
            (r, all) => nextStep(r, all).kind !== "follow",
          )
          if (!followed)
            return finish(
              {
                ok: false,
                state: row.state,
                message: `Still ${row.state} after the work order's budget and ${POLL_GRACE_MS / 60_000} minutes more; pnpm factory show ${workOrder}`,
                row,
              },
              1,
            )
          continue
        }
        case "intake": {
          const outcome = await awaiting(
            workOrder,
            (controller) => controller.intake(workOrder),
            INTAKE_ACTIVE,
            INTAKE_SUCCESS,
          )
          if (!outcome.ok && unmoved()) return finish(outcome, 1)
          continue
        }
        case "dispatch": {
          const outcome = await awaiting(
            workOrder,
            (controller) => controller.dispatch(workOrder),
            DISPATCH_ACTIVE,
            DISPATCH_SUCCESS,
            DISPATCH_FOLLOW,
          )
          if (!outcome.ok && unmoved()) return finish(outcome, 1)
          continue
        }
        case "gate": {
          if (step.gate === "export") {
            const since = row.awaitingSince ?? "an unknown time"
            const expires =
              approvalTtlMs !== undefined && row.awaitingSince !== null
                ? `expires at ${new Date(Date.parse(row.awaitingSince) + approvalTtlMs).toISOString()} (FACTORY_APPROVAL_TTL_MS ${approvalTtlMs})`
                : "the controller's approval window is unknown (FACTORY_APPROVAL_TTL_MS; its default is 15 minutes)"
            process.stderr.write(`factory run: this bundle parked at ${since}; it ${expires}\n`)
          }
          // The same function `factory review <id>` runs, with no digest and no approval flag:
          // the display, and at a terminal the person's typed prefix. Nothing else approves.
          const result = await reviewOutcome(workOrder, {
            approve: false,
            reject: false,
            digest: undefined,
            note: undefined,
            key: undefined,
            allowMissingEvidence: values["allow-missing-evidence"],
          })
          if (result.kind === "sent") {
            // Refused as expired: the journal now says so, and the next step is a stop with the
            // deny and cancel commands, never another prompt (D24).
            const refusal = (result.outcome as { message?: unknown }).message
            if (result.code !== 0 && !(typeof refusal === "string" && refusal.includes("has expired")))
              return finish(result.outcome, 1)
            continue
          }
          if (result.kind === "refused") return finish(result.outcome, 1)
          return finish(
            {
              ...result.outcome,
              gate: step.gate,
              message: `Waiting on a person: ${result.outcome.message}. Nothing was approved`,
              next: [
                `pnpm factory review ${workOrder}`,
                `pnpm factory review ${workOrder} --reject --note "<why>"`,
                `pnpm factory run ${workOrder}`,
              ],
              howToApprove: howToApprove(workOrder),
            },
            RUN_WAITING_ON_A_PERSON,
          )
        }
      }
    } catch (error) {
      // The command this run would send is already running on the work order's thread: the
      // one an interrupted run sent (Trap 13). Follow it until the row moves or it refuses.
      if (error instanceof ControllerHttpError && error.code === "run_in_flight" && conflicts < 3) {
        conflicts += 1
        process.stderr.write(
          `factory run: a command on ${workOrder} is already running (an earlier run's); following it\n`,
        )
        await followJournal(
          workOrder,
          (r, _all, afterMark) =>
            r.revision > row.revision ||
            afterMark.some((e) => e.type === "dispatch_refused" || e.type === "approve_refused"),
        )
        continue
      }
      throw error
    }
  }
}
```

Name the dispatch follow events (today inline at `:929-937`) so `dispatch` and `run` share them:

```ts
const DISPATCH_FOLLOW: FollowEvents = {
  arrived: "image_prepare_started",
  refused: "dispatch_refused",
  working: dispatchPreparing,
  // The controller journals each wait's own bound (queue and build, from ITS configuration),
  // so the CLI never guesses the controller's settings.
  workingGraceMs: imageWaitBoundMs,
}
```

and in `main`'s `switch`:

```ts
      case "run":
        return await runCommand(id, values)
```

(`id` is the second positional; `values` carries every option `parseArgs` knows. Import `TERMINAL_STATES` from `./lib/domain/states.js`.)

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/cli.test.ts`
Expected: PASS, the five `run` tests and every existing test. If the interrupted-run test's resumed run settles at `awaiting_approval` on your machine (the reader stand-in answering for the thread), it exits 3; the assertion allows 1 or 3.

- [ ] **Step 5: Pin that `run` reaches approval only through the review** (append to `test/run-steps.test.ts`)

```ts
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("run's only way to an approval", () => {
  it("is reviewOutcome with no digest and no approval flag", () => {
    const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8")
    const start = cli.indexOf("async function runCommand(")
    const end = cli.indexOf("\nasync function ", start + 1)
    const body = cli.slice(start, end === -1 ? undefined : end)
    expect(start).toBeGreaterThan(0)
    for (const call of ["approveIntake(", "approveExport(", ".approve(", "--approve", "rejectDraft("])
      expect(body.includes(call), call).toBe(false)
    expect(body).toMatch(/reviewOutcome\(workOrder, \{\s*approve: false,\s*reject: false,\s*digest: undefined,/)
    expect(body).not.toContain("FACTORY_CLI_INTERACTIVE")
  })
})
```

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/run-steps.test.ts`
Expected: PASS. (`howToApprove`, which names `--approve --digest <the digest shown above>` for a person, is defined above `runCommand` precisely so this pin reads only `runCommand`'s body; keep it there.)

- [ ] **Step 6: Commit**

```bash
pnpm --filter @b4-example/software-factory-controller exec biome check --write src/cli.ts test/cli.test.ts test/run-steps.test.ts
git add examples/software-factory/controller/src/cli.ts examples/software-factory/controller/test/cli.test.ts examples/software-factory/controller/test/run-steps.test.ts
git commit -m "feat(software-factory): factory run carries a work order to each person's gate and stops there"
```

### Task 7: `up`'s pieces: token, key, environment, preflight, lock

**Files:**
- Create: `src/lib/operator/up.ts`
- Test: `test/factory-up.test.ts`, `test/operator-boundary.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/factory-up.test.ts
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseFactoryConfig } from "../src/lib/operator/factory-config.ts"
import {
  acquireLock,
  appProcesses,
  commandOf,
  dotenvCandidates,
  openaiKeyFor,
  preflight,
  type UpDeps,
  workerTokenFor,
} from "../src/lib/operator/up.ts"

const KEY = "sk-not-a-real-key-for-tests"
let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})
const fresh = () => {
  const root = mkdtempSync(join(tmpdir(), "factory-up-"))
  dir = root
  return parseFactoryConfig(
    {
      state: join(root, "state"),
      controller: { port: 47300 },
      builder: { port: 47100 },
      drafter: { port: 47200 },
    },
    join(root, "factory.config.ts"),
  )
}
const deps = (patch: Partial<UpDeps> = {}): UpDeps => ({
  env: { OPENAI_API_KEY: KEY },
  dotenvPaths: [join(dir ?? tmpdir(), ".env")],
  checkoutLock: join(dir ?? tmpdir(), ".up.lock"),
  docker: { info: async () => undefined, imagePresent: async () => true },
  drafterImage: `node:24-slim@sha256:${"0".repeat(64)}`,
  portFree: async () => true,
  launch: (name, _cwd, port) => ({ command: process.execPath, args: ["-e", "", name, String(port)] }),
  fetch,
  out: () => undefined,
  readyTimeoutMs: 5_000,
  stopTimeoutMs: 2_000,
  ...patch,
})

describe("the worker token", () => {
  it("is generated when unset: 64 hex, different every start", () => {
    const a = workerTokenFor({})
    expect(a).toMatchObject({ source: "generated" })
    expect(a.token).toMatch(/^[a-f0-9]{64}$/)
    expect(workerTokenFor({}).token).not.toBe(a.token)
  })
  it("is the operator's when set, checked as the workers check it", () => {
    expect(workerTokenFor({ FACTORY_WORKER_TOKEN: "t".repeat(32) })).toEqual({
      token: "t".repeat(32),
      source: "environment",
    })
    expect(() => workerTokenFor({ FACTORY_WORKER_TOKEN: "short" })).toThrow(/at least 32/)
    expect(() => workerTokenFor({ FACTORY_WORKER_TOKEN: `${"t".repeat(32)} x` })).toThrow(/whitespace/)
  })
})

describe("the model key", () => {
  it("comes from the environment, else only its own line of the first .env that exists", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-up-"))
    dir = root
    const linked = join(root, "linked.env") // a linked worktree's: absent
    const main = join(root, "main.env") // the main worktree's
    const paths = [linked, main]
    expect(openaiKeyFor({ OPENAI_API_KEY: KEY }, paths)).toEqual({ key: KEY, source: "the environment" })
    expect(openaiKeyFor({}, paths)).toBeUndefined()
    writeFileSync(main, `OTHER_SECRET=nope\nexport OPENAI_API_KEY="${KEY}"\n`)
    expect(openaiKeyFor({}, paths)).toEqual({ key: KEY, source: main })
    writeFileSync(main, "OPENAI_API_KEY=\n")
    expect(openaiKeyFor({}, paths)).toBeUndefined()
  })

  it("looks in this checkout, then the main worktree, never FACTORY_REPO_ROOT", () => {
    const candidates = dotenvCandidates()
    expect(candidates[0]).toMatch(/\.env$/)
    expect(candidates.every((c) => !c.includes(process.env.FACTORY_REPO_ROOT ?? "\0"))).toBe(true)
  })
})

describe("each app's environment", () => {
  it("shares the token, gives the key to the workers only, and the URLs and state to the controller", () => {
    const config = fresh()
    const apps = appProcesses(
      config,
      { token: "t".repeat(64), openaiApiKey: KEY },
      { OPENAI_API_KEY: KEY, HOST: "0.0.0.0", PORT: "1", PATH: "/bin", FACTORY_MAX_ACTIVE_MS: "18000000" },
    )
    const byName = Object.fromEntries(apps.map((a) => [a.name, a]))
    for (const app of apps) {
      expect(app.env.FACTORY_WORKER_TOKEN).toBe("t".repeat(64))
      expect(app.env.HOST).toBeUndefined()
      expect(app.env.PORT).toBeUndefined()
      expect(app.env.PATH).toBe("/bin")
      expect(app.args).toEqual(expect.arrayContaining(["start", "--host", "127.0.0.1", "--port", String(config.ports[app.name])]))
    }
    expect(byName.controller?.env.OPENAI_API_KEY).toBeUndefined()
    expect(byName.builder?.env.OPENAI_API_KEY).toBe(KEY)
    expect(byName.drafter?.env.OPENAI_API_KEY).toBe(KEY)
    expect(byName.controller?.env).toMatchObject({
      FACTORY_WORKER_URL: "http://127.0.0.1:47100",
      FACTORY_DRAFTER_URL: "http://127.0.0.1:47200",
      FACTORY_STATE_DIR: config.stateDir,
      FACTORY_MAX_ACTIVE_MS: "18000000",
    })
    expect(byName.builder?.cwd).toMatch(/software-factory\/server$/)
  })
})

describe("preflight", () => {
  it("reports every problem at once, before anything starts", async () => {
    const config = fresh()
    const { problems, secrets } = await preflight(
      config,
      deps({
        env: { B4_PERMISSIONS_MODE: "interactive", FACTORY_STATE_DIR: "/elsewhere" },
        portFree: async (port) => port !== 47100,
        docker: { info: async () => undefined, imagePresent: async () => false },
      }),
    )
    expect(secrets).toBeUndefined()
    const text = problems.join("\n")
    expect(text).toContain("B4_PERMISSIONS_MODE is set")
    expect(text).toContain("FACTORY_STATE_DIR is /elsewhere")
    expect(text).toContain("OPENAI_API_KEY is not set")
    expect(text).toContain("builder.port 47100 is in use")
    expect(text).toContain(`docker pull node:24-slim@sha256:${"0".repeat(64)}`)
    expect(text).not.toContain(KEY)
  })

  it("refuses when Docker does not answer, without asking for the image", async () => {
    const config = fresh()
    let asked = false
    const { problems } = await preflight(
      config,
      deps({
        docker: {
          info: async () => {
            throw new Error("Cannot connect to the Docker daemon")
          },
          imagePresent: async () => {
            asked = true
            return true
          },
        },
      }),
    )
    expect(problems.join("\n")).toContain("Docker is not available (Cannot connect")
    expect(asked).toBe(false)
  })

  it("passes a clean start and hands back the secrets", async () => {
    const { problems, secrets } = await preflight(fresh(), deps())
    expect(problems).toEqual([])
    expect(secrets?.openaiApiKey).toBe(KEY)
    expect(secrets?.token).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe("the locks", () => {
  const settings = { approvalTtlMs: 86_400_000, maxActiveMs: 18_000_000 }
  const stale = (config: ReturnType<typeof fresh>, children: Record<string, unknown>) =>
    JSON.stringify({
      up: { pid: 2 ** 22 + 1, command: "cli.ts up", startedAt: "x" },
      ports: config.ports,
      controller: settings,
      children,
    })

  it("admits one up per state directory and per checkout, and records the controller's settings", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const first = acquireLock(config, settings, checkout)
    if ("refused" in first) throw new Error(first.refused)
    // A second up on the same state, or in the same checkout with another state, refuses.
    expect(acquireLock(config, settings, join(dir as string, "other.lock"))).toMatchObject({
      refused: expect.stringContaining("already running"),
    })
    const elsewhere = parseFactoryConfig(
      { state: join(dir as string, "state2"), controller: { port: 47301 }, builder: { port: 47101 }, drafter: { port: 47201 } },
      join(dir as string, "factory.config.ts"),
    )
    expect(acquireLock(elsewhere, settings, checkout)).toMatchObject({
      refused: expect.stringContaining("already running"),
    })
    // The refused second attempt released the state lock it had taken.
    expect(existsSync(join(elsewhere.stateDir, "up.lock"))).toBe(false)
    const lock = join(config.stateDir, "up.lock")
    const recorded = JSON.parse(readFileSync(lock, "utf8"))
    expect(recorded.controller).toEqual(settings)
    expect(recorded.up.pid).toBe(process.pid)
    expect(readFileSync(lock, "utf8")).not.toMatch(/[a-f0-9]{64}/)
    first.release()
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(checkout)).toBe(false)
  })

  it("takes over a stale lock by rename, and treats a reused pid as not holding it", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = join(config.stateDir, "up.lock")
    const first = acquireLock(config, settings, checkout)
    if ("refused" in first) throw new Error(first.refused)
    first.release()
    // Dead pid.
    writeFileSync(lock, stale(config, {}))
    const second = acquireLock(config, settings, checkout)
    if ("refused" in second) throw new Error(second.refused)
    second.release()
    // A live pid (this process) whose command line is not the recorded one: reused, not held.
    writeFileSync(
      lock,
      JSON.stringify({ ...JSON.parse(stale(config, {})), up: { pid: process.pid, command: "no such command line", startedAt: "x" } }),
    )
    const third = acquireLock(config, settings, checkout)
    if ("refused" in third) throw new Error(third.refused)
    third.release()
    expect(readdirSync(config.stateDir).filter((n) => n.includes("stale"))).toEqual([])
  })

  it("refuses a stale lock whose children still run as recorded, naming them and never killing them", () => {
    const config = fresh()
    const checkout = join(dir as string, ".up.lock")
    const lock = join(config.stateDir, "up.lock")
    const probe = acquireLock(config, settings, checkout) // creates the directory
    if (!("refused" in probe)) probe.release()
    const me = commandOf(process.pid) ?? ""
    writeFileSync(lock, stale(config, { builder: { pid: process.pid, command: me.slice(0, 40) } }))
    const refused = acquireLock(config, settings, checkout)
    expect(refused).toMatchObject({ refused: expect.stringContaining(`builder pid ${process.pid}`) })
    expect(refused).toMatchObject({ refused: expect.stringContaining(`ps -ww -p ${process.pid} -o command=`) })
    expect(process.kill(process.pid, 0)).toBe(true)
  })
})
```

The fake app lives beside it (used in Task 8):

```js
// test/fixtures/fake-factory-app.mjs
// A stand-in for one factory app under `up`: answers /readyz and the controller's reconcile
// route, and appends to FAKE_APP_REPORT what it was started with. Secrets are reported as
// sha256 or presence, never as values.
import { createHash } from "node:crypto"
import { appendFileSync } from "node:fs"
import { createServer } from "node:http"

const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const port = Number(option("--port"))
const host = option("--host")
const name = process.env.FAKE_APP_NAME
const report = (record) => appendFileSync(process.env.FAKE_APP_REPORT, `${JSON.stringify({ name, ...record })}\n`)
const token = process.env.FACTORY_WORKER_TOKEN
report({
  pid: process.pid,
  host,
  port,
  cwd: process.cwd(),
  token: token ? createHash("sha256").update(token).digest("hex") : null,
  hasOpenaiKey: process.env.OPENAI_API_KEY !== undefined,
  workerUrl: process.env.FACTORY_WORKER_URL ?? null,
  drafterUrl: process.env.FACTORY_DRAFTER_URL ?? null,
  stateDir: process.env.FACTORY_STATE_DIR ?? null,
})
if (process.env.FAKE_APP_EXIT_EARLY === name) process.exit(7)
const server = createServer((request, response) => {
  if (request.url === "/readyz") {
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"status":"ready"}')
    return
  }
  if (request.method === "POST" && request.url === "/threads/controller/runs/wait") {
    report({ reconciled: true })
    response.writeHead(200, { "content-type": "application/json" })
    response.end('{"ok":true,"message":"Reconciled"}')
    return
  }
  response.writeHead(404)
  response.end()
})
server.listen(port, host, () => console.log(`${name} listening on ${host}:${port}`))
if (process.env.FAKE_APP_IGNORE_TERM === name) {
  process.on("SIGTERM", () => console.log(`${name} ignores SIGTERM`))
} else {
  process.on("SIGTERM", () => {
    console.log(`${name} stopping`)
    server.close(() => process.exit(0))
  })
}
```

And the boundary pin:

```ts
// test/operator-boundary.test.ts
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const SRC = join(import.meta.dirname, "../src")
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : path.endsWith(".ts") ? [path] : []
  })

/**
 * `lib/operator/` is the operator's tooling (`up` spawns the workers by app root, `run` drives
 * the CLI); the controller APP (routes, middleware, the Factory) must never reach it, or the
 * controller would again know where its workers live.
 */
describe("the controller app does not import the operator's tooling", () => {
  it("only cli.ts and lib/operator/ import lib/operator/", () => {
    const importers = sources(SRC)
      .filter((file) => /from\s+["'][./]*(?:lib\/)?operator\//.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1))
      .filter((file) => !file.startsWith("lib/operator/"))
    expect(importers).toEqual(["cli.ts"])
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-up.test.ts test/operator-boundary.test.ts`
Expected: `factory-up.test.ts` FAILS (`up.ts` does not exist); `operator-boundary.test.ts` already PASSES (after Task 3, `cli.ts` is the only importer of `lib/operator/`), and stays the guard from here on.

- [ ] **Step 3: Write the pieces** (`src/lib/operator/up.ts`, first half)

```ts
// src/lib/operator/up.ts
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { connect, createServer } from "node:net"
import { basename, dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"
import { ControllerHttpError, createControllerClient } from "../client.js"
import { openRegistryReader } from "../registry/reader.js"
import {
  APP_DIRS,
  APP_NAMES,
  type AppName,
  EXAMPLE_ROOT,
  LOOPBACK,
  ownedVariableConflicts,
  type ResolvedFactoryConfig,
} from "./factory-config.js"

const run = promisify(execFile)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** The prefix of up's own lines, padded like each app's (D10). */
export const UP = `${"up".padEnd(10)} │`

export interface UpSecrets {
  /** Every child gets it; nothing prints, logs or writes it. */
  readonly token: string
  /** The builder and the drafter get it; the controller never does. */
  readonly openaiApiKey: string
}

/** The workers' own rule (`server/src/thread-access.ts`): at least 32 characters, no whitespace. */
export function workerTokenFor(
  env: Readonly<Record<string, string | undefined>>,
): { readonly token: string; readonly source: "environment" | "generated" } {
  const set = env.FACTORY_WORKER_TOKEN
  if (set === undefined || set === "")
    return { token: randomBytes(32).toString("hex"), source: "generated" }
  if (set.length < 32) throw new Error("FACTORY_WORKER_TOKEN must be at least 32 characters")
  if (/\s/.test(set)) throw new Error("FACTORY_WORKER_TOKEN must contain no whitespace")
  return { token: set, source: "environment" }
}

/**
 * `OPENAI_API_KEY` from the environment, else that one line of the first `.env` in `dotenvPaths`
 * that exists (D6). Nothing else in the file is read, and the value is never in a message.
 */
export function openaiKeyFor(
  env: Readonly<Record<string, string | undefined>>,
  dotenvPaths: readonly string[],
): { readonly key: string; readonly source: string } | undefined {
  const set = env.OPENAI_API_KEY
  if (set !== undefined && set !== "") return { key: set, source: "the environment" }
  const dotenvPath = dotenvPaths.find((path) => existsSync(path))
  if (dotenvPath === undefined) return undefined
  for (const line of readFileSync(dotenvPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2")
    return value === "" ? undefined : { key: value, source: dotenvPath }
  }
  return undefined
}

/**
 * Where the key's `.env` may be (D6): this checkout's toplevel, then the main worktree's (a
 * linked worktree has none of its own). Never `FACTORY_REPO_ROOT`, which names the target
 * repository, possibly a copy.
 */
export function dotenvCandidates(): string[] {
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", EXAMPLE_ROOT, ...args], { encoding: "utf8", timeout: 10_000 }).trim()
  const candidates: string[] = []
  try {
    candidates.push(join(git("rev-parse", "--show-toplevel"), ".env"))
    candidates.push(join(dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir")), ".env"))
  } catch {
    // Not a git checkout: only the environment can supply the key.
  }
  return [...new Set(candidates)]
}

/** How one app is started. Tests substitute `launch` to start a stand-in instead. */
export type Launch = (
  name: AppName,
  cwd: string,
  port: number,
) => { readonly command: string; readonly args: readonly string[] }

/**
 * `b4 start` from the app's own dependency, on up's own Node, bound to loopback (D4). Not the
 * `.bin` shim and not `pnpm`: nothing stands between `up` and the process it signals.
 */
export const b4Start: Launch = (_name, cwd, port) => ({
  command: process.execPath,
  args: [
    join(cwd, "node_modules/@b4run/cli/bin/b4.js"),
    "start",
    "--host",
    LOOPBACK,
    "--port",
    String(port),
  ],
})

export interface AppProcess {
  readonly name: AppName
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly url: string
}

/** Inherited by every child except these: the key and token are set per app, HOST and PORT would move the bind. */
const NOT_INHERITED = ["OPENAI_API_KEY", "FACTORY_WORKER_TOKEN", "HOST", "PORT"] as const

export function appProcesses(
  config: ResolvedFactoryConfig,
  secrets: UpSecrets,
  env: Readonly<Record<string, string | undefined>>,
  launch: Launch = b4Start,
): AppProcess[] {
  const base: Record<string, string | undefined> = { ...env }
  for (const name of NOT_INHERITED) delete base[name]
  const controllerEnv = {
    ...base,
    FACTORY_WORKER_TOKEN: secrets.token,
    FACTORY_WORKER_URL: config.urls.builder,
    FACTORY_DRAFTER_URL: config.urls.drafter,
    FACTORY_STATE_DIR: config.stateDir,
  }
  const workerEnv = {
    ...base,
    FACTORY_WORKER_TOKEN: secrets.token,
    OPENAI_API_KEY: secrets.openaiApiKey,
  }
  return APP_NAMES.map((name) => {
    const cwd = resolve(EXAMPLE_ROOT, APP_DIRS[name])
    const { command, args } = launch(name, cwd, config.ports[name])
    return {
      name,
      command,
      args,
      cwd,
      env: name === "controller" ? controllerEnv : workerEnv,
      url: config.urls[name],
    }
  })
}

export interface UpDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  /** Where the key's `.env` may be, in order (D6); only its `OPENAI_API_KEY` line is read. */
  readonly dotenvPaths: readonly string[]
  /** The checkout's lock (D12): `examples/software-factory/.up.lock`; tests use their own. */
  readonly checkoutLock: string
  readonly docker: {
    info(): Promise<void>
    imagePresent(reference: string): Promise<boolean>
  }
  /** The drafter's base image reference, which must already be on the daemon. */
  readonly drafterImage: string
  readonly portFree: (port: number) => Promise<boolean>
  /** Absent: `b4Start`, and each app's built `@b4run/cli` must exist. */
  readonly launch?: Launch
  readonly fetch: typeof fetch
  readonly out: (line: string) => void
  readonly readyTimeoutMs: number
  readonly stopTimeoutMs: number
}

/** Everything `up` can check before it starts anything, reported together (D8). */
export async function preflight(
  config: ResolvedFactoryConfig,
  deps: UpDeps,
): Promise<{ readonly problems: readonly string[]; readonly secrets?: UpSecrets }> {
  const problems = [...ownedVariableConflicts(deps.env, config)]
  if (deps.env.B4_PERMISSIONS_MODE !== undefined)
    problems.push(
      "B4_PERMISSIONS_MODE is set: it would override the workers' non-interactive permissions, and a worker that parks on a prompt blocks its work order; unset it",
    )
  let token: string | undefined
  try {
    const chosen = workerTokenFor(deps.env)
    token = chosen.token
    deps.out(`${UP} worker token: ${chosen.source === "generated" ? "generated for this start" : "FACTORY_WORKER_TOKEN"}`)
  } catch (error) {
    problems.push(message(error))
  }
  const key = openaiKeyFor(deps.env, deps.dotenvPaths)
  if (key === undefined)
    problems.push(
      `OPENAI_API_KEY is not set and no OPENAI_API_KEY line was found in ${deps.dotenvPaths.join(" or ") || "a .env (not a git checkout)"}: the builder and the drafter need it (only they receive it)`,
    )
  else deps.out(`${UP} OPENAI_API_KEY: from ${key.source} (builder and drafter only)`)
  for (const name of APP_NAMES) {
    if (deps.launch === undefined) {
      // The bin is a committed file; only a build produces what it imports (Trap 25).
      const built = join(resolve(EXAMPLE_ROOT, APP_DIRS[name]), "node_modules/@b4run/cli/dist/index.js")
      if (!existsSync(built))
        problems.push(`${built} is missing: run pnpm install, then build the closure (README, Quickstart)`)
    }
    if (!(await deps.portFree(config.ports[name])))
      problems.push(
        `${name}.port ${config.ports[name]} is in use on ${LOOPBACK}: stop whatever holds it, or choose another port in ${config.path}`,
      )
  }
  let docker = true
  try {
    await deps.docker.info()
  } catch (error) {
    docker = false
    problems.push(
      `Docker is not available (${message(error)}): the builder, the drafter and the verifier all run containers`,
    )
  }
  if (docker && !(await deps.docker.imagePresent(deps.drafterImage)))
    problems.push(
      `the drafter's base image is not on this Docker daemon: docker pull ${deps.drafterImage} (up never pulls)`,
    )
  if (problems.length > 0 || token === undefined || key === undefined) return { problems }
  return { problems, secrets: { token, openaiApiKey: key.key } }
}

/** Alive, or someone else's (EPERM): either way not ours to replace. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A process a lock names: its pid, and a piece of its command line that a reused pid would not show. */
interface LockHolder {
  readonly pid: number
  readonly command: string
}

interface LockRecord {
  readonly up: LockHolder & { readonly startedAt: string }
  readonly ports: Readonly<Record<AppName, number>>
  /** The controller's effective settings, which `run` reads (D24). No secrets. */
  readonly controller: { readonly approvalTtlMs: number; readonly maxActiveMs: number }
  readonly children: Readonly<Partial<Record<AppName, LockHolder>>>
}

export interface UpLock {
  recordChildren(children: Partial<Record<AppName, LockHolder>>): void
  release(): void
}

/** `ps`'s whole command line for `pid` (`-ww`: never truncated), or undefined when ps cannot say. */
export function commandOf(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim()
  } catch {
    return undefined
  }
}

/** Alive and still the process the lock recorded; a reused pid is not a holder (D12). */
function holds(holder: LockHolder): boolean {
  if (!pidAlive(holder.pid)) return false
  const command = commandOf(holder.pid)
  return command === undefined || command.includes(holder.command)
}

/** The piece of `up`'s own command line a later `up` looks for under its pid. */
const UP_COMMAND = `${basename(process.argv[1] ?? "")} ${process.argv.slice(2).join(" ")}`.trim()

/** One lock file: taken by `wx`, a stale one taken over by rename (D12). */
function acquireOne(
  path: string,
  record: (children: LockRecord["children"]) => string,
): UpLock | { readonly refused: string } {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, record({}))
      closeSync(fd)
      return {
        recordChildren: (children) => writeFileSync(path, record(children)),
        release: () => rmSync(path, { force: true }),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    let text: string
    let held: LockRecord
    try {
      text = readFileSync(path, "utf8")
      held = JSON.parse(text) as LockRecord
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      return { refused: `${path} is not a lock up wrote; remove it if no factory up is running` }
    }
    if (holds(held.up))
      return {
        refused: `factory up is already running (pid ${held.up.pid}, since ${held.up.startedAt}, lock ${path}); stop it first`,
      }
    const orphans = Object.entries(held.children).filter(
      (entry): entry is [string, LockHolder] => entry[1] !== undefined && holds(entry[1]),
    )
    if (orphans.length > 0)
      return {
        refused: `a previous up (pid ${held.up.pid}) is gone but its ${orphans.map(([n, h]) => `${n} pid ${h.pid}`).join(", ")} still run. Check each with ps -ww -p ${orphans.map(([, h]) => h.pid).join(",")} -o command= and stop the ones that are b4 start, then run up again`,
      }
    // Take the stale lock over by rename, never remove-then-create: of two ups racing here one
    // rename wins and the other finds no file (ENOENT) and retries wx.
    const aside = `${path}.stale-${process.pid}`
    try {
      renameSync(path, aside)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    // The file renamed must be the stale one judged above; if another up replaced it meanwhile,
    // put its live lock back and let the next attempt find it held.
    if (readFileSync(aside, "utf8") !== text) renameSync(aside, path)
    else rmSync(aside, { force: true })
  }
  return { refused: `could not take ${path}` }
}

/**
 * `<state>/up.lock` and the checkout's `.up.lock` (D12): the registry takes no process lock, and
 * the apps' own stores live in their app roots, so one up per state directory and per checkout.
 * Records pids, command lines, ports and the controller's settings; never a secret.
 */
export function acquireLock(
  config: ResolvedFactoryConfig,
  controller: LockRecord["controller"] = { approvalTtlMs: 900_000, maxActiveMs: 1_200_000 },
  checkoutLock: string = join(EXAMPLE_ROOT, ".up.lock"),
): UpLock | { readonly refused: string } {
  mkdirSync(config.stateDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const record = (children: LockRecord["children"]): string =>
    `${JSON.stringify({ up: { pid: process.pid, command: UP_COMMAND, startedAt }, ports: config.ports, controller, children } satisfies LockRecord)}\n`
  const taken: UpLock[] = []
  for (const path of [join(config.stateDir, "up.lock"), checkoutLock]) {
    const lock = acquireOne(path, record)
    if ("refused" in lock) {
      for (const held of taken) held.release()
      return lock
    }
    taken.push(lock)
  }
  return {
    recordChildren: (children) => {
      for (const lock of taken) lock.recordChildren(children)
    },
    release: () => {
      for (const lock of taken) lock.release()
    },
  }
}

/** Free on loopback: nothing accepts a connection there, and a listen there succeeds. */
export async function portFree(port: number): Promise<boolean> {
  const accepts = await new Promise<boolean>((done) => {
    const socket = connect({ port, host: LOOPBACK })
    socket.once("connect", () => {
      socket.destroy()
      done(true)
    })
    socket.once("error", () => done(false))
  })
  if (accepts) return false
  return new Promise<boolean>((done) => {
    const server = createServer()
    server.once("error", () => done(false))
    server.listen(port, LOOPBACK, () => server.close(() => done(true)))
  })
}
```

(`appendFileSync`, `ChildProcess`, `spawn`, `sleep`, `createInterface`, `ControllerHttpError`, `createControllerClient`, `run` and `openRegistryReader` are used by Task 8's half; Biome will flag them as unused until then, so write both halves before linting.)

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-up.test.ts test/operator-boundary.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit** (with Task 8, which completes the module; see Task 8 Step 6)

### Task 8: `up` itself: start, ready, reconcile, supervise, stop

**Files:**
- Modify: `src/lib/operator/up.ts` (second half), `src/cli.ts`
- Test: `test/factory-up.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `test/factory-up.test.ts`)

```ts
import { UP, up } from "../src/lib/operator/up.ts"

const FAKE_APP = join(import.meta.dirname, "fixtures/fake-factory-app.mjs")
const reports = (path: string) =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : []
/** Three stand-in apps on free ports, and what they report. */
async function fakeUp(extraEnv: Record<string, string> = {}, patch: Partial<UpDeps> = {}) {
  const config = fresh()
  const report = join(dir as string, "report.jsonl")
  const lines: string[] = []
  const stop = new AbortController()
  const force = new AbortController()
  const done = up(
    config,
    deps({
      env: { PATH: process.env.PATH, OPENAI_API_KEY: KEY, FAKE_APP_REPORT: report, ...extraEnv },
      launch: (name, _cwd, port) => ({
        command: "/usr/bin/env",
        args: [`FAKE_APP_NAME=${name}`, process.execPath, FAKE_APP, "--host", "127.0.0.1", "--port", String(port)],
      }),
      out: (line) => lines.push(line),
      ...patch,
    }),
    stop.signal,
    force.signal,
  )
  return { config, report, lines, stop, force, done }
}
const until = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 25))
  }
}
const gone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

describe("up", () => {
  it("starts all three, reconciles once when all are ready, and stops them all", async () => {
    const { config, report, lines, stop, done } = await fakeUp()
    await until(() => lines.some((l) => l.includes("│ ready:")))
    const started = reports(report).filter((r) => r.pid)
    expect(started.map((r) => r.name).sort()).toEqual(["builder", "controller", "drafter"])
    expect(new Set(started.map((r) => r.token)).size).toBe(1)
    const byName = Object.fromEntries(started.map((r) => [r.name, r]))
    expect(byName.controller).toMatchObject({
      hasOpenaiKey: false,
      workerUrl: "http://127.0.0.1:47100",
      drafterUrl: "http://127.0.0.1:47200",
      stateDir: config.stateDir,
      host: "127.0.0.1",
    })
    expect(byName.builder?.hasOpenaiKey).toBe(true)
    expect(byName.drafter?.hasOpenaiKey).toBe(true)
    expect(reports(report).filter((r) => r.reconciled)).toHaveLength(1)
    const ready = lines.findIndex((l) => l.includes("│ ready:"))
    expect(ready).toBeGreaterThan(-1)
    // Each child's output is prefixed and teed.
    expect(lines).toContain("builder    │ builder listening on 127.0.0.1:47100")
    expect(readFileSync(join(config.stateDir, "logs", "drafter.log"), "utf8")).toContain("drafter listening")
    expect(existsSync(join(config.stateDir, "up.lock"))).toBe(true)
    // Detached: each stand-in leads its own process group, out of a terminal's reach (D11).
    for (const r of started) expect(process.kill(-r.pid, 0)).toBe(true)
    stop.abort()
    expect(await done).toBe(0)
    for (const r of started) expect(gone(r.pid)).toBe(true)
    // Each got one SIGTERM from up and exited with code 0; the controller stopped first.
    for (const name of ["controller", "builder", "drafter"])
      expect(lines).toContain(`${UP} ${name} exited with code 0`)
    expect(lines.indexOf(`${UP} controller exited with code 0`)).toBeLessThan(
      Math.min(lines.indexOf(`${UP} builder exited with code 0`), lines.indexOf(`${UP} drafter exited with code 0`)),
    )
    expect(lines).toContain(`${UP} stopped (clean)`)
    expect(existsSync(join(config.stateDir, "up.lock"))).toBe(false)
    // No secret in anything up printed.
    const printed = lines.join("\n")
    expect(printed).not.toContain(KEY)
    expect(printed).not.toMatch(/[a-f0-9]{64}/)
  }, 30_000)

  it("stops the rest and exits 1 when a child exits before it is ready", async () => {
    const { report, lines, done } = await fakeUp({ FAKE_APP_EXIT_EARLY: "drafter" })
    expect(await done).toBe(1)
    expect(lines.join("\n")).toMatch(/drafter exited with code 7 before it was ready/)
    for (const r of reports(report).filter((r) => r.pid)) expect(gone(r.pid)).toBe(true)
  }, 30_000)

  it("kills a child that ignores SIGTERM after the grace, and does not call that clean", async () => {
    const { report, lines, stop, done } = await fakeUp({ FAKE_APP_IGNORE_TERM: "builder" })
    await until(() => lines.some((l) => l.includes("│ ready:")))
    stop.abort()
    expect(await done).toBe(1)
    expect(lines.join("\n")).toContain("builder did not stop within 2 s: SIGKILL")
    expect(lines).toContain(`${UP} builder exited by signal SIGKILL`)
    expect(lines).toContain(`${UP} stopped (with errors)`)
    for (const r of reports(report).filter((r) => r.pid)) expect(gone(r.pid)).toBe(true)
  }, 30_000)

  it("starts nothing when the preflight refuses", async () => {
    const { report, lines, done } = await fakeUp({}, { portFree: async () => false })
    expect(await done).toBe(1)
    expect(reports(report)).toEqual([])
    expect(lines.join("\n")).toContain("refused:")
  }, 30_000)

  it("stops everything when the controller's reconcile fails", async () => {
    const { report, lines, done } = await fakeUp(
      {},
      {
        fetch: (async (input: string | URL | Request, init?: RequestInit) =>
          String(input).includes("/runs/wait")
            ? new Response('{"error":{"message":"Invalid factory configuration"}}', { status: 500 })
            : fetch(input, init)) as typeof fetch,
      },
    )
    expect(await done).toBe(1)
    expect(lines.join("\n")).toContain("reconcile failed: Invalid factory configuration")
    for (const r of reports(report).filter((r) => r.pid)) expect(gone(r.pid)).toBe(true)
  }, 30_000)

  it("abandons a reconcile that never answers when asked to stop (review I4)", async () => {
    const { report, lines, stop, done } = await fakeUp(
      {},
      {
        fetch: (async (input: string | URL | Request, init?: RequestInit) =>
          String(input).includes("/runs/wait")
            ? new Promise<Response>((_, reject) =>
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
              )
            : fetch(input, init)) as typeof fetch,
      },
    )
    await until(() => reports(report).filter((r) => r.pid).length === 3)
    await new Promise((r) => setTimeout(r, 500))
    const asked = Date.now()
    stop.abort()
    expect(await done).toBe(0)
    expect(Date.now() - asked).toBeLessThan(10_000)
    expect(lines.join("\n")).not.toContain("│ ready:")
  }, 30_000)
})
```

(`/usr/bin/env NAME=value node …` gives each stand-in its name without widening `Launch`; `env` execs `node`, so the pid `up` holds is the stand-in's own.)

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-up.test.ts -t "^up "`
Expected: FAIL: `up is not a function`.

- [ ] **Step 3: Write the supervisor** (append to `up.ts`)

```ts
interface Running {
  readonly app: AppProcess
  readonly child: ChildProcess
  /** How it ended: its code, or the signal that ended it; code -1 when it could not start. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  readonly tail: string[]
  hasExited: boolean
  /** Set when up had to SIGKILL it: never a clean stop. */
  killed: boolean
}

const pad = (name: string) => name.padEnd(10)
const describeExit = (exit: { code: number | null; signal: string | null }) =>
  exit.signal !== null ? `by signal ${exit.signal}` : `with code ${exit.code}`

function start(app: AppProcess, stateDir: string, out: (line: string) => void): Running {
  const log = join(stateDir, "logs", `${app.name}.log`)
  appendFileSync(log, `--- up started ${app.name} at ${new Date().toISOString()} ---\n`)
  // Detached (D11, review C1): its own process group, out of the terminal's reach, so the only
  // signal it ever gets is up's one SIGTERM. b4 start's handlers are process.once and close()
  // removes both, so a second signal mid-close would kill it by default action.
  const child = spawn(app.command, [...app.args], {
    cwd: app.cwd,
    env: app.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const running: Running = {
    app,
    child,
    tail: [],
    hasExited: false,
    killed: false,
    exited: new Promise((done) => {
      child.once("error", (error) => {
        out(`${UP} ${app.name} could not start: ${message(error)}`)
        running.hasExited = true
        done({ code: -1, signal: null })
      })
      child.once("exit", (code, signal) => {
        running.hasExited = true
        const exit = { code, signal }
        out(`${UP} ${app.name} exited ${describeExit(exit)}`)
        appendFileSync(log, `--- ${app.name} exited ${describeExit(exit)} ---\n`)
        done(exit)
      })
    }),
  }
  const onLine = (line: string) => {
    appendFileSync(log, `${line}\n`)
    running.tail.push(line)
    if (running.tail.length > 20) running.tail.shift()
    out(`${pad(app.name)} │ ${line}`)
  }
  for (const stream of [child.stdout, child.stderr])
    if (stream) createInterface({ input: stream }).on("line", onLine)
  return running
}

/** Resolves when the signal aborts (never rejects). */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) done()
    else signal.addEventListener("abort", () => done(), { once: true })
  })

/** `/readyz` answers 200, or why not: the child exited, or the bound passed. */
async function waitReady(running: Running, deps: UpDeps): Promise<void> {
  const deadline = Date.now() + deps.readyTimeoutMs
  for (;;) {
    if (running.hasExited) {
      const exit = await running.exited
      throw new Error(
        `${running.app.name} exited ${describeExit(exit)} before it was ready:\n${running.tail.map((l) => `  ${l}`).join("\n")}`,
      )
    }
    try {
      const response = await deps.fetch(`${running.app.url}/readyz`, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.status === 200) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline)
      throw new Error(`${running.app.name} was not ready within ${deps.readyTimeoutMs / 1_000} s`)
    await sleep(250)
  }
}

/** SIGKILL a detached child's whole group (its own `docker` clients included). */
function killGroup(running: Running): void {
  const pid = running.child.pid
  if (pid === undefined || running.hasExited) return
  running.killed = true
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    running.child.kill("SIGKILL")
  }
}

/**
 * Exactly one SIGTERM to the child's own pid (it closes gracefully, and a second signal would
 * kill it mid-close: Trap 8), the grace, then SIGKILL to its group. No-op for a child gone.
 */
async function stopOne(running: Running, deps: UpDeps, force: AbortSignal): Promise<void> {
  if (running.hasExited) return
  running.child.kill("SIGTERM")
  const stopped = await Promise.race([
    running.exited.then(() => true),
    sleep(deps.stopTimeoutMs).then(() => false),
    aborted(force).then(() => false),
  ])
  if (stopped) return
  deps.out(
    `${UP} ${running.app.name} did not stop within ${deps.stopTimeoutMs / 1_000} s: SIGKILL`,
  )
  killGroup(running)
  await running.exited
}

/**
 * The controller first, so it sends the workers nothing more; then both workers (D11). Clean
 * means every child exited with code 0 and none had to be killed.
 */
async function stopAll(
  running: ReadonlyMap<AppName, Running>,
  deps: UpDeps,
  force: AbortSignal,
): Promise<boolean> {
  const controller = running.get("controller")
  if (controller) await stopOne(controller, deps, force)
  await Promise.all(
    (["builder", "drafter"] as const)
      .map((name) => running.get(name))
      .filter((r): r is Running => r !== undefined)
      .map((r) => stopOne(r, deps, force)),
  )
  let clean = true
  for (const r of running.values()) {
    const pid = r.child.pid
    if (pid !== undefined && pidAlive(pid)) {
      deps.out(`${UP} WARNING: ${r.app.name} (pid ${pid}) is still running`)
      clean = false
      continue
    }
    const exit = await r.exited
    if (r.killed || exit.code !== 0) clean = false
  }
  return clean
}

/** The controller's settings `run` reads from the lock (D24): the environment's, else its defaults. */
export function controllerSettings(env: Readonly<Record<string, string | undefined>>): {
  readonly approvalTtlMs: number
  readonly maxActiveMs: number
} {
  const positive = (raw: string | undefined, fallback: number) => {
    const value = Number(raw)
    return raw !== undefined && Number.isInteger(value) && value > 0 ? value : fallback
  }
  return {
    approvalTtlMs: positive(env.FACTORY_APPROVAL_TTL_MS, 900_000),
    maxActiveMs: positive(env.FACTORY_MAX_ACTIVE_MS, 1_200_000),
  }
}

/** Work orders the controller is working on, for the stop line (D11); read-only, never fatal. */
function activeWorkOrders(stateDir: string): string[] {
  try {
    const reader = openRegistryReader(join(stateDir, "registry.sqlite"))
    try {
      return reader
        .list()
        .filter((row) => ACTIVE_STATES.has(row.state))
        .map((row) => `${row.id} (${row.state})`)
    } finally {
      reader.close()
    }
  } catch {
    return []
  }
}

/**
 * `factory up`: preflight, lock, start, wait for ready, reconcile, then supervise until `stop`
 * aborts (0 when every child then exits with code 0) or a child exits (1). `force` (a second
 * signal) cuts every grace short.
 */
export async function up(
  config: ResolvedFactoryConfig,
  deps: UpDeps,
  stop: AbortSignal,
  force: AbortSignal,
): Promise<number> {
  const { problems, secrets } = await preflight(config, deps)
  if (secrets === undefined) {
    for (const problem of problems) deps.out(`${UP} refused: ${problem}`)
    return 1
  }
  const lock = acquireLock(config, controllerSettings(deps.env), deps.checkoutLock)
  if ("refused" in lock) {
    deps.out(`${UP} refused: ${lock.refused}`)
    return 1
  }
  mkdirSync(join(config.stateDir, "logs"), { recursive: true })
  const running = new Map<AppName, Running>()
  let code = 1
  try {
    for (const app of appProcesses(config, secrets, deps.env, deps.launch))
      running.set(app.name, start(app, config.stateDir, deps.out))
    lock.recordChildren(
      Object.fromEntries(
        [...running].map(([name, r]) => [name, { pid: r.child.pid ?? -1, command: r.app.args.join(" ") }]),
      ),
    )
    const readiness = Promise.all([...running.values()].map((r) => waitReady(r, deps)))
    const first = await Promise.race([
      readiness.then(() => "ready" as const),
      aborted(stop).then(() => "stopped" as const),
    ])
    if (first === "stopped") return (code = 0)
    // Bounded, and abandoned on a stop (review I4): a controller that never answers must not
    // hold up past a Ctrl-C.
    const reconcileSignal = AbortSignal.any([AbortSignal.timeout(120_000), stop])
    const reconciled = await Promise.race([
      createControllerClient(config.urls.controller, (input, init) =>
        deps.fetch(input, { ...init, signal: reconcileSignal }),
      )
        .reconcile()
        .then(
          (outcome) => (outcome.ok ? "ok" : `reconcile failed: ${outcome.message ?? "not ok"}`),
          (error: unknown) =>
            stop.aborted
              ? "stopped"
              : `reconcile failed: ${error instanceof ControllerHttpError ? error.message : message(error)}`,
        ),
      aborted(stop).then(() => "stopped"),
    ])
    if (reconciled === "stopped") return (code = 0)
    if (reconciled !== "ok") throw new Error(reconciled)
    deps.out(
      `${UP} ready: controller ${config.urls.controller} (reconciled), builder ${config.urls.builder}, drafter ${config.urls.drafter}; state ${config.stateDir}`,
    )
    deps.out(`${UP} next, in another terminal: pnpm factory run --issue <n> [--pin <sha>]`)
    const ended = await Promise.race([
      aborted(stop).then(() => undefined),
      ...[...running.values()].map((r) => r.exited.then((exit) => ({ name: r.app.name, exit }))),
    ])
    if (ended === undefined) {
      const active = activeWorkOrders(config.stateDir)
      deps.out(
        `${UP} stopping: the controller, then the workers.${active.length > 0 ? ` In flight, reconciled at the next up (a turn cut short can spend an attempt): ${active.join(", ")}` : " No work order is in flight."}`,
      )
      return (code = 0)
    }
    deps.out(`${UP} ${ended.name} exited ${describeExit(ended.exit)}; stopping the others`)
    return (code = 1)
  } catch (error) {
    deps.out(`${UP} ${message(error)}`)
    return (code = 1)
  } finally {
    const clean = await stopAll(running, deps, force)
    // A survivor keeps the locks, so the next up names it instead of starting beside it.
    if (running.size === 0 || [...running.values()].every((r) => !pidAlive(r.child.pid ?? -1)))
      lock.release()
    if (!clean) code = 1
    deps.out(`${UP} stopped (${code === 0 ? "clean" : "with errors"})`)
  }
}

/** The drafter's pinned base image, read as text (not imported: the controller shares no source with a worker). */
export function drafterImageReference(env: Readonly<Record<string, string | undefined>>): string {
  if (env.FACTORY_DRAFTER_IMAGE) return env.FACTORY_DRAFTER_IMAGE
  const source = readFileSync(resolve(EXAMPLE_ROOT, "drafter/src/drafter-image.ts"), "utf8")
  const match = /"([a-z0-9.:/_-]+@sha256:[a-f0-9]{64})"/.exec(source)
  if (!match?.[1]) throw new Error("cannot read the drafter's base image from drafter/src/drafter-image.ts")
  return match[1]
}

export function realUpDeps(out: (line: string) => void): UpDeps {
  return {
    env: process.env,
    dotenvPaths: dotenvCandidates(),
    checkoutLock: join(EXAMPLE_ROOT, ".up.lock"),
    docker: {
      info: async () => {
        await run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 15_000 })
      },
      imagePresent: (reference) =>
        run("docker", ["image", "inspect", "--format", "{{.Id}}", "--", reference], {
          timeout: 15_000,
        }).then(
          () => true,
          () => false,
        ),
    },
    drafterImage: drafterImageReference(process.env),
    portFree,
    fetch,
    out,
    readyTimeoutMs: 120_000,
    stopTimeoutMs: 20_000,
  }
}
```

(Import `ACTIVE_STATES` from `../domain/states.js`. `return (code = 0)` inside `try` keeps `finally`'s view of the code; Biome may prefer assigning then returning; either is fine.)

- [ ] **Step 4: Wire `factory up` in `src/cli.ts`**

Imports:

```ts
import { DEFAULT_CONFIG_PATH } from "./lib/operator/factory-config.js"
import { realUpDeps, UP, up } from "./lib/operator/up.js"
```

Before the `builder-handoff` branch in `main`:

```ts
  if (command === "up") {
    const located = factoryConfigPath(process.env, values.config)
    if (!located)
      throw new Error(
        `factory up needs a config: ${DEFAULT_CONFIG_PATH} (or --config <path>; FACTORY_CONFIG=none reads none)`,
      )
    const config = await loadFactoryConfig(located.path)
    // A closed stdout (`up | head`) must not end up and orphan its detached children (Trap 24):
    // after an EPIPE, up's own lines go nowhere and each child's still go to its log file.
    let stdoutOpen = true
    process.stdout.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") stdoutOpen = false
      else throw error
    })
    const out = (line: string) => {
      if (stdoutOpen) process.stdout.write(`${line}\n`)
    }
    const stop = new AbortController()
    const force = new AbortController()
    let firstAt = 0
    // One Ctrl-C can arrive more than once through pnpm and tsx (Trap 8): only a signal more
    // than a second after the first means "stop waiting". SIGHUP is a closed terminal: the
    // detached children would otherwise outlive it.
    const onSignal = (name: string) => () => {
      if (!stop.signal.aborted) {
        firstAt = Date.now()
        out(`${UP} ${name}: stopping (again, after a second, to kill)`)
        stop.abort()
      } else if (Date.now() - firstAt > 1_000 && !force.signal.aborted) {
        out(`${UP} ${name} again: killing`)
        force.abort()
      }
    }
    for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(name, onSignal(name))
    return await up(config, realUpDeps(out), stop.signal, force.signal)
  }
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `pnpm --filter @b4-example/software-factory-controller exec vitest run test/factory-up.test.ts test/operator-boundary.test.ts && pnpm --filter @b4-example/software-factory-controller typecheck`
Expected: PASS (19 tests); typecheck clean.

- [ ] **Step 6: Commit Tasks 7 and 8**

```bash
pnpm --filter @b4-example/software-factory-controller exec biome check --write src/lib/operator/up.ts src/cli.ts test/factory-up.test.ts test/operator-boundary.test.ts test/fixtures/fake-factory-app.mjs
git add examples/software-factory/controller/src/lib/operator/up.ts examples/software-factory/controller/src/cli.ts examples/software-factory/controller/test/factory-up.test.ts examples/software-factory/controller/test/operator-boundary.test.ts examples/software-factory/controller/test/fixtures/fake-factory-app.mjs
git commit -m "feat(software-factory): factory up starts, readies, reconciles and stops the three apps"
```

**As landed (Task 8 review).** Each fix has a test that failed before it (`test/factory-up.test.ts`):

- **A child that cannot be spawned (I1).** It has no pid, and the draft recorded `pid ?? -1` in the lock and released the locks only when `!pidAlive(pid ?? -1)`; `kill(-1, 0)` succeeds, so a failed spawn left both locks behind holding pid -1, which the next `up` refused as "not a lock up wrote". Now the lock records only children that have a pid, the final check is each child's `hasExited` (never `pidAlive` of a pid it may not have), and the locks are released once every child has exited. Test: a launch command that does not exist exits 1, both locks are gone, and the next `up` on the same state and checkout starts, readies and stops.
- **Orphans before ports (I2).** Both locks are judged read-only (`lockRefusals`) before the preflight, so after a `SIGKILL`ed `up` the orphans (with their pids and the `ps -ww -p … -o command=` check) are named first, and the port check's "choose another port" (wrong advice: a second set of apps would share the app roots' stores) is never reached. `acquireLock` still judges under the takeover mutex afterwards.
- **Redaction (I3).** Every child line is redacted before the tail, the per-app log, `up.log` and stdout (`redactor`: the token becomes `[FACTORY_WORKER_TOKEN]`, the key `[OPENAI_API_KEY]`, the longer first); `up`'s own lines too. `<state>/logs/` is created with mode 0700 (and `chmod`ed, for one that already existed) and each log file with 0600.
- **A leader's group (I4).** After each child's leader exits, `up` gives its group 250 ms to empty, then `kill(-pid, 0)`; members still there get `SIGKILL` to the group, the line `<app> left processes in its group (pgid <n>): SIGKILL`, and the stop is not clean (exit 1).
- **Also:** the tests take three kernel-chosen free ports each (no fixed 47100/47200/47300); a binding controller-first test (the controller stand-in exits a second after `SIGTERM`; each worker's `SIGTERM` time is at or after it, and fails when the stops run concurrently); a readiness-timeout test (a stand-in that answers 503 to `/readyz`, a 1.5 s bound); a `logs/` that cannot be created refuses, releases both locks and starts nothing; `release` removes every lock even when one `rmSync` throws (then rethrows the first failure; `up` reports it as a warning and exits 1); the `.env` reader refuses a backtick-quoted value and refuses a file with two `OPENAI_API_KEY` lines, naming the file and never a value (dotenv keeps the last, a first-match reader the first; neither guess is safe); each child's stdout and stderr pipe and its readline interface have `'error'` listeners (`followLines`), so a pipe read error is one warning line and never crashes `up`; a child that printed nothing before dying reads `… exited with code 7 before it was ready`, with no dangling colon.

### Task 9: `up` with the real apps (Docker lane)

**Files:**
- Create: `test/factory-up.integration.test.ts`

- [ ] **Step 1: Write the lane**

```ts
// test/factory-up.integration.test.ts
import { execFile, spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"

const run = promisify(execFile)
const tsxBin = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs")
const cliEntry = join(import.meta.dirname, "../src/cli.ts")
const packageRoot = join(import.meta.dirname, "..")
const KEY = "sk-not-a-real-key-for-tests"
/** A known token, so the lane can prove it never leaves the three processes' environments. */
const TOKEN = "7".repeat(64)

/** Ports the kernel hands out now; `up`'s preflight re-checks them. */
async function freePorts(n: number): Promise<number[]> {
  const ports: number[] = []
  while (ports.length < n) {
    const port = await new Promise<number>((done) => {
      const server = createServer().listen(0, "127.0.0.1", () => {
        const address = server.address()
        server.close(() => done(typeof address === "object" && address ? address.port : 0))
      })
    })
    if (port >= 1024 && !ports.includes(port)) ports.push(port)
  }
  return ports
}

let dir: string | undefined
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe("factory up with the real controller, builder and drafter", () => {
  it("serves all three on loopback, reconciles, keeps the token and key to itself, and stops on one Ctrl-C", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-up-lane-"))
    const [controller, builder, drafter] = await freePorts(3)
    const config = join(dir, "factory.config.ts")
    const state = join(dir, "state")
    writeFileSync(
      config,
      `export default ${JSON.stringify({ state, controller: { port: controller }, builder: { port: builder }, drafter: { port: drafter } })}\n`,
    )
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FACTORY_CONFIG: config,
      OPENAI_API_KEY: KEY,
      FACTORY_WORKER_TOKEN: TOKEN,
    }
    for (const name of [
      "FACTORY_STATE_DIR",
      "FACTORY_CONTROLLER_URL",
      "FACTORY_WORKER_URL",
      "FACTORY_DRAFTER_URL",
      "B4_PERMISSIONS_MODE",
    ])
      delete env[name]
    // Its own process group, as a terminal's foreground group would be. The apps are detached
    // from it, so the SIGINT below reaches tsx and up only: up stops the apps itself.
    const upProcess = spawn(process.execPath, [tsxBin, cliEntry, "up"], {
      env,
      cwd: packageRoot,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    upProcess.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    upProcess.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    const deadline = Date.now() + 180_000
    while (!output.includes("│ ready:")) {
      if (Date.now() > deadline || upProcess.exitCode !== null)
        throw new Error(`up did not become ready:\n${output}`)
      await new Promise((r) => setTimeout(r, 250))
    }
    for (const port of [controller, builder, drafter])
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200)
    // A worker answers only the token holder, and nobody printed the token or the key.
    for (const port of [builder, drafter])
      expect(
        (
          await fetch(`http://127.0.0.1:${port}/threads`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(403)
    expect(output).not.toContain(KEY)
    expect(output).not.toContain(TOKEN)
    // The lock records pids, commands, ports and the controller's settings; read it while held.
    const lockText = readFileSync(join(state, "up.lock"), "utf8")
    expect(JSON.parse(lockText).controller).toEqual({ approvalTtlMs: 900_000, maxActiveMs: 1_200_000 })
    // The CLI reads the same config: the registry the reconcile opened is there to read.
    const { stdout } = await run(process.execPath, [tsxBin, cliEntry, "list"], {
      env,
      cwd: packageRoot,
    })
    expect(JSON.parse(stdout)).toEqual([])

    const started = Date.now()
    process.kill(-(upProcess.pid as number), "SIGINT")
    const code = await new Promise<number | null>((done) => upProcess.once("exit", done))
    expect(code, output).toBe(0)
    expect(Date.now() - started).toBeLessThan(60_000)
    // Detached, each app got exactly one SIGTERM from up and closed cleanly (review C1): exit
    // code 0, never "by signal". A child killed mid-close is a finding, not a flake: read its log.
    for (const name of ["controller", "builder", "drafter"])
      expect(output, output).toContain(`${name} exited with code 0`)
    expect(output).toContain("stopped (clean)")
    // Nothing secret in what up printed, in any log, or in the lock (read before it is removed:
    // the lane records its contents from the "ready" moment below).
    for (const log of readdirSync(join(state, "logs"))) {
      const text = readFileSync(join(state, "logs", log), "utf8")
      expect(text).not.toContain(KEY)
      expect(text).not.toContain(TOKEN)
    }
    expect(lockText).not.toContain(TOKEN)
    expect(lockText).not.toContain(KEY)
    for (const port of [controller, builder, drafter])
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()
    expect(existsSync(join(state, "up.lock"))).toBe(false)
    const { stdout: ps } = await run("ps", ["-Ao", "pid=,command="])
    const survivors = ps
      .split("\n")
      .filter((line) => [controller, builder, drafter].some((p) => line.includes(`--port ${p}`)))
    expect(survivors).toEqual([])
  }, 300_000)
})
```

- [ ] **Step 2: Run the lane** (Docker, and the drafter's base image pulled)

```bash
docker pull "$(grep -oE '[a-z0-9.:/-]+@sha256:[a-f0-9]{64}' examples/software-factory/drafter/src/drafter-image.ts)"
pnpm --filter @b4-example/software-factory-controller exec vitest run --config vitest.sandbox.config.ts test/factory-up.integration.test.ts
```

Expected: PASS in about a minute plus the lane's global image setup. Record the file's own duration for the PR (Trap 19). If a child survives or exits by signal, do not widen the grace first: read `<state>/logs/<app>.log` for why. The lane takes this checkout's `.up.lock` (D12): it refuses, by design, beside a live `up` in the same checkout (Trap 21); run it with none.

- [ ] **Step 3: Once, by hand, from a fresh checkout** (no `.b4/` anywhere under the three apps), confirm `b4 start` needs no `b4 build` or typegen output: `git worktree add ../factory-fresh origin/main` (or the branch), install and build the closure there (Trap 1), then run this lane in it. The spike saw the controller serve with a `.b4/` holding only its stores; if any app in a fresh checkout refuses to start without a build, add that build (or a refusal naming it) to `preflight` and to the README's quickstart before merging. Remove the worktree with `git worktree remove` afterwards.

- [ ] **Step 3: Commit**

```bash
pnpm --filter @b4-example/software-factory-controller exec biome check --write test/factory-up.integration.test.ts
git add examples/software-factory/controller/test/factory-up.integration.test.ts
git commit -m "test(software-factory): factory up with the real apps, stopped by one Ctrl-C"
```

### Task 10: `pnpm factory` from the example, and its state directory

**Files:**
- Create: `examples/software-factory/package.json`, `examples/software-factory/.gitignore`

- [ ] **Step 1: Write them**

```json
{
  "name": "@b4-example/software-factory",
  "private": true,
  "version": "0.0.0",
  "scripts": {
    "factory": "pnpm --silent --filter @b4-example/software-factory-controller factory"
  }
}
```

(`--silent`, D18: no `> … factory` banner ahead of the JSON on stdout, no `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` block on a non-zero exit, and the exit code, 3 included, reaches the shell.)

```gitignore
# factory up's state directory (factory.config.ts): the registry, images, evidence, exports and logs.
.factory/
# factory up's checkout lock (one up per checkout: the apps' own stores live in their app roots),
# and its takeover mutex and temporary siblings.
.up.lock*
# A second checkout's own ports: copy factory.config.ts here and point FACTORY_CONFIG at it.
factory.config.local.ts
```

- [ ] **Step 2: Verify the spelling works and changes nothing else**

```bash
cd examples/software-factory && pnpm factory --help | head -3 && (FACTORY_CONFIG=none FACTORY_STATE_DIR=/nonexistent pnpm factory show wo-none; echo "exit $?") && cd ../..
pnpm -r list --depth -1 | grep -c software-factory   # still 3: the new package.json is not a workspace member
git check-ignore -v examples/software-factory/.factory/registry.sqlite
pnpm install --frozen-lockfile                       # the lockfile does not move
```

Expected: the usage's first lines; then only the CLI's own error line and `exit 1` (no pnpm banner, no `ERR_PNPM_…` block); `3`; the new rule named; install clean.

- [ ] **Step 3: Commit**

```bash
git add examples/software-factory/package.json examples/software-factory/.gitignore
git commit -m "chore(software-factory): pnpm factory from the example, with its state ignored"
```

### Task 11: Docs: the quickstart and the spec's as-landed note

**Files:**
- Modify: `examples/software-factory/README.md`, `docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md`

- [ ] **Step 1: README.** Add a `## Quickstart` section before `## Run it`, and rename `## Run it` to `## Run it by hand` with one sentence saying `up` does steps 1-3 and the CLI reads the config (so step 4's exports and alias are optional). The quickstart, in the README's voice:

```
## Quickstart

From `examples/software-factory`, with Docker running, the drafter's base image pulled
(`docker pull <the reference in drafter/src/drafter-image.ts>`) and the workspace built
(`pnpm turbo run build --filter=@b4-example/software-factory-controller^... --filter=@b4-example/software-factory-server^... --filter=@b4-example/software-factory-drafter^...`):

    FACTORY_MAX_ACTIVE_MS=18000000 FACTORY_APPROVAL_TTL_MS=86400000 pnpm factory up   # terminal 1
    pnpm factory run --issue 714 --pin 765e6e16fec86bba0859d3f85edf7136f663f720   # terminal 2
```

Then explain, in prose: `up` reads `factory.config.ts` (the three ports and the state directory, validated strictly; `examples/software-factory/.factory` by default, ignored); refuses to start beside another `up`, on a port in use, without Docker, without the drafter's base image, with `B4_PERMISSIONS_MODE` set, or with an exported `FACTORY_*` URL or state that disagrees with the config; generates the worker token for each start (or uses `FACTORY_WORKER_TOKEN`) and gives it only to the three processes; takes `OPENAI_API_KEY` from the environment or from that one line of the repository's `.env` and gives it to the builder and drafter only; starts each app with `b4 start` on 127.0.0.1 (no file watching: restart `up` after editing an app); waits for `/readyz` on all three, reconciles, and prefixes and tees each process's output to `<state>/logs/`; stops the controller first on `SIGTERM`, and everything on Ctrl-C, killing whatever has not stopped after 20 s. `run` creates or resumes the issue's work order (one live work order per issue, or per issue and pin with `--pin`; `--new` starts another; `run <id>` works on one), runs intake, and **stops at the draft**: it shows exactly what `factory review` shows and, at a terminal, asks for the task digest's first eight hex digits; then it dispatches, follows the builder's turn and the verification, and **stops at the bundle** the same way; after the person's prefix it follows the approval's re-verification to the export. It never approves on its own: without a terminal, or on no or a wrong answer, it exits 3 and prints the commands a person runs (`pnpm factory review <id>`, then `pnpm factory run <id>`). It stops at a block with the next commands and never retries or cancels. Exit codes: 0 exported, 3 waiting on a person, 130 interrupted (the controller keeps working; `run` again resumes), 1 anything else. Why `FACTORY_MAX_ACTIVE_MS=18000000`: the `cli` target (the one #714 is drafted onto) verifies for up to an hour, and `review` warns at the draft when the budget is too small. Why `FACTORY_APPROVAL_TTL_MS=86400000`: a frozen bundle expires 15 minutes after it parks by default and cannot be re-frozen, so a person who steps away loses a verified candidate; the export gate prints when the bundle parked and when it expires, and `run` stops at an expired one with the deny and cancel commands instead of asking.

Also say: the key's `.env` is this checkout's, else the main worktree's (a linked worktree has none), never the target repository's; the apps' own stores live in their app roots, so one `up` per checkout (a lock enforces it), and a second checkout on the same host copies `factory.config.ts` to the ignored `factory.config.local.ts` with other ports and sets `FACTORY_CONFIG` to it; stopping `up` while a turn runs cuts the turn short, and the next `up`'s reconcile treats it as ended (a partial draft or candidate usually spends an attempt), so the stop line lists what is in flight and the time to stop is between gates; `--allow-missing-evidence` applies to both gates of a `run`; a pinless `run --issue <n>` also matches an exported replay of that issue at a pin (it answers "already exported"; `--new` starts a live run); the prompt appears only at a real terminal (stdin and stderr both TTYs), and `FACTORY_CLI_INTERACTIVE` is a test seam that works only under vitest.

Update the Environment section: add `FACTORY_CONFIG` (the CLI's config file; `none` reads none) to the CLI paragraph (`:702-712`), and say that `FACTORY_CONTROLLER_URL` and `FACTORY_STATE_DIR` default from the config.

- [ ] **Step 2: Spec.** Append an as-landed note to §7, in the style of items 4-6:

```
**As landed** ([plan](../plans/2026-09-28-factory-up-and-run.md)). Three processes, not two:
the builder and the drafter are still separate apps (item 1's fold was not done, and is not
glue), so `factory.config.ts` names `state` and three ports (`controller`, `builder`,
`drafter`), all on 127.0.0.1, validated strictly (the sketch's `worker` and `token` keys are
refused by name). The spelling is `pnpm factory …` from `examples/software-factory` (an
orchestration-only `package.json`; the root has no `factory` script). `up` generates the
worker token per start (or takes `FACTORY_WORKER_TOKEN`) and gives the model key to the two
workers only; it runs `b4 start`, not `b4 dev`, so §9 findings 4 and 21 do not arise under it;
it takes a lock on the state directory, waits for `/readyz` on all three and then calls the
reconcile route, so the last table row is removed for a controller `up` manages (the app still
has no boot hook). It does not restart a process that exits (finding 8's supervisor, in part).
`run` resumes by the issue (and pin), stops at each person's gate with `review`'s own display
and typed prefix (exit 3 without a terminal; it takes no approval flag), follows long steps
through the journal and a 409 `run_in_flight` alike, and stops at blocks. `review` now warns
at a draft when dispatch would refuse the work order's budget: #714's quickstart needs
`FACTORY_MAX_ACTIVE_MS=18000000`, and `FACTORY_APPROVAL_TTL_MS=86400000` so a bundle does not
expire while its person is away. The apps are detached and stopped by `up` alone, one
`SIGTERM` each (`b4 start` dies by default action on a second signal mid-close). Proof: `factory-config.test.ts`, `run-steps.test.ts`, the
`run` cases in `cli.test.ts`, `factory-up.test.ts` against stand-in apps, and
`factory-up.integration.test.ts` with the real three (<wall clock>). Live: <Task 12's result>.
```

- [ ] **Step 3: Check and commit**

```bash
node scripts/check-docs.mjs
git add examples/software-factory/README.md docs/superpowers/specs/2026-09-23-software-factory-framework-gaps-design.md
git commit -m "docs(software-factory): the up/run quickstart, and spec §7 as landed"
```

- [ ] **Step 4: The package's whole gate, then the repository's**

```bash
pnpm --filter @b4-example/software-factory-controller lint
pnpm --filter @b4-example/software-factory-controller typecheck
pnpm --filter @b4-example/software-factory-controller test
pnpm --filter @b4-example/software-factory-controller test:sandbox
pnpm lint && pnpm typecheck
```

Expected: all green. Do not pipe a gate through `tail` (it hides the exit code).

### Task 12: The live replay of #714 through `up` and `run` (by hand, before merge)

Not a CI lane. Brian decides at both gates (Trap 4).

- [ ] **Step 1: Start the factory** (terminal A, from `examples/software-factory`; the key is read from the repository's `.env` by `up`, never printed)

```bash
source ~/.nvm/nvm.sh && nvm use 24
FACTORY_MAX_ACTIVE_MS=18000000 FACTORY_APPROVAL_TTL_MS=86400000 pnpm factory up
```

Expected: the three `listening` lines, `worker token: generated for this start`, `OPENAI_API_KEY: from /Users/blove/repos/dawn/.env (builder and drafter only)` (the main worktree's, from a linked worktree), then `ready … (reconciled)`. No other `up` may be live in this checkout (D12).

- [ ] **Step 2: Run the issue** (terminal B, Brian at a real terminal)

```bash
pnpm factory run --issue 714 --pin 765e6e16fec86bba0859d3f85edf7136f663f720
```

At the draft, Brian reads the display and types the prefix (or rejects with `pnpm factory review <id> --reject --note "…"` and runs `pnpm factory run <id>` again). An agent driving this step runs it without a terminal: `run` exits 3 at the draft; the agent shows Brian the draft, the digest and the oracle proof, and waits; Brian runs `pnpm factory review <id>` himself; the agent then runs `pnpm factory run <id>`. The same at the bundle.

- [ ] **Step 3: Interrupt and resume once**, during the builder's turn or the verification: Ctrl-C in terminal B (expect exit 130 and the resume line), then `pnpm factory run --issue 714 --pin 765e6e16…` again (expect `resuming <id>` and no second work order in `pnpm factory list`).

- [ ] **Step 4: Stop the factory** with one Ctrl-C in terminal A, between gates (D11); expect the stop line to list no work order in flight, `controller exited with code 0` before both workers' `exited with code 0`, `stopped (clean)` within about 20 s, and `ps -Ao pid,command | grep -E 'b4.js start'` to show nothing of this checkout's. This is the check that one Ctrl-C through `pnpm → pnpm → tsx → up` lets `up` finish its ordered stop (Trap 8). Once, also start `pnpm factory up | head -5`, wait for `ready` in `<state>/logs/controller.log`, and confirm `up` keeps supervising after `head` exits (Trap 24) and stops cleanly on a Ctrl-C.

- [ ] **Step 5: Record** in the spec's §7 as-landed note and the PR: the work order id, each phase's wall clock, the gate decisions, whether the candidate passes the reference test (b090ad42's `runs-wait-output.test.ts`, as sub-project 4 graded it), and every operator step that needed knowledge the quickstart does not give.

---

## Proof map

| Proof | Where |
|---|---|
| `run` never approves without a person's typed prefix (the hard requirement) | Task 5 (no approval step; every state mapped); Task 6 ("stops at the draft for a person": exit 3, no `intake_approved`, no digest in the printed next commands (the JSON row carries it, as `show` does); a wrong prefix sends nothing), Task 4 (the prompt needs stdin and stderr TTYs; the seam only under vitest, D25), ("refuses every way of approving by argument": `--approve`, `--digest`, `--reject`, `--note`, `--revision`, `--bundle` by name, `--yes`/`--auto-approve` unknown, nothing created), Step 5 (the only call into approval is `reviewOutcome` with no digest and no approval flag) |
| At each gate `run` prints what `factory review` prints | Task 6 (the same sections and the same digest line as a `review` of the same row) |
| The typed prefix does approve, and the export follows to `exported` | Task 6 ("takes a catalog task to its bundle, and exports only on the person's typed prefix") |
| Resuming: same work order, no second create, no re-dispatch; Ctrl-C leaves the work going | Task 5 (`chooseWorkOrder`); Task 6 (the second `run` "resuming"; the interrupted run: exit 130, one `dispatch_committed`) |
| Done is done; `--new` starts another | Task 6 |
| Blocks stop `run` with the right next commands | Task 5 |
| `review` warns when dispatch would refuse the budget | Task 4 |
| Config: strict, near-misses refused, spec keys named, distinct ports, state outside app roots, committed file valid | Task 1 |
| CLI reads the config; environment wins with a warning; `none`; a named missing file refuses | Task 2; Task 3 |
| `up`: token generated or checked; key from env or its one `.env` line; key only to workers; token shared; URLs and state to the controller; `HOST`/`PORT` stripped; loopback bind | Task 7 (unit); Task 8 (stand-ins report what they received); Task 9 (real apps: 403 without the token, nothing secret printed) |
| `up` refuses before starting anything: conflicting environment, `B4_PERMISSIONS_MODE`, no key, port in use, no Docker, no drafter image, a second `up`, a stale lock with live children | Task 7; Task 8 ("starts nothing when the preflight refuses") |
| Readiness, then one reconcile; a failed reconcile stops everything | Task 8; Task 9 (the registry the reconcile opened is readable by `list`) |
| Logs prefixed and teed | Task 8 |
| Shutdown: ordered on `SIGTERM`, one Ctrl-C stops all, `SIGKILL` after the grace, nothing survives, lock removed | Task 8; Task 9 (real apps, process-group `SIGINT`, `ps` shows no survivor) |
| The controller app never imports the operator's tooling | Task 7 (`operator-boundary.test.ts`); `no-worker-filesystem.test.ts` unchanged |
| Children detached; each gets one `SIGTERM` from `up`, the controller first; every child exits with code 0 on a clean stop, and a killed one is not called clean (review C1) | Task 8 ("starts all three …": process groups, exit lines, order, `stopped (clean)`; "kills a child that ignores SIGTERM …": exit 1, `by signal SIGKILL`); Task 9 (real apps: `exited with code 0` for all three after one process-group `SIGINT`); Task 12 Step 4 (through `pnpm`) |
| A reconcile that never answers does not hold `up` past a stop (review I4) | Task 8 ("abandons a reconcile …") |
| One `up` per state directory and per checkout; a stale lock taken over by rename; a reused pid is not a holder; the controller's settings recorded (review minor) | Task 7 ("the locks") |
| No test reads the committed config or writes the live state directory (D23) | Task 3 (both vitest configs; `git status` after the CLI tests) |
| An expired bundle is never prompted for; the gate says when it parked and expires (D24) | Task 5 ("never prompts for an expired bundle"); Task 6 ("run stops at an expired bundle …": one prompt, exit 1, deny and cancel commands) |
| The interactive seam only under vitest, announced; no prompt without TTYs (D25) | Task 4 ("honours the interactive test seam only under vitest …") |
| The key's `.env`: this checkout's, else the main worktree's, never `FACTORY_REPO_ROOT` (D6) | Task 7 ("the model key") |
| The token and key never reach output, logs or the lock (review minor) | Task 8 (printed lines); Task 9 (a known token and key, scanned in output, every log and the lock) |
| `pnpm factory` prints clean JSON and passes the exit code through (D18) | Task 10 Step 2 |
| A closed stdout does not orphan the children (Trap 24) | Task 12 Step 4 (by hand: `up \| head`) |
| `b4 start` needs no build output (review minor) | Today, row 6 (spike); Task 9 Step 3 (a fresh checkout, by hand) |
| The quickstart works as typed | Task 12 |

## Follow-ups recorded, not in this plan

- **Fold the drafter into the builder app** (spec §7 "one worker app", D3): a thread resolver that serves both handoffs, the drafter's allow-list and resources as per-thread records; a trust review of one process holding both.
- **A restarting supervisor** (spec §9 finding 8): restart a crashed worker after the framework marks orphaned `busy` threads idle at startup (finding 7), and a crashed controller followed by a reconcile.
- **Sweep orphaned sandbox containers at worker startup** (finding 17). `up` removes nothing from the Docker daemon.
- **Per-work-order budgets from the target** (finding 5): a `maxActiveMs` in `create`'s input that `run` sizes from the drafted target would replace D20's warning and the quickstart's variable; today the budget is fixed at create, before intake knows the target.
- **Drain on stop**: `up` could wait for in-flight dispatches before stopping the controller; today they are aborted and reconciled at the next `up`.
- **Remote workers**: a config `url` for a worker `up` does not start (the spec's original shape), once someone runs one elsewhere.
- **`run --retry`**, if people find themselves always retrying: the decision stays explicit.
- **Run-time files in an app root through other variables**: the config refuses a state directory inside any app root (compared by device and inode, so symlinks and case variants are caught), but `FACTORY_ARTIFACTS_DIR` and `FACTORY_EXPORT_DIR` are read from the environment unchecked and can still place run-time files in an app root (spec §9 finding 4). Give them the same check where they are read.
- **Framework**: `b4 dev`'s hard-coded watch ignore list (findings 4, 21) still bites the manual runbook.

## Self-review

- **Spec coverage.** §7's quickstart: the config file (Task 1, as corrected by D2, D3), `pnpm factory up` (Tasks 7-10, D18), `pnpm factory run --issue 714 [--pin <sha>]` (Tasks 5-6); the table's last two rows: "four terminals, export of URL and state dir, an alias" (D17, D18, Task 3, Task 10), "`factory reconcile` after a controller restart" (D9, Task 8). §8 item 7 is this plan. The findings `up` touches (4, 8, 21) are addressed or recorded (Spec corrections 9, 10; Follow-ups).
- **The hard requirement** is in D13, Trap 4, Task 4's seam guard, Task 5's type, Task 6's tests and source pin, and Task 12's procedure. `run` has no approval flag; the one path to an approval is `review`'s prompt, which needs stdin and stderr at a terminal (or the vitest-only seam, D25) and a typed prefix of the digest it displayed; the printed next commands leave the digest for the person to read off the display (the JSON row carries it, as `show` always has).
- **Placeholder scan.** Every code step carries its code and every run step its command and expected result. Two slots are for numbers only a run produces (the lane's wall clock, Task 12's result), named where they go. Two instructions ask the implementer to check a name against the code before running (the dispatch transition's journal name in Task 6; the `rootDir` fallback in Task 1).
- **Type consistency.** `ResolvedFactoryConfig` (Task 1) is what `applyConfigDefaults`, `ownedVariableConflicts` (Task 2), `appProcesses`, `preflight`, `acquireLock` and `up` (Tasks 7-8) take. `RunStep` and `chooseWorkOrder` (Task 5) are what `runCommand` (Task 6) switches on. `ReviewResult` (Task 4) is what `runCommand`'s gate reads. `UpDeps.launch` is the seam the unit tests and `b4Start` share.
- **YAGNI.** No framework change; no new dependency (zod, `diff` and tsx are already the controller's); no restart logic; no remote workers; no colour or rotation in the logs.

## Review amendments (2026-09-28)

| # | Finding | Where addressed |
|---|---|---|
| C1 | Children in `up`'s process group get the terminal's `SIGINT`; `b4 start`'s `process.once` handlers are removed by `close()` (`serve-runtime.ts:116-137`), so `up`'s follow-up `SIGTERM` killed them by default action mid-close | D11 reversed: `detached: true`, one `SIGTERM` per child from `up` (controller first), `SIGKILL` to the group after the grace, `SIGHUP` handled, each child's exit logged by code or signal, clean only when all exit 0; Trap 8 rewritten; Task 8 Step 3 (`start`, `stopOne`, `killGroup`, `stopAll`) and Step 4 (signals); Task 8 tests (process groups, exit lines, order, killed ≠ clean); Task 9 asserts `exited with code 0` for all three; D12's orphan check kept for a `SIGKILL`ed `up`; Today row 6 notes the spike sent `SIGTERM` only |
| I1 | The committed config would reach CLI tests that spawn without `FACTORY_STATE_DIR` (`builder-handoff`) and write into the live `.factory` | D23; Task 3 Step 1 (`test.env` in both vitest configs) and Step 4 (`git status` check); Trap 22; File structure |
| I2 | `afterEach` `rmSync(dir)` with `dir` undefined | Task 7 test preamble (`if (dir)`; `fresh()` assigns a local root) |
| I3 | The bundle expires after `FACTORY_APPROVAL_TTL_MS` (15 min, `factory.ts:1525-1528`) with no re-freeze | D24; D22 and the quickstart set `FACTORY_APPROVAL_TTL_MS=86400000`; `up` records the controller's settings in its lock (Task 7 `acquireLock`, Task 8 `controllerSettings`); Task 5 `bundleExpired` and the `stop` step, with tests; Task 6 export-gate line, the expired-refusal path and its test; Trap 23; Task 11 README and spec note |
| I4 | Boot reconcile could hang `up` past a stop | Task 8 Step 3 (`AbortSignal.any([timeout(120 s), stop])`, raced with the stop) and the "abandons a reconcile …" test |
| I5 | `.env` from `FACTORY_REPO_ROOT` is wrong and a linked worktree has none | D6 amended; Task 7 `openaiKeyFor` over `dotenvCandidates()` (this checkout's toplevel, then the main worktree via `--git-common-dir`), with tests; Task 11 README; Task 12 expected line |
| I6 | The orchestration script needs `--silent` for clean JSON and exit codes | D18, D16; Task 10 (script and an exit-code check) |
| I7 | Gate hardening: seam only under a test marker, loud; prompt needs stderr TTY too; don't claim no digest is printed | D25; D13 amended (stdin and stderr TTYs; the *next commands* are digest-free, the JSON row carries the digest); Task 4 (`interactive()` and its test); Task 6 test comment; Proof map; Self-review |
| m1 | Lock takeover raced (remove-then-create) and pids can be reused | D12; Task 7 `acquireOne` (rename aside, compare, restore if not the stale record; `holds` checks `ps -ww … -o command=`), with tests |
| m2 | Apps' runtime stores live in their app roots | D12 (a checkout lock: one `up` per checkout); Trap 21; Task 9 Step 2 note; Task 11 README |
| m3 | Stopping `up` mid-turn spends an attempt at the next reconcile | D11; the stop line lists active work orders (Task 8 `activeWorkOrders`); Task 11 README; Task 12 Step 4 (stop between gates) |
| m4 | Preflight checked the committed `bin/b4.js`, not the build | Task 7 preflight checks `node_modules/@b4run/cli/dist/index.js`; Trap 25 |
| m5 | `b4 start` in a fresh checkout without `.b4/` | Today row 6 (the controller served with a `.b4/` of stores only; `b4 start` reads source); Task 9 Step 3 (a fresh worktree, by hand; add a build to preflight if one is needed) |
| m6 | Secrets: assert a known token absent from output, logs and lock; scan logs for the key | Task 9 (known `FACTORY_WORKER_TOKEN`, scans of output, every log and the lock) |
| m7 | D20's remedy wording | D20 and `intakeBudgetWarning`: "restart `pnpm factory up` with `FACTORY_MAX_ACTIVE_MS=…` … run it again with `--new`" |
| m8 | Pinless runs vs an old exported replay | D14; Task 11 README |
| m9 | Ports for several worktrees | D18 (`factory.config.local.ts`, ignored, via `FACTORY_CONFIG`); Task 10 `.gitignore`; Task 11 README |
| m10 | `--allow-missing-evidence` applies to both gates | D13; Task 11 README |
| m11 | `up \| head` must not orphan children | D11; Trap 24; Task 8 Step 4 (`EPIPE` switches output off, supervision continues); Task 12 Step 4 by hand |

**Where I applied a finding differently.** None disagreed with. Two notes on scope: the `EPIPE` path is proved by hand (Task 12 Step 4) rather than by a unit test, because it lives in the CLI's wiring of `process.stdout`, which the in-process `up` tests do not use and a spawned test would need to close its read end at a precise moment; and the fresh-checkout check (m5) is a by-hand step, since CI's `sandbox-docker` job builds both workers before `test:sandbox` and so cannot show it. The approval window reaches `run` through `up`'s lock rather than a new controller endpoint: example-only, and a controller started by hand still gets the safe behaviour (the expiry learned from the refusal, no second prompt).


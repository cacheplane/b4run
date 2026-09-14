# Runnable code-fixer blueprint

Date: 2026-09-13
Status: independent review approved; user approved 2026-09-13

## Purpose and approved direction

Build a real B4 agent application that repairs failing tests in a controlled
repository. It is both a usable developer blueprint and the source of evidence
for the future homepage. The central takeaway is: **this clean, organized,
readable code runs this agent**. The brand lead remains “Ridiculous speed.
Readable code.” Speed means developer building speed, not a promised model
latency or measured productivity improvement.

The user approved a code-fixing story, a runnable example in this monorepo,
controlled fixtures derived from actual defects, subsequent dogfooding on real
B4 issues, and two initial tasks for evaluation. Homepage visitors should see
the result immediately and inspect how the application produced it.

This spec covers the blueprint, fixtures, evaluation, and evidence format.
Homepage implementation, a new web client, remote repository creation,
automated PR publication, and a standalone published blueprint are separate
follow-ups. No changes to framework behavior are assumed; a missing public
capability must be surfaced before expanding this plan.

## Source evidence

- [CLI parsing regression, PR #399](https://github.com/cacheplane/b4run/pull/399):
  subcommand flags were rejected by the outer parser before reaching the memory
  handler. Existing handler tests missed the public parsing boundary. Use only
  this defect, not the unrelated scaffold assertion repair in the same PR.
- [Nullable tool schemas, PR #573](https://github.com/cacheplane/b4run/pull/573):
  explicit null alternatives were lost during schema generation and unsupported
  in runtime conversion. Required and optional fields must remain distinct.
- Existing implementation patterns:
  `examples/research/server/b4.config.ts`,
  `examples/research/server/src/app/research/index.ts`,
  `examples/research/server/test/sandbox-docker.test.ts`, and
  `examples/research/server/src/app/research/evals/research-quality.eval.ts`.
  These demonstrate real public APIs for a route, planning, tools, sandboxing,
  memory, subagents, offline fixtures, and evals.

The historical issues have been repaired. The blueprint deliberately recreates
them in bounded fixtures; it does not claim to discover or repair a current bug.

## Application structure

Use `examples/code-fixer/server` as the private workspace package, consistent
with the existing `examples/*/*` workspace glob. Keep one agent implementation
for both tasks. Target selection supplies a repository snapshot, task, and
verification command; it must not choose issue-specific agent instructions or
hardcoded patches.

The package contains:

- A `/fix` agent route with concise instructions and a seeded `plan.md`.
- Workspace file tools and sandbox command execution through existing B4 APIs.
- A reusable testing skill: reproduce the failure, inspect relevant source,
  repair the behavior, and run verification without weakening tests.
- A config file with the sandbox provider, tool permissions, and resource limits.
- Task manifests and fixture preparation, invocation, and evidence-export scripts.
- Offline tests, Docker integration tests, and live evaluations.
- A README with prerequisites, exact runnable commands, application file tour,
  and the distinction between the agent application and the target project.

Start with the SDK's documented `gpt-5-mini` convention and permit a documented
model override. Pin tested dependency versions in the lockfile. The final plan
must derive executable run commands from the repository's existing interfaces;
the schematic mockup is not an API specification.

The command-line path must be sufficient to run and inspect the blueprint.
Do not require a new browser client to use it. Existing supported clients may
be documented as optional inspection surfaces.

## Fixture contract

Ship both fixtures with the example first so local execution does not depend on
creating or cloning a new public repository. A future Cacheplane fixture repo
can distribute the same versioned material without becoming a second authority.

Each fixture has a manifest recording its identifier, source PR and exact source
commit, extraction changes, dependency lock, permitted source paths, immutable
tests and configuration, setup procedure, failing command, and success checks.
Retain applicable source license and provenance. Generate a fresh Git repository
with a recorded starting commit from the faulty snapshot for each attempt.
Exclude the historical fix and solution commits from the agent workspace.

Fixtures should preserve the actual defective logic and relevant library
boundary. A miniature mock that replaces the CLI parser or schema converter
would not substantiate the intended story. Extraction may remove unrelated
release, app, or framework setup, but must document every such reduction.

### CLI flags

Reproduce an outer Commander registration rejecting a supported nested flag.
Visible tests and the run command must exercise the actual CLI entry point, not
call only the command handler. Preserve a representative documented dry-run
command and at least one value-taking flag. Verification checks argument
forwarding, supported flag behavior, and rejection of invalid options at the
appropriate parser/handler boundary. Do not require real memory storage or a
model call inside the target CLI just to exercise parsing.

### Nullable tool inputs

Reproduce nullable TypeScript input becoming an incorrect generated schema and
runtime validator. Preserve the schema and conversion stages and actual
validation library. Verification includes string and null acceptance, required
versus optional fields, nested nullable inputs, and rejection of unrelated
values. Use public entry points of the extracted pipeline and retain tests for
existing non-nullable behavior. No provider call is needed inside the fixture.

### Fixture qualification before agent work

For each extracted fixture, prove the original snapshot fails for the intended
reason and the historical repair passes the visible and independent checks.
Measure setup and test runtime; do not promise a time budget before measuring.
If preserving a real boundary makes extraction impractical, revisit fixture
scope explicitly rather than substituting an unrelated toy bug.

## Workspace and execution boundary

Docker is the default for live fixture execution. Prepare the image and locked
dependencies before the attempt. The target test process needs no network,
repository credentials, or provider key. Provider calls belong to the B4 host;
the key must not enter the target workspace, image, logs, or captured evidence.

Each attempt gets a fresh sandbox and target Git baseline. Do not mount the
contributor checkout or Docker socket into the target. The workspace tool view
and command working directory must refer to the same target files. Assert this
with integration coverage, including separation between attempts.

Apply explicit execution, resource, and agent-step limits. A timeout is an
incomplete attempt, not a successful result. Export artifacts before teardown
when possible and record failures if preservation fails. Teardown runs for
success, failure, cancellation, and approval denial.

The core run reads, edits, verifies, and exports a patch/report. It does not push
a branch or publish a PR. Demonstrate human approval with a separate tool that
promotes a prepared patch into a local review outbox. This makes the approval
boundary real and testable without pretending a remote publication happened.
Name the action “Export for review,” not “Publish.” In unattended evals, stop at
the approval request and grade the prepared patch without granting that action.
Record this intentional stop as `approval-pending`, separately from timeouts
and incomplete attempts; task correctness can still pass independent checks.

## Evaluation contract

### Independent verification

An evaluator outside the agent workspace owns the authoritative baseline,
manifest, and additional checks. After the attempt, collect the patch and apply
only permitted source changes to a fresh verifier copy with original tests and
configuration. Reject attempts to alter tests, task manifests, dependency locks,
evaluation code, or files outside the allowed scope. Do not run verification in
the agent-mutated workspace and mistake its output for independent evidence.

The verifier runs inside its own constrained execution environment, since the
submitted source is executable. Additional tests are withheld from the agent's
workspace during the run, not claimed to be secret from readers of the public
blueprint. The reference repair is never supplied to the agent.

Score outcomes rather than similarity to the reference diff. Correct alternate
repairs may pass. Hard criteria are:

1. The issue's independent behavior checks pass.
2. Existing baseline checks still pass.
3. The patch changes only permitted source files and leaves tests intact.
4. The agent's tool trace shows an actual reproduction and verification attempt.
5. No review-outbox action executes without approval.

Record each criterion separately and require all for task success. A missing
receipt, infrastructure error, timeout, and behavior failure must have distinct
statuses; retain them in the attempt accounting rather than silently dropping
unsuccessful attempts.

### Three execution paths

- Offline regression tests use scripted model responses to exercise tool wiring,
  control flow, and scoring without a provider key. They do not prove the model
  can solve the task.
- Docker integration tests exercise real workspace reads/writes, target test
  commands, independent verification, approval allow/deny, and cleanup.
- Live evals run the same agent against both tasks with real model responses,
  from fresh workspaces. Use three attempts per fixture for initial evidence,
  with model/config recorded and explicit per-attempt time, step, and token
  budgets in the implementation plan. Compare configurations only on the same
  fixture versions. Report all attempts, not just the best run.

Capture total duration and phase durations, model-reported token usage when
available, commands/results, tool trace, patch, final report, verification
results, approval state, and environment identifiers. Unavailable token/cost
data stays unavailable; do not invent cost or speed claims. Two fixtures are a
small regression set, not evidence of general coding competence.

Reuse `@b4run/testing` and `@b4run/evals` where their public contracts fit. Keep
fixture provisioning and independent patch verification as explicit example
utilities; do not add a new framework or evaluation service for this blueprint.

## Capability expansion

The initial complete story demonstrates agent instructions, planning, a testing
skill, tools, workspace access, sandbox execution, verification, and approval.
Default thread persistence may be documented to its actual supported boundary.

After this baseline is evaluated, extend the same application with an optional
review subagent, explicit memory, and a restart/resume demonstration. Keep these
as subsequent increments, not mandatory scaffolding for the smallest example.
Cross-task memory starts empty in baseline evals to prevent solution leakage.
Adding capabilities must produce runnable code and new evidence before they
appear as working homepage interactions.

## Homepage evidence handoff

Export a versioned evidence bundle containing the exact agent application
revision, fixture revision, model/config, real run events, source file snapshots,
target patch, verification receipts, and a mapping from activity to the actual
application file that enables it. Exclude keys, credentials, and machine-private
paths. Show the target project separately from the B4 application source.

The initial mockup used schematic config and illustrative output. Replace those
with code and results from a successful live run. Label playback “Recorded run”;
preserve real timing in the evidence and disclose edited/condensed playback.
Instant homepage playback is not a claim of instant agent execution.

The later homepage can open at the verified result, let visitors inspect the
steps, and offer “Run this agent” with matching versioned instructions. Do not
implement the homepage or marketing recording pipeline in this increment.

## Validation and delivery

The implementation plan must include fixture red/green qualification, offline
tests, real Docker integration, a published-package consumer check independent
of workspace linking, and the initial six live attempts. An unavailable provider
or Docker environment is reported as incomplete verification, not replaced by
scripted success. Exact commands and measured receipts belong in the README
and implementation completion record.

Run the repository's required validation lanes for the implementation and any
applicable changeset checks. For this design-only increment, verify links and
whitespace and obtain independent spec review followed by user review.

Once the baseline works, use the same agent on a separately selected real B4
maintenance issue in an isolated checkout. That follow-up gets an appropriate
monorepo execution budget and ordinary human code review; it is not a condition
for claiming the controlled fixtures work, nor authority to modify unrelated
issues automatically.

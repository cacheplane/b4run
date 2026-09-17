# b4.run Software Factory
## Research-backed design proposal · RFC 001 · Draft 0.1

**Prepared for:** Brian Love / Cacheplane  
**Research date:** September 16, 2026  
**Status:** Proposed architecture; not implemented or benchmarked in this session  
**Repository inspected:** `cacheplane/b4run`  
**Source snapshot:** `8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba`

> Turn an approved engineering intent into an independently verified, reviewable change—using readable TypeScript, bounded agents, and explicit delivery policy.

## Executive decision

Build a new **`examples/software-factory/`** application on b4.run. Combine the research example's discovery, context, and workbench with the code-fixer example's captured workspaces, candidate inspection, independent verification, and exact-candidate approval. Add an application-owned work-order lifecycle and evidence registry. Do not turn the research coordinator's system prompt into the authority for shipping software.

The central separation is:

**Agents propose and implement. Verification produces evidence. Application policy authorizes progression. Humans initially authorize scope and delivery.**

Use LangGraph through b4.run for orchestration rather than introducing another workflow engine. Keep factory-specific concepts in ordinary application code until repeated use demonstrates a useful framework primitive. The first milestone should repair one bounded TypeScript defect and export the exact approved patch locally. A later milestone can open a draft pull request. Merge, release, and production deployment remain separate capabilities with separate authorization.

This is a proposal for a dependable development system, not a claim that the present examples are already a production software factory.

---

## 1. What we are building

For this project, a **software factory** is a repeatable system that accepts engineering work, establishes a testable contract, performs bounded implementation, independently checks the result, and delivers an evidence-backed candidate through a controlled release boundary.

Its output is not merely code or a convincing transcript. It is a **change package** containing the exact patch, its source baseline, approved requirements, verification results, remaining risks, and the authority to perform a particular delivery action.

### 1.1 Initial product hypothesis

A b4-native factory can reduce the human coordination and review effort required for well-scoped changes without making the codebase harder to understand or weakening correctness and authorization controls.

This decomposes into three testable hypotheses:

| Hypothesis | What would support it | What would contradict it |
|---|---|---|
| Explicit orchestration improves dependability. | More trials reach a valid review state; fewer missing approvals, abandoned verification steps, and duplicate actions. | The extra lifecycle adds overhead without improving end-to-end outcomes. |
| Independent evidence improves acceptance quality. | The factory rejects superficially passing but incorrect repairs and improves held-out correctness. | The verifier mostly agrees with weak visible tests or admits bypasses. |
| Reusing b4 improves developer ergonomics. | The factory remains a small, understandable application using public b4 surfaces. | Most implementation requires framework internals, duplicate runtimes, or hidden infrastructure. |

### 1.2 Starting assumptions

Start with one trusted operator or small authenticated team, one allowlisted TypeScript/Node repository, durable storage on one host, and one implementation writer at a time. Begin with bug fixes and narrowly scoped features that have concrete observable behavior. Treat source code, issue text, retrieved pages, dependency scripts, and model output as untrusted inputs even when the operator is trusted.

The eventual system may build greenfield applications and coordinate larger changes. Those are expansion paths, not prerequisites for testing the core hypothesis.

### 1.3 Non-goals for the initial version

Do not initially build a general project-management platform, an autonomous product manager, an unrestricted coding swarm, a new model SDK, a replacement for LangGraph, a new workflow DSL, a knowledge graph, or behavioral clones of every external service. Do not automatically merge, publish packages, migrate production data, or deploy to production.

Human code review is allowed. Eliminating human involvement is not a success metric; eliminating avoidable human effort while preserving outcomes is.

---

## 2. What already exists in b4.run

The inspected repository contains both `examples/research` and `examples/code-fixer`. The latter materially changes the recommendation: research is a useful source of interaction and discovery patterns, but code-fixer is closer to the factory's execution kernel. [R1] [R2] [R3] [R4] [R5] [R6] [R7]

### 2.1 Research: reuse its capabilities, not its control model

The research server has a coordinator, researcher subagents, a local corpus, planning todos, skills, output offloading, reviewed memory candidates, optional Docker execution, and fixture-backed tests/evals. Its principal workflow is expressed in the coordinator's system prompt: recall context, plan, delegate, read sources, synthesize, and save a report. [R1] [R2] [R3]

That is useful agent behavior, but it is not an independently enforced delivery state machine. A recursion ceiling is not a work budget, and a completed todo is not proof that an acceptance criterion passed.

| Existing element | Factory adaptation | Treatment |
|---|---|---|
| Research coordinator and researcher subagents | Repository investigation, dependency/API research, risk discovery | Reuse as a bounded discovery activity. |
| `searchCorpus` / `readDoc` | Source-tree inspection and versioned documentation retrieval | Replace bundled-corpus assumptions; retain provenance. |
| `plan.md` and todos | Human-readable view of a validated implementation plan | Keep for presentation, not authoritative scheduling. |
| Source-citing skills | Link design claims to repository paths, revisions, and external evidence | Adapt to engineering claims and acceptance requirements. |
| Output offloading | Large logs, diffs, traces, and reports outside model context | Preserve bounded previews; move authoritative artifacts outside writable worker storage. |
| Candidate memory writes | Reviewed repository lessons and reusable repair patterns | Retain review, provenance, scope, and invalidation. |
| Next.js/CopilotKit workbench | Intake, work-order status, artifacts, diff review, approvals | Reuse components while replacing thread-only state. |
| Fixture tests and evals | Orchestration regression tests plus separate live capability trials | Keep their purposes distinct. |

The current example researches a **bundled local corpus**; its existence does not establish a general-purpose live web research integration. Add a host-mediated retrieval adapter only where a work order needs it. [R1]

### 2.2 Code-fixer: preserve its strongest invariants

The code-fixer walkthrough separates captured initial source from the mutable candidate, restricts the editable inventory, verifies in a fresh workspace, and binds review to a digest. Its export path rechecks the candidate, verifies again, and writes an idempotent local receipt. It does not commit, push, or modify another checkout. [R4] [R5] [R6] [R7]

The factory should carry forward five invariants:

1. Captured source bytes—not the worker's description or `git status` alone—define the baseline.
2. A candidate may change only the source inventory authorized by policy.
3. Verification uses a fresh environment and host-owned checks.
4. Approval authorizes an exact candidate and operation, not whatever the workspace contains later.
5. Retrying a delivery operation cannot silently turn it into a new delivery.

The existing verifier uses named assertion requirements and rejects skipped or missing checks. Its source comments and walkthrough correctly describe this as a focused repair policy, not a proof of arbitrary program correctness. [R5] [R6]

### 2.3 Existing evidence: useful, but narrowly qualified

The checked-in September 13 evaluation ledger reports a final `gpt-5` batch with four qualifying outcomes across six attempts: three of three on the CLI fixture and one of three on the nullable-inputs fixture. Two nullable repairs passed visible tests but failed independent checks. All six reached the runtime export approval gate. [R8]

Those observations came from an earlier, explicitly recorded agent commit, not a new execution of the source snapshot inspected for this document. The ledger's qualifying workflow recordings stop at the approval boundary; they do not demonstrate human-approved publication. The two-fixture sample does not establish a general success rate. Authoritative billable token usage was unavailable in that report. [R8]

**Design consequence:** measure correctness, workflow progress, authorization, and delivery separately. Do not compress all four into a single green badge.

### 2.4 Current gaps that matter to a factory

The research workbench's thread list is browser-local, restored history omits earlier subagent activity cards, and its proxy has no authentication. Its documentation explicitly limits it to a trusted sole-user environment. The component code is reusable; the example's ownership and history model is not a shared factory control plane. [R9]

b4's documented runtime distinguishes checkpoint persistence from distributed coordination. Active-run and cancellation state are process-local. Agent Protocol execution survives a viewer disconnect; AG-UI execution is aborted when its response disconnects. [R11]

**Design consequence:** durable factory execution belongs behind Agent Protocol and an application-owned work registry. The browser observes and submits authorized commands; it must not be the owner of the job's lifetime.

### 2.5 Version boundary

The inspected code-fixer README states that its installation blueprint remains pinned to qualified B4 0.8.32 while the checkout contains a newer shared-workspace API requiring release qualification. Do not mix current example source with an arbitrary published package version. Start from one pinned checkout, build compatible packages together, and perform the documented packed-consumer qualification before claiming an installable factory blueprint. This document does not assert what npm `latest` currently resolves to. [R4]

---

## 3. External research and what to borrow

These are selected primary engineering sources, not a controlled comparison between platforms. Their reported outcomes establish useful design precedents, not projected b4 performance.

| Source | Relevant observation | Decision for this factory |
|---|---|---|
| StrongDM, *Software Factories and the Agentic Moment*, February 6, 2026 | Describes specifications and externally held scenarios, including behavioral service twins, as part of non-interactive development. [E1] | Separate implementation from acceptance. Do not adopt the no-human-review rule or token-spending target as requirements. |
| StrongDM, *Attractor specification* | Describes graph traversal, explicit outcomes, goal gates, checkpoints, and bounded retries. [E2] | Borrow explicit lifecycle semantics. Express them in TypeScript/LangGraph; do not implement a second DOT-based runtime. Hard factory gates must not accept partial success. |
| OpenAI, *Harness engineering*, February 11, 2026 | Emphasizes repository knowledge, runnable isolated environments, and machine-readable feedback such as UI state and observability. [E3] | Invest in legible workspaces and feedback, not only prompts. |
| Anthropic, *Effective harnesses for long-running agents*, November 26, 2025 | Uses initialization, incremental work, and durable progress artifacts to maintain continuity. [E4] | Resume from recorded artifacts and explicit remaining work rather than an indefinitely growing conversation. |
| Anthropic, *Harness design for long-running application development*, March 24, 2026 | Separates planning, generation, and evaluation; uses explicit contracts and calibrated feedback. Some earlier harness mechanisms became unnecessary with a different model. [E5] | Separate responsibilities, but add extra agents and context-reset machinery only when evaluation justifies them. |
| Anthropic, *Demystifying evals for AI agents*, January 9, 2026 | Distinguishes tasks, trials, graders, and environmental outcomes; combines deterministic checks with calibrated judgment. [E6] | Grade what changed and whether it works, not just what the agent said or the exact command text it used. |
| LangGraph JavaScript interrupt documentation | Resuming an interrupted node restarts that node, so preceding code executes again. [E7] | Design replay-safe nodes and idempotent external effects. A checkpoint alone does not make publication exactly once. |

The synthesis is not “more agents are better.” It is **better contracts, better execution environments, better evidence, and explicit control over irreversible actions**.

---

## 4. Architecture and ownership

### 4.1 Logical structure

```text
Operator / authenticated client / allowlisted issue intake
                         |
                 Factory command API
                         |
            Work-order registry + event journal
                         |
          Explicit lifecycle on b4 / LangGraph
             /             |               \
       Research       Implementation    Verification
       activity         activity          activity
       read-only       sandbox writer    fresh sandbox
             \             |               /
                Immutable change package
                         |
                Policy and review gate
                         |
             Exact-candidate authorization
                         |
           Idempotent delivery outbox / adapter
                         |
             Local export -> draft PR later
```

These are logical responsibilities, not a mandate for seven services. Start with one Node host, its b4 runtime, local durable stores, and sandboxed processes. The worker sandbox, verifier authority, and delivery credentials still need distinct privilege boundaries even when hosted on one machine.

### 4.2 Responsibility boundary

| Layer | Responsibility |
|---|---|
| LangGraph | Graph execution and checkpoint/interrupt mechanisms. |
| b4.run | Application routes, discovered tools, agent integration, workspace/sandbox primitives, permissions, testing conventions, and runtime interfaces used by this application. |
| Factory application | Work-order lifecycle, requirements and task contracts, repository policy, budgets, artifact identity, verification policy, ownership, approval intent, and delivery reconciliation. |
| Operator / existing delivery systems | Scope approval, repository access, CI requirements, merge policy, production release, and incident response. |

b4 supports `agent`, `workflow`, `graph`, and `chain` route entries in `src/app/**/index.ts`. The proposed controller is a named `graph` route; bounded workers use ordinary `agent()` routes. These are existing entry shapes, not a proposed `defineFactory()` SDK. [R10]

### 4.3 Control plane versus worker agency

The controller owns state transitions and supplies bounded tasks. A worker can propose a plan, make source edits, request diagnostics, and submit a candidate. It cannot set an authoritative verification result, approve its own work, lower its risk tier, increase its budget, or choose a new delivery destination.

The verifier is primarily a trusted execution harness, not merely an agent with a different persona. An optional reviewing model may critique maintainability or investigate failures, but it cannot override a failing mandatory check.

### 4.4 Native execution first; a narrow adapter boundary

Define an application-owned worker adapter with operations equivalent to `start`, `inspect`, `cancel`, and `collectArtifacts`. Initially implement only a b4-backed adapter. Keep model selection and tool policy outside task prose.

Do not call the model-facing `task()` tool as if it were a documented TypeScript orchestration function: b4's dispatch recipe explicitly distinguishes those interfaces. Use subagents inside a research activity where appropriate. For controller-to-worker execution, qualify the supported runtime/Agent Protocol integration, recording the child thread before dispatch. Propagate cancellation explicitly across that boundary; disconnecting an HTTP viewer is not cancellation. [R14]

Prefer public embedding surfaces or an authenticated private runtime endpoint over imports from b4's lower-level tooling internals. The exact adapter wiring is a first-milestone integration test, not an API assumed to exist. [R15]

An external coding harness can later implement the same adapter for a controlled comparison. Do not introduce two harnesses before the b4-native baseline is measured.

---

## 5. Work-order lifecycle

### 5.1 Main flow

```text
RECEIVED
  -> BASELINING
  -> DISCOVERING                 optional for already-concrete tasks
  -> SPEC_REVIEW
  -> PLANNING
  -> IMPLEMENTING
  -> VERIFYING
       -> IMPLEMENTING          bounded repair attempt
       -> BLOCKED               ambiguity, missing capability, exhausted budget
       -> REVIEW_READY
  -> AWAITING_DELIVERY_APPROVAL
  -> EXPORTING
  -> EXPORTED
```

A later delivery extension introduces `PUBLISHING_PR` and `PR_OPENED`. `MERGED`, `RELEASED`, and `DEPLOYED` must remain distinct states backed by actual external evidence; they are not synonyms for `EXPORTED`.

`CANCEL_REQUESTED`, `CANCELLED`, `FAILED`, `DENIED`, and `EXPIRED` are explicit outcomes. A cancellation request blocks new work immediately but becomes cancelled only after worker termination or recorded reconciliation of already-committed effects.

### 5.2 Stage contracts

| Stage | Required inputs | Durable output / exit condition |
|---|---|---|
| Baseline | Authorized repository and issue/task snapshot | Captured source inventory, base revision, environment identity, baseline test evidence. |
| Discovery | Baseline and question budget | Relevant source map, evidence-backed findings, uncertainty and risk notes. |
| Spec review | Intent, findings, known constraints | Approved behavioral criteria, non-goals, scope, risk policy, and budget. |
| Planning | Approved spec | Validated task dependencies, allowed changes, verification obligations, bounded task sizes. |
| Implementation | One task contract and its exact base | Candidate files/patch plus observed diagnostics; never an authoritative pass verdict. |
| Verification | Candidate, immutable check policy, exact environment | Trusted evidence for mandatory checks and a structured verdict. |
| Review | Candidate and complete evidence | Frozen review bundle, unresolved issues, and an exact requested action. |
| Export | Valid approval plus fresh revalidation | Idempotent export receipt for the approved bytes. |

For a small defect, the intake can already contain an approved specification. Do not force a second approval ceremony for identical scope. Larger or ambiguous tasks must stop for clarification rather than inventing product requirements.

### 5.3 The specification is a versioned contract

The approved spec should state the behavior to add or repair, existing behavior to preserve, examples and edge cases, explicit non-goals, allowed source areas, required checks, and risk-sensitive exclusions. Keep implementation details flexible unless compatibility or architecture makes them part of the requirement.

Every acceptance criterion receives an ID. Every verification obligation references those IDs. Missing coverage is a review failure, not something an eloquent report can compensate for.

Example contract for a parser repair:

```text
A1: Omitted optional input preserves the documented default.
A2: An explicit null is accepted only where the declared schema permits null.
A3: Existing valid non-null inputs retain their previous behavior.
A4: Invalid inputs continue to fail through the documented error surface.
Non-goal: No changes to unrelated schema generation or public API names.
```

Changing the approved behavior or scope creates a new spec revision and invalidates dependent plans and review bundles. It does not mutate the old acceptance record.

### 5.4 Task planning and concurrency

The planner may propose a task dependency graph. A deterministic validator checks that dependencies exist, there are no cycles, each task references acceptance criteria, and its write scope fits policy. The executor schedules validated tasks, not model-written todo status.

In the first version, there is one implementation writer. Independent read-only research can run concurrently. Later, independent writers receive separate captured workspaces and candidate branches. Integration creates a new candidate against a known base and runs the combined verification policy. Never concatenate patches and assume separately passing tasks imply a passing integrated result.

Start with a configurable maximum of three candidate attempts per work order—one initial attempt and two repair attempts—as a pilot setting, not a proven optimum. Keep transient infrastructure retries separate from repair attempts, and bound both. Repeated identical failures should trigger diagnosis or escalation, not another unchanged prompt.

---

## 6. Data model and artifact contracts

The following TypeScript is a **proposed application-domain sketch**, not new b4 SDK exports or a complete implementation. Validate every boundary at runtime; TypeScript types alone do not establish trust.

```ts
type Digest = `sha256:${string}`;
type Verdict = "pass" | "fail" | "inconclusive";

type ArtifactRef = Readonly<{
  id: string;
  digest: Digest;
  mediaType: string;
  bytes: number;
  schemaVersion: number;
}>;

type WorkOrder = Readonly<{
  id: string;
  revision: number;                 // compare-and-swap revision
  ownerId: string;                  // derived from verified identity
  repositoryId: string;             // server-resolved allowlisted repository
  baseline: ArtifactRef;
  specification: ArtifactRef;
  policy: ArtifactRef;
  environment: ArtifactRef;
  acceptanceIds: readonly string[];
  state: string;                    // implementation uses a closed state union
  limits: {
    maxCandidateAttempts: number;
    maxActiveMilliseconds: number;
    maxModelCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxEstimatedCostMicrousd: number;
  };
}>;

type Candidate = Readonly<{
  id: string;
  workOrderId: string;
  taskId: string;
  baselineDigest: Digest;
  specificationDigest: Digest;
  policyDigest: Digest;
  environmentDigest: Digest;
  changedFiles: ArtifactRef;
  patch: ArtifactRef;
}>;

type VerificationReceipt = Readonly<{
  id: string;
  candidateDigest: Digest;
  verifierIdentity: string;         // assigned by trusted harness, not a model
  policyDigest: Digest;
  environmentDigest: Digest;
  checks: readonly {
    id: string;
    acceptanceIds: readonly string[];
    verdict: Verdict;
    evidence: readonly ArtifactRef[];
  }[];
  verdict: Verdict;
}>;

type DeliveryApproval = Readonly<{
  id: string;
  workOrderId: string;
  reviewBundleDigest: Digest;
  operation: "export-local" | "open-draft-pr";
  destinationId: string;
  approvedBy: string;
  approvedAt: string;
  expiresAt: string;
  status: "approved" | "consumed" | "revoked";
}>;
```

### 6.1 Identity and authority

A review-bundle digest binds the repository identity, captured baseline, approved spec and policy, environment identity, changed bytes, required evidence, requested action, and destination. Specify a canonical serialization and path-normalization scheme before implementation. A hash gives content identity; authorization still requires a trusted issuer and server-side ownership checks.

The controller resolves artifact IDs to authorized storage entries. The model cannot supply an arbitrary filesystem path or external URI and have it accepted as trusted evidence. Verification receipts are persisted through a trusted harness interface, not accepted from worker JSON because it matches a schema.

### 6.2 Artifact storage

Store immutable artifacts outside the writable implementation workspace. Graph state holds references rather than megabytes of logs. Small deployments can use a content-addressed directory with atomic writes; the interface should allow an object store later.

Each work order should retain its task snapshot, source inventory, environment manifest, findings, approved spec, task plan, candidate patch, visible test output, independent verification, review bundle, approval, and delivery receipt. Include the model/provider identifier, relevant configuration, b4/harness revision, dependency lock digest, and container image digest in execution provenance. Reproducible inputs do not imply deterministic live-model outputs.

Define access controls, redaction, byte limits, retention, and deletion per artifact type. Preserve authorized evidence without indefinitely retaining secrets, personal data, or unnecessary full transcripts. Operational events and tool outputs are sufficient for the audit model; private model reasoning is not required.

---

## 7. Durable execution, recovery, and cancellation

### 7.1 One authoritative business state

Use an application-owned work-order database for business state, event sequence numbers, candidate references, approval records, and delivery outbox entries. Use LangGraph checkpoints for execution continuation. Do not permit these two stores to independently decide whether a change is approved or delivered.

A graph node reads the current work-order revision and invokes an idempotent application command. The command commits its state transition, event, and outbox intent together. A repeated invocation with the same operation key returns the recorded result. The graph checkpoint can then advance. If the process dies between the application commit and the graph checkpoint, replay observes the committed command rather than producing another effect.

This is an application transaction boundary, not an atomic transaction spanning the graph checkpointer, filesystem, and GitHub. External side effects still require reconciliation.

### 7.2 Execution is not owned by the browser

Run the factory through Agent Protocol. Expose an application event stream that the workbench can reconnect to using a sequence cursor. Persist lifecycle and activity events before treating them as part of the audit trail. An AG-UI-compatible presentation adapter is optional; the existing research transport must not be mistaken for a background job guarantee. [R9] [R11]

Record child thread IDs before starting work. On retry, inspect the existing child run and artifacts rather than blindly starting another. An unused orphan thread after a creation failure can be cleaned up; an ambiguous already-started mutation must be reconciled before another dispatch.

### 7.3 Interrupt and approval safety

Keep an interrupt boundary free of unrecorded, non-idempotent effects. LangGraph restarts the interrupted node on resume. Therefore, code before the pause may execute more than once. [E7]

Persist the approval request idempotently, pause, authenticate the response, and revalidate the bundle. A reply of “approved” in chat has no effect unless the controller records the corresponding authorized approval operation. The model cannot infer consent from prior conversational enthusiasm.

A permission to use a tool is not proof that its candidate passed verification. Likewise, a passing candidate is not permission to publish it.

### 7.4 Failure and cancellation behavior

On startup, reconcile work orders left running, pending child runs, incomplete verification, and outbox operations. Resume only compatible graph/spec/policy versions; otherwise leave a recoverable blocked record rather than replaying old state under changed code.

Cancellation must reach every owned child and sandbox process. Stop new dispatch immediately, propagate explicit cancellation to Agent Protocol children, terminate descendants after a grace period, record the outcome, and reconcile delivery operations already in flight. A completed remote write cannot be made nonexistent by changing local state to cancelled; show what happened and require any compensating action separately.

### 7.5 Single host first; replicas later

Keep the first application on one Node host with durable local disk. Persist its factory database, b4 state, artifact directory, and required sandbox volumes. Restore testing is part of qualification, not an assumption.

b4 documents separate stores for checkpoints, thread metadata, permission grants, and memory; its permissions cache also has replica-refresh implications. Moving one store to Postgres does not migrate all state or establish tenant ownership. [R12]

If multi-worker deployment becomes necessary, add a real claim/lease protocol, monotonic fencing tokens, compare-and-swap transitions, heartbeats, and orphan reconciliation. Route cancellation and resume to the runtime owning the child. b4's shared persistence alone does not provide a distributed execution coordinator. [R11]

---

## 8. Workspace and execution security

### 8.1 Four distinct authorities

**Controller:** knows identity, scope, budget, and state; does not execute repository code in its own process.

**Builder:** can read the permitted source snapshot and write the authorized candidate workspace. It has no delivery credentials, verifier secrets, signing keys, or access to other work orders.

**Verifier:** reconstructs the candidate in a fresh environment, runs the approved checks, and issues evidence through a trusted harness. It cannot approve delivery.

**Publisher:** performs a narrowly scoped approved delivery operation using separately held credentials. It cannot invent or repair a candidate.

These separations are enforced by host processes, containers, filesystem access, and credential boundaries—not by four system prompts.

### 8.2 Source and environment preparation

Resolve repositories and revisions through an allowlisted adapter. Capture the task and source inventory. Pin dependency locks and immutable image identities. Prepare dependencies in a separate, restricted setup environment; dependency lifecycle scripts are untrusted code too. Do not make package installation a route to host credentials.

Default builder and verifier execution to denied network access. Enable narrowly scoped external access only when a task requires it and the policy explicitly permits it. Provide repository/documentation retrieval through host-mediated tools rather than handing unrestricted credentials to shell commands.

Never mount the host Docker socket or production secret directories into a candidate workspace. Limit CPU, memory, process count, disk growth, output, execution time, and descendant lifetime. Reject unexpected symlinks, path traversal, binary/executable additions, and changed immutable files according to the task policy.

The code-fixer already provides a focused captured-workspace and inventory-checking pattern to adapt. Its exact allowances should not be copied unchanged to every repository. [R4] [R5] [R6]

### 8.3 Prompt injection and permissions

Treat issue comments, repository instructions, retrieved pages, logs, and dependency output as data. They can inform implementation, but they cannot change host policy, destination, budget, or authority. An `AGENTS.md` file may describe project conventions; it is not an authorization source for acquiring credentials or broadening scope.

Shell allowlists are a convenience for supported operations, not the only isolation layer. An allowed interpreter can execute behavior more powerful than its command name suggests. Enforce consequences at the sandbox, network, filesystem, and credential boundaries.

Do not allow persistent “always approve” grants for candidate export or PR creation. Use operation-scoped approval and re-check current authorization at delivery time.

### 8.4 Authentication and ownership

Before network exposure, replace the research example's unauthenticated proxy behavior. Authenticate at the service edge; authorize work orders, threads, artifacts, memory, approvals, cancellations, and delivery targets at the server that owns them. CSRF protection and approval expiry are required for browser-originated state changes.

b4's `thread-access` mechanism governs thread ownership separately from route middleware. A route name is not an owner identity. Both Agent Protocol and AG-UI can resume parked work, so enforcement must cover every enabled resume path; unused paths should be disabled at the edge. [R13]

For the pilot, one operator is acceptable only behind an explicit authenticated/private boundary. “The ID is hard to guess” is not access control.

### 8.5 Self-hosting boundary

The factory can eventually propose improvements to b4 or to its own source repository, but the running controller, verifier, policies, and dependency images remain immutable for that work order. Never let the candidate change the machinery currently judging or authorizing it. Upgrading that machinery is a separately reviewed release and qualification operation.

---

## 9. Verification and acceptance

### 9.1 A candidate needs an evidence bundle

Require baseline characterization, relevant regression checks, task-specific acceptance checks, source-scope validation, and the project's configured type/lint/build/security checks. For a bug fix, establish the defect before editing and demonstrate its repair without breaking required existing behavior. For a new feature, use an explicit acceptance contract rather than demanding an artificial pre-existing failing test.

A verification result must distinguish a real failure from an unavailable dependency, timeout, flaky check, unsupported environment, or missing evidence. `inconclusive` blocks automatic advancement. A zero exit code without the expected checks is not enough.

For browser-facing work, add observable user journeys and, where appropriate, backend-state assertions. Screenshots and a reviewing model may help assess usability, but a nice screenshot alone does not demonstrate the behavior.

### 9.2 Three testing surfaces—not one repeatedly consulted holdout

| Surface | Visible to builder? | Used during repair? | Purpose |
|---|---|---|---|
| Development checks | Yes | Yes | Fast, understandable local feedback and regression prevention. |
| Independent validation | Not mounted into builder workspace | Yes, with controlled feedback | Catch omissions and prevent editing the verifier into agreement. |
| Frozen qualification holdout | No | No feedback until a trial/configuration is complete | Measure generalization without iterative answer leakage. |

Once the repair loop receives feedback from an independent suite, it is a validation surface for that loop, not a pristine statistical holdout. Maintain a separate untouched qualification set and record exposure. Keep requirements public even when test inputs are private; hidden tests must not encode undisclosed product requirements.

Human maintainers or a separately reviewed check-authoring process establish authoritative acceptance checks. Builder-authored tests are useful supplementary artifacts, but they cannot replace the existing trusted policy in the same run.

### 9.3 Independence has limits

The existing code-fixer injects independent checks only into the fresh verifier workspace and protects persistent source/test inventories. That improves separation from the builder, but arbitrary submitted code may still observe its runtime environment. It is not a universal guarantee of test secrecy or adversarial-code safety. [R5] [R6]

For higher-risk tasks, place the oracle and result collection in a separate trusted process or external black-box harness, expose only the intended application interface, and enforce read-only or inaccessible oracle material. Never put publisher credentials or approval keys in any environment executing the candidate.

### 9.4 Judgment versus hard gates

Use deterministic checks for executable requirements. Use a calibrated model reviewer for explainability, maintainability, architectural fit, and subjective UX quality where useful. Preserve its evidence and uncertainty. Model agreement cannot override an executable failure, missing assertion, unauthorized file change, or absent approval.

Prefer a small rubric: does the change satisfy the contract, preserve stated behavior, remain within architecture, avoid unnecessary dependencies, and stay understandable to a human maintainer? A blanket preference for more tests, more agents, or more generated documentation is not a quality metric.

---

## 10. Review, approval, and delivery

### 10.1 What the operator sees

The review view should answer: what was requested, what changed, why this approach, which acceptance criteria passed, what remains uncertain, how much work was consumed, and exactly what action is being requested.

Show the contextual diff, approved spec revision, baseline commit, environment identity, acceptance/evidence map, warnings, and target destination. Do not require reading the entire conversation to discover whether the tests passed.

### 10.2 Exact-candidate authorization

Freeze a review bundle before requesting approval. Bind authorization to its digest, operation, destination, actor, and expiry. Reinspect before delivery. Any source, scope, policy, target, or relevant environment change requires a new bundle and approval.

A post-approval fresh verification receipt can be appended to the delivery record while preserving the originally reviewed bundle. It must verify the same candidate and policy; it cannot silently substitute a different candidate or broaden the approved operation.

For repository delivery, recheck the target branch state. Under the initial strict policy, base drift requires rebase/integration, verification, and new approval. No silent force-push or rebase under stale consent.

### 10.3 Outbox and external reconciliation

The first delivery adapter performs local export, following the existing exact-byte receipt pattern. Later, PR delivery uses a narrowly scoped GitHub integration held outside the builder.

Commit the approved delivery intent to an outbox with a unique operation key. Before retrying an uncertain remote operation, inspect the expected branch/commit/PR marker and reconcile what already happened. Use deterministic branch names and record remote IDs, but do not mistake naming conventions for an atomic transaction.

For example, a network timeout after PR creation must not cause a second PR or a claim of failure when the first already exists. Conversely, an HTTP request being sent is not evidence that publication completed. Store and show a confirmed remote receipt.

PR creation is not permission to trigger privileged deployment automation. Review the destination repository's event-triggered CI boundary before enabling writes; untrusted candidate execution must not inherit privileged secrets merely because the publisher opened a branch or PR.

### 10.4 Later release boundary

Merge, package publication, database migrations, and deployment require additional policies. A future release stage should bind a built artifact digest to verified source, use the existing delivery system, verify post-deployment health, and define rollback or compensating actions. Irreversible migrations require explicit treatment. None of that belongs to the initial agent's unrestricted shell toolset.

---

## 11. Workbench adaptation

Retain the research example's visual components where useful: transcript, composer, plan cards, activity cards, and interrupt presentation. Replace its browser-local navigation with a server-backed work-order list. Store persistent activity events rather than expecting every streamed subagent card to survive reload. [R9]

Use three primary views:

**Work queue:** pending/running/blocked/review-ready work, ownership, risk, and budget. A work order can have multiple threads and attempts; it is not a thread alias.

**Work-order detail:** approved intent, stage timeline, task state, artifacts, test/eval evidence, and current limitations. Chat remains available for clarification, but it is not the source of delivery truth.

**Review and delivery:** frozen diff/evidence bundle and operation-scoped approval. Clearly distinguish passed verification, granted approval, local export, and remote delivery.

Support reconnect without starting another run. Persist unsent drafts independently of liveness screens. Restore pending approvals from authoritative state, disable duplicate submissions, and expose explicit cancellation rather than equating a closed tab with a cancelled job.

The AG-UI/CopilotKit integration should be treated as a reusable presentation boundary, not as a requirement that all factory work run through the current research chat transport.

---

## 12. Context, skills, and memory

Build a bounded context package for each activity: its task contract, relevant source map, selected documentation, architecture rules, baseline findings, and only the prior evidence needed for that task. Use source references to retrieve more when necessary. Offload large logs and full documents rather than placing everything in the prompt.

Separate working context from durable lessons. A worker can propose a reusable lesson, but activation requires review or a separately qualified promotion policy. A lesson should identify its repository scope, source revision, evidence, owner, and invalidation conditions. A new dependency version or contradictory test should be able to retire it.

Good memory: a verified command/environment requirement, an architectural constraint, or a repair pattern with cited boundaries. Bad memory: “all nullable inputs should become undefined” inferred from one apparently successful patch.

Freeze memory inputs during comparative evaluations so one trial does not learn the reference solution from another. Do not create a large cross-repository memory platform before the factory can reliably complete a single work order.

---

## 13. Budgets, observability, and economics

Budget the whole work order, including subagents, repair attempts, verification, and delivery preparation. Track active execution time separately from time waiting for a person. Enforce model-call/token limits and sandbox limits even when exact monetary usage is unavailable.

For a monetary ceiling, reserve a conservative estimate before dispatch based on versioned pricing/configuration, reconcile reported usage afterward, and record whether values are authoritative or estimated. Concurrent workers cannot each spend the entire remaining budget. Unknown usage is not zero usage. Model cancellation may not cancel all already-incurred provider charges.

Capture structured lifecycle events, tool failures, verification verdicts, artifact identities, permission decisions, resource use, and delivery receipts. Do not treat generated explanations as authoritative telemetry.

The principal economic metric is:

```text
cost per accepted change =
  (model usage + execution infrastructure + verification + human review
   + attributable rework across successful and failed attempts)
  / number of changes accepted under the defined quality policy
```

Track first-attempt correctness, correctness within the attempt budget, human active minutes, time to review-ready, escaped defects, rejected candidates, scope violations, duplicate delivery attempts, and live-run cost coverage. Do not optimize for tokens spent, generated lines, number of agents, or PR volume.

---

## 14. Evaluation and experiment plan

### 14.1 Keep three kinds of proof separate

**Deterministic regression tests** prove state-machine behavior, fixture replay, authorization, and integration wiring for known inputs.

**Sandbox integration tests** prove actual filesystem, process, verification, approval, export, and cleanup behavior with controlled repairs and adversarial fixtures.

**Live capability trials** measure whether a selected model plus harness can solve tasks under the configured tools and budget. A fixture replay cannot establish that capability.

This follows the distinction between agent outcomes and the machinery used to grade them. [E6]

### 14.2 Initial comparison

Use the existing two historical defects as development fixtures, not the complete benchmark. Assemble a proposed pilot set of approximately 24 additional bounded tasks across CLI behavior, schema/validation, API behavior, and small feature work. Reserve a portion as untouched qualification tasks before tuning. Select tasks with clear requirements and verified reference solutions; do not provide the reference repair or future solution history to the worker.

Compare:

| Arm | Description | Question |
|---|---|---|
| A | Bounded b4 implementation worker with code-fixer-style verification and approval | What does the simpler baseline achieve? |
| B | The explicit factory lifecycle with the same model, tools, environment, and budget | Does orchestration improve full-process outcomes? |
| C, optional | Arm B plus research/planning activities for tasks where discovery is genuinely needed | Does research add enough value to justify its cost? |

Use repeated fresh trials—initially three per task/configuration as a pilot choice. Randomize execution order, freeze task/environment versions, and retain failures. Compare like-for-like attempt and cost budgets. Record task-level paired outcomes and uncertainty; multiple trials of the same task are not independent new tasks. This pilot can identify large effects and obvious failure classes, not certify broad reliability.

Do not add an external harness arm until the native baseline is sufficiently stable to make the comparison meaningful.

### 14.3 Non-negotiable invariant tests

| Scenario | Required outcome |
|---|---|
| Visible suite passes; independent acceptance fails | No review-ready/export success. |
| Worker weakens tests, changes checker policy, or spoofs successful stdout | Rejected or detected; no authoritative pass receipt from worker output. |
| Workspace changes while approval is pending | Old approval cannot export new bytes. |
| Process dies after intent commit but before checkpoint | Replay returns the existing command result or reconciles it without a second delivery. |
| Browser or observer disconnects | Factory execution policy remains independent of that observer; reconnect restores state. |
| Cancellation arrives with child work running | New dispatch stops, child cancellation is propagated, and eventual outcome is recorded. |
| Duplicate/stale approval or cross-owner request | Denied without changing delivery state. |
| Budget is exhausted | No further unreserved agent activity; work becomes blocked or terminated. |
| Candidate attempts path traversal or secret/network access | Denied at the actual isolation boundary. |
| PR creation response is lost | Reconcile the existing remote result; do not blindly duplicate. |
| Target base changes | Reverification and renewed approval under the strict initial policy. |
| Restart occurs across incompatible factory versions | Block or execute an explicit tested migration; never silently replay under new semantics. |

Require all mandatory invariant tests to pass before a pilot release. Passing a finite suite does not prove the absence of every security defect.

### 14.4 Failure taxonomy

Classify at least: misunderstood requirement; incomplete plan; incorrect patch; regression; test-policy weakness; tool restriction; unavailable environment; model/step limit; budget exhaustion; approval misuse; source drift; transport interruption; recovery defect; publication uncertainty; and user cancellation. Keep a genuine capability failure separate from an invalid test or broken environment.

The existing code-fixer ledger's distinction between visible-test success and independent correctness, and its record of scorer limitations, make it a useful starting example of honest evaluation reporting. [R8]

### 14.5 Promotion criteria

Before expansion, predeclare the target task class and acceptable tradeoffs. Require an observable improvement in accepted-change outcomes or human active effort versus the simpler baseline, no failures in mandatory delivery/authorization invariants, and cost data with stated coverage. Broaden autonomy by task category and risk, not by one aggregate success percentage.

---

## 15. Proposed repository structure

```text
examples/software-factory/
  README.md
  server/
    b4.config.ts
    src/
      app/
        factory/
          index.ts                 # named graph entry; explicit lifecycle
          state.ts
        research/
          index.ts                 # bounded agent activity
          subagents/researcher/
            index.ts
        implement/
          index.ts                 # bounded agent activity
          tools/
          skills/
      auth.ts
      thread-access.ts
      domain/
        work-order.ts
        specification.ts
        candidate.ts
        approval.ts
        events.ts
        policy.ts
      orchestration/
        commands.ts
        transitions.ts
        recovery.ts
        worker-executor.ts
      repositories/
        source-capture.ts
        repository-policy.ts
      execution/
        b4-worker-executor.ts
        environment.ts
      verification/
        inspect-candidate.ts
        verify-candidate.ts
        receipts.ts
      delivery/
        outbox.ts
        local-export.ts
        github-pr.ts               # later milestone
      storage/
        registry.ts
        artifacts.ts
      workbench-api/
        commands.ts
        events.ts
    test/
      lifecycle.test.ts
      approval.test.ts
      recovery.test.ts
      isolation.test.ts
      sandbox.integration.test.ts
      delivery.test.ts
    evals/
      tasks/
      reports/
  web/
    app/
      work-orders/
      components/
      api/
```

This is a proposed layout, not an assertion that these files or public APIs exist today. Adapt existing examples into the new application; do not depend on importing their private helpers by relative path. Extract a shared helper only after both examples demonstrably need the same stable contract. Keep the two original examples independently runnable.

---

## 16. Implementation milestones

### M0 — Qualify the foundation

Pin a source revision, build the compatible b4 packages, run existing code-fixer replay/integration tests, and establish a fresh live baseline with complete records. Test the controller-to-worker dispatch seam, raw graph checkpointing, pending approval recovery, cancellation, and source capture under the intended Node runtime. Validate copied-app/packed-package compatibility before advancing the blueprint pin. [R4] [R10] [R14] [R15]

**Exit:** one documented, reproducible environment and a capability matrix separating verified behavior from intended behavior. If a runtime seam is missing, add the smallest tested primitive or adjust the adapter—not a speculative platform rewrite.

### M1 — One work order, one exact local export

Implement the work-order schema, policy-controlled transitions, one implementation worker, independent verifier, immutable review bundle, and idempotent local export. A prepared spec and simple API/CLI review surface are sufficient; rich research and UI are not blockers.

**Exit:** a fixture with visible-test success but independent failure cannot export; a correct candidate can be approved and exported; restart, stale approval, duplicate command, cancellation, and budget tests pass.

### M2 — Discovery and a durable workbench

Add optional research, approved spec revisioning, validated task planning, server-backed work-order navigation, persistent events, and review/diff UI. Activate authentication and thread/resource ownership before making it accessible to anyone beyond the isolated operator environment.

**Exit:** the operator can create work, inspect its evidence, leave and reconnect, resolve an exact pending approval, and observe a complete durable history without owning execution through the browser connection.

### M3 — Approved draft pull requests

Add a restricted repository adapter, a publication outbox, confirmed remote receipts, target-base rechecks, and repository CI exposure review. Keep merge and deployment outside scope.

**Exit:** approved candidates create the intended draft PR exactly as observed after reconciliation; lost responses, duplicate delivery commands, stale bases, revoked permissions, and privileged-CI hazards have tested handling.

### M4 — Expand only where measurements justify it

Run the comparative pilot. Add selective parallelism, additional repository classes, or lower-friction approval for well-defined low-risk tasks only after demonstrated benefit. Candidate integrations, policy changes, and factory self-updates continue to require independent qualification.

**Exit:** a documented task-class-specific autonomy policy and measured cost/quality tradeoffs—not a blanket claim of autonomous engineering.

---

## 17. Decisions and unresolved choices

### Recommended now

Create a new example. Keep the existing research and code-fixer examples. Use readable TypeScript and existing b4 route conventions. Start with a single implementation writer and a trusted independent verifier. Run durable work over Agent Protocol. Use local export before remote writes. Keep factory state and authorization in the application. Reuse UI components but replace the demo's ownership and history assumptions.

### Resolve during the first integration slice

Choose the first real target repository and task class; validate the specific controller/worker runtime seam; decide who authors and approves authoritative acceptance checks; select the initial identity boundary and operator roles; and define the exact per-task budget based on observed usage. These choices are localized and do not require deciding a multi-tenant cloud architecture upfront.

### Defer deliberately

A general factory package, alternative coding harnesses, distributed scheduling, a digital-twin platform, automated merges, production deployment, and cross-repository learning should wait for evidence that the small application needs them.

**Recommended first demonstration:** take a known historical defect, show an initially plausible repair being rejected by independent checks, obtain a valid repair, restart while approval is pending, and export only the exact approved candidate without a duplicate. That demonstrates the factory's value more credibly than a long autonomous coding video.

---

## 18. Research method and limitations

This proposal is based on read-only inspection of the public `cacheplane/b4run` repository through the connected GitHub integration, current b4 documentation, and the primary engineering sources below. The inspected source snapshot is pinned at the top of this document. External documentation is a September 16, 2026 observation and can change.

No repository files were modified. No packages were installed, no sandbox was executed, no live model trial was run, and no PR was created as part of this research. Historical outcomes are attributed to their checked-in evaluation ledger rather than represented as results reproduced here. Proposed interfaces, lifecycle states, file structure, milestones, and pilot sizes are design choices for discussion—not currently implemented b4 capabilities.

The main remaining engineering uncertainty is not whether the pattern is expressible in TypeScript. It is whether the combined runtime, permission, worker-dispatch, recovery, verification, and delivery seams meet the proposed invariants under real failures. The milestone sequence is designed to test those seams before broadening the product.

## Sources

Repository references below use the pinned source revision unless otherwise stated.

[R1]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/examples/research/server/README.md "Research server tour, tests, corpus, memory, and sandbox behavior"
[R2]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/examples/research/server/src/app/research/index.ts "Research coordinator source"
[R3]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/examples/research/server/b4.config.ts "Research application configuration"
[R4]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/examples/code-fixer/server/README.md "Code-fixer operation, scope, and publication-version caveat"
[R5]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/examples/code-fixer/server/WALKTHROUGH.md "Captured source, exact candidates, and independent verification"
[R6]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/examples/code-fixer/server/src/review/verifier.ts "Actual verifier implementation"
[R7]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/examples/code-fixer/server/src/app/fix/tools/exportForReview.ts "Exact-candidate, reverified, idempotent local export"
[R8]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/docs/superpowers/runbooks/2026-09-13-code-fixer-live-evaluations.md "Historical live evaluation ledger, including failures and limitations"
[R9]: https://github.com/cacheplane/b4run/blob/8b40b8b33c1cdf6933bfb66a2e6f762b96a711ba/examples/research/web/README.md "Workbench integration, persistence gaps, and security caveats"
[R10]: https://b4.run/docs/routes "Current b4 route entry conventions; retrieved September 16, 2026"
[R11]: https://b4.run/docs/production-topology "Current b4 runtime lifetime, transport, and coordination boundaries; retrieved September 16, 2026"
[R12]: https://b4.run/docs/persistence "Current b4 persistence and tenancy boundaries; retrieved September 16, 2026"
[R13]: https://b4.run/docs/thread-access "Current thread ownership and resume authorization; retrieved September 16, 2026"
[R14]: https://b4.run/docs/recipes/dispatch-from-route "Subagent versus programmatic dispatch; explicit cancellation requirements"
[R15]: https://b4.run/docs/embedding "Public runtime embedding surfaces and lifecycle responsibilities"
[E1]: https://factory.strongdm.ai/ "StrongDM: Software Factories and the Agentic Moment; February 6, 2026"
[E2]: https://github.com/strongdm/attractor/blob/main/attractor-spec.md "StrongDM: Attractor specification; current document retrieved September 16, 2026"
[E3]: https://openai.com/index/harness-engineering/ "OpenAI: Harness engineering; February 11, 2026"
[E4]: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents "Anthropic: Effective harnesses for long-running agents; November 26, 2025"
[E5]: https://www.anthropic.com/engineering/harness-design-long-running-apps "Anthropic: Harness design for long-running application development; March 24, 2026"
[E6]: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents "Anthropic: Demystifying evals for AI agents; January 9, 2026"
[E7]: https://docs.langchain.com/oss/javascript/langgraph/interrupts "LangGraph JavaScript: Interrupts and replay behavior; retrieved September 16, 2026"

### Source index

**Repository and runtime:** [R1] Research server; [R2] coordinator; [R3] research configuration; [R4] code-fixer server; [R5] repair walkthrough; [R6] verifier source; [R7] export source; [R8] historical live evaluations; [R9] workbench; [R10] routes; [R11] production topology; [R12] persistence; [R13] thread access; [R14] dispatch; [R15] embedding.

**External engineering research:** [E1] StrongDM factory; [E2] Attractor; [E3] OpenAI harness engineering; [E4] Anthropic long-running harness; [E5] Anthropic application-development harness; [E6] Anthropic evals; [E7] LangGraph interrupts.

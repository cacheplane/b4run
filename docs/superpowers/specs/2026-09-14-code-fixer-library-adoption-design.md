# Code-fixer dogfooding: library adoption

Date: 2026-09-14
Status: user approved library-first direction; incremental designs below

## Principle

Code-fixer is a consumer and acceptance case for B4, not a second runtime.
Improve shared mechanisms where the example reveals a concrete framework gap.
Application code retains task selection, allowed edits, correctness assertions,
and the meaning/content of a review export. Do not copy all example helpers into
a framework package or introduce a code-repair subsystem into B4.

## Existing mechanisms to extend

- `SandboxManager` already deduplicates acquisition and owns idle release,
  shutdown release, and thread deletion. Extend that path, not a parallel manager.
- `SandboxProvider` already distinguishes release from destroy and supports
  reattachment. Durable initialization must distinguish workspace creation from
  compute acquisition; an in-memory initialized set cannot provide that contract.
- `@b4run/testing` already provides subprocess startup and bounded termination.
  Evaluate reuse before adding an isolated-case executor.
- `runEval` already accepts an injected `runCase`. Add lifecycle/failure support
  at the appropriate runner boundary rather than making evaluators own Docker.
- Runtime permissions already own approval and resume. The app supplies candidate
  content and validates it; do not replace that protocol with a custom CLI gate.

## Delivery sequence

### 1. Public tool identity — first bounded implementation

Expose `readonly threadId?: string` on `B4ToolContext`. This formalizes identity
already forwarded by the LangChain tool converter and preserved by the authored
tool wrapper. Absence is valid outside an invocation with thread context.
It identifies a conversation; it is not an authenticated principal, authorization
decision, globally unique provider resource name, or permission bypass.

Do not add a raw sandbox handle to model-facing tool arguments or expose internal
LangGraph configurable values. Add compile-time coverage for presence, absence,
and readonly behavior; verify the converter sources identity from runtime config
and never tool arguments. Keep existing conversion and tool discovery coverage.
Document the optional field and add a patch changeset. No runtime behavior change
is intended for this slice. Existing restart/resume/built-app acceptance remains
required when the corrected app starts depending on this field.

### 2. Durable initialization and scoped resource identity

Specify lifecycle and ownership before choosing an API. Required properties:
initialize a newly created workspace before its first tool operation; retain
edits across release/reacquire/restart; coordinate concurrent initialization;
recover or fail clearly after partial initialization; delete only owned resources.
Initialization content remains application-supplied and versioned.

Scope resource identity by installation/application and logical thread with a
stable collision-resistant mapping. Assess both Docker and Kubernetes naming and
reattachment. The user explicitly authorized breaking changes on 2026-09-14. Require scope
and remove legacy naming; document the storage cutover without compatibility
branches or automatic legacy attachment/deletion. Application isolation alone
does not constitute tenant authorization. Trusted ownership metadata must not
reside solely in the agent-editable workspace.

Audit existing labels, leases, and infrastructure reaping before expanding cleanup.
Distinguish warm compute, retained workspace storage, and disposable eval resources.
A crashed process must not cause a sweeper to delete another active process's
resources. Provider conformance and restart/failure tests govern this increment.

### 3. Evaluation case lifecycle and evidence

Support deterministic case setup, bounded execution, artifact inspection, scoring,
and guaranteed teardown through ordinary eval definitions and supported helpers.
Define cancellation, timeout, execution failure, scoring failure, and cleanup
failure distinctly. Preserve failed case outcomes and choose/document whether a
batch continues; do not silently change existing fail-fast behavior.

An isolated process option should reuse existing subprocess machinery. Unit tests
and ordinary lightweight evals should not require Docker. The example supplies
fixture setup and independent checks through generic lifecycle seams. Public
result artifacts need typed provenance and explicit redaction boundaries; avoid
claiming generic secret redaction can make arbitrary recordings safe to publish.

### 4. Usage accounting correctness

The collector currently appends streamed text chunks to `AgentRunResult.tokens`,
and `tokensUnder` compares that array length. This measures chunks, not provider
token usage. Specify separate content and usage fields; propagate provider-reported
input/output/total counts where available and preserve unavailable status.
Prevent double-counting final usage events, retries, and nested runs. Define
unsupported-provider and partial-stream behavior. Preserve/deprecate legacy
chunk-count semantics explicitly rather than silently changing an existing scorer.
Reported usage thresholds are post-run evaluation gates, not hard billing caps.
Real-time limits need a separately defined enforcement contract.

### 5. Consume and distribute

Refactor code-fixer to use the proven public capabilities, retaining its domain
verification. Exercise normal development and built runtime paths, thread isolation,
approval/resume, and both fixture evals. Review the application code with the user
before creating its PR. Publish the actual `b4 add code-fixer` guide only against
verified source and compatible released packages. Historical homepage evidence
continues to describe the recorded revision.

## Scope and workflow

Each library increment gets a concrete design, failing acceptance tests, focused
implementation and review. The first identity slice is intentionally small enough
to verify independently; later sections define requirements, not invented public
API signatures. Keep PRs bounded and follow repository CI submission limits.
No new model calls, automatic release, or PR creation is authorized by this plan
before the user's requested code walkthrough.

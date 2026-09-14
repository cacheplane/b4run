# Code-fixer application and distribution correction

Date: 2026-09-14
Status: independent design review approved; user review pending

## Objective

Make code-fixer an exemplary, ordinary B4 application that users can quickly
install and run. Deliver an actual agent-facing blueprint through `b4 add`.
The user has authorized correcting the earlier architectural and distribution
misalignment. Marketing work pauses until the example supports its claims.

This supersedes the September 13 spec's deferral of a published blueprint and
the implementation plan's `src/blueprint` application organization. Existing
historical recordings and evaluation results remain immutable evidence.

## Decision and alternatives

Adopt the standard B4 application lifecycle and distribute a guide derived from
that application. A directory-only rename would leave the runner dependency
intact. Adding a guide around the current runner would distribute the wrong
example. Neither meets the requested correction.

Implement in two sequential increments: correct and verify the example first;
then publish the installation guide against a verified source revision and
compatible published B4 release. A new scaffold template is not required.

## Application contract

- Keep `examples/code-fixer/server/src/app/fix/index.ts` as the agent route.
  Route tools, `plan.md`, skills, and `evals/*.eval.ts` follow documented B4
  discovery conventions. Add contributor guidance for the example.
- Provide normal `dev`, `build`, `start`, `check`, and `eval` commands using
  supported B4 interfaces. Live user execution must not import the testing
  harness or require an evaluation-attempt process or environment variable.
- Keep deterministic application helpers in responsibility-named directories:
  `src/sandbox/` for fixture-backed workspace initialization and lifecycle;
  `src/review/` for patch validation, independent verification, and local export;
  `src/fixtures/` for the trusted fixture catalog. No `src/blueprint/` layer.
- Keep the two controlled historical fixtures. The CLI task is the default;
  nullable remains available for harder evaluations. Do not silently replace
  the task with arbitrary remote-repository access.
- Default to Docker isolation with prepared dependencies, denied network,
  host-only provider credentials, and existing resource limits.
- Reuse the existing Workbench for browser interaction if the user selects the
  recommended server-plus-Workbench delivery. Do not build another client or
  another approval protocol. Server-only delivery remains a pending preference.

## Thread ownership and verification

Normal server execution must support independent concurrent threads. Remove the
global single-attempt assumption and lookup of the sole active handle. Seeding
must survive provider reattachment and server restart without resetting edits.
Thread deletion cleans up that thread's application metadata and sandbox only.
Persist each thread's fixture identity and baseline revision; changing the
default task must not retarget an existing thread. Reject noncanonical thread
identifiers before provider acquisition: accept only bounded lowercase ASCII
letters, digits, and hyphens within the provider's documented length constraints.
Use an isolated Docker provider scope for this local example; do not claim
multi-tenant isolation from a thread ID. Persisted metadata must include the
provider scope identity so it cannot silently attach to another installation.

Tools must resolve their workspace from trusted runtime identity, not a thread
ID, output path, or receipt supplied by the model. Persist trusted baselines and
review receipts outside the editable target workspace, with bounded identifiers
and exclusive writes. Never trust an agent-writable marker as authority for a
baseline or export destination.

The public `B4ToolContext` currently exposes `signal`, `fs`, and `middleware`,
but does not declare thread identity. The LangChain converter already forwards
thread identity internally. Before implementation, trace the complete tool
invocation paths and determine whether a small documented public context
extension is required. Do not hide an undocumented cast, URL-parsing workaround,
module-cache singleton, or model-supplied identity in the example. If a framework
extension is required, specify and test it separately with a patch changeset;
the installation guide must wait for a compatible published release.

Preserve source-only patch restrictions, pristine visible and independent tests,
separate verifier execution, and rejection of altered verification files,
symlinks, added/deleted files, and oversized patches. Approval gates local export
through B4's runtime. Verify the actual candidate again after approval; do not
export unverified or changed bytes. Denial exports nothing. No remote PR or push.
Bind the proposed review to a digest of trusted candidate bytes. If those bytes
change while approval is pending, require a new review rather than applying the
old approval to another patch. A digest or receipt identifier supplied in tool
arguments is only a lookup hint, never authority to bypass thread ownership.
The user must be able to inspect the verified candidate before approval through
ordinary tool results/client presentation, without the evaluation runner.

## Tests and evaluations

Move batch orchestration, replay preparation, provenance capture, and historical
recording export into clearly named test/evaluation support. Retain the parent
deadline and owned-resource cleanup for batch attempts. These are evaluation
concerns, not the normal app entry point.

Expose route-local eval definitions discoverable by `b4 eval`; keep independent
correctness scoring and all six existing workflow criteria. Test both fixtures
through replay without paid model calls. A small fixture-backed real-server test
must cover normal execution and approval/resume, two independent threads, denied
export, reattachment/restart, and cleanup. Include built Node execution, not only
an imported test harness. Retain historical results without recasting them as
validation of the corrected revision.
Add collision-oriented identity tests (case, punctuation, length), mismatched
provider-scope metadata, and conflicting existing-app installation fixtures.

## Actual blueprint delivery

Add `apps/web/content/blueprints/agents/code-fixer.md` and explicitly extend the
catalog's category validation and docs to support complete agent examples.
Retain the existing `b4 add` contract: it prints a guide for a coding agent to
apply; it does not silently install dependencies or run software.

The guide detects the package manager, existing app structure, env conventions,
and existing installation. It creates ordinary B4 files from the verified example,
preserves unrelated routes, documents Node/Docker/API-key prerequisites, and
provides setup, first-run, replay, and approval instructions. Source acquisition
is revision-pinned and bounded to the required files; no second handwritten agent
implementation. Existing installations must be detected without overwriting
user edits. Newly created apps use a supported scaffold path.
Sandbox and permission configuration are app-global. For an existing app, inspect
them first: reuse only a demonstrably compatible configuration; otherwise explain
the conflict and install into a separate sibling app by default. Do not overwrite
an existing sandbox provider, broaden permissions for unrelated routes, or silently
convert a local-filesystem app to a sandboxed app. Any deliberate shared-app
configuration migration requires its own review. Preserve existing Workbench
configuration and register a new route only where the client supports doing so.

Prove the guide in a fresh directory outside this monorepo, using published
packages without workspace links or private tooling. Record exact commands and
the compatible release. A clean first run must not require contributors' full
monorepo validation sequence. Measure setup separately from agent execution;
make no new timing claim without evidence.

## Documentation and acceptance

Update example READMEs and walkthrough to show the corrected application,
standard run path, and separate blueprint distribution. Update public links as
needed while keeping homepage recording source pinned to its historical revision.
Do not rewrite recorded code to resemble the new implementation.

Acceptance requires: normal runtime and built app execute successfully; no
testing dependency in the normal run path; thread isolation and approval tests
pass; route-local evals are discovered; both replay fixtures pass; blueprint
catalog/route tests pass; a fresh published-package installation works; relevant
docs, package and full repository CI checks pass before merge. Independent design,
implementation, and user-visible quick-start reviews are required.

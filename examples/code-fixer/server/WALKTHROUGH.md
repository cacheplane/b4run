# Follow a repair

[`src/app/fix/index.ts`](./src/app/fix/index.ts) defines the agent: reproduce,
repair, verify, and request approval. B4 discovers its tools, plan, skill, and eval
from the route directory. The route uses the same workspace tools a user would
use in another B4 application.

[`b4.config.ts`](./b4.config.ts) chooses Docker and declares the
[project workspace](./src/project/workspace.ts). Its source inventory, task,
project identity, and dependency link come from the checked-in sample. B4 captures
those bytes, initializes the workspace, and owns recovery and deletion.

[`prepareReview`](./src/app/fix/tools/prepareReview.ts) shows the review sequence directly:
inspect the candidate, verify it independently, and return its diff and verification.

Its shared [`inspectCandidate`](./src/review/inspect.ts) helper reads the original source through
`ctx.workspace.readInitialFile` and the current source through B4's
`inspectWorkspace(ctx.fs, policy)`. It compares the inventories and permits only
listed source edits. Initial captured bytes define the baseline; Git is useful
for diagnostics but cannot replace that authority. Inspection rejects unexpected
links, executable or binary files, and oversized inventories.

[`verifyChanges`](./src/review/verifier.ts) uses `withWorkspace` to create a fresh
workspace from the captured source and immutable image identity. It applies the
candidate, runs visible tests, then installs the independent checks. The
host-owned check policy requires exact named assertions. Inspection before and
after each test suite detects persistent source or test changes. These checks
are a focused repair policy, not a proof of arbitrary code correctness.

[`prepareReview`](./src/app/fix/tools/prepareReview.ts) returns the verification,
a contextual diff, and a candidate. Its digest binds source identity, workspace
identity, and changed bytes. The agent passes that candidate to
[`exportForReview`](./src/app/fix/tools/exportForReview.ts). B4 pauses before
executing the tool and presents the approval request.

After approval, export re-inspects the workspace, checks that the candidate still
matches, independently verifies it again, and writes an idempotent local receipt.
It never turns approval into permission to export a later edit. B4 owns the
pause/resume lifecycle; this code supplies the review policy and content.

[`repair.eval.ts`](./src/app/fix/evals/repair.eval.ts) uses the same scoring
functions as the [Docker replay test](./test/agent.integration.test.ts). The live
eval measures the model; the replay checks wiring using a known repair. Historical
qualification and batch recording tools live outside the copied application in
[`test/code-fixer`](../../../test/code-fixer/).

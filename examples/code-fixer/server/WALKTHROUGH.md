# Code-fixer application walkthrough

Start with [the route](./src/app/fix/index.ts). It asks the agent to read the task,
reproduce the failure, repair permitted source, verify the result, and prepare a
candidate for approval. Plans, skills, and tools use ordinary route discovery.

[The config](./b4.config.ts) declares a Docker provider and a
[fixture workspace](./src/fixtures/workspace.ts). The descriptor contains only
trusted fixture inventory, task text, fixture identity, and the prepared dependency
link. B4 captures exact source bytes and owns creation, reconnection, and deletion.
The app does not keep provider handles or process-global baselines.

[Candidate inspection](./src/review/prepare.ts) reads the initial fixture identity
from `ctx.workspace.readInitialFile`. It checks a bounded current inventory using
permission-bound filesystem methods, compares it with captured source bytes, and
accepts only the fixture's allowed source paths. Git is convenient for the agent's
diagnostics; mutable Git metadata is never verification authority.

[Independent verification](./src/review/verifier.ts) uses B4's `withWorkspace`
helper to create a separate disposable workspace from the original captured
source and immutable Docker image identity. The verifier applies complete
candidate file contents, runs pristine visible tests, and installs host-only
independent checks. Exact named assertions and unchanged verification inputs
are required for success.

[`prepareReview`](./src/app/fix/tools/prepareReview.ts) returns checks, a diff,
and a complete candidate. The candidate digest binds the initial source digest,
workspace identity, and source bytes. The agent supplies that same candidate to
[`exportForReview`](./src/app/fix/tools/exportForReview.ts), which the route marks
as approval-required. After approval, export rejects a changed workspace,
re-verifies those exact bytes, and writes a deterministic local outbox receipt.
Runtime approval owns pausing and resuming; the app supplies review content.

[Evaluation support](./src/evaluation/) drives the same route harness. Offline
replay applies a checked-in historical repair through normal tools, extracts the
prepared candidate, then requests approval in a second turn. Batch subprocesses,
deadlines, and evidence files are evaluation concerns. They are not prerequisites
for `b4 dev` or built Node execution.

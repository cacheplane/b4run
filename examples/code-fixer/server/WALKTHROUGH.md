# This code runs this agent.

A developer agent needs a project, tools, limits, and a definition of done.
This example puts each responsibility in a small file. The code below is taken
from the runnable example; source links open the complete files.

[Run it](./README.md#run-from-the-monorepo-root) · [Watch the recorded highlights](https://b4.run/#blueprint)

## 1. Write the agent

[`src/app/fix/index.ts`](./src/app/fix/index.ts) defines the route. The same agent
handles both fixtures. The default is `gpt-5-mini`; the homepage recording used
`B4_CODE_FIXER_MODEL=gpt-5`. Model calls happen on the host.

```ts
import { agent } from "@b4run/sdk"

export default agent({
  model: process.env.B4_CODE_FIXER_MODEL ?? "gpt-5-mini",
  recursionLimit: 60,
  description: "Repairs a failing test and verifies the change.",
  tools: { approve: ["exportForReview"] },
  systemPrompt: `You fix a focused code defect in the workspace project.
Read TASK.md and the verify-change skill. Reproduce the failure with npm test
before editing. Inspect the relevant source and make the smallest correct fix.
Use readFile, listDir, writeFile, and runBash. Use the commands documented in
TASK.md for diagnostics; inspect files rather than inventing other shell commands. Never change tests, configuration,
dependencies, or files outside the source paths specified in TASK.md.
Run npm test after the change and verify the task's preservation requirements,
not just its failing example. Explain what changed and what actually passed.
Then call exportForReview({}) to request runtime approval. Calling this tool
pauses BEFORE export and presents the human approval gate. Do not substitute
a prose confirmation question for the tool call; the runtime owns approval.
Do not claim success if a command failed or a test was not run.`,
})
```

The [plan](./src/app/fix/plan.md) lays out the sequence. The
[verification skill](./src/app/fix/skills/verify-change/SKILL.md) carries reusable
instructions. The runtime discovers those files; the prompt tells the agent
when to use them.

## 2. Give it a workspace

A run starts with the faulty project and `TASK.md`. The example's
[`seededProvider`](./src/blueprint/seeded-provider.ts) wraps the sandbox provider
and seeds each thread once. Reacquiring that thread keeps its edits. Concurrent
acquisition shares the pending initialization; destroying the thread clears its
seed state. This lifetime belongs to the running attempt, not permanent storage.

```ts
          if (!initialized.has(input.threadId)) {
            await seed(handle, input.signal)
            initialized.add(input.threadId)
          }
```

The runner creates an isolated attempt for each task. Reference repairs and
independent checks stay outside the agent's workspace. This isolation and seeding
policy are example code built on B4's workspace and sandbox interfaces.

## 3. Let it execute. Set the limits.

[`b4.config.ts`](./b4.config.ts) connects the provider and allows the required
workspace commands. Both agent execution and independent verification use this
policy from [`verifier.ts`](./src/blueprint/verifier.ts):

```ts
export const sandboxPolicy = {
  network: { mode: "deny" as const },
  env: { npm_config_cache: "/tmp/npm-cache", npm_config_update_notifier: "false" },
  resources: { memoryMb: 1024, cpus: 1, timeoutMs: 120_000 },
}
```

Prepare the image with network access before running the agent. The containers
then use prepared dependencies with network denied. The model API key stays on
the host. The runner adds a ten-minute attempt deadline and owned-resource cleanup;
`timeoutMs` above bounds individual sandbox commands.

## 4. Verify outside the agent's process

After the agent reproduces the failure and repairs source, the runner collects
actual changes. It rejects edits outside the manifest's source paths, including
changed tests and configuration. A fresh verifier sandbox starts from the fixture
baseline and applies the allowed patch. Assertions run outside the process loading
submitted source; named test completions and unchanged verification files are
required.

For the CLI recording, the visible test checks the documented dry-run flag.
Three independent checks cover argument forwarding, invalid arguments, and
preservation of memory state and files. These are the example's checks, not a
built-in guarantee that arbitrary generated code is correct.

## 5. Make done measurable

[`evaluate.ts`](./src/blueprint/evaluate.ts) passes the collected criteria through
B4's evaluation API. `gate.perScorer()` requires every criterion to meet its
threshold. The example supplies the observations and criterion values.

```ts
export async function evaluateRun(run: AgentRunResult, criteria: Record<string, boolean>) {
  return runEval(
    defineEval({
      name: "code-fixer independent verification",
      route: "/fix#agent",
      dataset: [{ name: "attempt", input: "Repair the fixture" }],
      scorers: Object.entries(criteria).map(([name, passed]) =>
        custom(() => passed, { name, threshold: 1 }),
      ),
      gate: gate.perScorer(),
    }),
    { runCase: async () => run },
  )
}
```

The six criteria cover visible checks in the verifier, independent checks, allowed
patch scope, the agent reproducing failure before editing, the agent verifying
tests after editing, and reaching the runtime approval gate. Preserve failures
alongside successes.

The final six-attempt gpt-5 batch passed **4/6** workflows: CLI **3/3** and
nullable-inputs **1/3**. The [report](../../../docs/superpowers/runbooks/2026-09-13-code-fixer-live-evaluations.md)
retains **24 attempts across four batches**. The homepage selects one successful
CLI run lasting 1m53s including verification and cleanup; it is not a benchmark.

## 6. The next action is your call

`tools: { approve: ["exportForReview"] }` pauses before that tool executes. An
interactive terminal shows the verified diff and asks for approval. Without a
terminal, the attempt stops at `approval-pending`. Evals also stop at this gate.

After approval, [`exportForReview.ts`](./src/app/fix/tools/exportForReview.ts)
verifies again and writes a receipt into the local review outbox:

```ts
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { B4ToolContext } from "@b4run/sdk"
import { attemptContext } from "../../../blueprint/attempt-context.js"

export default async function exportForReview(_input: Record<string, never>, ctx: B4ToolContext) {
  const root = process.env.B4_CODE_FIXER_ATTEMPT_DIR
  if (!root) throw new Error("Run the agent through the blueprint runner to export")
  const receipt = await attemptContext().verify(ctx.signal)
  if (!receipt.verification.passed) throw new Error("Independent verification failed")
  const outbox = join(root, "review-outbox")
  await mkdir(outbox, { recursive: true })
  await writeFile(join(outbox, "patch.json"), JSON.stringify(receipt, null, 2), { flag: "wx" })
  return {
    exported: true,
    task: receipt.task,
    message: "Verified patch exported for local review. No remote publication.",
  }
}
```

The export creates `review-outbox/patch.json` in the attempt directory. It does
not push a branch or open a PR. Human approval permits this local action; the
recorded homepage run remains approval-pending, with nothing exported.

## Make it yours

1. Start with the [setup and replay instructions](./README.md#run-from-the-monorepo-root).
2. Replace the controlled fixture with a project you own. Define allowed source
   paths and independent checks before expanding the agent's permissions.
3. Keep the route readable. Put reusable instructions in skills and deterministic
   checks in ordinary TypeScript. Change the tool at the approval boundary when
   your workflow needs a different action.

For the framework contracts, read [workspaces](https://b4.run/docs/workspace),
[sandboxing](https://b4.run/docs/sandbox), [evals](https://b4.run/docs/evals), and
[permissions](https://b4.run/docs/permissions).

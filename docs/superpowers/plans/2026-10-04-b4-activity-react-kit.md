# B4 Activity Components — Sub-project 2a: React Kit + CopilotKit Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the React activity kit (`TurnActivity`, `Step`, `StepGroup`, `StepDetail`, `PlanStep`, `ReasoningStep`, `SubagentStep`, `ApprovalCard`, `SourceChips` and the building blocks) in `@b4run/ag-ui/react`, its stylesheet under `@layer b4-activity`, and a new `@b4run/ag-ui/copilotkit` connector (`B4Activity`, `useB4Turns`, `useB4ChatSlots`) that drives a stock `<CopilotChat>` from the `./view` reducer.

**Architecture:** Components are pure functions of `TurnView`/`StepView` props from `@b4run/ag-ui/view` (spec §6, layer 3) and render the DOM contract of spec §5.6; all interaction state (open/closed, elapsed ticks, the 300 ms no-flash rule) lives in small hooks next to the components. The connector (layer 4) subscribes to the AG-UI agent, folds events with `reduceTurns`, and hands `TurnView`s to the components through `<CopilotChat>` slot props the Task 20 spike verified (`messageView.transformMessages`, `assistantMessage` with `Object.assign` statics, `toolbarVisible`) plus `useRenderTool({ name: "*" })` to silence stock tool rows and `useInterrupt` to render `ApprovalCard`s in the chat. Legacy cards (`PlanActivityCard`, `ActivityChecklist`, `SubagentPanel`, the `classNames`/`components` slots) stay exported from `./react` in this sub-project, marked deprecated; sub-project 2b removes them when the research example and its scaffold template adopt the kit. The one breaking change here: `b4ActivityRenderers`/`b4PlanActivityRenderer` move from `./react` to `./copilotkit`, so `./react` no longer imports CopilotKit.

**Tech Stack:** TypeScript (NodeNext ESM, `exactOptionalPropertyTypes`), React 19 (`react-jsx`), `@copilotkit/react-core@1.76` v2 API, `@ag-ui/client` 1.0.1, Vitest 4 (static markup via `react-dom/server`; jsdom + Testing Library for interaction tests), Biome (always `--config-path packages/config-biome/biome.json`), plain CSS with `@layer`.

---

## Mapping facts the tasks rely on

- **View types** (`packages/ag-ui/src/view/turns.ts`): `TurnView { runId, status: working|awaiting|done|failed|stopped, startedAt, endedAt?, steps, text, approvals, error?, failed }`, `ToolStep { kind:"tool", id, name, status: pending|running|done|failed|awaiting, args, result?, icon?, label?, sources?, startedAt, settledAt?, approval? }`, `PlanStep { kind:"plan", id, todos, startedAt, updatedAt }`, `ReasoningStep { kind:"reasoning", id, messageId?, text, status: streaming|done, startedAt, settledAt? }`, `SubagentStep { kind:"subagent", id, name, description?, status: running|paused|done|failed, result?, error?, startedAt, settledAt?, turn }`, `ApprovalView { interruptId, kind, detail, message?, grant?, offersAlways }`. Labels: `stepLabel(step, overrides)`, `groupSteps(steps, overrides)` → `(StepView | StepGroup)[]` with `StepGroup { kind:"group", name, label, steps }`; `StepLabelOverrides`. `reduceTurns(state, event, options?)`, `EMPTY_TURNS`, `ReduceTurnsOptions { now?, hiddenTools?, resuming? }`, `isSubagentMessage(message)`.
- **Spec sources:** catalog and behaviour rules §3/§3.1/§3.2, visual spec §5 (tokens §5.1, DOM contract §5.6), connector §6.2, error handling §7, testing §8 of `docs/superpowers/specs/2026-10-03-b4-activity-components-design.md`. Mockup: `docs/superpowers/specs/assets/2026-10-03-b4-activity-components/direction-b-lifecycle.html` (icons as `<symbol>`s at its top; colors are hard-coded there and map onto §5.1 tokens).
- **Spike findings** (plan `2026-10-03-b4-activity-protocol-and-view-core.md`, "Spike findings (2026-10-04)"): `SlotValue<typeof CopilotChatAssistantMessage>` needs the namespace statics → `Object.assign(wrapper, CopilotChatAssistantMessage)`; `messageView={{ transformMessages, assistantMessage }}` on `<CopilotChat>` typechecks; `toolCallsView` is rendered once per assistant message even with no tool calls; `transformMessages` receives `assistant → tool → assistant → tool …`, so adjacency merging never fires: merge by turn; CopilotKit renders subagent `TEXT_MESSAGE_*` as top-level assistant messages carrying `subagentRunId`; CopilotKit restores a parked interrupt after reload from the replayed `RUN_FINISHED`, so the connector needs no `/threads/:id/state` read.
- **CopilotKit v2 hooks** (`examples/research/web/node_modules/@copilotkit/react-core/dist/copilotkit-*.d.mts`): `useAgent({ agentId? }) → { agent: AbstractAgent, isReady }`; `useRenderTool({ name: "*", render, agentId? }, deps?)`; `useInterrupt({ render: (props: InterruptRenderProps) => ReactElement, enabled?, agentId?, renderInChat? })` with `InterruptRenderProps { event, interrupt, interrupts: Interrupt[], result, resolve: (payload?, interruptId?) => Promise, cancel: (interruptId?) => Promise }`; `CopilotChatAssistantMessageProps { message: AssistantMessage, messages?, isRunning?, isLatest?, toolbarVisible?, toolCallsView?, … }`; `CopilotChatToolCallsViewProps { message: AssistantMessage, messages? }`; `Message`/`AssistantMessage` from `@ag-ui/core` (`AssistantMessage.content: string | ContentPart[] | undefined`, `toolCalls?: ToolCall[]`, `subagentRunId?`).
- **Package facts:** `packages/ag-ui/vitest.config.ts` is `environment: "node"` — interaction tests opt in per file with `// @vitest-environment jsdom`. Existing React tests use `renderToStaticMarkup`. `jsdom@30.0.1`, `@testing-library/react@16.3.2` and `@testing-library/dom@10.4.1` are already in `pnpm-lock.yaml` (other packages), so adding them as devDependencies pulls nothing new. `axe-core` is not in the lockfile and is NOT added here (DOM-contract assertions cover §5.5; the Playwright keyboard pass is sub-project 2b, with the research example). `package.json#build` copies only `src/react/styles.css` to `dist/react/`; a new CSS file needs its own copy line. `./react` is registered `node-only`/`application` (not edge-safe) in `scripts/check-docs.mjs` and `apps/web/app/components/docs/api-reference.ts`; the new `./copilotkit` entry is registered the same way. Registry count pins: `ARTIFACT_REGISTRY.length` 51 → 52 and imports 47 → 48 (`check-docs.mjs` ≈ `:4251-4260`, `api-reference.test.ts:714`). The docs inventory (`scripts/lib/docs-api-inventory.mjs`) diffs the `### \`@b4run/ag-ui/<subpath>\`` export tables in `apps/web/content/docs/api/ag-ui.mdx` against the SOURCE barrel both ways: every export needs a row, every row needs an export. `scripts/readme-contracts.test.mjs:270-305` pins README headings `## React renderers`, the word `b4ActivityRenderers`, and `**Rung 1 — tokens.**` … `**Rung 4 — eject.**` — keep all of them in this sub-project. `packages/cli/test/api-reference-compatibility.test.ts` imports every `node-only` address under plain Node (`assertNodeImport`) and requires a browser-negative violation (`assertBrowserImportNegative`), which React's `process.env.NODE_ENV` provides.
- **Consumers to keep compiling:** `examples/chat/web/app/page.tsx:2` imports `b4ActivityRenderers` from `./react` → `./copilotkit`. `examples/research/web` (and its byte-identical twin `packages/devkit/templates/app-research/web`, enforced by `packages/devkit/test/templates.test.ts:496-549`) imports only `planActivityContentSchema`, `PlanActivityCard`, `B4ActivityClassNames`, `SubagentPanel`, `useSubagentRuns`, `SubagentEventSource` — all retained here, so neither tree changes in this sub-project.
- **Banned wording** (`scripts/check-docs.mjs` `forbiddenContent`, `test/security-dependencies/brand-migration.test.ts`): no retired product name (also not inside other words), no other chat product's class or token names, no "byte-identical", "auto-registered", `openai:gpt…`. Say "another framework" or "Angular"; the values in §5.1 are the host chat's, the names are B4's.
- **Commit trailer:** every commit ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Never bare `biome check --write` at the repo root; format from `packages/ag-ui` with `npx biome check --write --config-path ../config-biome/biome.json <paths>`.

## File structure

```
packages/ag-ui/
  package.json                          devDeps jsdom + testing-library; "./copilotkit" export
  src/react/
    index.ts                            barrel: kit + blocks + legacy (deprecated); no CopilotKit import
    styles.css                          rewritten: §5.1 tokens, @layer b4-activity, kit + legacy rules
    activity/
      format.ts                         formatDuration, summary/meta text, plan progress, reasoning label (pure)
      icons.tsx                         StepIcon (10 ToolDisplayIcon names + chevron/alert/check), inline SVG
      Disclosure.tsx                    <button aria-expanded> + panel; useDisclosure (auto vs manual rule)
      useLive.ts                        300 ms no-flash + 1 s elapsed tick (useElapsed)
      StatusText.tsx                    the "· meta" fragments; decision/awaiting suffixes
      SourceChips.tsx                   chips list with +N overflow
      StepDetail.tsx                    Inputs / Output panel (pretty JSON or text)
      Step.tsx                          ToolStep row (li.b4-step[data-kind=tool])
      PlanStep.tsx                      plan row + Checklist block
      ReasoningStep.tsx                 reasoning row
      StepGroup.tsx                     merged consecutive calls
      SubagentStep.tsx                  nested TurnActivity in .b4-step__children
      TurnActivity.tsx                  summary line + ol.b4-turn__steps; role=status region
      ApprovalCard.tsx                  the approval card (§3.2)
    renderers.tsx                       DELETED (moved to copilotkit/renderers.tsx)
  src/copilotkit/
    index.ts                            barrel
    renderers.tsx                       b4PlanActivityRenderer, b4ActivityRenderers (moved from ./react)
    useB4Turns.ts                       agent.subscribe → reduceTurns; resume tracking
    messages.ts                         mergeTurnMessages (pure): drop subagent messages, one tool row per turn
    B4Activity.tsx                      provider: context, wildcard tool renderer (null), useInterrupt → ApprovalCards
    useB4ChatSlots.tsx                  messageView slots: transformMessages + assistantMessage wrapper
  test/react/
    format.test.ts, icons.test.tsx, Disclosure.test.tsx, Step.test.tsx, PlanStep.test.tsx,
    ReasoningStep.test.tsx, StepGroup.test.tsx, SubagentStep.test.tsx, TurnActivity.test.tsx,
    ApprovalCard.test.tsx, public-api.test.ts; styles.test.ts (rewritten); renderers.test.tsx (moved)
  test/copilotkit/
    messages.test.ts, useB4Turns.test.tsx, B4Activity.test.tsx, useB4ChatSlots.test.tsx, public-api.test.ts
scripts/check-docs.mjs                  ./copilotkit tuple; counts 52/48
apps/web/app/components/docs/api-reference.ts (+ .test.ts)   runtimeImport + importAddress; count 48
apps/web/content/docs/api/ag-ui.mdx     ./copilotkit section; ./react table rewritten for the kit
apps/web/content/docs/api.mdx           catalog row surfaces
apps/web/content/docs/ag-ui.mdx         "Consuming it from a web UI" rewritten around B4Activity
apps/web/content/docs/upgrading.mdx     entry: renderers moved to ./copilotkit; legacy cards deprecated
packages/ag-ui/README.md                "## Activity components" + "## CopilotKit connector"; rungs kept
examples/chat/web/app/page.tsx          import from @b4run/ag-ui/copilotkit
.changeset/ag-ui-react-kit.md           patch, **Breaking:** renderers moved
```

Every task below runs from the worktree root with Node 24 (`source ~/.nvm/nvm.sh; nvm use 24`). Package-filtered commands: `pnpm --filter @b4run/ag-ui exec vitest run <files>`, `pnpm --filter @b4run/ag-ui typecheck`, `pnpm --filter @b4run/ag-ui lint`.

---

# PR 1 — React kit (`./react`)

### Task 1: DOM test environment for `packages/ag-ui`

**Files:**
- Modify: `packages/ag-ui/package.json` (devDependencies)
- Create: `packages/ag-ui/test/react/dom-environment.test.tsx`

- [ ] **Step 1: Add the devDependencies**

In `packages/ag-ui/package.json` `devDependencies`, add (keep the object sorted as it is today, alphabetically by key):

```json
"@testing-library/dom": "10.4.1",
"@testing-library/react": "16.3.2",
"jsdom": "30.0.1",
```

Run: `pnpm install --frozen-lockfile=false --prefer-offline` from the repo root, then `git diff --stat pnpm-lock.yaml` — expect only the `packages/ag-ui` importer block to change (no new package tarballs; all three versions already exist in the lockfile for `packages/inspector` / `apps/web`).

- [ ] **Step 2: Write a smoke test that proves jsdom + Testing Library work per file**

`packages/ag-ui/test/react/dom-environment.test.tsx`:

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, test } from "vitest"

function Counter() {
  const [n, setN] = useState(0)
  return (
    <button type="button" onClick={() => setN((v) => v + 1)}>
      clicks: {n}
    </button>
  )
}

describe("jsdom environment", () => {
  test("renders and handles a click", () => {
    render(<Counter />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByRole("button").textContent).toBe("clicks: 1")
  })
})
```

- [ ] **Step 3: Run it**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react/dom-environment.test.tsx`
Expected: 1 passed. Also run `pnpm --filter @b4run/ag-ui typecheck` (the test tsconfig must pick up `@testing-library/react` types; if it reports `Cannot find module '@testing-library/react'`, check `packages/ag-ui/tsconfig.test.json` `types`/`include` — it includes `test/**/*.tsx` today).

- [ ] **Step 4: Commit**

```bash
git add packages/ag-ui/package.json pnpm-lock.yaml packages/ag-ui/test/react/dom-environment.test.tsx
git commit -m "test(ag-ui): jsdom and Testing Library for component interaction tests

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 2: `format.ts` — durations, summary line, plan progress, reasoning label

**Files:**
- Create: `packages/ag-ui/src/react/activity/format.ts`
- Test: `packages/ag-ui/test/react/format.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "vitest"
import {
  countSources,
  countSteps,
  formatDuration,
  planProgress,
  reasoningLabel,
  summaryLine,
} from "../../src/react/activity/format.js"
import type { ToolStep, TurnView } from "../../src/view/turns.js"

const tool = (o: Partial<ToolStep> & { id: string; name: string }): ToolStep => ({
  kind: "tool",
  status: "done",
  args: "",
  startedAt: 0,
  settledAt: 1000,
  ...o,
})
const turn = (o: Partial<TurnView>): TurnView => ({
  runId: "r",
  status: "done",
  startedAt: 0,
  endedAt: 72_000,
  steps: [],
  text: "",
  approvals: [],
  failed: 0,
  ...o,
})

describe("formatDuration", () => {
  test("uses <1s, Ns, Nm Ms and never claims <1s for unknown", () => {
    expect(formatDuration(0)).toBe("<1s")
    expect(formatDuration(999)).toBe("<1s")
    expect(formatDuration(12_000)).toBe("12s")
    expect(formatDuration(72_000)).toBe("1m 12s")
    expect(formatDuration(600_000)).toBe("10m 0s")
    expect(formatDuration(Number.NaN)).toBeUndefined()
    expect(formatDuration(-5)).toBeUndefined()
  })
})

describe("summaryLine", () => {
  test("working shows the newest running label and the elapsed time", () => {
    const t = turn({
      status: "working",
      endedAt: undefined,
      steps: [
        tool({ id: "a", name: "recall", label: "Checked memory", startedAt: 0 }),
        tool({ id: "b", name: "searchCorpus", status: "running", label: "Searching the corpus", startedAt: 500, settledAt: undefined }),
      ],
    })
    expect(summaryLine(t, 12_400)).toEqual({ text: "Searching the corpus", meta: "· 12s", live: true })
  })
  test("working with no running step falls back to Working", () => {
    expect(summaryLine(turn({ status: "working", endedAt: undefined }), 400)).toEqual({ text: "Working", meta: "· <1s", live: true })
  })
  test("awaiting reads Waiting for your approval", () => {
    expect(summaryLine(turn({ status: "awaiting", endedAt: undefined }), 38_000)).toEqual({ text: "Waiting for your approval", meta: "· 38s", live: false })
  })
  test("done counts steps, sources and failures", () => {
    const t = turn({
      steps: [
        tool({ id: "a", name: "searchCorpus", sources: [{ title: "a.md" }, { title: "b.md" }] }),
        tool({ id: "b", name: "readDoc", sources: [{ title: "c.md" }] }),
        tool({ id: "c", name: "writeFile" }),
      ],
    })
    expect(summaryLine(t, 999_999)).toEqual({ text: "Worked for 1m 12s", meta: "· 3 steps · 3 sources", live: false })
    expect(summaryLine(turn({ ...t, status: "failed", failed: 1 }), 0).meta).toBe("· 3 steps · 3 sources · 1 failed")
    expect(summaryLine(turn({ steps: [tool({ id: "a", name: "x" })] }), 0).meta).toBe("· 1 step")
  })
  test("stopped reads Stopped after d; an unknown duration drops the time", () => {
    expect(summaryLine(turn({ status: "stopped", endedAt: 41_000 }), 0)).toEqual({ text: "Stopped after 41s", meta: "", live: false })
    expect(summaryLine(turn({ status: "done", endedAt: undefined, startedAt: 5000 }), 0).text).toBe("Worked")
  })
})

describe("counts and labels", () => {
  test("countSteps counts nested subagent steps and groups as one each", () => {
    const nested = turn({ steps: [tool({ id: "n1", name: "readDoc" }), tool({ id: "n2", name: "readDoc" })] })
    const t = turn({
      steps: [
        tool({ id: "a", name: "x" }),
        { kind: "subagent", id: "s", name: "researcher", status: "done", startedAt: 0, turn: nested },
      ],
    })
    expect(countSteps(t)).toBe(4)
    expect(countSources(t)).toBe(0)
  })
  test("planProgress and reasoningLabel", () => {
    expect(planProgress([{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }])).toEqual({ done: 1, total: 3 })
    expect(reasoningLabel({ kind: "reasoning", id: "r", text: "hmm", status: "streaming", startedAt: 0 })).toBe("Thinking…")
    expect(reasoningLabel({ kind: "reasoning", id: "r", text: "hmm", status: "done", startedAt: 0, settledAt: 4000 })).toBe("Thought for 4s")
    expect(reasoningLabel({ kind: "reasoning", id: "r", text: "", status: "done", startedAt: 0, settledAt: 4000 })).toBe("Thought for 4s")
    expect(reasoningLabel({ kind: "reasoning", id: "r", text: "hmm", status: "done", startedAt: 0 })).toBe("Show reasoning")
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react/format.test.ts`
Expected: FAIL — cannot resolve `../../src/react/activity/format.js`.

- [ ] **Step 3: Implement**

`packages/ag-ui/src/react/activity/format.ts`:

```ts
import type { B4PlanActivityContent } from "../../activities.js"
import type { ReasoningStep, StepView, ToolStep, TurnView } from "../../view/turns.js"

/**
 * `<1s`, `Ns`, `Nm Ms` (the host chat's format). Undefined for an unknown or
 * negative duration: the UI then drops the time rather than claiming `<1s`.
 */
export function formatDuration(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return "<1s"
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

const isTool = (step: StepView): step is ToolStep => step.kind === "tool"

/** Steps in this turn and every nested subagent turn (a subagent counts as one step too). */
export function countSteps(turn: TurnView): number {
  let n = 0
  for (const step of turn.steps) {
    n += 1
    if (step.kind === "subagent") n += countSteps(step.turn)
  }
  return n
}

export function countSources(turn: TurnView): number {
  let n = 0
  for (const step of turn.steps) {
    if (isTool(step)) n += step.sources?.length ?? 0
    else if (step.kind === "subagent") n += countSources(step.turn)
  }
  return n
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`

export interface SummaryLine {
  /** The sentence ("Searching the corpus", "Worked for 1m 12s"). */
  readonly text: string
  /** The muted tail ("· 12s", "· 9 steps · 3 sources · 1 failed"), possibly empty. */
  readonly meta: string
  /** Whether the text is the running treatment (shimmer) — only while working. */
  readonly live: boolean
}

/** The newest running tool step's label, searching nested turns too. */
function activeLabel(turn: TurnView): string | undefined {
  let best: { startedAt: number; label: string } | undefined
  const visit = (t: TurnView) => {
    for (const step of t.steps) {
      if (isTool(step) && step.status === "running" && step.label) {
        if (best === undefined || step.startedAt >= best.startedAt) best = { startedAt: step.startedAt, label: step.label }
      } else if (step.kind === "subagent") visit(step.turn)
    }
  }
  visit(turn)
  return best?.label
}

/** The summary line for a turn at time `now` (spec §3.1). */
export function summaryLine(turn: TurnView, now: number): SummaryLine {
  const elapsed = formatDuration((turn.endedAt ?? now) - turn.startedAt)
  const tick = elapsed === undefined ? "" : `· ${elapsed}`
  switch (turn.status) {
    case "working":
      return { text: activeLabel(turn) ?? "Working", meta: tick, live: true }
    case "awaiting":
      return { text: "Waiting for your approval", meta: tick, live: false }
    case "stopped":
      return { text: elapsed === undefined ? "Stopped" : `Stopped after ${elapsed}`, meta: "", live: false }
    default: {
      const parts = [plural(countSteps(turn), "step")]
      const sources = countSources(turn)
      if (sources > 0) parts.push(plural(sources, "source"))
      if (turn.failed > 0) parts.push(`${turn.failed} failed`)
      return {
        text: elapsed === undefined ? "Worked" : `Worked for ${elapsed}`,
        meta: `· ${parts.join(" · ")}`,
        live: false,
      }
    }
  }
}

export function planProgress(todos: B4PlanActivityContent["todos"]): { done: number; total: number } {
  return { done: todos.filter((t) => t.status === "completed").length, total: todos.length }
}

/** "Thinking…", "Thought for 4s", or "Show reasoning" when the duration is unknown (spec §3). */
export function reasoningLabel(step: ReasoningStep): string {
  if (step.status === "streaming") return "Thinking…"
  const d = step.settledAt === undefined ? undefined : formatDuration(step.settledAt - step.startedAt)
  return d === undefined ? "Show reasoning" : `Thought for ${d}`
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react/format.test.ts && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint`
Expected: all pass. (Format first: from `packages/ag-ui`, `npx biome check --write --config-path ../config-biome/biome.json src/react/activity test/react`.)

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/react/activity/format.ts packages/ag-ui/test/react/format.test.ts
git commit -m "feat(ag-ui): duration, summary-line and label formatting for the activity kit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 3: `icons.tsx` — `StepIcon`

**Files:**
- Create: `packages/ag-ui/src/react/activity/icons.tsx`
- Test: `packages/ag-ui/test/react/icons.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { TOOL_DISPLAY_ICONS } from "@b4run/sdk"
import { Chevron, StepIcon } from "../../src/react/activity/icons.js"

describe("StepIcon", () => {
  test("renders an aria-hidden 16px SVG for every ToolDisplayIcon name and the extras", () => {
    for (const name of [...TOOL_DISPLAY_ICONS, "alert", "check"] as const) {
      const markup = renderToStaticMarkup(<StepIcon name={name} />)
      expect(markup).toContain('class="b4-step__icon"')
      expect(markup).toContain('aria-hidden="true"')
      expect(markup).toContain('viewBox="0 0 16 16"')
      expect(markup).toContain('stroke="currentColor"')
    }
  })
  test("an unknown name falls back to the generic tool glyph", () => {
    expect(renderToStaticMarkup(<StepIcon name="nope" />)).toBe(renderToStaticMarkup(<StepIcon name="tool" />))
  })
  test("the chevron is 12px and aria-hidden", () => {
    const markup = renderToStaticMarkup(<Chevron />)
    expect(markup).toContain('viewBox="0 0 12 12"')
    expect(markup).toContain('class="b4-chevron"')
    expect(markup).toContain('aria-hidden="true"')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react/icons.test.tsx` — FAIL (module missing).

- [ ] **Step 3: Implement**

`packages/ag-ui/src/react/activity/icons.tsx` (paths lifted from the mockup's `<symbol>`s; `think`→i-think, `plan`→i-list, `search`→i-search, `read`→i-doc, `agent`→i-agent, `run`→i-term, `write`→i-write, `memory`→i-mem, `alert`→i-alert; `web` and `tool` are new):

```tsx
import type { ReactElement } from "react"

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" } as const

/** One glyph per `ToolDisplayIcon` name plus `alert` and `check`; 16×16, `currentColor`, 1.3 stroke. */
const GLYPHS: Readonly<Record<string, ReactElement>> = {
  think: (
    <>
      <path d="M8 2.5a4 4 0 0 0-2.3 7.3c.4.3.6.7.6 1.2v.5h3.4V11c0-.5.2-.9.6-1.2A4 4 0 0 0 8 2.5Z" {...STROKE} />
      <path d="M6.6 13.5h2.8" {...STROKE} />
    </>
  ),
  plan: (
    <>
      <path d="M6 4h7M6 8h7M6 12h7" {...STROKE} />
      <path d="m2.5 4 .8.8L4.6 3.3M2.5 8l.8.8 1.3-1.5" {...STROKE} strokeWidth={1.2} />
      <circle cx="3.4" cy="12" r=".9" {...STROKE} strokeWidth={1.1} />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.2" {...STROKE} />
      <path d="m10.2 10.2 3.3 3.3" {...STROKE} />
    </>
  ),
  read: (
    <>
      <path d="M4 2h5.5L12 4.5V14H4z" {...STROKE} />
      <path d="M6 8h4M6 10.5h4" {...STROKE} strokeWidth={1.2} />
    </>
  ),
  write: <path d="M3 13l.6-2.6L10.5 3.5l2 2L5.6 12.4z" {...STROKE} />,
  run: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" {...STROKE} />
      <path d="m5 7 1.6 1.4L5 9.8M8.2 10h2.6" {...STROKE} strokeWidth={1.2} />
    </>
  ),
  web: (
    <>
      <circle cx="8" cy="8" r="5.5" {...STROKE} />
      <path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11" {...STROKE} strokeWidth={1.1} />
    </>
  ),
  memory: <path d="M3 4.5C3 3.7 5.2 3 8 3s5 .7 5 1.5-2.2 1.5-5 1.5S3 5.3 3 4.5Zm0 0v7C3 12.3 5.2 13 8 13s5-.7 5-1.5v-7" {...STROKE} />,
  agent: (
    <>
      <circle cx="8" cy="5.5" r="2.5" {...STROKE} />
      <path d="M3 13.5c.6-2.4 2.6-3.8 5-3.8s4.4 1.4 5 3.8" {...STROKE} />
    </>
  ),
  tool: (
    <>
      <circle cx="8" cy="8" r="2.2" {...STROKE} />
      <path d="M8 2v2M8 12v2M2 8h2M12 8h2M3.8 3.8l1.4 1.4M10.8 10.8l1.4 1.4M3.8 12.2l1.4-1.4M10.8 5.2l1.4-1.4" {...STROKE} strokeWidth={1.2} />
    </>
  ),
  alert: (
    <>
      <path d="M8 5v3.5" {...STROKE} strokeWidth={1.5} />
      <circle cx="8" cy="11" r=".9" fill="currentColor" />
      <circle cx="8" cy="8" r="6" {...STROKE} />
    </>
  ),
  check: <path d="m3.5 8.5 2.8 2.8 6.2-6.6" {...STROKE} strokeWidth={1.5} />,
}

/** A step's glyph. Unknown names draw the generic `tool` glyph. */
export function StepIcon({ name }: { readonly name: string | undefined }): ReactElement {
  const glyph = (name !== undefined && GLYPHS[name]) || (GLYPHS.tool as ReactElement)
  return (
    <svg className="b4-step__icon" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {glyph}
    </svg>
  )
}

/** The disclosure chevron; CSS rotates it 90° when open. */
export function Chevron(): ReactElement {
  return (
    <svg className="b4-chevron" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false">
      <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
```

Note: `GLYPHS` must contain every member of `TOOL_DISPLAY_ICONS` (`search, read, write, run, web, memory, plan, agent, think, tool`); the test iterates the SDK constant so a future icon name added to the SDK fails here until drawn.

- [ ] **Step 4: Run tests, typecheck, lint; commit**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react/icons.test.tsx && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint` — pass.

```bash
git add packages/ag-ui/src/react/activity/icons.tsx packages/ag-ui/test/react/icons.test.tsx
git commit -m "feat(ag-ui): StepIcon glyphs for every ToolDisplayIcon

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 4: `Disclosure` + `useDisclosure` + `useLive`

**Files:**
- Create: `packages/ag-ui/src/react/activity/Disclosure.tsx`, `packages/ag-ui/src/react/activity/useLive.ts`
- Test: `packages/ag-ui/test/react/Disclosure.test.tsx`

Behaviour (spec §3.1 "Open and closed", "No spinner flash", "Summary line … ticks once a second"):
- `useDisclosure({ autoOpen, live })`: `open = manual ?? autoOpen`. A click sets `manual`. When `live` flips from `false` to `true` the manual choice is cleared (the item "becomes live again", so automation wins). Returns `{ open, toggle }`.
- `useElapsed(active, now)`: returns `now()` re-sampled every 1000 ms while `active`; static otherwise.
- `useLive(step)`: true when `step.status === "running"` AND it has been running ≥ 300 ms (re-evaluated after a 300 ms timer), so a call settling within 300 ms never shows its running treatment.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Disclosure } from "../../src/react/activity/Disclosure.js"
import { useElapsed, useLive } from "../../src/react/activity/useLive.js"
import type { ToolStep } from "../../src/view/turns.js"

describe("Disclosure", () => {
  test("renders a button with aria-expanded, toggles on click, and the panel only when open", () => {
    render(
      <Disclosure autoOpen={false} live={false} className="x" summary={<span>sum</span>}>
        <p>panel</p>
      </Disclosure>,
    )
    const button = screen.getByRole("button", { name: "sum" })
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByText("panel")).toBeNull()
    fireEvent.click(button)
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(screen.getByText("panel")).toBeTruthy()
  })

  test("a manual toggle wins until the item becomes live again", () => {
    const { rerender } = render(
      <Disclosure autoOpen={true} live={true} className="x" summary="s">
        <p>panel</p>
      </Disclosure>,
    )
    fireEvent.click(screen.getByRole("button"))
    expect(screen.queryByText("panel")).toBeNull()
    rerender(
      <Disclosure autoOpen={false} live={false} className="x" summary="s">
        <p>panel</p>
      </Disclosure>,
    )
    expect(screen.queryByText("panel")).toBeNull()
    rerender(
      <Disclosure autoOpen={true} live={true} className="x" summary="s">
        <p>panel</p>
      </Disclosure>,
    )
    expect(screen.getByText("panel")).toBeTruthy()
  })
})

describe("useLive / useElapsed", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function Probe({ step, now }: { step: ToolStep; now: () => number }) {
    const live = useLive(step, now)
    const t = useElapsed(step.status === "running", now)
    return <output>{`${live}:${t}`}</output>
  }
  const step = (status: ToolStep["status"], startedAt: number): ToolStep => ({ kind: "tool", id: "a", name: "x", status, args: "", startedAt })

  test("a running step is not live for its first 300 ms, then is", () => {
    let clock = 1000
    const now = () => clock
    render(<Probe step={step("running", 1000)} now={now} />)
    expect(screen.getByRole("status").textContent).toBe("false:1000")
    act(() => {
      clock = 1400
      vi.advanceTimersByTime(300)
    })
    expect(screen.getByRole("status").textContent?.startsWith("true:")).toBe(true)
  })

  test("a step that starts old is live immediately; done is never live", () => {
    const old = render(<Probe step={step("running", 0)} now={() => 5000} />)
    expect(old.container.textContent).toBe("true:5000")
    const done = render(<Probe step={step("done", 0)} now={() => 5000} />)
    expect(done.container.textContent).toBe("false:5000")
  })

  test("elapsed re-samples the clock every second while active", () => {
    let clock = 0
    render(<Probe step={step("running", 0)} now={() => clock} />)
    act(() => {
      clock = 2500
      vi.advanceTimersByTime(1000)
    })
    expect(screen.getByRole("status").textContent?.endsWith(":2500")).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react/Disclosure.test.tsx` — FAIL (modules missing).

- [ ] **Step 3: Implement `useLive.ts`**

```ts
import { useEffect, useState } from "react"
import type { ToolStep } from "../../view/turns.js"

/** A step settling within this window never shows its running treatment (spec §3.1). */
export const NO_FLASH_MS = 300

/** `now()` re-sampled once a second while `active`; the last sample otherwise. */
export function useElapsed(active: boolean, now: () => number): number {
  const [tick, setTick] = useState(() => now())
  useEffect(() => {
    setTick(now())
    if (!active) return
    const id = setInterval(() => setTick(now()), 1000)
    return () => clearInterval(id)
  }, [active, now])
  return tick
}

/** Whether a tool step shows as running: running for at least `NO_FLASH_MS`. */
export function useLive(step: Pick<ToolStep, "status" | "startedAt">, now: () => number): boolean {
  const running = step.status === "running"
  const age = now() - step.startedAt
  const [past, setPast] = useState(age >= NO_FLASH_MS)
  useEffect(() => {
    if (!running) return
    const remaining = NO_FLASH_MS - (now() - step.startedAt)
    if (remaining <= 0) {
      setPast(true)
      return
    }
    setPast(false)
    const id = setTimeout(() => setPast(true), remaining)
    return () => clearTimeout(id)
  }, [running, step.startedAt, now])
  return running && past
}
```

- [ ] **Step 4: Implement `Disclosure.tsx`**

```tsx
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { Chevron } from "./icons.js"

/**
 * Open/closed per spec §3.1: automation decides until the user toggles, and
 * the user's choice holds until the item becomes live again.
 */
export function useDisclosure(autoOpen: boolean, live: boolean): { open: boolean; toggle: () => void } {
  const [manual, setManual] = useState<boolean | undefined>(undefined)
  const wasLive = useRef(live)
  useEffect(() => {
    if (live && !wasLive.current) setManual(undefined)
    wasLive.current = live
  }, [live])
  const open = manual ?? autoOpen
  const toggle = useCallback(() => setManual(!open), [open])
  return { open, toggle }
}

export interface DisclosureProps {
  readonly autoOpen: boolean
  readonly live: boolean
  /** Class of the toggle button (`b4-turn__summary`, `b4-step__line`). */
  readonly className: string
  readonly summary: ReactNode
  /** Rendered only while open. */
  readonly children: ReactNode
  /** Extra attributes for the button (data-state and the like). */
  readonly buttonProps?: Readonly<Record<string, string | undefined>>
  /** Wrapper around the panel (`b4-step__detail`, `b4-step__children`); defaults to a fragment. */
  readonly panelClassName?: string
  /** When set, the parent reads the open state (for `data-expanded`). */
  readonly onOpenChange?: (open: boolean) => void
}

/** A `<button aria-expanded>` plus its panel; 24px+ tall through CSS (spec §5.5). */
export function Disclosure(props: DisclosureProps): ReactElement {
  const { open, toggle } = useDisclosure(props.autoOpen, props.live)
  const { onOpenChange } = props
  useEffect(() => onOpenChange?.(open), [open, onOpenChange])
  return (
    <>
      <button type="button" className={props.className} aria-expanded={open} onClick={toggle} {...props.buttonProps}>
        <Chevron />
        {props.summary}
      </button>
      {open ? (props.panelClassName ? <div className={props.panelClassName}>{props.children}</div> : props.children) : null}
    </>
  )
}
```

- [ ] **Step 5: Run tests, typecheck, lint; commit**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react/Disclosure.test.tsx && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint` — pass.

```bash
git add packages/ag-ui/src/react/activity/Disclosure.tsx packages/ag-ui/src/react/activity/useLive.ts packages/ag-ui/test/react/Disclosure.test.tsx
git commit -m "feat(ag-ui): Disclosure with the open/closed rule, no-flash and elapsed hooks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 5: `StatusText`, `SourceChips`, `StepDetail`

**Files:**
- Create: `packages/ag-ui/src/react/activity/StatusText.tsx`, `packages/ag-ui/src/react/activity/SourceChips.tsx`, `packages/ag-ui/src/react/activity/StepDetail.tsx`
- Test: `packages/ag-ui/test/react/StepDetail.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SourceChips } from "../../src/react/activity/SourceChips.js"
import { StatusText } from "../../src/react/activity/StatusText.js"
import { prettyValue, StepDetail } from "../../src/react/activity/StepDetail.js"

describe("StatusText", () => {
  test("renders the muted meta fragment, or nothing when empty", () => {
    expect(renderToStaticMarkup(<StatusText>· 4 of 4 done</StatusText>)).toBe('<span class="b4-step__meta">· 4 of 4 done</span>')
    expect(renderToStaticMarkup(<StatusText>{""}</StatusText>)).toBe("")
  })
})

describe("SourceChips", () => {
  test("renders a labelled list of chips with +N overflow after the limit", () => {
    const markup = renderToStaticMarkup(
      <SourceChips sources={[{ title: "a.md" }, { title: "b.md", href: "https://x.test/b" }, { title: "c.md" }, { title: "d.md" }]} limit={3} />,
    )
    expect(markup).toContain('<ul class="b4-step__sources" aria-label="Sources">')
    expect(markup).toContain('<a class="b4-chip" href="https://x.test/b" target="_blank" rel="noreferrer">b.md</a>')
    expect(markup).toContain('<span class="b4-chip">a.md</span>')
    expect(markup).toContain('<li class="b4-chip b4-chip--more">+1</li>')
    expect(markup).not.toContain("d.md")
  })
  test("renders nothing for no sources", () => {
    expect(renderToStaticMarkup(<SourceChips sources={[]} />)).toBe("")
  })
})

describe("StepDetail", () => {
  test("pretty-prints JSON inputs and output, labels the sections, and passes text through", () => {
    const markup = renderToStaticMarkup(<StepDetail args='{"query":"a"}' result="3 hits" />)
    expect(markup).toContain('<div class="b4-step__detail">')
    expect(markup).toContain('<h4 class="b4-step__detail-label">Inputs</h4>')
    expect(markup).toContain('<pre class="b4-step__code">{\n  &quot;query&quot;: &quot;a&quot;\n}</pre>')
    expect(markup).toContain('<h4 class="b4-step__detail-label">Output</h4>')
    expect(markup).toContain('<pre class="b4-step__code">3 hits</pre>')
  })
  test("omits an empty section and never throws on bad JSON", () => {
    expect(prettyValue("{not json")).toBe("{not json")
    expect(prettyValue("")).toBe("")
    const markup = renderToStaticMarkup(<StepDetail args="" result={undefined} />)
    expect(markup).toBe('<div class="b4-step__detail"><p class="b4-step__detail-empty">No details yet.</p></div>')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @b4run/ag-ui exec vitest run test/react/StepDetail.test.tsx` → FAIL.

- [ ] **Step 3: Implement**

`StatusText.tsx`:

```tsx
import type { ReactElement, ReactNode } from "react"

/** The muted "· …" fragment after a sentence. Renders nothing for empty content. */
export function StatusText({ children }: { readonly children: ReactNode }): ReactElement | null {
  if (children === "" || children === null || children === undefined || children === false) return null
  return <span className="b4-step__meta">{children}</span>
}
```

`SourceChips.tsx`:

```tsx
import type { ReactElement } from "react"
import type { StepSource } from "../../view/turns.js"

export interface SourceChipsProps {
  readonly sources: readonly StepSource[]
  /** Chips shown before the "+N" overflow chip. */
  readonly limit?: number
}

/** File or URL chips from a step's `sources` (spec §3), with "+N" overflow. */
export function SourceChips({ sources, limit = 3 }: SourceChipsProps): ReactElement | null {
  if (sources.length === 0) return null
  const shown = sources.slice(0, limit)
  const more = sources.length - shown.length
  return (
    <ul className="b4-step__sources" aria-label="Sources">
      {shown.map((source, index) => (
        <li key={`${source.title}:${index}`}>
          {source.href ? (
            <a className="b4-chip" href={source.href} target="_blank" rel="noreferrer">
              {source.title}
            </a>
          ) : (
            <span className="b4-chip">{source.title}</span>
          )}
        </li>
      ))}
      {more > 0 ? <li className="b4-chip b4-chip--more">+{more}</li> : null}
    </ul>
  )
}
```

`StepDetail.tsx`:

```tsx
import type { ReactElement } from "react"

/** JSON pretty-printed with two spaces; anything else (or invalid JSON) as-is. Never throws. */
export function prettyValue(text: string): string {
  if (text.trim() === "") return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

export interface StepDetailProps {
  readonly args: string
  readonly result?: string | undefined
}

/** A step's Inputs and Output (spec §3 `StepDetail`); CSS caps it at 250px with scroll. */
export function StepDetail({ args, result }: StepDetailProps): ReactElement {
  const inputs = prettyValue(args)
  const output = result === undefined ? "" : prettyValue(result)
  const empty = inputs.trim() === "" && output.trim() === ""
  return (
    <div className="b4-step__detail">
      {empty ? <p className="b4-step__detail-empty">No details yet.</p> : null}
      {inputs.trim() !== "" ? (
        <>
          <h4 className="b4-step__detail-label">Inputs</h4>
          <pre className="b4-step__code">{inputs}</pre>
        </>
      ) : null}
      {output.trim() !== "" ? (
        <>
          <h4 className="b4-step__detail-label">Output</h4>
          <pre className="b4-step__code">{output}</pre>
        </>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add packages/ag-ui/src/react/activity/StatusText.tsx packages/ag-ui/src/react/activity/SourceChips.tsx packages/ag-ui/src/react/activity/StepDetail.tsx packages/ag-ui/test/react/StepDetail.test.tsx
git commit -m "feat(ag-ui): StatusText, SourceChips and StepDetail blocks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 6: `Step` — the tool step row

**Files:**
- Create: `packages/ag-ui/src/react/activity/Step.tsx`
- Test: `packages/ag-ui/test/react/Step.test.tsx`

Contract (spec §5.6): `li.b4-step[data-state][data-kind=tool][data-expanded?]` > `button.b4-step__line[aria-expanded]` > `.b4-step__icon .b4-step__text .b4-step__meta`, then `.b4-step__sources` and (when open) `.b4-step__detail`. Rules: label from `stepLabel(step, labels)`; a running step not yet live (300 ms) renders `data-state="pending"`; a failed step auto-opens (§3.1); meta: `· awaiting approval` while awaiting, `· failed` when failed with no result, nothing otherwise; `renderStep[name]` replaces the detail panel.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Step } from "../../src/react/activity/Step.js"
import type { ToolStep } from "../../src/view/turns.js"

const tool = (o: Partial<ToolStep> & { id: string; name: string }): ToolStep => ({
  kind: "tool",
  status: "done",
  args: '{"query":"a"}',
  startedAt: 0,
  settledAt: 1000,
  ...o,
})
const now = () => 10_000

describe("Step", () => {
  test("renders the DOM contract with the server label and sources, closed by default", () => {
    const markup = renderToStaticMarkup(
      <Step step={tool({ id: "a", name: "searchCorpus", icon: "search", label: "Searched the corpus", sources: [{ title: "a.md" }] })} now={now} />,
    )
    expect(markup).toContain('<li class="b4-step" data-state="done" data-kind="tool">')
    expect(markup).toContain('<button type="button" class="b4-step__line" aria-expanded="false">')
    expect(markup).toContain('<span class="b4-step__text">Searched the corpus</span>')
    expect(markup).toContain('class="b4-step__sources"')
    expect(markup).not.toContain("b4-step__detail")
  })
  test("falls back to Used x / an override, and a running step reads as pending for 300 ms", () => {
    expect(renderToStaticMarkup(<Step step={tool({ id: "a", name: "x" })} now={now} />)).toContain(">Used x<")
    expect(renderToStaticMarkup(<Step step={tool({ id: "a", name: "x" })} labels={{ x: { done: () => "Did x" } }} now={now} />)).toContain(">Did x<")
    const fresh = renderToStaticMarkup(<Step step={tool({ id: "a", name: "x", status: "running", startedAt: 9_900, settledAt: undefined })} now={now} />)
    expect(fresh).toContain('data-state="pending"')
    const old = renderToStaticMarkup(<Step step={tool({ id: "a", name: "x", status: "running", startedAt: 0, settledAt: undefined })} now={now} />)
    expect(old).toContain('data-state="running"')
  })
  test("awaiting and failed add meta; a failed step opens itself", () => {
    expect(renderToStaticMarkup(<Step step={tool({ id: "a", name: "x", status: "awaiting" })} now={now} />)).toContain('<span class="b4-step__meta">· awaiting approval</span>')
    const failed = renderToStaticMarkup(<Step step={tool({ id: "a", name: "x", status: "failed", result: "ENOENT" })} now={now} />)
    expect(failed).toContain('data-state="failed" data-kind="tool" data-expanded="true"')
    expect(failed).toContain('aria-expanded="true"')
    expect(failed).toContain("ENOENT")
  })
  test("clicking opens the detail; renderStep replaces it", () => {
    const { rerender } = render(<Step step={tool({ id: "a", name: "x", result: "3 hits" })} now={now} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByText("3 hits")).toBeTruthy()
    rerender(<Step step={tool({ id: "a", name: "x", result: "3 hits" })} now={now} renderStep={{ x: ({ step }) => <table data-testid="t">{step.result}</table> }} />)
    expect(screen.getByTestId("t").textContent).toBe("3 hits")
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement `Step.tsx`**

```tsx
import { type ReactElement, type ReactNode, useState } from "react"
import { type StepLabelOverrides, stepLabel } from "../../view/labels.js"
import type { ToolStep } from "../../view/turns.js"
import { Disclosure } from "./Disclosure.js"
import { StepIcon } from "./icons.js"
import { SourceChips } from "./SourceChips.js"
import { StatusText } from "./StatusText.js"
import { StepDetail } from "./StepDetail.js"
import { useLive } from "./useLive.js"

/** An app view that replaces a step's `StepDetail` (spec §3.1 "Per-tool views"). */
export type StepRenderer = (props: { readonly step: ToolStep }) => ReactNode
export type StepRenderers = Readonly<Record<string, StepRenderer>>

export interface StepProps {
  readonly step: ToolStep
  readonly labels?: StepLabelOverrides | undefined
  readonly renderStep?: StepRenderers | undefined
  readonly now: () => number
}

function meta(step: ToolStep): string {
  if (step.status === "awaiting") return "· awaiting approval"
  if (step.status === "failed" && step.result === undefined) return "· failed"
  return ""
}

/** One tool call as a sentence; opens to its inputs and output (spec §3 `Step`). */
export function Step({ step, labels, renderStep, now }: StepProps): ReactElement {
  const live = useLive(step, now)
  const state = step.status === "running" && !live ? "pending" : step.status
  const [expanded, setExpanded] = useState(step.status === "failed")
  const custom = Object.hasOwn(renderStep ?? {}, step.name) ? renderStep?.[step.name] : undefined
  return (
    <li className="b4-step" data-state={state} data-kind="tool" {...(expanded ? { "data-expanded": "true" } : {})}>
      <Disclosure
        className="b4-step__line"
        autoOpen={step.status === "failed"}
        live={live}
        onOpenChange={setExpanded}
        summary={
          <>
            <StepIcon name={step.status === "failed" ? "alert" : step.icon} />
            <span className="b4-step__text">{stepLabel(step, labels)}</span>
            <StatusText>{meta(step)}</StatusText>
          </>
        }
      >
        {custom ? <div className="b4-step__detail">{custom({ step })}</div> : <StepDetail args={step.args} result={step.result} />}
      </Disclosure>
      {step.sources ? <SourceChips sources={step.sources} /> : null}
    </li>
  )
}
```

Note on `data-expanded`: the first static render of a failed step must already carry it, which is why the initial `useState` mirrors `autoOpen`; `onOpenChange` keeps it in sync after clicks.

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add packages/ag-ui/src/react/activity/Step.tsx packages/ag-ui/test/react/Step.test.tsx
git commit -m "feat(ag-ui): Step renders a tool call as a sentence with detail and sources

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 7: `PlanStep` + `Checklist`

**Files:**
- Create: `packages/ag-ui/src/react/activity/PlanStep.tsx`
- Test: `packages/ag-ui/test/react/PlanStep.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { Checklist, PlanStep } from "../../src/react/activity/PlanStep.js"
import type { PlanStep as PlanStepView } from "../../src/view/turns.js"

const plan = (todos: PlanStepView["todos"]): PlanStepView => ({ kind: "plan", id: "p", todos, startedAt: 0, updatedAt: 0 })
const todos: PlanStepView["todos"] = [
  { content: "Restate the question", status: "completed" },
  { content: "Search the corpus", status: "in_progress" },
  { content: "Write the comparison", status: "pending" },
]

describe("PlanStep", () => {
  test("reads Made a plan · 1 of 3 done, open while the turn is live, with an SVG checklist", () => {
    const markup = renderToStaticMarkup(<PlanStep step={plan(todos)} live={true} />)
    expect(markup).toContain('<li class="b4-step" data-state="running" data-kind="plan" data-expanded="true">')
    expect(markup).toContain('<span class="b4-step__text">Made a plan</span><span class="b4-step__meta">· 1 of 3 done</span>')
    expect(markup).toContain('<ol class="b4-checklist" aria-label="Plan">')
    expect(markup).toContain('<li class="b4-checklist__item" data-status="completed">')
    expect(markup).toContain('<li class="b4-checklist__item" data-status="in_progress">')
    expect(markup).toContain("Search the corpus")
  })
  test("settles when the turn ends: done state, closed by default", () => {
    const markup = renderToStaticMarkup(<PlanStep step={plan(todos.map((t) => ({ ...t, status: "completed" })))} live={false} />)
    expect(markup).toContain('data-state="done" data-kind="plan">')
    expect(markup).toContain("· 3 of 3 done")
    expect(markup).not.toContain("b4-checklist")
  })
  test("Checklist is exported for custom steps", () => {
    expect(renderToStaticMarkup(<Checklist todos={todos} />)).toContain('data-status="pending"')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```tsx
import { type ReactElement, useState } from "react"
import type { B4PlanActivityContent } from "../../activities.js"
import type { PlanStep as PlanStepView } from "../../view/turns.js"
import { Disclosure } from "./Disclosure.js"
import { planProgress } from "./format.js"
import { StepIcon } from "./icons.js"
import { StatusText } from "./StatusText.js"

/** The plan's checklist (spec §3 `PlanStep`): SVG boxes, done items struck through by CSS. */
export function Checklist({ todos }: { readonly todos: B4PlanActivityContent["todos"] }): ReactElement {
  return (
    <ol className="b4-checklist" aria-label="Plan">
      {todos.map((todo, index) => (
        <li key={`${index}:${todo.content}`} className="b4-checklist__item" data-status={todo.status}>
          <svg className="b4-checklist__box" viewBox="0 0 14 14" width="14" height="14" aria-hidden="true" focusable="false">
            <rect x="0.7" y="0.7" width="12.6" height="12.6" rx="3" fill={todo.status === "completed" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.4" />
            {todo.status === "completed" ? <path d="m3.5 7.2 2.3 2.3 4.7-5" fill="none" stroke="var(--b4-activity-on-primary)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /> : null}
          </svg>
          <span className="b4-checklist__text">{todo.content}</span>
          <span className="b4-visually-hidden">{todo.status === "completed" ? " (done)" : todo.status === "in_progress" ? " (in progress)" : " (pending)"}</span>
        </li>
      ))}
    </ol>
  )
}

export interface PlanStepProps {
  readonly step: PlanStepView
  /** Whether the owning turn is still working; the plan is running only then (spec §3). */
  readonly live: boolean
}

/** "Made a plan · 2 of 4 done" with the checklist (spec §3 `PlanStep`). Updates in place. */
export function PlanStep({ step, live }: PlanStepProps): ReactElement {
  const { done, total } = planProgress(step.todos)
  const [expanded, setExpanded] = useState(live)
  return (
    <li className="b4-step" data-state={live ? "running" : "done"} data-kind="plan" {...(expanded ? { "data-expanded": "true" } : {})}>
      <Disclosure
        className="b4-step__line"
        autoOpen={live}
        live={live}
        onOpenChange={setExpanded}
        panelClassName="b4-step__children"
        summary={
          <>
            <StepIcon name="plan" />
            <span className="b4-step__text">Made a plan</span>
            <StatusText>{`· ${done} of ${total} done`}</StatusText>
          </>
        }
      >
        <Checklist todos={step.todos} />
      </Disclosure>
    </li>
  )
}
```

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add packages/ag-ui/src/react/activity/PlanStep.tsx packages/ag-ui/test/react/PlanStep.test.tsx
git commit -m "feat(ag-ui): PlanStep and Checklist

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 8: `ReasoningStep`

**Files:**
- Create: `packages/ag-ui/src/react/activity/ReasoningStep.tsx`
- Test: `packages/ag-ui/test/react/ReasoningStep.test.tsx`

Spec §3: labels "Thinking…", "Thought for 4s", "Show reasoning" (no duration); states streaming · done · encrypted (empty text when done → not openable; the line renders as a plain `span`, not a button). Nothing closes while the user reads (handled by `useDisclosure`'s manual rule: a reasoning step is `live` only while streaming, so settling never clears a manual open).

- [ ] **Step 1: Write the failing tests**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { ReasoningStep } from "../../src/react/activity/ReasoningStep.js"
import type { ReasoningStep as View } from "../../src/view/turns.js"

const step = (o: Partial<View>): View => ({ kind: "reasoning", id: "r", text: "Let me think", status: "done", startedAt: 0, settledAt: 4000, ...o })

describe("ReasoningStep", () => {
  test("streaming reads Thinking…, is running and open", () => {
    const markup = renderToStaticMarkup(<ReasoningStep step={step({ status: "streaming", settledAt: undefined })} />)
    expect(markup).toContain('data-state="running" data-kind="reasoning" data-expanded="true"')
    expect(markup).toContain(">Thinking…<")
    expect(markup).toContain('<div class="b4-step__detail"><p class="b4-step__reasoning">Let me think</p></div>')
  })
  test("done reads Thought for 4s and is closed", () => {
    const markup = renderToStaticMarkup(<ReasoningStep step={step({})} />)
    expect(markup).toContain('data-state="done" data-kind="reasoning">')
    expect(markup).toContain(">Thought for 4s<")
    expect(markup).not.toContain("b4-step__detail")
  })
  test("encrypted (done with no text) is not openable", () => {
    const markup = renderToStaticMarkup(<ReasoningStep step={step({ text: "" })} />)
    expect(markup).toContain('<span class="b4-step__line b4-step__line--static">')
    expect(markup).not.toContain("<button")
    expect(markup).toContain(">Thought for 4s<")
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```tsx
import { type ReactElement, useState } from "react"
import type { ReasoningStep as ReasoningStepView } from "../../view/turns.js"
import { Disclosure } from "./Disclosure.js"
import { reasoningLabel } from "./format.js"
import { StepIcon } from "./icons.js"

/** A reasoning span (spec §3 `ReasoningStep`): opens to its text; encrypted spans are not openable. */
export function ReasoningStep({ step }: { readonly step: ReasoningStepView }): ReactElement {
  const streaming = step.status === "streaming"
  const encrypted = !streaming && step.text.trim() === ""
  const [expanded, setExpanded] = useState(streaming)
  const summary = (
    <>
      <StepIcon name="think" />
      <span className="b4-step__text">{reasoningLabel(step)}</span>
    </>
  )
  return (
    <li className="b4-step" data-state={streaming ? "running" : "done"} data-kind="reasoning" {...(expanded && !encrypted ? { "data-expanded": "true" } : {})}>
      {encrypted ? (
        <span className="b4-step__line b4-step__line--static">{summary}</span>
      ) : (
        <Disclosure className="b4-step__line" autoOpen={streaming} live={streaming} onOpenChange={setExpanded} panelClassName="b4-step__detail" summary={summary}>
          <p className="b4-step__reasoning">{step.text}</p>
        </Disclosure>
      )}
    </li>
  )
}
```

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add packages/ag-ui/src/react/activity/ReasoningStep.tsx packages/ag-ui/test/react/ReasoningStep.test.tsx
git commit -m "feat(ag-ui): ReasoningStep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 9: `StepGroup`

**Files:**
- Create: `packages/ag-ui/src/react/activity/StepGroup.tsx`
- Test: `packages/ag-ui/test/react/StepGroup.test.tsx`

`groupSteps` only merges `done` tool steps, so a group is always `done`; it renders `li.b4-step[data-kind=group]` with the group label, `· N calls` meta... no: the label already carries the count ("Searched the corpus 2 times"), so the meta shows the merged sources count when any. Opens to `.b4-step__children` > `ol.b4-turn__steps` of the individual `Step`s.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { StepGroup } from "../../src/react/activity/StepGroup.js"
import type { StepGroup as Group } from "../../src/view/labels.js"
import type { ToolStep } from "../../src/view/turns.js"

const tool = (id: string, o: Partial<ToolStep> = {}): ToolStep => ({ kind: "tool", id, name: "searchCorpus", status: "done", args: `{"q":"${id}"}`, startedAt: 0, settledAt: 10, icon: "search", ...o })
const group: Group = { kind: "group", name: "searchCorpus", label: "Searched the corpus 2 times", steps: [tool("a", { sources: [{ title: "a.md" }] }), tool("b")] }
const now = () => 1000

describe("StepGroup", () => {
  test("renders one closed row with the merged label and the sources count", () => {
    const markup = renderToStaticMarkup(<StepGroup group={group} now={now} />)
    expect(markup).toContain('<li class="b4-step" data-state="done" data-kind="group">')
    expect(markup).toContain('<span class="b4-step__text">Searched the corpus 2 times</span><span class="b4-step__meta">· 1 source</span>')
    expect(markup).not.toContain("b4-step__children")
  })
  test("opens to the individual steps", () => {
    render(<StepGroup group={group} now={now} />)
    fireEvent.click(screen.getByRole("button", { name: /Searched the corpus 2 times/ }))
    const items = screen.getAllByRole("listitem")
    expect(items.length).toBe(1 + 2 + 1) // group row, two steps, one source chip
    expect(screen.getAllByText("Used searchCorpus")).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```tsx
import { type ReactElement, useState } from "react"
import type { StepGroup as StepGroupView, StepLabelOverrides } from "../../view/labels.js"
import { Disclosure } from "./Disclosure.js"
import { StepIcon } from "./icons.js"
import { Step, type StepRenderers } from "./Step.js"
import { StatusText } from "./StatusText.js"

export interface StepGroupProps {
  readonly group: StepGroupView
  readonly labels?: StepLabelOverrides | undefined
  readonly renderStep?: StepRenderers | undefined
  readonly now: () => number
}

/** Consecutive done calls of one tool, merged (spec §3 `StepGroup`). Opens to the individual steps. */
export function StepGroup({ group, labels, renderStep, now }: StepGroupProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const sources = group.steps.reduce((n, step) => n + (step.sources?.length ?? 0), 0)
  return (
    <li className="b4-step" data-state="done" data-kind="group" {...(expanded ? { "data-expanded": "true" } : {})}>
      <Disclosure
        className="b4-step__line"
        autoOpen={false}
        live={false}
        onOpenChange={setExpanded}
        panelClassName="b4-step__children"
        summary={
          <>
            <StepIcon name={group.steps[0]?.icon} />
            <span className="b4-step__text">{group.label}</span>
            <StatusText>{sources > 0 ? `· ${sources} source${sources === 1 ? "" : "s"}` : ""}</StatusText>
          </>
        }
      >
        <ol className="b4-turn__steps">
          {group.steps.map((step) => (
            <Step key={step.id} step={step} labels={labels} renderStep={renderStep} now={now} />
          ))}
        </ol>
      </Disclosure>
    </li>
  )
}
```

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add packages/ag-ui/src/react/activity/StepGroup.tsx packages/ag-ui/test/react/StepGroup.test.tsx
git commit -m "feat(ag-ui): StepGroup merges consecutive calls of one tool

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 10: `TurnActivity` and `SubagentStep` (mutually recursive)

**Files:**
- Create: `packages/ag-ui/src/react/activity/TurnActivity.tsx`, `packages/ag-ui/src/react/activity/SubagentStep.tsx`
- Test: `packages/ag-ui/test/react/TurnActivity.test.tsx`, `packages/ag-ui/test/react/SubagentStep.test.tsx`

`TurnActivity` (spec §3, §3.1, §5.5, §5.6): `.b4-turn[data-state][data-expanded]` > `button.b4-turn__summary[aria-expanded]` (chevron, `.b4-turn__text` with `data-live` for the shimmer, `.b4-turn__time`) + a visually hidden `role="status"` region carrying the summary text, updated only when the text changes (not every second) + `ol.b4-turn__steps` when open. Open while working or awaiting; folds when settled; a turn already settled on first mount ("restored") starts folded. Steps render through `groupSteps(turn.steps, labels)` → `Step` / `StepGroup` / `PlanStep` / `ReasoningStep` / `SubagentStep`. `nested` turns (inside a subagent) use the subagent's name in the summary ("researcher · paused", "researcher finished · 5 steps").

`SubagentStep`: `li.b4-step[data-kind=subagent][data-state=running|awaiting|done|failed]` (paused → `awaiting`), line text "Asked **researcher** to {description}" while running/paused, "researcher finished · N steps" when done, "researcher failed" when failed; `.b4-step__children` holds the nested `TurnActivity` with `nested={{ name, status }}`.

- [ ] **Step 1: Write the failing tests**

`TurnActivity.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { TurnActivity } from "../../src/react/activity/TurnActivity.js"
import type { ToolStep, TurnView } from "../../src/view/turns.js"

const tool = (id: string, o: Partial<ToolStep> = {}): ToolStep => ({ kind: "tool", id, name: "searchCorpus", status: "done", args: "", startedAt: 0, settledAt: 500, label: "Searched the corpus", icon: "search", ...o })
const turn = (o: Partial<TurnView>): TurnView => ({ runId: "r", status: "done", startedAt: 0, endedAt: 72_000, steps: [tool("a"), tool("b")], text: "", approvals: [], failed: 0, ...o })

describe("TurnActivity", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("a working turn is open, shimmers the active label, ticks the time and announces once per label", () => {
    let clock = 12_400
    const now = () => clock
    const working = turn({ status: "working", endedAt: undefined, steps: [tool("a"), tool("b", { status: "running", settledAt: undefined, label: "Searching the corpus", startedAt: 100 })] })
    render(<TurnActivity turn={working} now={now} />)
    const root = screen.getByTestId("turn")
    expect(root.getAttribute("data-state")).toBe("working")
    expect(root.getAttribute("data-expanded")).toBe("true")
    const summary = screen.getByRole("button", { expanded: true })
    expect(summary.querySelector(".b4-turn__text")?.textContent).toBe("Searching the corpus")
    expect(summary.querySelector(".b4-turn__text")?.getAttribute("data-live")).toBe("true")
    expect(summary.querySelector(".b4-turn__time")?.textContent).toBe("· 12s")
    expect(screen.getByRole("status").textContent).toBe("Searching the corpus")
    act(() => {
      clock = 13_400
      vi.advanceTimersByTime(1000)
    })
    expect(summary.querySelector(".b4-turn__time")?.textContent).toBe("· 13s")
    expect(screen.getByRole("status").textContent).toBe("Searching the corpus")
    expect(screen.getAllByRole("listitem")).toHaveLength(2) // one done call and one running call: nothing merges while a call is live
  })

  test("a settled turn starts folded with the Worked for summary; clicking opens the steps", () => {
    const markup = renderToStaticMarkup(<TurnActivity turn={turn({ steps: [tool("a"), tool("b", { name: "readDoc", label: "Read a.md" })] })} now={() => 0} />)
    expect(markup).toContain('<section class="b4-turn" data-state="done" data-testid="turn">')
    expect(markup).toContain('<span class="b4-turn__text">Worked for 1m 12s</span><span class="b4-turn__time">· 2 steps</span>')
    expect(markup).not.toContain("b4-turn__steps")
    render(<TurnActivity turn={turn({})} now={() => 0} />)
    fireEvent.click(screen.getByRole("button"))
    expect(screen.getByRole("list")).toBeTruthy()
  })

  test("a live turn that settles folds; a failed step keeps the turn state failed and opens the step", () => {
    const live = turn({ status: "working", endedAt: undefined })
    const { rerender } = render(<TurnActivity turn={live} now={() => 1000} />)
    expect(screen.getByTestId("turn").getAttribute("data-expanded")).toBe("true")
    rerender(<TurnActivity turn={turn({ status: "failed", failed: 1, steps: [tool("a", { status: "failed", result: "ENOENT", label: "Couldn't read plan.md" })] })} now={() => 2000} />)
    expect(screen.getByTestId("turn").getAttribute("data-expanded")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Worked for/ }))
    expect(screen.getByText("Couldn't read plan.md").closest("li")?.getAttribute("data-expanded")).toBe("true")
    expect(screen.getByText("· 1 step · 1 failed")).toBeTruthy()
  })

  test("awaiting turns read Waiting for your approval and stay open", () => {
    const markup = renderToStaticMarkup(<TurnActivity turn={turn({ status: "awaiting", endedAt: undefined, steps: [tool("a", { status: "awaiting", label: "Wants to run a command" })] })} now={() => 38_000} />)
    expect(markup).toContain('data-state="awaiting" data-expanded="true"')
    expect(markup).toContain(">Waiting for your approval<")
    expect(markup).toContain("· awaiting approval")
  })

  test("nested turns name the subagent", () => {
    const markup = renderToStaticMarkup(<TurnActivity turn={turn({})} now={() => 0} nested={{ name: "researcher", status: "done" }} />)
    expect(markup).toContain('<span class="b4-turn__text">researcher finished</span><span class="b4-turn__time">· 2 steps</span>')
    const paused = renderToStaticMarkup(<TurnActivity turn={turn({ status: "awaiting", endedAt: undefined })} now={() => 0} nested={{ name: "researcher", status: "paused" }} />)
    expect(paused).toContain(">researcher · paused<")
  })
})
```

`SubagentStep.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SubagentStep } from "../../src/react/activity/SubagentStep.js"
import type { SubagentStep as View, ToolStep, TurnView } from "../../src/view/turns.js"

const tool = (id: string): ToolStep => ({ kind: "tool", id, name: "readDoc", status: "done", args: "", startedAt: 0, settledAt: 5, label: "Read a.md" })
const nested = (status: TurnView["status"]): TurnView => ({ runId: "c", status, startedAt: 0, ...(status === "working" || status === "awaiting" ? {} : { endedAt: 9000 }), steps: [tool("n1"), tool("n2")], text: "", approvals: [], failed: 0 })
const sub = (o: Partial<View>): View => ({ kind: "subagent", id: "s", name: "researcher", description: "summarize ReAct", status: "done", startedAt: 0, settledAt: 9000, turn: nested("done"), ...o })

describe("SubagentStep", () => {
  test("running reads Asked researcher to …, is open, and nests the child's activity", () => {
    const markup = renderToStaticMarkup(<SubagentStep step={sub({ status: "running", settledAt: undefined, turn: nested("working") })} now={() => 1000} />)
    expect(markup).toContain('<li class="b4-step" data-state="running" data-kind="subagent" data-expanded="true">')
    expect(markup).toContain('<span class="b4-step__text">Asked <b>researcher</b> to summarize ReAct</span>')
    expect(markup).toContain('<div class="b4-step__children"><section class="b4-turn" data-state="working"')
  })
  test("paused maps to awaiting; done folds to researcher finished · N steps", () => {
    expect(renderToStaticMarkup(<SubagentStep step={sub({ status: "paused", settledAt: undefined, turn: nested("awaiting") })} now={() => 0} />)).toContain('data-state="awaiting" data-kind="subagent"')
    const done = renderToStaticMarkup(<SubagentStep step={sub({})} now={() => 0} />)
    expect(done).toContain('data-state="done" data-kind="subagent">')
    expect(done).toContain('<span class="b4-step__text">researcher finished</span><span class="b4-step__meta">· 2 steps</span>')
    expect(done).not.toContain("b4-step__children")
  })
  test("failed reads researcher failed with the error", () => {
    const markup = renderToStaticMarkup(<SubagentStep step={sub({ status: "failed", error: "boom", turn: nested("failed") })} now={() => 0} />)
    expect(markup).toContain('data-state="failed" data-kind="subagent" data-expanded="true"')
    expect(markup).toContain('<span class="b4-step__text">researcher failed</span><span class="b4-step__meta">· boom</span>')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — both FAIL.

- [ ] **Step 3: Implement `TurnActivity.tsx`**

```tsx
import { type ReactElement, useEffect, useMemo, useRef, useState } from "react"
import { groupSteps, type StepLabelOverrides } from "../../view/labels.js"
import type { TurnView } from "../../view/turns.js"
import { Disclosure } from "./Disclosure.js"
import { countSteps, summaryLine } from "./format.js"
import { PlanStep } from "./PlanStep.js"
import { ReasoningStep } from "./ReasoningStep.js"
import { Step, type StepRenderers } from "./Step.js"
import { StepGroup } from "./StepGroup.js"
import { SubagentStep } from "./SubagentStep.js"
import { useElapsed } from "./useLive.js"

export interface TurnActivityProps {
  readonly turn: TurnView
  readonly labels?: StepLabelOverrides | undefined
  readonly renderStep?: StepRenderers | undefined
  /** The clock; defaults to `Date.now`. Inject in tests. */
  readonly now?: (() => number) | undefined
  /** Set when this is a subagent's turn: the summary names the subagent instead. */
  readonly nested?: { readonly name: string; readonly status: "running" | "paused" | "done" | "failed" } | undefined
}

const defaultNow = () => Date.now()
const isLive = (turn: TurnView) => turn.status === "working" || turn.status === "awaiting"

function nestedSummary(turn: TurnView, nested: NonNullable<TurnActivityProps["nested"]>): { text: string; meta: string } {
  const steps = `· ${countSteps(turn)} step${countSteps(turn) === 1 ? "" : "s"}`
  switch (nested.status) {
    case "paused":
      return { text: `${nested.name} · paused`, meta: "" }
    case "running":
      return { text: `${nested.name} · working`, meta: "" }
    case "failed":
      return { text: `${nested.name} failed`, meta: turn.error ? `· ${turn.error}` : steps }
    default:
      return { text: `${nested.name} finished`, meta: steps }
  }
}

/** The summary line plus the step list for one turn (spec §3 `TurnActivity`). */
export function TurnActivity({ turn, labels, renderStep, now = defaultNow, nested }: TurnActivityProps): ReactElement {
  const live = isLive(turn)
  const sampled = useElapsed(live, now)
  const line = nested ? { ...nestedSummary(turn, nested), live: false } : summaryLine(turn, sampled)
  const [expanded, setExpanded] = useState(live) // a turn settled at mount ("restored") starts folded
  const grouped = useMemo(() => groupSteps(turn.steps, labels), [turn.steps, labels])

  // One live region per turn, updated when the sentence changes — never on the 1 s tick.
  const announced = useRef(line.text)
  const [announce, setAnnounce] = useState(line.text)
  useEffect(() => {
    if (announced.current !== line.text) {
      announced.current = line.text
      setAnnounce(line.text)
    }
  }, [line.text])

  return (
    <section className="b4-turn" data-state={turn.status} {...(expanded ? { "data-expanded": "true" } : {})} data-testid="turn">
      <Disclosure
        className="b4-turn__summary"
        autoOpen={live}
        live={live}
        onOpenChange={setExpanded}
        summary={
          <>
            <span className="b4-turn__text" {...(line.live ? { "data-live": "true" } : {})}>
              {line.text}
            </span>
            {line.meta ? <span className="b4-turn__time">{line.meta}</span> : null}
          </>
        }
      >
        <ol className="b4-turn__steps">
          {grouped.map((item) => {
            switch (item.kind) {
              case "group":
                return <StepGroup key={`g:${item.steps[0]?.id}`} group={item} labels={labels} renderStep={renderStep} now={now} />
              case "tool":
                return <Step key={item.id} step={item} labels={labels} renderStep={renderStep} now={now} />
              case "plan":
                return <PlanStep key={item.id} step={item} live={turn.status === "working"} />
              case "reasoning":
                return <ReasoningStep key={item.id} step={item} />
              default:
                return <SubagentStep key={item.id} step={item} labels={labels} renderStep={renderStep} now={now} />
            }
          })}
        </ol>
      </Disclosure>
      <span className="b4-visually-hidden" role="status">
        {announce}
      </span>
    </section>
  )
}
```

- [ ] **Step 4: Implement `SubagentStep.tsx`**

```tsx
import { type ReactElement, useState } from "react"
import type { StepLabelOverrides } from "../../view/labels.js"
import type { SubagentStep as SubagentStepView } from "../../view/turns.js"
import { Disclosure } from "./Disclosure.js"
import { countSteps } from "./format.js"
import { StepIcon } from "./icons.js"
import { StatusText } from "./StatusText.js"
import type { StepRenderers } from "./Step.js"
import { TurnActivity } from "./TurnActivity.js"

export interface SubagentStepProps {
  readonly step: SubagentStepView
  readonly labels?: StepLabelOverrides | undefined
  readonly renderStep?: StepRenderers | undefined
  readonly now: () => number
}

const STATE = { running: "running", paused: "awaiting", done: "done", failed: "failed" } as const

/** "Asked researcher to …" with the child's own activity nested (spec §3 `SubagentStep`). */
export function SubagentStep({ step, labels, renderStep, now }: SubagentStepProps): ReactElement {
  const live = step.status === "running" || step.status === "paused"
  const autoOpen = live || step.status === "failed"
  const [expanded, setExpanded] = useState(autoOpen)
  const steps = countSteps(step.turn)
  const text = live ? (
    <>
      Asked <b>{step.name}</b> to {step.description ?? "help"}
    </>
  ) : step.status === "failed" ? (
    `${step.name} failed`
  ) : (
    `${step.name} finished`
  )
  const meta = step.status === "failed" ? (step.error ? `· ${step.error}` : "") : live ? "" : `· ${steps} step${steps === 1 ? "" : "s"}`
  return (
    <li className="b4-step" data-state={STATE[step.status]} data-kind="subagent" {...(expanded ? { "data-expanded": "true" } : {})}>
      <Disclosure
        className="b4-step__line"
        autoOpen={autoOpen}
        live={live}
        onOpenChange={setExpanded}
        panelClassName="b4-step__children"
        summary={
          <>
            <StepIcon name={step.status === "failed" ? "alert" : "agent"} />
            <span className="b4-step__text">{text}</span>
            <StatusText>{meta}</StatusText>
          </>
        }
      >
        <TurnActivity turn={step.turn} labels={labels} renderStep={renderStep} now={now} nested={{ name: step.name, status: step.status }} />
      </Disclosure>
    </li>
  )
}
```

Circular import note: `TurnActivity.tsx` imports `SubagentStep.tsx` and vice versa. Both only reference the other inside render functions (never at module top level), so ESM cycles resolve fine; the public-api test in Task 14 imports the barrel and renders a nested fixture to prove it.

- [ ] **Step 5: Run tests, typecheck, lint; commit**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react/TurnActivity.test.tsx test/react/SubagentStep.test.tsx && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint` — pass.

```bash
git add packages/ag-ui/src/react/activity/TurnActivity.tsx packages/ag-ui/src/react/activity/SubagentStep.tsx packages/ag-ui/test/react/TurnActivity.test.tsx packages/ag-ui/test/react/SubagentStep.test.tsx
git commit -m "feat(ag-ui): TurnActivity and nested SubagentStep

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 11: `ApprovalCard`

**Files:**
- Create: `packages/ag-ui/src/react/activity/ApprovalCard.tsx`
- Test: `packages/ag-ui/test/react/ApprovalCard.test.tsx`

Spec §3.2. Props: `approval: ApprovalView`, `agent: string` ("The agent" for the root, the subagent's name otherwise), `label: string` (the gated step's running label, e.g. "run a command"), `onDecide(decision: "once" | "always" | "deny") => Promise<void> | void`. States: `awaiting` → `deciding` (buttons disabled, `aria-busy`) → unmount by the host when the interrupt clears, or `failed` (inline error, buttons re-enabled). Payload: `detail.argsPreview` (string) else `detail.command` (string) else pretty JSON of `detail` minus `suggestedPattern`. Scope line from `detail.suggestedPattern` + `kind`; absent when `offersAlways` is false, as is the "Always allow" button.

- [ ] **Step 1: Write the failing tests**

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { ApprovalCard, approvalPayload, scopeLine } from "../../src/react/activity/ApprovalCard.js"
import type { ApprovalView } from "../../src/view/turns.js"

const approval = (o: Partial<ApprovalView> = {}): ApprovalView => ({
  interruptId: "perm-1",
  kind: "command",
  detail: { command: "node scripts/fetch-source.mjs https://example.org/paper", suggestedPattern: "node scripts/fetch-source.mjs" },
  message: "It isn't on this app's allow-list.",
  offersAlways: true,
  ...o,
})

describe("ApprovalCard", () => {
  test("renders the contract: title, reason, payload, three buttons on one row, scope line, role=alert", () => {
    const markup = renderToStaticMarkup(<ApprovalCard approval={approval()} agent="researcher" label="run a command" onDecide={() => {}} />)
    expect(markup).toContain('<section class="b4-approval" data-state="awaiting" role="alert">')
    expect(markup).toContain('<h3 class="b4-approval__title">researcher wants to run a command</h3>')
    expect(markup).toContain('<p class="b4-approval__reason">It isn&#x27;t on this app&#x27;s allow-list.</p>')
    expect(markup).toContain('<pre class="b4-approval__payload">node scripts/fetch-source.mjs https://example.org/paper</pre>')
    expect(markup).toContain('<div class="b4-approval__actions"><button type="button" class="b4-approval__button b4-approval__button--primary">Allow once</button><button type="button" class="b4-approval__button b4-approval__button--secondary">Always allow</button><button type="button" class="b4-approval__button b4-approval__button--text">Deny</button></div>')
    expect(markup).toContain('<p class="b4-approval__scope">“Always allow” applies to this exact command, for this app.</p>')
  })
  test("without always: no second button and no scope line", () => {
    const markup = renderToStaticMarkup(<ApprovalCard approval={approval({ offersAlways: false })} agent="The agent" label="deploy" onDecide={() => {}} />)
    expect(markup).not.toContain("Always allow")
    expect(markup).not.toContain("b4-approval__scope")
  })
  test("payload and scope helpers", () => {
    expect(approvalPayload({ argsPreview: "deployProd({env:'prod'})", command: "x" })).toBe("deployProd({env:'prod'})")
    expect(approvalPayload({ foo: 1, suggestedPattern: "p" })).toBe('{\n  "foo": 1\n}')
    expect(scopeLine("tool", { suggestedPattern: "deployProd" })).toBe("“Always allow” applies to every call of deployProd, for this app.")
    expect(scopeLine("command", {})).toBe("“Always allow” applies to this exact command, for this app.")
    expect(scopeLine("memory", { scope: "thread" })).toBe("“Always allow” applies in this conversation only.")
  })
  test("deciding disables the buttons; a rejected decision re-enables them with an inline error", async () => {
    let reject: (e: Error) => void = () => {}
    const onDecide = vi.fn(() => new Promise<void>((_, r) => { reject = r }))
    render(<ApprovalCard approval={approval()} agent="The agent" label="run a command" onDecide={onDecide} />)
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(onDecide).toHaveBeenCalledWith("once")
    const card = screen.getByRole("alert")
    expect(card.getAttribute("data-state")).toBe("deciding")
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => {
      reject(new Error("network down"))
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(card.getAttribute("data-state")).toBe("failed")
    expect(screen.getByText("Couldn't send your decision: network down")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Deny" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

```tsx
import { type ReactElement, useState } from "react"
import type { ApprovalView } from "../../view/turns.js"

export type ApprovalDecision = "once" | "always" | "deny"

export interface ApprovalCardProps {
  readonly approval: ApprovalView
  /** "The agent" for the root run, the subagent's name otherwise (spec §3.2). */
  readonly agent: string
  /** The gated step's running label, lower-cased by the caller: "run a command". */
  readonly label: string
  readonly onDecide: (decision: ApprovalDecision) => Promise<void> | void
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined)

/** `detail.argsPreview`, else the command, else the detail as JSON without the scope hint. */
export function approvalPayload(detail: Readonly<Record<string, unknown>>): string {
  const preview = text(detail.argsPreview) ?? text(detail.command)
  if (preview !== undefined) return preview
  const { suggestedPattern: _omit, ...rest } = detail
  try {
    return JSON.stringify(rest, null, 2)
  } catch {
    return String(rest)
  }
}

/** The sentence under the buttons that says what "Always allow" covers (spec §3.2). */
export function scopeLine(kind: string, detail: Readonly<Record<string, unknown>>): string {
  if (detail.scope === "thread") return "“Always allow” applies in this conversation only."
  const pattern = text(detail.suggestedPattern)
  if (kind === "command" || pattern === undefined) return "“Always allow” applies to this exact command, for this app."
  return `“Always allow” applies to every call of ${pattern}, for this app.`
}

/** The approval card (spec §3.2): one per pending interrupt, after the turn's activity. */
export function ApprovalCard({ approval, agent, label, onDecide }: ApprovalCardProps): ReactElement {
  const [state, setState] = useState<"awaiting" | "deciding" | "failed">("awaiting")
  const [error, setError] = useState<string | undefined>(undefined)
  const decide = (decision: ApprovalDecision) => {
    setState("deciding")
    setError(undefined)
    Promise.resolve()
      .then(() => onDecide(decision))
      .catch((cause: unknown) => {
        setState("failed")
        setError(cause instanceof Error ? cause.message : String(cause))
      })
  }
  const busy = state === "deciding"
  return (
    <section className="b4-approval" data-state={state} role="alert" {...(busy ? { "aria-busy": true } : {})}>
      <h3 className="b4-approval__title">
        {agent} wants to {label}
      </h3>
      {approval.message ? <p className="b4-approval__reason">{approval.message}</p> : null}
      <pre className="b4-approval__payload">{approvalPayload(approval.detail)}</pre>
      <div className="b4-approval__actions">
        <button type="button" className="b4-approval__button b4-approval__button--primary" disabled={busy} onClick={() => decide("once")}>
          Allow once
        </button>
        {approval.offersAlways ? (
          <button type="button" className="b4-approval__button b4-approval__button--secondary" disabled={busy} onClick={() => decide("always")}>
            Always allow
          </button>
        ) : null}
        <button type="button" className="b4-approval__button b4-approval__button--text" disabled={busy} onClick={() => decide("deny")}>
          Deny
        </button>
      </div>
      {error !== undefined ? <p className="b4-approval__error">Couldn't send your decision: {error}</p> : null}
      {approval.offersAlways ? <p className="b4-approval__scope">{scopeLine(approval.kind, approval.detail)}</p> : null}
    </section>
  )
}
```

Note: `renderToStaticMarkup` omits `disabled` when false, which is why the first test's expected button markup has no `disabled` attribute.

- [ ] **Step 4: Run tests, typecheck, lint; commit**

```bash
git add packages/ag-ui/src/react/activity/ApprovalCard.tsx packages/ag-ui/test/react/ApprovalCard.test.tsx
git commit -m "feat(ag-ui): ApprovalCard

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 12: `styles.css` under `@layer b4-activity` with the §5.1 tokens

**Files:**
- Modify: `packages/ag-ui/src/react/styles.css` (rewrite; keep the legacy card rules)
- Modify: `packages/ag-ui/test/react/styles.test.ts` (rewrite)

- [ ] **Step 1: Rewrite the test**

Replace `packages/ag-ui/test/react/styles.test.ts` with:

```ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const CSS = readFileSync(fileURLToPath(new URL("../../src/react/styles.css", import.meta.url)), "utf8")
const withoutComments = CSS.replace(/\/\*[\s\S]*?\*\//g, "")

/** Every class the kit emits (spec §5.6 plus the blocks), read from the TSX so the two cannot drift. */
const KIT_SOURCES = [
  "Disclosure.tsx", "icons.tsx", "StatusText.tsx", "SourceChips.tsx", "StepDetail.tsx", "Step.tsx",
  "PlanStep.tsx", "ReasoningStep.tsx", "StepGroup.tsx", "SubagentStep.tsx", "TurnActivity.tsx", "ApprovalCard.tsx",
]
  .map((f) => readFileSync(fileURLToPath(new URL(`../../src/react/activity/${f}`, import.meta.url)), "utf8"))
  .join("\n")
const emittedClasses = [...new Set([...KIT_SOURCES.matchAll(/className=\{?["'`]([^"'`$]+)/g)].flatMap((m) => (m[1] ?? "").split(/\s+/)))].filter(Boolean)

const TOKENS = [
  "surface", "surface-alt", "border", "text", "muted", "running", "running-bg", "complete", "failed", "failed-bg",
  "primary", "on-primary", "radius", "radius-card", "radius-pill", "font-mono",
]

describe("styles.css", () => {
  test("every rule lives in @layer b4-activity", () => {
    const beforeLayer = withoutComments.slice(0, withoutComments.indexOf("@layer b4-activity"))
    expect(beforeLayer.trim()).toBe("")
    expect(withoutComments.match(/@layer b4-activity\s*\{/g)?.length).toBe(1)
  })
  test("defines every §5.1 token in light, media-dark and explicit-dark blocks", () => {
    for (const token of TOKENS) {
      const occurrences = withoutComments.match(new RegExp(`--b4-activity-${token}:`, "g"))?.length ?? 0
      expect(occurrences, token).toBeGreaterThanOrEqual(token === "radius" || token.startsWith("radius-") || token === "font-mono" ? 1 : 3)
    }
    expect(withoutComments).toContain(":where(:root)")
    expect(withoutComments).toContain('@media (prefers-color-scheme: dark)')
    expect(withoutComments).toContain(':where(:root[data-b4-theme="dark"]')
    expect(withoutComments).toContain(".dark")
    expect(withoutComments).toContain('[data-theme="dark"]')
    expect(withoutComments).toContain("--b4-activity-complete: #15803d")
  })
  test("every emitted class has at least one rule, and every selector is prefixed", () => {
    for (const cls of emittedClasses) expect(withoutComments, cls).toContain(`.${cls}`)
    const selectors = [...withoutComments.matchAll(/(^|[}{;])\s*([^{}@]+?)\s*\{/g)].map((m) => (m[2] ?? "").trim()).filter(Boolean)
    for (const selector of selectors) {
      for (const part of selector.split(",").map((p) => p.trim())) {
        const unwrapped = /^:where\((.*)\)$/.exec(part)?.[1] ?? part
        const ok = /(^|[\s>+~(])\.b4-/.test(unwrapped) || /^:root/.test(unwrapped) || /^\.dark\b|^\[data-theme="dark"\]/.test(unwrapped) || unwrapped === "to"
        expect(ok, selector).toBe(true)
      }
    }
  })
  test("motion: the shimmer, the 200ms chevron, and a reduced-motion block that turns both off", () => {
    expect(withoutComments).toMatch(/\.b4-turn__text\[data-live="true"\][^}]*animation:\s*b4-shimmer 2\.2s linear infinite/)
    expect(withoutComments).toMatch(/\.b4-chevron[^}]*transition:\s*transform 200ms/)
    const start = withoutComments.indexOf("@media (prefers-reduced-motion: reduce)")
    expect(start).toBeGreaterThan(0)
    const reduced = withoutComments.slice(start)
    expect(reduced).toContain("animation: none")
    expect(reduced).toContain("transition: none")
  })
  test("accessibility: visible focus ring, 24px disclosure targets, a visually-hidden utility", () => {
    expect(withoutComments).toMatch(/\.b4-turn__summary:focus-visible,\s*\.b4-step__line:focus-visible,\s*\.b4-approval__button:focus-visible\s*\{[^}]*outline/)
    expect(withoutComments).toMatch(/\.b4-step__line\s*\{[^}]*min-height:\s*26px/)
    expect(withoutComments).toMatch(/\.b4-visually-hidden\s*\{[^}]*clip/)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm --filter @b4run/ag-ui exec vitest run test/react/styles.test.ts` → FAIL (no `@layer`, missing tokens).

- [ ] **Step 3: Rewrite the stylesheet**

Replace the whole of `packages/ag-ui/src/react/styles.css` with the following, then append the EXISTING legacy rules (everything from today's first `.b4-activity {` rule to the end of the current file, unchanged) inside the layer where the `/* ---- Legacy cards … */` comment sits:

```css
/*
 * B4.run activity components — default appearance.
 *
 * Import once in your app:
 *   import "@b4run/ag-ui/react/styles.css"
 *
 * Every rule sits in `@layer b4-activity`, so any unlayered app CSS wins
 * without specificity games. Override the `--b4-activity-*` tokens in your own
 * `:root` to retheme; the three token blocks are `:where()`-wrapped (specificity
 * 0,0,0) so a plain `:root { --b4-activity-text: … }` always wins.
 *
 * Dark follows the HOST, not the OS: `.dark` or `[data-theme="dark"]` on an
 * ancestor. `data-b4-theme="light" | "dark" | "auto"` on an ancestor overrides;
 * `auto` follows `prefers-color-scheme`.
 */
@layer b4-activity {
  :where(:root) {
    --b4-activity-surface: #fff;
    --b4-activity-surface-alt: rgb(249 249 249);
    --b4-activity-border: rgb(229 229 229);
    --b4-activity-text: rgb(28 28 28);
    --b4-activity-muted: rgb(115 115 115);
    --b4-activity-running: #b45309;
    --b4-activity-running-bg: #fffbeb;
    --b4-activity-complete: #15803d;
    --b4-activity-failed: #b91c1c;
    --b4-activity-failed-bg: #fef2f2;
    --b4-activity-primary: rgb(28 28 28);
    --b4-activity-on-primary: #fff;
    --b4-activity-radius: 8px;
    --b4-activity-radius-card: 16px;
    --b4-activity-radius-pill: 9999px;
    --b4-activity-font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    /* Legacy card geometry (removed with the legacy cards). */
    --b4-activity-gap: 8px;
    --b4-activity-font-size: 13px;
    --b4-activity-margin: 6px 0;
    --b4-activity-padding: 8px 10px;
    --b4-activity-header-weight: 600;
  }

  @media (prefers-color-scheme: dark) {
    :where(:root[data-b4-theme="auto"]) {
      --b4-activity-surface: rgb(17 17 17);
      --b4-activity-surface-alt: rgb(44 44 44);
      --b4-activity-border: rgb(45 45 45);
      --b4-activity-text: rgb(245 245 245);
      --b4-activity-muted: rgb(160 160 160);
      --b4-activity-running: #fbbf24;
      --b4-activity-running-bg: rgb(45 35 21);
      --b4-activity-complete: #4ade80;
      --b4-activity-failed: #fca5a5;
      --b4-activity-failed-bg: rgb(45 21 21);
      --b4-activity-primary: #fff;
      --b4-activity-on-primary: rgb(28 28 28);
    }
  }

  :where(:root[data-b4-theme="dark"]),
  :where(.dark:not([data-b4-theme="light"])),
  :where([data-theme="dark"]:not([data-b4-theme="light"])) {
    --b4-activity-surface: rgb(17 17 17);
    --b4-activity-surface-alt: rgb(44 44 44);
    --b4-activity-border: rgb(45 45 45);
    --b4-activity-text: rgb(245 245 245);
    --b4-activity-muted: rgb(160 160 160);
    --b4-activity-running: #fbbf24;
    --b4-activity-running-bg: rgb(45 35 21);
    --b4-activity-complete: #4ade80;
    --b4-activity-failed: #fca5a5;
    --b4-activity-failed-bg: rgb(45 21 21);
    --b4-activity-primary: #fff;
    --b4-activity-on-primary: rgb(28 28 28);
  }

  /* ---- Turn ---------------------------------------------------------- */
  .b4-turn {
    color: var(--b4-activity-text);
    font-size: 14px;
    line-height: 1.5;
  }
  .b4-turn__summary,
  .b4-step__line {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    min-height: 26px;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    color: var(--b4-activity-muted);
    cursor: pointer;
    text-align: left;
  }
  .b4-turn__text {
    color: var(--b4-activity-muted);
  }
  .b4-turn[data-state="working"] .b4-turn__text[data-live="true"] {
    background: linear-gradient(90deg, rgb(110 110 110) 0%, rgb(205 205 205) 50%, rgb(110 110 110) 100%);
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  .b4-turn__text[data-live="true"] {
    animation: b4-shimmer 2.2s linear infinite;
  }
  @keyframes b4-shimmer {
    to {
      background-position: -200% 0;
    }
  }
  .b4-turn__time,
  .b4-step__meta {
    color: var(--b4-activity-muted);
    opacity: 0.75;
  }
  .b4-chevron {
    flex: none;
    color: var(--b4-activity-muted);
    transition: transform 200ms;
  }
  [aria-expanded="true"] > .b4-chevron {
    transform: rotate(90deg);
  }
  .b4-turn__steps {
    list-style: none;
    margin: 6px 0 2px 5px;
    padding: 0 0 0 18px;
    border-left: 1px solid var(--b4-activity-border);
  }

  /* ---- Step ---------------------------------------------------------- */
  .b4-step {
    padding: 5px 0;
  }
  .b4-step__line {
    align-items: flex-start;
    gap: 10px;
    color: var(--b4-activity-text);
    opacity: 0.8;
  }
  .b4-step__line--static {
    cursor: default;
  }
  .b4-step[data-state="running"] > .b4-step__line {
    opacity: 1;
  }
  .b4-step[data-state="pending"] > .b4-step__line {
    opacity: 0.6;
  }
  .b4-step[data-state="awaiting"] > .b4-step__line .b4-step__icon {
    color: var(--b4-activity-running);
  }
  .b4-step[data-state="failed"] > .b4-step__line {
    color: var(--b4-activity-failed);
    opacity: 1;
  }
  .b4-step__icon {
    flex: none;
    margin-top: 3px;
    color: var(--b4-activity-muted);
  }
  .b4-step[data-state="running"] > .b4-step__line .b4-step__icon {
    color: var(--b4-activity-text);
  }
  .b4-step__text b {
    font-weight: 500;
    color: var(--b4-activity-text);
  }
  .b4-step__detail,
  .b4-step__children {
    margin: 6px 0 0 26px;
  }
  .b4-step__detail {
    max-height: 250px;
    overflow: auto;
    font-size: 12.5px;
  }
  .b4-step__detail-label {
    margin: 6px 0 2px;
    font-size: 12px;
    font-weight: 500;
    color: var(--b4-activity-muted);
  }
  .b4-step__detail-empty,
  .b4-step__reasoning {
    margin: 0;
    color: var(--b4-activity-muted);
    white-space: pre-wrap;
  }
  .b4-step__code {
    margin: 0;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--b4-activity-surface-alt);
    font-family: var(--b4-activity-font-mono);
    font-size: 12.5px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .b4-step[data-state="failed"] .b4-step__code {
    background: var(--b4-activity-failed-bg);
    color: var(--b4-activity-failed);
  }
  .b4-step__children > .b4-turn {
    border-radius: 12px;
    background: var(--b4-activity-surface-alt);
    padding: 8px 12px;
    font-size: 13.5px;
  }
  .b4-step__children > .b4-turn > .b4-turn__steps {
    margin-left: 4px;
  }

  /* ---- Sources, checklist ------------------------------------------- */
  .b4-step__sources {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    list-style: none;
    margin: 6px 0 0 26px;
    padding: 0;
  }
  .b4-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 10px;
    border: 1px solid var(--b4-activity-border);
    border-radius: var(--b4-activity-radius-pill);
    background: var(--b4-activity-surface);
    color: var(--b4-activity-text);
    font-size: 12px;
    text-decoration: none;
  }
  .b4-chip--more {
    color: var(--b4-activity-muted);
  }
  .b4-checklist {
    display: flex;
    flex-direction: column;
    gap: 3px;
    list-style: none;
    margin: 0;
    padding: 0;
    font-size: 13.5px;
  }
  .b4-checklist__item {
    display: flex;
    gap: 8px;
    align-items: center;
  }
  .b4-checklist__box {
    flex: none;
    color: var(--b4-activity-muted);
  }
  .b4-checklist__item[data-status="completed"] .b4-checklist__box,
  .b4-checklist__item[data-status="in_progress"] .b4-checklist__box {
    color: var(--b4-activity-primary);
  }
  .b4-checklist__item[data-status="completed"] .b4-checklist__text {
    color: var(--b4-activity-muted);
    text-decoration: line-through;
  }
  .b4-checklist__item[data-status="pending"] .b4-checklist__text {
    color: var(--b4-activity-muted);
  }

  /* ---- Approval card ------------------------------------------------- */
  .b4-approval {
    margin: 12px 0 4px;
    padding: 14px 16px;
    border: 1px solid var(--b4-activity-border);
    border-radius: var(--b4-activity-radius-card);
    background: var(--b4-activity-surface);
    color: var(--b4-activity-text);
    box-shadow: 0 1px 3px rgb(0 0 0 / 5%);
    font-size: 14px;
    line-height: 1.5;
  }
  .b4-approval__title {
    margin: 0 0 4px;
    font-size: 14.5px;
    font-weight: 500;
  }
  .b4-approval__reason {
    margin: 0 0 10px;
    font-size: 13px;
    color: var(--b4-activity-muted);
  }
  .b4-approval__payload {
    margin: 0 0 12px;
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--b4-activity-surface-alt);
    font-family: var(--b4-activity-font-mono);
    font-size: 12.5px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .b4-approval__actions {
    display: flex;
    flex-wrap: nowrap;
    align-items: center;
    gap: 6px;
  }
  .b4-approval__button {
    padding: 6px 15px;
    border: 1px solid transparent;
    border-radius: var(--b4-activity-radius-pill);
    background: none;
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    color: var(--b4-activity-text);
    white-space: nowrap;
    cursor: pointer;
  }
  .b4-approval__button:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .b4-approval__button--primary {
    background: var(--b4-activity-primary);
    color: var(--b4-activity-on-primary);
  }
  .b4-approval__button--secondary {
    border-color: var(--b4-activity-border);
  }
  .b4-approval__button--text {
    margin-left: auto;
    color: var(--b4-activity-muted);
  }
  .b4-approval__scope {
    margin: 8px 0 0;
    font-size: 12px;
    color: var(--b4-activity-muted);
  }
  .b4-approval__error {
    margin: 8px 0 0;
    padding: 6px 10px;
    border-radius: 10px;
    background: var(--b4-activity-failed-bg);
    color: var(--b4-activity-failed);
    font-size: 13px;
  }

  /* ---- Accessibility and motion -------------------------------------- */
  .b4-turn__summary:focus-visible,
  .b4-step__line:focus-visible,
  .b4-approval__button:focus-visible {
    outline: 2px solid var(--b4-activity-primary);
    outline-offset: 2px;
    border-radius: var(--b4-activity-radius);
  }
  .b4-visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  @media (prefers-reduced-motion: reduce) {
    .b4-turn__text[data-live="true"] {
      animation: none;
      background: none;
      color: var(--b4-activity-text);
    }
    .b4-chevron {
      transition: none;
    }
  }

  /* ---- Legacy cards (PlanActivityCard, ActivityChecklist, SubagentPanel) —
     removed in sub-project 2b. Rules below are today's, moved into the layer. */
}
```

(Paste the current `.b4-activity…` rules — from today's `.b4-activity {` through the last rule — just above the closing `}` of the layer. Delete today's three top-of-file token blocks: the new blocks above replace them and keep every legacy token name.)

- [ ] **Step 4: Run the whole React suite**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react && pnpm --filter @b4run/ag-ui lint`
Expected: all pass, including the legacy `customization.test.tsx` / `SubagentPanel.test.tsx` (they test markup, not CSS). Biome does not format CSS here (`lint` covers `src` as a folder; if it reports CSS formatting, run `npx biome format --write --config-path ../config-biome/biome.json src/react/styles.css` from `packages/ag-ui`).

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/react/styles.css packages/ag-ui/test/react/styles.test.ts
git commit -m "feat(ag-ui): activity stylesheet under @layer b4-activity with the design tokens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 13: The `./react` barrel — kit in, CopilotKit out

**Files:**
- Modify: `packages/ag-ui/src/react/index.ts`
- Delete: `packages/ag-ui/src/react/renderers.tsx` (recreated under `src/copilotkit/` in Task 15)
- Move: `packages/ag-ui/test/react/renderers.test.tsx` → `packages/ag-ui/test/copilotkit/renderers.test.tsx` (Task 15 fixes its imports; delete the old path in this task so the React suite stays green)
- Create: `packages/ag-ui/test/react/public-api.test.ts`

- [ ] **Step 1: Write the failing public-api test**

```ts
import { readdirSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import * as react from "../../src/react/index.js"

describe("@b4run/ag-ui/react public API", () => {
  test("exports the activity kit, the blocks, the hooks and the legacy cards", () => {
    expect(Object.keys(react).sort()).toEqual(
      [
        "ActivityChecklist",
        "ApprovalCard",
        "Checklist",
        "Chevron",
        "Disclosure",
        "EMPTY_SUBAGENT_RUNS",
        "PlanActivityCard",
        "PlanStep",
        "ReasoningStep",
        "SourceChips",
        "StatusText",
        "Step",
        "StepDetail",
        "StepGroup",
        "StepIcon",
        "SubagentPanel",
        "SubagentStep",
        "TurnActivity",
        "approvalPayload",
        "cx",
        "formatDuration",
        "isSubagentMessage",
        "planActivityContentSchema",
        "reduceSubagentRuns",
        "scopeLine",
        "summaryLine",
        "useDisclosure",
        "useElapsed",
        "useLive",
        "useSubagentRuns",
      ].sort(),
    )
  })
  test("imports nothing from CopilotKit (that belongs to ./copilotkit)", () => {
    const dir = fileURLToPath(new URL("../../src/react/", import.meta.url))
    const files = [...readdirSync(dir), ...readdirSync(`${dir}activity`).map((f) => `activity/${f}`)].filter((f) => /\.tsx?$/.test(f))
    for (const file of files) expect(readFileSync(`${dir}${file}`, "utf8"), file).not.toMatch(/@copilotkit/)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL (the barrel still exports `b4ActivityRenderers`; `renderers.tsx` imports CopilotKit).

- [ ] **Step 3: Rewrite the barrel**

```ts
/**
 * `@b4run/ag-ui/react` — the React activity kit.
 *
 * React is an OPTIONAL peer dependency: importing the root (`@b4run/ag-ui`) or
 * `./sse` never loads this module. This entry has no CopilotKit dependency;
 * the CopilotKit connector lives at `@b4run/ag-ui/copilotkit`.
 *
 * Components take plain props built by `@b4run/ag-ui/view` (`reduceTurns`) and
 * render the DOM contract in the activity-components spec: `TurnActivity` for a
 * turn, `ApprovalCard` for a parked interrupt, and the step rows and building
 * blocks (`Disclosure`, `StepIcon`, `StatusText`, `Checklist`) for custom steps.
 *
 * Deprecated, removed in a later release once the research example adopts the
 * kit: `PlanActivityCard`, `ActivityChecklist`, `SubagentPanel`, the
 * `classNames`/`components` slots and `cx`.
 */
export { ApprovalCard, type ApprovalCardProps, type ApprovalDecision, approvalPayload, scopeLine } from "./activity/ApprovalCard.js"
export { Disclosure, type DisclosureProps, useDisclosure } from "./activity/Disclosure.js"
export { formatDuration, type SummaryLine, summaryLine } from "./activity/format.js"
export { Chevron, StepIcon } from "./activity/icons.js"
export { Checklist, PlanStep, type PlanStepProps } from "./activity/PlanStep.js"
export { ReasoningStep } from "./activity/ReasoningStep.js"
export { SourceChips, type SourceChipsProps } from "./activity/SourceChips.js"
export { StatusText } from "./activity/StatusText.js"
export { Step, type StepProps, type StepRenderer, type StepRenderers } from "./activity/Step.js"
export { StepDetail, type StepDetailProps } from "./activity/StepDetail.js"
export { StepGroup, type StepGroupProps } from "./activity/StepGroup.js"
export { SubagentStep, type SubagentStepProps } from "./activity/SubagentStep.js"
export { TurnActivity, type TurnActivityProps } from "./activity/TurnActivity.js"
export { useElapsed, useLive } from "./activity/useLive.js"
/** @deprecated Legacy card; removed when the research example adopts `TurnActivity`. */
export { ActivityChecklist } from "./ActivityChecklist.js"
/** @deprecated Legacy card; removed when the research example adopts `TurnActivity`. */
export { PlanActivityCard } from "./PlanActivityCard.js"
/** @deprecated Legacy customization slots; the kit is styled through `@layer b4-activity` and tokens. */
export { type B4ActivityClassNames, type B4ActivityComponents, type B4TodoRowProps, type B4ToolRowProps, cx } from "./parts.js"
/** @deprecated Legacy card; removed when the research example adopts `SubagentStep`. */
export { SubagentPanel } from "./SubagentPanel.js"
export { planActivityContentSchema } from "./schemas.js"
export {
  EMPTY_SUBAGENT_RUNS,
  isSubagentMessage,
  reduceSubagentRuns,
  type SubagentEventSource,
  type SubagentRun,
  type SubagentRunsState,
  type SubagentToolCall,
  useSubagentRuns,
} from "./useSubagentRuns.js"
```

Then:

```bash
git rm -q packages/ag-ui/src/react/renderers.tsx
git mv packages/ag-ui/test/react/renderers.test.tsx packages/ag-ui/test/copilotkit/renderers.test.tsx
```

(`test/copilotkit/renderers.test.tsx` now fails to resolve its import; Task 15 fixes it. Until then run the React suite only. If `test/react/customization.test.tsx` imports anything from `renderers.js`, repoint that import to `../../src/copilotkit/renderers.js` in Task 15 as well.)

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint`
Expected: `test/react` all pass. `typecheck` includes `tsconfig.test.json`, which now covers `test/copilotkit/renderers.test.tsx` with a broken import → it FAILS until Task 15. Acceptable for this commit only; note it in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/react/index.ts packages/ag-ui/test/react/public-api.test.ts
git commit -m "feat(ag-ui)!: ./react exports the activity kit and drops its CopilotKit import

b4ActivityRenderers and b4PlanActivityRenderer move to the new
@b4run/ag-ui/copilotkit entry (next commit); the legacy cards stay,
deprecated. The moved renderers test resolves again in that commit.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 14: PR 1 whole-kit smoke, then open PR 1

- [ ] **Step 1: Render a full research-like fixture through the barrel**

Create `packages/ag-ui/test/react/kit-smoke.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { TurnActivity } from "../../src/react/index.js"
import type { TurnView } from "../../src/view/turns.js"

const nested: TurnView = {
  runId: "c1", status: "done", startedAt: 1000, endedAt: 9000, text: "ReAct interleaves…", approvals: [], failed: 0,
  steps: [
    { kind: "tool", id: "n1", name: "readDoc", status: "done", args: '{"path":"a.md"}', result: "…", label: "Read a.md", icon: "read", startedAt: 1000, settledAt: 2000 },
    { kind: "tool", id: "n2", name: "runBash", status: "done", args: '{"command":"node x"}', result: "ok", label: "Ran node x", icon: "run", startedAt: 2000, settledAt: 8000 },
  ],
}
const turn: TurnView = {
  runId: "r1", status: "done", startedAt: 0, endedAt: 72_000, text: "", approvals: [], failed: 0,
  steps: [
    { kind: "reasoning", id: "th", text: "plan it", status: "done", startedAt: 0, settledAt: 4000 },
    { kind: "plan", id: "plan", todos: [{ content: "a", status: "completed" }, { content: "b", status: "completed" }], startedAt: 0, updatedAt: 1 },
    { kind: "tool", id: "s1", name: "searchCorpus", status: "done", args: "{}", label: "Searched the corpus", icon: "search", startedAt: 10, settledAt: 20, sources: [{ title: "a.md" }] },
    { kind: "tool", id: "s2", name: "searchCorpus", status: "done", args: "{}", label: "Searched the corpus", icon: "search", startedAt: 20, settledAt: 30, sources: [{ title: "b.md" }] },
    { kind: "subagent", id: "c1", name: "researcher", description: "summarize ReAct", status: "done", startedAt: 1000, settledAt: 9000, turn: nested },
    { kind: "tool", id: "w", name: "writeFile", status: "done", args: '{"path":"reports/x.md"}', label: "Saved reports/x.md", icon: "write", startedAt: 9000, settledAt: 9500 },
  ],
}

describe("kit smoke", () => {
  test("a settled research turn renders folded with the right summary, and open with every row kind", () => {
    const folded = renderToStaticMarkup(<TurnActivity turn={turn} now={() => 0} />)
    expect(folded).toContain("Worked for 1m 12s")
    expect(folded).toContain("· 8 steps · 2 sources")
    expect(folded).not.toContain("b4-turn__steps")
  })
})
```

Then add an interaction test in the same file (`// @vitest-environment jsdom` at the top) that clicks the summary and asserts the row kinds in order: `reasoning, plan, group, subagent, tool` via `screen.getAllByRole("listitem").map((li) => li.getAttribute("data-kind")).filter(Boolean)` — expected `["reasoning", "plan", "group", "subagent", "tool"]` (the subagent is closed, so its nested rows are not in the DOM; the plan is closed too; the group is closed).

- [ ] **Step 2: Run, commit**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/react` — pass.

```bash
git add packages/ag-ui/test/react/kit-smoke.test.tsx
git commit -m "test(ag-ui): render a settled research turn through the kit barrel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

PR 1 is NOT opened on its own: `typecheck` is red until Task 15 restores the moved renderers test, and `check-docs` is red until Task 16 updates the `./react` export table. Continue straight into PR 2's tasks on the same branch; the plan's single PR carries both halves. (Keeping one PR also avoids a second CI treadmill pass.)

---

# PR 2 (same branch) — `./copilotkit` connector, registration, docs

### Task 15: `@b4run/ag-ui/copilotkit` — renderers, `useB4Turns`, `mergeTurnMessages`, `B4Activity`, `useB4ChatSlots`

**Files:**
- Create: `packages/ag-ui/src/copilotkit/index.ts`, `renderers.tsx`, `useB4Turns.ts`, `messages.ts`, `B4Activity.tsx`, `useB4ChatSlots.tsx`
- Modify: `packages/ag-ui/package.json` (`exports["./copilotkit"]`)
- Test: `packages/ag-ui/test/copilotkit/renderers.test.tsx` (moved; fix imports), `messages.test.ts`, `useB4Turns.test.tsx`, `B4Activity.test.tsx`, `public-api.test.ts`

Design (spec §6.2 + spike):
- `useB4Turns(agent, options)` — `agent.subscribe({ onEvent })` folding `reduceTurns`; `options.hiddenTools`, `options.labels` are not reducer options (labels are a render concern); `resuming` is tracked internally: the hook exposes `markResuming()` which `B4Activity`'s approval handler calls right before `resolve`/`cancel`, and the next `RUN_STARTED` consumes it (`resuming: true` for that one event, then back to `undefined`).
- `mergeTurnMessages(messages)` — pure: drop messages where `isSubagentMessage(m)`; within a turn (a run of messages after each `user` message) keep the FIRST assistant message that has `toolCalls` and no text, drop later tool-only assistant messages, keep `tool` messages and text-bearing assistant messages. Exported so the app can test its own rendering.
- `B4Activity` — a context provider: `{ turns: TurnsView, labels, renderStep, now }` + `useRenderTool({ name: "*", render: () => null })` (the stock tool rows are replaced by `TurnActivity`) + `useInterrupt({ render })` (default `renderInChat`, so CopilotKit places the cards after the messages) rendering one `ApprovalCard` per `interrupts[]` entry: `agent` = the subagent name when the interrupt's `subagentRunId`/`metadata.subagentRunId` names a subagent step, else "The agent"; `label` = the awaiting step's `stepLabel` lower-cased first letter, else "continue"; `onDecide` → `markResuming()` then `resolve(decision === "deny" ? undefined : decision, id)` / `cancel(id)` for deny (matches the research example's `PermissionInterrupt`: deny cancels, others resolve with the decision string; B4's `responseSchema` enum is `once|always|deny`, and B4 treats `cancelled` as denial).
- `useB4ChatSlots()` — reads the context, returns `{ messageView: { transformMessages: mergeTurnMessages, assistantMessage } }` where `assistantMessage = Object.assign(function B4AssistantMessage(props) {…}, CopilotChatAssistantMessage)`: `toolbarVisible={hasText}`, `toolCallsView={B4ToolCallsView}`. `B4ToolCallsView({ message })` finds the turn whose steps (at any nesting) include one of `message.toolCalls[].id` and renders `<TurnActivity turn … />`, else `null`. Module-level stable components; turns reach them through context so the slot identity never changes.

- [ ] **Step 1: Write the failing tests**

`test/copilotkit/messages.test.ts`:

```ts
import type { Message } from "@ag-ui/core"
import { describe, expect, test } from "vitest"
import { mergeTurnMessages } from "../../src/copilotkit/messages.js"

const user = (id: string): Message => ({ id, role: "user", content: "hi" })
const text = (id: string, content = "Answer."): Message => ({ id, role: "assistant", content })
const calls = (id: string, ...ids: string[]): Message => ({ id, role: "assistant", content: "", toolCalls: ids.map((c) => ({ id: c, type: "function", function: { name: "x", arguments: "{}" } })) })
const result = (id: string, callId: string): Message => ({ id, role: "tool", content: "ok", toolCallId: callId })

describe("mergeTurnMessages", () => {
  test("keeps one tool-only assistant message per turn, keeps tool results and text, and restarts at each user message", () => {
    const out = mergeTurnMessages([user("u1"), calls("a1", "c1"), result("t1", "c1"), calls("a2", "c2"), result("t2", "c2"), text("a3"), user("u2"), calls("b1", "c3"), result("t3", "c3"), text("b2")])
    expect(out.map((m) => m.id)).toEqual(["u1", "a1", "t1", "t2", "a3", "u2", "b1", "t3", "b2"])
  })
  test("drops subagent messages and returns the same array when nothing changes", () => {
    const sub = { ...text("s1"), subagentRunId: "k1" } as Message
    expect(mergeTurnMessages([user("u1"), sub, text("a1")]).map((m) => m.id)).toEqual(["u1", "a1"])
    const stable = [user("u1"), text("a1")]
    expect(mergeTurnMessages(stable)).toBe(stable)
  })
})
```

`test/copilotkit/useB4Turns.test.tsx` (uses a fake agent with a `subscribe` seam, like `test/react/useSubagentRuns.test.tsx`; copy its `FakeAgent` helper if one exists there, else:)

```tsx
// @vitest-environment jsdom
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import { useB4Turns } from "../../src/copilotkit/useB4Turns.js"

class FakeAgent {
  private handlers: Array<(p: { event: BaseEvent }) => void> = []
  subscribe(s: { onEvent?: (p: { event: BaseEvent }) => void }) {
    if (s.onEvent) this.handlers.push(s.onEvent)
    return { unsubscribe: () => {} }
  }
  emit(event: BaseEvent) {
    for (const h of this.handlers) h({ event })
  }
}
const started = (runId: string): BaseEvent => ({ type: EventType.RUN_STARTED, threadId: "t", runId } as BaseEvent)
const finished = (runId: string): BaseEvent => ({ type: EventType.RUN_FINISHED, threadId: "t", runId, outcome: { type: "success" } } as BaseEvent)

describe("useB4Turns", () => {
  test("folds the agent's events into turns and consumes markResuming on the next RUN_STARTED", () => {
    const agent = new FakeAgent()
    const { result } = renderHook(() => useB4Turns(agent as never, { now: () => 1 }))
    act(() => {
      agent.emit(started("r1"))
      agent.emit({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "command" }] } } as BaseEvent)
    })
    expect(result.current.turns.turns[0]?.status).toBe("awaiting")
    act(() => result.current.markResuming())
    act(() => {
      agent.emit(started("r2"))
      agent.emit(finished("r2"))
    })
    expect(result.current.turns.turns).toHaveLength(1)
    expect(result.current.turns.turns[0]?.status).toBe("done")
    act(() => {
      agent.emit(started("r3"))
    })
    expect(result.current.turns.turns).toHaveLength(2) // no markResuming → a new turn
  })
})
```

`test/copilotkit/B4Activity.test.tsx` (mocks CopilotKit's v2 module; the fake agent above is shared via a small `test/copilotkit/fake-agent.ts` — extract it there and import in both tests):

```tsx
// @vitest-environment jsdom
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactElement } from "react"
import { describe, expect, test, vi } from "vitest"
import { FakeAgent } from "./fake-agent.js"

const agent = new FakeAgent()
const interruptConfig: { render?: (props: unknown) => ReactElement } = {}
const resolve = vi.fn(async () => {})
const cancel = vi.fn(async () => {})
const toolRenderers: Array<(props: unknown) => unknown> = []

vi.mock("@copilotkit/react-core/v2", () => ({
  useAgent: () => ({ agent, isReady: true }),
  useRenderTool: (config: { render: (props: unknown) => unknown }) => {
    toolRenderers.push(config.render)
  },
  useInterrupt: (config: { render: (props: unknown) => ReactElement }) => {
    interruptConfig.render = config.render
  },
  CopilotChatAssistantMessage: Object.assign(
    (props: { message: unknown; toolCallsView?: (p: { message: unknown }) => ReactElement | null }) =>
      props.toolCallsView ? props.toolCallsView({ message: props.message }) : null,
    { Toolbar: () => null },
  ),
}))

const { B4Activity, useB4ChatSlots } = await import("../../src/copilotkit/index.js")

function Host() {
  const slots = useB4ChatSlots()
  const Assistant = slots.messageView.assistantMessage as unknown as (p: { message: unknown }) => ReactElement
  return <Assistant message={{ id: "a1", role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "runBash", arguments: "{}" } }] }} />
}

describe("B4Activity", () => {
  test("silences stock tool rows, renders the turn for a message's tool calls, and renders approval cards that resolve or cancel", async () => {
    render(
      <B4Activity now={() => 5000}>
        <Host />
      </B4Activity>,
    )
    expect(toolRenderers[0]?.({})).toBeNull()
    act(() => {
      agent.emit({ type: EventType.RUN_STARTED, threadId: "t", runId: "r1" } as BaseEvent)
      agent.emit({ type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "runBash" } as BaseEvent)
      agent.emit({ type: EventType.CUSTOM, name: "b4.step", value: { toolCallId: "c1", status: "running", label: "Running node x", icon: "run" } } as BaseEvent)
      agent.emit({ type: EventType.RUN_FINISHED, threadId: "t", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "i1", reason: "command", toolCallId: "c1", responseSchema: { type: "string", enum: ["once", "always", "deny"] }, metadata: { kind: "command", detail: { command: "node x", suggestedPattern: "node" } } }] } } as BaseEvent)
    })
    expect(screen.getByTestId("turn").getAttribute("data-state")).toBe("awaiting")
    expect(screen.getByText("Running node x")).toBeTruthy()

    const card = interruptConfig.render?.({ interrupts: [{ id: "i1", reason: "command", toolCallId: "c1", responseSchema: { enum: ["once", "always", "deny"] }, metadata: { kind: "command", detail: { command: "node x" } } }], resolve, cancel }) as ReactElement
    render(card)
    expect(screen.getByText("The agent wants to running node x")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Allow once" }))
    expect(resolve).toHaveBeenCalledWith("once", "i1")
    fireEvent.click(screen.getByRole("button", { name: "Deny" }))
    expect(cancel).toHaveBeenCalledWith("i1")
  })
})
```

(The title reads "The agent wants to running node x" because the label is the step's running label verbatim after lower-casing its first letter; spec §3.2's example "wants to run a command" relies on a tool `display.running` phrased as an infinitive — note this in the connector's doc comment as guidance for tool authors, and do not transform verbs.)

`test/copilotkit/public-api.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import * as copilotkit from "../../src/copilotkit/index.js"

describe("@b4run/ag-ui/copilotkit public API", () => {
  test("exports the connector and the moved renderers", () => {
    expect(Object.keys(copilotkit).sort()).toEqual(["B4Activity", "b4ActivityRenderers", "b4PlanActivityRenderer", "mergeTurnMessages", "useB4ChatSlots", "useB4Turns"].sort())
  })
})
```

Fix `test/copilotkit/renderers.test.tsx` imports: `../../src/react/renderers.js` → `../../src/copilotkit/renderers.js`; `PlanActivityCard`/schema imports stay on `../../src/react/...`.

- [ ] **Step 2: Run to verify they fail** — `pnpm --filter @b4run/ag-ui exec vitest run test/copilotkit` → FAIL (modules missing).

- [ ] **Step 3: Implement**

`src/copilotkit/renderers.tsx` — today's `src/react/renderers.tsx` verbatim with imports repointed: `../activities.js`, `../react/PlanActivityCard.js`, `../react/schemas.js`.

`src/copilotkit/messages.ts`:

```ts
import type { Message } from "@ag-ui/core"
import { isSubagentMessage } from "../view/subagent-runs.js"

const toolOnly = (m: Message): boolean =>
  m.role === "assistant" &&
  (m.content === undefined || m.content === "" || (Array.isArray(m.content) && m.content.length === 0)) &&
  Array.isArray((m as { toolCalls?: unknown }).toolCalls)

/**
 * `messageView.transformMessages` for `<CopilotChat>`: one tool-only assistant
 * row per turn (the row `TurnActivity` renders on), tool results and prose kept,
 * subagent messages dropped (their text lives inside the nested turn). Returns
 * the input array when nothing changes.
 */
export function mergeTurnMessages(messages: Message[]): Message[] {
  const out: Message[] = []
  let seenToolRow = false
  let changed = false
  for (const message of messages) {
    if (isSubagentMessage(message)) {
      changed = true
      continue
    }
    if (message.role === "user") seenToolRow = false
    if (toolOnly(message)) {
      if (seenToolRow) {
        changed = true
        continue
      }
      seenToolRow = true
    }
    out.push(message)
  }
  return changed ? out : messages
}
```

`src/copilotkit/useB4Turns.ts`:

```ts
import type { BaseEvent } from "@ag-ui/core"
import { EventType } from "@ag-ui/core"
import { useCallback, useEffect, useRef, useState } from "react"
import type { SubagentEventSource } from "../react/useSubagentRuns.js"
import { EMPTY_TURNS, type ReduceTurnsOptions, reduceTurns, type TurnsView } from "../view/turns.js"

export interface UseB4TurnsOptions {
  readonly now?: (() => number) | undefined
  readonly hiddenTools?: readonly string[] | undefined
}

export interface UseB4TurnsResult {
  readonly turns: TurnsView
  /**
   * Call right before sending a `resume`: the next `RUN_STARTED` then continues
   * the awaiting turn instead of guessing (`ReduceTurnsOptions.resuming`).
   */
  readonly markResuming: () => void
}

/**
 * The agent's thread as turns, kept current from its event stream (replayed
 * events included). Options are read through a ref so a new `hiddenTools`
 * array literal on every render never re-subscribes (which would reset the view).
 */
export function useB4Turns(agent: SubagentEventSource | undefined, options: UseB4TurnsOptions = {}): UseB4TurnsResult {
  const [turns, setTurns] = useState<TurnsView>(EMPTY_TURNS)
  const resuming = useRef(false)
  const latest = useRef(options)
  latest.current = options
  useEffect(() => {
    if (agent === undefined) return
    setTurns(EMPTY_TURNS)
    const subscription = agent.subscribe({
      onEvent: ({ event }: { event: BaseEvent }) => {
        const { now, hiddenTools } = latest.current
        const reducerOptions: ReduceTurnsOptions = {
          ...(now !== undefined ? { now } : {}),
          ...(hiddenTools !== undefined ? { hiddenTools } : {}),
          ...(event.type === EventType.RUN_STARTED && resuming.current ? { resuming: true } : {}),
        }
        if (event.type === EventType.RUN_STARTED) resuming.current = false
        setTurns((previous) => reduceTurns(previous, event, reducerOptions))
      },
    })
    return () => subscription.unsubscribe()
  }, [agent])
  const markResuming = useCallback(() => {
    resuming.current = true
  }, [])
  return { turns, markResuming }
}
```

`src/copilotkit/B4Activity.tsx`:

```tsx
import type { Interrupt } from "@ag-ui/client"
import { useAgent, useInterrupt, useRenderTool } from "@copilotkit/react-core/v2"
import { createContext, type ReactElement, type ReactNode, useContext, useMemo } from "react"
import { ApprovalCard, type ApprovalDecision } from "../react/activity/ApprovalCard.js"
import type { StepRenderers } from "../react/activity/Step.js"
import { type StepLabelOverrides, stepLabel } from "../view/labels.js"
import type { ApprovalView, StepView, ToolStep, TurnView, TurnsView } from "../view/turns.js"
import { useB4Turns } from "./useB4Turns.js"

export interface B4ActivityContextValue {
  readonly turns: TurnsView
  readonly labels: StepLabelOverrides | undefined
  readonly renderStep: StepRenderers | undefined
  readonly now: () => number
}

const Context = createContext<B4ActivityContextValue | undefined>(undefined)

/** The turns and render options `B4Activity` provides; throws outside it. */
export function useB4ActivityContext(): B4ActivityContextValue {
  const value = useContext(Context)
  if (value === undefined) throw new Error("useB4ChatSlots must be used inside <B4Activity>")
  return value
}

export interface B4ActivityProps {
  readonly agentId?: string | undefined
  readonly labels?: StepLabelOverrides | undefined
  readonly hiddenTools?: readonly string[] | undefined
  readonly renderStep?: StepRenderers | undefined
  readonly now?: (() => number) | undefined
  readonly children?: ReactNode
}

/** The step a parked interrupt gates, and the subagent it sits in, at any depth. */
function locate(turns: readonly TurnView[], toolCallId: string | undefined, agentName = "The agent"): { step?: ToolStep; agent: string } {
  if (toolCallId === undefined) return { agent: agentName }
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.kind === "tool" && step.id === toolCallId) return { step, agent: agentName }
      if (step.kind === "subagent") {
        const found = locate([step.turn], toolCallId, step.name)
        if (found.step) return found
      }
    }
  }
  return { agent: agentName }
}

function approvalOf(interrupt: Interrupt): ApprovalView {
  const metadata = (interrupt.metadata ?? {}) as Record<string, unknown>
  const detail = (typeof metadata.detail === "object" && metadata.detail !== null ? metadata.detail : {}) as Record<string, unknown>
  const schema = interrupt.responseSchema as { enum?: unknown } | undefined
  return {
    interruptId: interrupt.id,
    kind: typeof metadata.kind === "string" ? metadata.kind : (interrupt.reason ?? "approval"),
    detail,
    ...(typeof metadata.message === "string" ? { message: metadata.message } : {}),
    ...(typeof metadata.grant === "string" ? { grant: metadata.grant } : {}),
    offersAlways: Array.isArray(schema?.enum) && schema.enum.includes("always"),
  }
}

const lowerFirst = (s: string) => (s.length > 0 ? s[0]?.toLowerCase() + s.slice(1) : s)

/**
 * Drives a stock `<CopilotChat>` with B4.run's activity kit (spec §6.2): hides
 * CopilotKit's generic tool rows, renders one `ApprovalCard` per parked
 * interrupt in the chat, and provides the thread's turns to `useB4ChatSlots`.
 * Tool authors: phrase `display.running` as an infinitive ("run a command") so
 * the card reads "The agent wants to run a command".
 */
export function B4Activity({ agentId, labels, hiddenTools, renderStep, now = Date.now, children }: B4ActivityProps): ReactElement {
  const { agent } = useAgent(agentId !== undefined ? { agentId } : {})
  const { turns, markResuming } = useB4Turns(agent, { now, hiddenTools })
  useRenderTool({ name: "*", render: () => null, ...(agentId !== undefined ? { agentId } : {}) }, [agentId])
  useInterrupt({
    ...(agentId !== undefined ? { agentId } : {}),
    render: ({ interrupts, resolve, cancel }) => (
      <>
        {interrupts.map((interrupt) => {
          const approval = approvalOf(interrupt)
          const { step, agent: agentName } = locate(turns.turns, interrupt.toolCallId)
          const label = step ? lowerFirst(stepLabel({ ...step, status: "running" }, labels)) : "continue"
          const onDecide = async (decision: ApprovalDecision) => {
            markResuming()
            if (decision === "deny") await cancel(interrupt.id)
            else await resolve(decision, interrupt.id)
          }
          return <ApprovalCard key={interrupt.id} approval={approval} agent={agentName} label={label} onDecide={onDecide} />
        })}
      </>
    ),
  })
  const value = useMemo<B4ActivityContextValue>(() => ({ turns, labels, renderStep, now }), [turns, labels, renderStep, now])
  return <Context.Provider value={value}>{children}</Context.Provider>
}

/** The turn that owns any of these tool call ids, searching nested turns. */
export function turnForToolCalls(turns: TurnsView, ids: readonly string[]): TurnView | undefined {
  const owns = (steps: readonly StepView[]): boolean =>
    steps.some((s) => (s.kind === "tool" && ids.includes(s.id)) || (s.kind === "subagent" && (ids.includes(s.id) || owns(s.turn.steps))))
  return turns.turns.find((turn) => owns(turn.steps))
}
```

`src/copilotkit/useB4ChatSlots.tsx`:

```tsx
import { CopilotChatAssistantMessage, type CopilotChatAssistantMessageProps } from "@copilotkit/react-core/v2"
import type { ReactElement } from "react"
import { TurnActivity } from "../react/activity/TurnActivity.js"
import { turnForToolCalls, useB4ActivityContext } from "./B4Activity.js"
import { mergeTurnMessages } from "./messages.js"

function B4ToolCallsView({ message }: { readonly message: { readonly toolCalls?: ReadonlyArray<{ readonly id: string }> | undefined } }): ReactElement | null {
  const { turns, labels, renderStep, now } = useB4ActivityContext()
  const ids = message.toolCalls?.map((c) => c.id) ?? []
  if (ids.length === 0) return null
  const turn = turnForToolCalls(turns, ids)
  return turn ? <TurnActivity turn={turn} labels={labels} renderStep={renderStep} now={now} /> : null
}

const hasText = (content: unknown): boolean =>
  (typeof content === "string" && content.trim() !== "") || (Array.isArray(content) && content.some((p) => typeof p === "object" && p !== null && (p as { type?: unknown }).type === "text"))

// `SlotValue<typeof CopilotChatAssistantMessage>` requires the component's
// namespace statics; Object.assign copies them onto the wrapper (spike finding).
const B4AssistantMessage = Object.assign(function B4AssistantMessage(props: CopilotChatAssistantMessageProps) {
  return <CopilotChatAssistantMessage {...props} toolbarVisible={hasText(props.message.content)} toolCallsView={B4ToolCallsView} />
}, CopilotChatAssistantMessage)

export interface B4ChatSlots {
  readonly messageView: {
    readonly transformMessages: typeof mergeTurnMessages
    readonly assistantMessage: typeof B4AssistantMessage
  }
}

/**
 * Props to spread onto `<CopilotChat>` inside `<B4Activity>`: one tool row per
 * turn, rendered as `TurnActivity`; no toolbar under tool-only rows.
 *
 * ```tsx
 * <B4Activity><Chat /></B4Activity>
 * function Chat() { return <CopilotChat {...useB4ChatSlots()} /> }
 * ```
 */
export function useB4ChatSlots(): B4ChatSlots {
  useB4ActivityContext() // fail fast outside the provider
  return SLOTS
}

const SLOTS: B4ChatSlots = { messageView: { transformMessages: mergeTurnMessages, assistantMessage: B4AssistantMessage } }
```

`src/copilotkit/index.ts`:

```ts
/**
 * `@b4run/ag-ui/copilotkit` — the CopilotKit (React) connector for B4.run's
 * activity kit. `react` and `@copilotkit/react-core` (>=1.76, the v2 API) are
 * optional peer dependencies of `@b4run/ag-ui`; this is the only entry that
 * imports CopilotKit.
 */
export { B4Activity, type B4ActivityProps } from "./B4Activity.js"
export { mergeTurnMessages } from "./messages.js"
export { b4ActivityRenderers, b4PlanActivityRenderer } from "./renderers.js"
export { type B4ChatSlots, useB4ChatSlots } from "./useB4ChatSlots.js"
export { type UseB4TurnsOptions, type UseB4TurnsResult, useB4Turns } from "./useB4Turns.js"
```

`package.json` `exports`: insert after `"./react"`:

```json
"./copilotkit": {
  "types": "./dist/copilotkit/index.d.ts",
  "default": "./dist/copilotkit/index.js"
},
```

(`@ag-ui/client` is already an optional peer; `Interrupt` is imported as a type only.)

- [ ] **Step 4: Run tests, typecheck, lint, build**

Run: `pnpm --filter @b4run/ag-ui exec vitest run && pnpm --filter @b4run/ag-ui typecheck && pnpm --filter @b4run/ag-ui lint && pnpm --filter @b4run/ag-ui build && ls packages/ag-ui/dist/copilotkit/index.js`
Expected: all pass; `dist/copilotkit/index.js` exists. If `useInterrupt`'s `render` typing rejects the fragment, wrap it in `<div className="b4-approvals">` and add that class to `styles.css` (margin 0).

- [ ] **Step 5: Commit**

```bash
git add packages/ag-ui/src/copilotkit packages/ag-ui/test/copilotkit packages/ag-ui/package.json
git commit -m "feat(ag-ui): @b4run/ag-ui/copilotkit — B4Activity, useB4Turns, useB4ChatSlots; renderers move here

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 16: Register `./copilotkit`; docs, README, changeset, upgrading, lastmod

**Files:**
- Modify: `scripts/check-docs.mjs` (`EXPECTED_API_ARTIFACT_POLICY_TUPLES` after the `./react` tuple; count pins 51→52, 47→48), `apps/web/app/components/docs/api-reference.ts` (`runtimeImport("@b4run/ag-ui", "./copilotkit", "detailed", "node-only", "application")` after the `./react` line; `importAddress("@b4run/ag-ui", "./copilotkit")` in `PACKAGE_CATALOG`), `apps/web/app/components/docs/api-reference.test.ts` (`["@b4run/ag-ui", "./copilotkit"]` in `EXPECTED_DETAILED_IMPORTS`; `toHaveLength(47)` → `48`), `apps/web/content/docs/api.mdx` (ag-ui catalog row gains `@b4run/ag-ui/copilotkit`), `apps/web/content/docs/api/ag-ui.mdx`, `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/upgrading.mdx`, `packages/ag-ui/README.md`
- Create: `.changeset/ag-ui-react-kit.md`

- [ ] **Step 1: Pins** — exactly as listed above; do NOT add `./copilotkit` to `EDGE_SAFE_API_ADDRESSES`.

- [ ] **Step 2: `api/ag-ui.mdx`**

Compatibility table: add `| \`@b4run/ag-ui/copilotkit\` | node-only | not-claimed | application | supported |` after the `./react` row. Import section: add `import { B4Activity, useB4ChatSlots } from "@b4run/ag-ui/copilotkit"` with one sentence. Prose at the `@b4run/ag-ui/view … It ships CopilotKit renderers …` paragraph: replace "`@b4run/ag-ui/react` is the React client entry built on it. It ships CopilotKit renderers for B4.run's built-in orchestration activities." with "`@b4run/ag-ui/react` is the React activity kit built on it: `TurnActivity`, `ApprovalCard` and the step rows take the view core's props and render one turn in plain language. `@b4run/ag-ui/copilotkit` connects the kit to a stock CopilotKit chat." Keep the rest of the paragraph.

Rewrite the `### \`@b4run/ag-ui/react\`` export table so it has exactly one row per export of the new barrel (Task 13's list). Rows (keep this wording):

```mdx
| Export | Responsibility |
|---|---|
| `TurnActivity` | The summary line plus the step list for one turn, nested for subagents: working, awaiting, done, failed or stopped. |
| `Step` | One tool call as a sentence with its icon and meta; opens to `StepDetail`. |
| `StepGroup` | Consecutive done calls of one tool, merged; opens to the individual steps. |
| `StepDetail` | A step's Inputs and Output, pretty JSON or text. |
| `PlanStep` | "Made a plan · 2 of 4 done" with the checklist; updates in place. |
| `ReasoningStep` | "Thinking…", "Thought for 4s" or "Show reasoning"; opens to the text. |
| `SubagentStep` | "Asked researcher to …" with the child's own activity nested; folds to "researcher finished · N steps". |
| `ApprovalCard` | A parked interrupt: who wants what, why, the payload, Allow once / Always allow / Deny on one row, and the scope line. |
| `SourceChips` | File or URL chips from a step's sources, with "+N" overflow. |
| `Disclosure` | A `button[aria-expanded]` and its panel, following the open/closed rule. |
| `useDisclosure` | The open/closed rule: automation decides until the user toggles; the user wins until the item is live again. |
| `StepIcon` | The glyph for a `ToolDisplayIcon` name (16px, `currentColor`). |
| `Chevron` | The disclosure chevron. |
| `StatusText` | The muted "· meta" fragment after a sentence. |
| `Checklist` | The plan's SVG checklist. |
| `summaryLine` | The summary sentence and meta for a turn at a given time. |
| `formatDuration` | `<1s`, `Ns`, `Nm Ms`; undefined for an unknown duration. |
| `approvalPayload` | The payload an approval card shows: args preview, command, or detail JSON. |
| `scopeLine` | What "Always allow" covers, from the interrupt's kind and pattern. |
| `useLive` | Whether a running step shows its running treatment (after 300 ms). |
| `useElapsed` | A clock re-sampled once a second while active. |
| `useSubagentRuns` | Fold the agent's events into the subagent tree (`SubagentRunsState`). |
| `reduceSubagentRuns` | Re-export of the pure reducer from `@b4run/ag-ui/view`. |
| `EMPTY_SUBAGENT_RUNS` | Re-export from `@b4run/ag-ui/view`. |
| `isSubagentMessage` | Re-export from `@b4run/ag-ui/view`. |
| `planActivityContentSchema` | Zod schema for the `b4.plan` activity content. |
| `PlanActivityCard` | Deprecated legacy plan card; removed when the research example adopts `TurnActivity`. |
| `ActivityChecklist` | Deprecated legacy checklist; removed with `PlanActivityCard`. |
| `SubagentPanel` | Deprecated legacy subagent tree; removed when the research example adopts `SubagentStep`. |
| `cx` | Deprecated class joiner for the legacy cards' `classNames` slots. |
```

Then add, before the `### \`@b4run/ag-ui/react\`` heading's sibling for CSS (or right after the react table):

```mdx
### `@b4run/ag-ui/copilotkit`

The CopilotKit (React) connector: it drives a stock `<CopilotChat>` with the activity kit.

| Export | Responsibility |
|---|---|
| `B4Activity` | Provider around your chat: hides CopilotKit's generic tool rows, renders one `ApprovalCard` per parked interrupt, and keeps the thread's turns current from the agent's events. |
| `useB4ChatSlots` | Props to spread onto `<CopilotChat>`: one tool row per turn rendered as `TurnActivity`, no toolbar under tool-only rows. |
| `useB4Turns` | The agent's thread as turns (`reduceTurns`), plus `markResuming()` to call before sending a resume. |
| `mergeTurnMessages` | The `transformMessages` function `useB4ChatSlots` installs: one tool-only assistant row per turn, subagent messages dropped. |
| `b4ActivityRenderers` | CopilotKit `renderActivityMessages` for hosts not using `B4Activity`: the legacy plan card. Moved here from `./react`. |
| `b4PlanActivityRenderer` | The plan renderer alone. Moved here from `./react`. |
```

Update the `styles.css` token list in the same page to the §5.1 names (surface, surface-alt, border, text, muted, running, running-bg, complete, failed, failed-bg, primary, on-primary, radius, radius-card, radius-pill, font-mono) and say the sheet is `@layer b4-activity` so app CSS wins; keep a sentence that the legacy geometry tokens (`gap`, `font-size`, `margin`, `padding`, `header-weight`) remain until the legacy cards go. Update the prose line that names `classNames`/`components` to say they are deprecated.

- [ ] **Step 3: `ag-ui.mdx` "Consuming it from a web UI"**

Replace the `b4ActivityRenderers` snippet with:

```tsx
import "@b4run/ag-ui/react/styles.css"
import { B4Activity, useB4ChatSlots } from "@b4run/ag-ui/copilotkit"
import { CopilotChat, CopilotKit } from "@copilotkit/react-core/v2"

function Chat() {
  return <CopilotChat {...useB4ChatSlots()} />
}

export default function Page() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit" useSingleEndpoint={false}>
      <B4Activity>
        <Chat />
      </B4Activity>
    </CopilotKit>
  )
}
```

followed by three sentences: what renders (one `TurnActivity` per turn, approval cards in the chat), that `labels`, `hiddenTools` and `renderStep` on `B4Activity` reword, hide or re-render steps, and that a host with its own transcript uses `useB4Turns` + `TurnActivity` + `ApprovalCard` directly (the research example does this in a later release). Keep the existing `SubagentPanel`/`useSubagentRuns` paragraph but prefix it with "Deprecated:".

- [ ] **Step 4: README**

In `packages/ag-ui/README.md`, before `## React renderers`, add `## Activity components` (the kit: one paragraph + the Chat snippet above) and `## CopilotKit connector` (B4Activity / useB4ChatSlots / useB4Turns one line each, and that `b4ActivityRenderers` moved here). In `## React renderers`, change the import to `@b4run/ag-ui/copilotkit` and add "Deprecated: the legacy cards and the `classNames`/`components` rungs go away once the research example adopts the kit." Keep the exact strings `## React renderers`, `b4ActivityRenderers`, `**Rung 1 — tokens.**`, `**Rung 2 — \`classNames\`.**`, `**Rung 3 — \`components\`.**`, `**Rung 4 — eject.**` (pinned by `scripts/readme-contracts.test.mjs`). Add `@b4run/ag-ui/copilotkit` to the "Runtime and stability" per-subpath list.

- [ ] **Step 5: `upgrading.mdx` entry** (newest first, under `## Changes by version`):

```mdx
### `b4ActivityRenderers` lives in `@b4run/ag-ui/copilotkit`

Landed in the first release after **0.13.1**. Action required if you import `b4ActivityRenderers` or `b4PlanActivityRenderer` from `@b4run/ag-ui/react`: import them from `@b4run/ag-ui/copilotkit` instead. `./react` no longer depends on CopilotKit; it is the React activity kit (`TurnActivity`, `ApprovalCard`, the step rows). The legacy cards `PlanActivityCard`, `ActivityChecklist` and `SubagentPanel` and their `classNames`/`components` slots still ship, deprecated, until the research example adopts the kit. The stylesheet now sits in `@layer b4-activity` with the design tokens `--b4-activity-surface-alt`, `-running-bg`, `-failed-bg`, `-primary`, `-on-primary`, `-radius-card`, `-radius-pill` and `-font-mono` added; `-complete` is now `#15803d`. See [AG-UI](/docs/ag-ui).
```

- [ ] **Step 6: Changeset** `.changeset/ag-ui-react-kit.md`:

```md
---
"@b4run/ag-ui": patch
---

**Breaking:** `b4ActivityRenderers` and `b4PlanActivityRenderer` moved from `@b4run/ag-ui/react` to the new `@b4run/ag-ui/copilotkit` entry; `./react` no longer imports CopilotKit.

`@b4run/ag-ui/react` is now the React activity kit: `TurnActivity`, `Step`, `StepGroup`, `StepDetail`, `PlanStep`, `ReasoningStep`, `SubagentStep`, `ApprovalCard`, `SourceChips` and the building blocks, rendering one turn in plain language from `@b4run/ag-ui/view`. `@b4run/ag-ui/copilotkit` drives a stock `<CopilotChat>` with it (`B4Activity`, `useB4ChatSlots`, `useB4Turns`). The stylesheet moves into `@layer b4-activity` with the design tokens; dark mode follows the host (`.dark`, `[data-theme="dark"]`, `data-b4-theme`). The legacy cards stay, deprecated.
```

- [ ] **Step 7: Gates**

Run: `pnpm build && node scripts/check-docs.mjs && pnpm --filter @b4run/web exec vitest run app/components/docs && pnpm pack:check && node scripts/readme-contracts.test.mjs 2>/dev/null || pnpm exec vitest run scripts/readme-contracts.test.mjs`
Expected: all pass (the inventory validates both export tables against the barrels; a mismatch names the export). Then `pnpm --filter @b4run/cli exec vitest run test/api-reference-compatibility.test.ts` — the new `node-only` address must import under plain Node and fail the browser-negative probe (React's `process.env.NODE_ENV`); expected PASS.

- [ ] **Step 8: Commit, regenerate lastmod, commit**

```bash
git add scripts/check-docs.mjs apps/web/app/components/docs apps/web/content/docs packages/ag-ui/README.md .changeset/ag-ui-react-kit.md
git commit -m "docs: register @b4run/ag-ui/copilotkit; document the activity kit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod && git add apps/web/app/seo/lastmod.generated.json && git commit -m "chore(web): regenerate seo lastmod

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 17: The chat example imports the renderers from `./copilotkit`

**Files:**
- Modify: `examples/chat/web/app/page.tsx:2`

- [ ] **Step 1: Change the import**

`import { b4ActivityRenderers } from "@b4run/ag-ui/react"` → `import { b4ActivityRenderers } from "@b4run/ag-ui/copilotkit"`. Update the comment block's sentence "(Subagents are not activities; a client that drives a delegating route renders them with `SubagentPanel`.)" to "(Subagents are not activities; a client that drives a delegating route renders them with the activity kit's `SubagentStep`.)".

- [ ] **Step 2: Typecheck both examples and the devkit parity test**

Run: `pnpm --filter @b4-example/chat-web typecheck && pnpm --filter @b4-example/research-web typecheck && pnpm --filter @b4run/devkit exec vitest run test/templates.test.ts`
Expected: pass (research imports only retained exports; the template parity test is unaffected because no research file changed).

- [ ] **Step 3: Commit**

```bash
git add examples/chat/web/app/page.tsx
git commit -m "chore(chat-example): import the activity renderers from @b4run/ag-ui/copilotkit

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

### Task 18: Validation and the PR

- [ ] **Step 1: Full local gates**

Run: `pnpm lint && pnpm typecheck && node scripts/check-docs.mjs && pnpm --filter @b4run/ag-ui test && pnpm --filter @b4run/web test && pnpm pack:check && node scripts/check-changesets.mjs`
Expected: all pass. Then `pnpm test` (full; `assert-docker-smoke` / `bounded-filesystem` timeouts under contention are known flakes — rerun those files in isolation if they fire). Run `pnpm verify:harness:framework` (~7 min): the generated research app typechecks against the published-shape `@b4run/ag-ui`; it imports only retained `./react` exports, so expected PASS.

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin blove/activity-react-kit
gh pr create --base main --title "feat(ag-ui)!: React activity kit and the @b4run/ag-ui/copilotkit connector" --body "$(cat <<'EOF'
Sub-project 2a of `docs/superpowers/specs/2026-10-03-b4-activity-components-design.md` (plan: `docs/superpowers/plans/2026-10-04-b4-activity-react-kit.md`).

- `@b4run/ag-ui/react` is the React activity kit: `TurnActivity`, `Step`, `StepGroup`, `StepDetail`, `PlanStep`, `ReasoningStep`, `SubagentStep`, `ApprovalCard`, `SourceChips` and the blocks, rendering the spec's DOM contract from `@b4run/ag-ui/view` props; stylesheet under `@layer b4-activity` with the design tokens, host-driven dark mode, reduced-motion and focus rules.
- New `@b4run/ag-ui/copilotkit`: `B4Activity` (silences stock tool rows, renders approval cards in the chat, provides turns), `useB4ChatSlots` (one `TurnActivity` per turn via `transformMessages` + `assistantMessage`), `useB4Turns`.
- **Breaking:** `b4ActivityRenderers`/`b4PlanActivityRenderer` moved to `./copilotkit`; `./react` has no CopilotKit import. Legacy cards stay, deprecated, until sub-project 2b (research example adoption).
- Docs: `/docs/api/ag-ui` tables for both entries, registry pins, upgrading entry, README sections, changeset.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Then `mcp__ccd_pr__get_status`, `mcp__ccd_pr__set_monitor` (auto_fix) and `mcp__ccd_pr__set_auto_merge` (`enabled: true`, `squash`).

---

## Deferred to sub-project 2b (research example + template adoption)

- Replace `PlanCard`, `ToolCallCard`, `SubagentPanel`, `PermissionPrompt`/`PermissionInterrupt`, `HydratedInterrupts` in `examples/research/web` with `useB4Turns` + `TurnActivity` + `ApprovalCard`; mirror into `packages/devkit/templates/app-research/web` (byte parity test, `.template` counts).
- Rewrite the W8 harness locators and the golden list (`test/harness/workbench-suggestions.ts`, `.test.ts`), the W7 restore assertions, and `docs/brand/demo/capture.mjs`.
- Remove the legacy cards, `classNames`/`components`, `cx`, the legacy tokens and CSS, the README rungs 2–3 and their `readme-contracts` pins, the `recipes/research-web-ui.mdx` ladder prose; `upgrading.mdx` entry.
- The Playwright keyboard pass (toggle, approve, deny) and an `axe-core` devDependency for component tests (spec §8).
- Verify, in the research example, that CopilotKit's `connect` replay reaches `agent.subscribe` (so `useB4Turns` restores a thread after reload); if not, feed the replayed stream into the reducer from the connect response.

## Self-review

**Spec coverage.** §3 catalog: every component has a task (TurnActivity/SubagentStep T10, Step T6, StepGroup T9, StepDetail/SourceChips T5, PlanStep T7, ReasoningStep T8, ApprovalCard T11; blocks Disclosure/StepIcon/StatusText/Checklist T3–T7). §3.1: open/closed rule and manual-wins (T4), summary line and 1 s tick (T2/T10), merging (T9 via `groupSteps`), 300 ms no-flash (T4/T6), hidden tools (`hiddenTools` through `useB4Turns` T15), per-tool views (`renderStep` T6/T10). §3.2: placement in chat (T15 `useInterrupt` default `renderInChat`), text/buttons/scope/alert/states (T11); "the step's sentence gains · allowed once" is NOT implemented — the reducer clears the approval on resume and the spec now says the decision annotation comes from the connector; B4Activity knows the decision (it sent it) but carrying it onto the step is deferred to 2b (noted). §4 labels: `stepLabel` client-first precedence consumed (T6). §5.1–5.5: tokens, type/spacing, host-driven theme, motion, a11y (T12; `role="status"` per turn T10; `role="alert"` T11). §5.6 DOM contract: classes and data attributes as specified (`.b4-step__sources` sits outside the button, as a sibling — the contract lists it among the row's children, satisfied). §6.2: `B4Activity` props `labels? hiddenTools? renderStep?` (T15), `useB4ChatSlots` with the three slot behaviours (T15), independent per-interrupt resolution (T15), spike-driven forms (statics via `Object.assign`, merge by turn, replay-restored interrupts). §7: throwing override → fallback (view core), malformed payloads dropped (reducer), decision fails to send → inline error + re-enabled buttons (T11). §8 components: every state asserted against the contract in T5–T11 (light/dark are CSS tokens, asserted in T12); axe and Playwright deferred to 2b and stated. §9 item 2: components ✔, `./copilotkit` ✔, `@layer` ✔, research example + template adoption → 2b (stated), breaking `./react` + upgrading entry ✔ (partial: renderers move now, slots removal in 2b).

**Placeholders.** None: every code step has the code; the one "paste today's rules" instruction in T12 references existing file content by location.

**Type consistency.** `StepRenderers`/`StepRenderer` defined in T6 and used in T9/T10/T15 with the same names; `Disclosure` props (`autoOpen`, `live`, `className`, `summary`, `panelClassName`, `onOpenChange`) consistent across T4, T6–T10; `summaryLine(turn, now)` returns `{ text, meta, live }` in T2 and T10; `useLive(step, now)` / `useElapsed(active, now)` signatures match T4 and T6/T10; `ApprovalDecision` "once|always|deny" in T11 and T15; `useB4Turns(agent, { now, hiddenTools })` returns `{ turns, markResuming }` in T15's hook, provider and test; `turnForToolCalls(turns: TurnsView, ids)` defined and used in T15; the public-api lists in T13 and T15 match the barrels written in those tasks.

/**
 * Views both activity kits render: the React kit (`src/react`) and the
 * Angular kit (`src/angular`). The parity tests render each fixture
 * through both kits and compare the serialized DOM contract to one committed
 * snapshot (`activity-contract.snap.json`), so a kit that drifts fails.
 *
 * Plain data only (and label functions): no framework imports.
 */
import type { StepLabelOverrides } from "../../src/view/labels.ts"
import type {
  ApprovalView,
  PlanStep,
  ReasoningStep,
  StepView,
  SubagentStep,
  ToolStep,
  TurnView,
} from "../../src/view/turns.ts"

/**
 * `Partial` that also accepts an explicit `undefined`, so a case can unset a
 * default (`endedAt: undefined`); {@link compact} then drops the key, which
 * `exactOptionalPropertyTypes` requires of the built view.
 */
export type Loose<T> = { [K in keyof T]?: T[K] | undefined }
export const compact = <T extends object>(o: Loose<T>): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

export const tool = (id: string, o: Loose<ToolStep> = {}): ToolStep =>
  compact<ToolStep>({
    kind: "tool",
    id,
    name: "searchCorpus",
    status: "done",
    args: "",
    startedAt: 0,
    settledAt: 500,
    label: "Searched the corpus",
    icon: "search",
    ...o,
  })

export const turn = (o: Loose<TurnView>): TurnView =>
  compact<TurnView>({
    runId: "r",
    status: "done",
    startedAt: 0,
    endedAt: 72_000,
    steps: [tool("a"), tool("b")],
    text: "",
    approvals: [],
    failed: 0,
    ...o,
  })

export const plan = (o: Loose<PlanStep> = {}): PlanStep =>
  compact<PlanStep>({
    kind: "plan",
    id: "plan",
    todos: [
      { content: "Find sources", status: "completed" },
      { content: "Draft the summary", status: "in_progress" },
      { content: "Check citations", status: "pending" },
      { content: "Save the report", status: "pending" },
    ],
    startedAt: 0,
    updatedAt: 1,
    ...o,
  })

export const reasoning = (o: Loose<ReasoningStep> = {}): ReasoningStep =>
  compact<ReasoningStep>({
    kind: "reasoning",
    id: "th",
    text: "Weigh the two sources first.",
    status: "done",
    startedAt: 0,
    settledAt: 4000,
    ...o,
  })

export const subagent = (o: Loose<SubagentStep> = {}): SubagentStep =>
  compact<SubagentStep>({
    kind: "subagent",
    id: "c1",
    name: "researcher",
    description: "Briefs the weather along the route",
    status: "done",
    startedAt: 1000,
    settledAt: 9000,
    turn: turn({
      runId: "c1",
      startedAt: 1000,
      endedAt: 9000,
      steps: [
        tool("n1", {
          name: "readDoc",
          args: '{"path":"a.md"}',
          result: "…",
          label: "Read a.md",
          icon: "read",
          startedAt: 1000,
          settledAt: 2000,
        }),
        tool("n2", {
          name: "runBash",
          args: '{"command":"node x"}',
          result: "ok",
          label: "Ran node x",
          icon: "run",
          startedAt: 2000,
          settledAt: 8000,
        }),
      ],
    }),
    ...o,
  })

export const approval = (o: Loose<ApprovalView> = {}): ApprovalView =>
  compact<ApprovalView>({
    interruptId: "i1",
    kind: "command",
    detail: { command: "rm -rf build", suggestedPattern: "rm -rf build" },
    message: "It isn't on this app's allow-list.",
    offersAlways: true,
    ...o,
  })

export interface TurnFixture {
  readonly turn: TurnView
  /** The clock the kit samples; fixed, so the snapshot is stable. */
  readonly now: number
  readonly labels?: StepLabelOverrides
  readonly nested?: { readonly name: string; readonly status: SubagentStep["status"] }
}

export interface ApprovalFixture {
  readonly approval: ApprovalView
  readonly agent: string
  readonly label: string
  /**
   * Click this button after mounting (`pending`: the decision never settles,
   * so the card stays deciding; `reject`: it fails with "network down").
   */
  readonly decide?: {
    readonly choice: "once" | "always" | "deny"
    readonly outcome: "pending" | "reject"
  }
}

const researchSteps: readonly StepView[] = [
  reasoning(),
  plan({
    todos: [
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
    ],
  }),
  tool("s1", { args: "{}", startedAt: 10, settledAt: 20, sources: [{ title: "a.md" }] }),
  tool("s2", { args: "{}", startedAt: 20, settledAt: 30, sources: [{ title: "b.md" }] }),
  subagent({ description: "summarize ReAct" }),
  tool("w", {
    name: "writeFile",
    args: '{"path":"reports/x.md"}',
    label: "Saved reports/x.md",
    icon: "write",
    startedAt: 9000,
    settledAt: 9500,
  }),
]

/** Every turn state, every step kind and state, the detail and source variants. */
export const TURN_FIXTURES: Readonly<Record<string, TurnFixture>> = {
  "done research turn": { turn: turn({ steps: researchSteps }), now: 0 },
  "working turn with a live and a fresh call": {
    now: 12_400,
    turn: turn({
      status: "working",
      endedAt: undefined,
      steps: [
        tool("a"),
        tool("b", {
          status: "running",
          settledAt: undefined,
          label: "Searching the corpus",
          startedAt: 100,
        }),
        tool("c", {
          name: "readDoc",
          status: "running",
          settledAt: undefined,
          label: "Reading a.md",
          icon: "read",
          startedAt: 12_300,
        }),
      ],
    }),
  },
  "working turn with no running call": {
    now: 3000,
    turn: turn({ status: "working", endedAt: undefined, steps: [plan()] }),
  },
  "awaiting turn": {
    now: 38_000,
    turn: turn({
      status: "awaiting",
      endedAt: undefined,
      steps: [
        tool("a", {
          name: "runBash",
          status: "awaiting",
          settledAt: undefined,
          args: '{"command":"rm -rf build"}',
          label: "Wants to run a command",
          icon: "run",
          approval: approval(),
        }),
      ],
    }),
  },
  "failed turn": {
    now: 2000,
    turn: turn({
      status: "failed",
      failed: 2,
      steps: [
        tool("a", {
          name: "readDoc",
          status: "failed",
          args: '{"path":"plan.md"}',
          result: "ENOENT: no such file",
          label: "Couldn't read plan.md",
          icon: "read",
        }),
        tool("b", { status: "failed", label: "Searched the corpus" }),
      ],
    }),
  },
  "stopped turn": {
    now: 0,
    turn: turn({ status: "stopped", endedAt: 4200, steps: [tool("a")] }),
  },
  "stopped turn of unknown length": {
    now: 0,
    turn: turn({ status: "stopped", startedAt: 5000, endedAt: 1000, steps: [] }),
  },
  "denied call": {
    now: 0,
    turn: turn({
      steps: [
        tool("a", {
          name: "deployProd",
          status: "denied",
          args: '{"env":"prod"}',
          label: "Wanted to deploy",
          icon: "run",
        }),
      ],
    }),
  },
  "details: fields, text, code, empty and truncated": {
    now: 0,
    turn: turn({
      steps: [
        tool("j", { args: '{"query":"react","limit":3}', result: '{"hits":2}' }),
        tool("t", { name: "readDoc", args: "plain text", result: "not json {", icon: "read" }),
        tool("e", { name: "noop", args: "", label: "Did nothing", icon: "tool" }),
        tool("x", { name: "dump", args: "{}", result: "x".repeat(20_010), label: "Dumped" }),
        tool("n", {
          name: "getMetar",
          args: '{"ids":["KSTP","KRST"]}',
          result: '[{"id":"KSTP","flightCategory":"VFR"}]',
          label: "Fetched METARs",
          icon: "web",
        }),
        tool("w", {
          name: "writeFile",
          args: JSON.stringify({ path: "reports/a.md", content: `| Leg |\n${"-".repeat(90)}` }),
          result: '"wrote 99 bytes"',
          label: "Saved reports/a.md",
          icon: "write",
        }),
      ],
    }),
  },
  "sources: links, unsafe hrefs, overflow": {
    now: 0,
    turn: turn({
      steps: [
        tool("s", {
          name: "webSearch",
          icon: "web",
          label: "Searched the web",
          sources: [
            { title: "MDN", href: "https://developer.mozilla.org" },
            { title: "script", href: "javascript:alert(1)" },
            { title: "local", href: "/files/a.md" },
            { title: "mail", href: "mailto:a@b.c" },
            { title: "plain" },
          ],
        }),
      ],
    }),
  },
  "a group with sources and one without": {
    now: 0,
    turn: turn({
      steps: [
        tool("g1", { sources: [{ title: "a.md" }] }),
        tool("g2", { sources: [{ title: "b.md" }, { title: "c.md" }] }),
        tool("h1", { name: "readDoc", label: "Read a.md", icon: "read" }),
        tool("h2", { name: "readDoc", label: "Read b.md", icon: "read" }),
      ],
    }),
  },
  "label overrides": {
    now: 0,
    labels: {
      searchCorpus: {
        done: () => "Looked it up",
        group: (n) => `Looked things up ${n} times`,
      },
    },
    turn: turn({}),
  },
  "unknown icon and missing label": {
    now: 0,
    turn: turn({
      steps: [tool("u", { name: "mystery", label: undefined, icon: "constructor" })],
    }),
  },
  "reasoning: streaming, done, unknown duration, encrypted": {
    now: 1000,
    turn: turn({
      status: "working",
      endedAt: undefined,
      steps: [
        reasoning({ id: "r1" }),
        reasoning({ id: "r2", settledAt: undefined }),
        reasoning({ id: "r3", text: "" }),
        reasoning({ id: "r4", status: "streaming", settledAt: undefined, text: "Hmm" }),
      ],
    }),
  },
  "plan, live": {
    now: 500,
    turn: turn({ status: "working", endedAt: undefined, steps: [plan()] }),
  },
  "subagents: running, paused, done, failed": {
    now: 10_000,
    turn: turn({
      status: "awaiting",
      endedAt: undefined,
      steps: [
        subagent({
          id: "run",
          status: "running",
          settledAt: undefined,
          turn: turn({
            runId: "run",
            status: "working",
            startedAt: 1000,
            endedAt: undefined,
            steps: [
              tool("q", {
                name: "readDoc",
                status: "running",
                settledAt: undefined,
                label: "Reading a.md",
                icon: "read",
                startedAt: 2000,
              }),
            ],
          }),
        }),
        subagent({
          id: "paused",
          name: "deployer",
          description: undefined,
          status: "paused",
          settledAt: undefined,
          turn: turn({
            runId: "paused",
            status: "awaiting",
            endedAt: undefined,
            steps: [
              tool("d", {
                name: "deployProd",
                status: "awaiting",
                settledAt: undefined,
                label: "Wants to deploy",
                icon: "run",
              }),
            ],
          }),
        }),
        subagent({ id: "done" }),
        subagent({
          id: "failed",
          status: "failed",
          error: "boom",
          turn: turn({ runId: "failed", status: "failed", error: "boom", failed: 1, steps: [] }),
        }),
        subagent({
          id: "failed-quietly",
          status: "failed",
          turn: turn({ runId: "fq", status: "failed", failed: 1, steps: [tool("z")] }),
        }),
      ],
    }),
  },
  "nested turn, finished": {
    now: 0,
    turn: turn({}),
    nested: { name: "researcher", status: "done" },
  },
  "nested turn, paused": {
    now: 0,
    turn: turn({ status: "awaiting", endedAt: undefined }),
    nested: { name: "researcher", status: "paused" },
  },
  "nested turn, failed with an error": {
    now: 0,
    turn: turn({ status: "failed", error: "boom", failed: 1 }),
    nested: { name: "researcher", status: "failed" },
  },
  "nested turn, running": {
    now: 5000,
    turn: turn({
      status: "working",
      endedAt: undefined,
      steps: [
        tool("a"),
        tool("b", {
          name: "readDoc",
          status: "running",
          settledAt: undefined,
          label: "Reading a.md",
          icon: "read",
          startedAt: 100,
        }),
      ],
    }),
    nested: { name: "researcher", status: "running" },
  },
}

/** Every approval card variant: scopes, payload kinds, a pending and a failed decision. */
export const APPROVAL_FIXTURES: Readonly<Record<string, ApprovalFixture>> = {
  "command, offers always": { approval: approval(), agent: "The agent", label: "run a command" },
  "tool with a pattern": {
    approval: approval({
      kind: "tool",
      detail: { argsPreview: '{"env":"prod"}', suggestedPattern: "deployProd" },
    }),
    agent: "deployer",
    label: "deploy",
  },
  "tool with nested and long arguments": {
    approval: approval({
      kind: "tool",
      offersAlways: false,
      detail: {
        toolName: "fileFlightPlan",
        argsPreview: JSON.stringify({
          flightPlan: { item7: "N738ZU", item13: "KSTP1600", item16: "KRST0045" },
          remarks: `RMK/${"VFR FLIGHT PLAN ".repeat(8).trim()}`,
          crew: ["pilot", "observer"],
          legs: [{ from: "KSTP", to: "KRST" }],
        }),
        suggestedPattern: "fileFlightPlan",
      },
    }),
    agent: "The agent",
    label: "file N738ZU KSTP to KRST",
  },
  "tool without a pattern": {
    approval: approval({ kind: "tool", detail: { argsPreview: "{}" } }),
    agent: "The agent",
    label: "use a tool",
  },
  "per-thread grant": {
    approval: approval({ kind: "tool", detail: { argsPreview: "{}", scope: "thread" } }),
    agent: "The agent",
    label: "use a tool",
  },
  "subagent gate, no message": {
    approval: approval({
      kind: "subagent",
      message: undefined,
      detail: {
        subagentName: "researcher",
        subagentRouteId: "/research",
        inputPreview: "Summarize ReAct",
        reason: "Subagents need approval",
      },
    }),
    agent: "The agent",
    label: "ask researcher",
  },
  "no always, JSON detail": {
    approval: approval({ kind: "path", offersAlways: false, detail: { path: "/etc/hosts" } }),
    agent: "The agent",
    label: "write a file",
  },
  "no details": {
    approval: approval({ kind: "other", offersAlways: false, detail: {} }),
    agent: "The agent",
    label: "do something",
  },
  deciding: {
    approval: approval(),
    agent: "The agent",
    label: "run a command",
    decide: { choice: "once", outcome: "pending" },
  },
  "failed to send": {
    approval: approval(),
    agent: "The agent",
    label: "run a command",
    decide: { choice: "deny", outcome: "reject" },
  },
}

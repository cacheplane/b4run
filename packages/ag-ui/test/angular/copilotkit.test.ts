import { readFileSync } from "node:fs"
import { Component, inject, input } from "@angular/core"
import { TestBed } from "@angular/core/testing"
import type { ToolStep } from "@b4run/ag-ui/view"
import { CopilotChat, CopilotKit, provideCopilotKit } from "@copilotkit/angular"
import axe from "axe-core"
import { afterEach, describe, expect, onTestFinished, test, vi } from "vitest"
import {
  B4ActivityApprovalsComponent,
  B4ActivityAssistantMessageComponent,
  type B4ActivityOptions,
  B4ActivityStore,
  provideB4Activity,
} from "../../src/angular/copilotkit/index.js"
import { B4TurnsStore, MessageActivityComponent } from "../../src/angular/events/index.js"
import {
  CONTRACT_SNAPSHOT_PATH,
  type ContractSnapshot,
  expandAll,
  serializeContract,
} from "../fixtures/contract-serializer.ts"
import {
  parkedRun,
  runError,
  runFinished,
  runStarted,
  step,
  toolArgs,
  toolEnd,
  toolResult,
  toolStart,
} from "./agui-events.js"
import { button, click, markupWithoutComments, mount } from "./render.js"
import { ScriptedAgent } from "./scripted-agent.js"

const committed = JSON.parse(readFileSync(CONTRACT_SNAPSHOT_PATH, "utf8")) as ContractSnapshot

/** Lets the agent's event pipeline (asynchronous in `@ag-ui/client`) and CopilotKit catch up. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup(options: B4ActivityOptions = {}) {
  const agent = new ScriptedAgent()
  TestBed.configureTestingModule({
    providers: [
      provideCopilotKit({ agents: { default: agent }, enableInspector: false }),
      provideB4Activity({ now: () => 5000, ...options }),
    ],
  })
  const store = TestBed.inject(B4ActivityStore)
  // `injectInterrupt` connects its controller in an effect; an app's first
  // tick runs it, a bare TestBed needs one.
  TestBed.tick()
  return { agent, store, kit: TestBed.inject(CopilotKit) }
}

/**
 * Starts a CopilotKit run of `agent`; resolves once the agent's `run` is
 * streaming, with the run's settlement (wrapped: an async function returning
 * the promise itself would wait for the run to end).
 */
async function startRun(kit: CopilotKit, agent: ScriptedAgent) {
  const runs = agent.inputs.length
  const done = kit.core.runAgent({ agent }).catch(() => undefined)
  await vi.waitFor(() => expect(agent.inputs.length).toBeGreaterThan(runs))
  return { done }
}

/** Ends the streaming run and waits for CopilotKit to settle it. */
async function endRun(agent: ScriptedAgent, done?: Promise<unknown>) {
  agent.end()
  await done
  await flush()
}

const text = (messageId: string, delta: string) => [
  { type: "TEXT_MESSAGE_START", messageId, role: "assistant" },
  { type: "TEXT_MESSAGE_CONTENT", messageId, delta },
  { type: "TEXT_MESSAGE_END", messageId },
]

afterEach(() => vi.useRealTimers())

describe("provideB4Activity: the agent's thread as turns", () => {
  test("live: follows the agent from injectAgentStore, one event at a time", async () => {
    const { agent, store, kit } = setup()
    const { done } = await startRun(kit, agent)
    agent.emit(runStarted("r1"), toolStart("c1", "runBash"), toolEnd("c1"))
    await flush()
    expect(store.turns().turns).toHaveLength(1)
    expect(store.turns().turns[0]).toMatchObject({ status: "working", startedAt: 5000 })
    agent.emit(toolResult("c1", "ok"), runFinished("r1"))
    await endRun(agent, done)
    expect(store.turns().turns[0]?.status).toBe("done")
    expect(TestBed.inject(B4TurnsStore)).toBe(store.turnsStore)
  })

  test("replay: CopilotKit's connect replays the thread, folded at each event's timestamp", async () => {
    const { agent, store, kit } = setup()
    agent.replay = [
      runStarted("r1", { timestamp: 1000 }),
      toolStart("c1", "runBash", { timestamp: 2000 }),
      toolEnd("c1", { timestamp: 2000 }),
      toolResult("c1", "ok", { timestamp: 3000 }),
      runFinished("r1", { timestamp: 193_000 }),
    ] as never[]
    await kit.core.connectAgent({ agent })
    await flush()
    const [turn] = store.turns().turns
    expect(turn).toMatchObject({ status: "done", startedAt: 1000, endedAt: 193_000 })
    expect(turn?.steps[0]).toMatchObject({ settledAt: 3000 })
  })

  test("a failed run reads failed", async () => {
    const { agent, store, kit } = setup()
    const { done } = await startRun(kit, agent)
    agent.emit(runStarted("r1"), runError("boom"))
    await endRun(agent, done)
    expect(store.turns().turns[0]).toMatchObject({ status: "failed", error: "boom" })
  })
})

describe("<b4-activity-approvals>: injectInterrupt → one approval card each", () => {
  async function parkedThread(options: B4ActivityOptions = {}) {
    const ctx = setup(options)
    const { done } = await startRun(ctx.kit, ctx.agent)
    ctx.agent.emit(...parkedRun())
    await endRun(ctx.agent, done)
    const fixture = mount(B4ActivityApprovalsComponent, {})
    const root = fixture.nativeElement as HTMLElement
    return { ...ctx, fixture, root }
  }

  test("a parked run shows its card, in the contract the kits share", async () => {
    const { store, root } = await parkedThread()
    expect(store.interrupts().map((i) => i.id)).toEqual(["i1"])
    expect(store.turns().turns[0]?.status).toBe("awaiting")
    expect(serializeContract(root)).toBe(committed.approvals["command, offers always"])
  })

  test("Allow once marks the resume and resolves through CopilotKit; the resumed run continues the turn", async () => {
    const { agent, store, fixture, root } = await parkedThread()
    const resuming = vi.spyOn(store.turnsStore, "markResuming")
    click(fixture, button(root, "Allow once"))
    await vi.waitFor(() => expect(agent.inputs).toHaveLength(2))
    expect(resuming).toHaveBeenCalledOnce()
    expect(agent.inputs[1]?.resume).toEqual([
      expect.objectContaining({ interruptId: "i1", status: "resolved", payload: "once" }),
    ])
    agent.emit(runStarted("r2"), toolResult("c1", "ok"), runFinished("r2"))
    await endRun(agent)
    fixture.detectChanges()
    expect(store.turns().turns.map((t) => [t.runId, t.status])).toEqual([["r2", "done"]])
    expect(root.querySelector("section.b4-approval")).toBeNull()
  })

  test("Deny cancels the interrupt through CopilotKit", async () => {
    const { agent, fixture, root } = await parkedThread()
    click(fixture, button(root, "Deny"))
    await vi.waitFor(() => expect(agent.inputs).toHaveLength(2))
    expect(agent.inputs[1]?.resume).toEqual([
      expect.objectContaining({ interruptId: "i1", status: "cancelled" }),
    ])
  })

  test("a resume CopilotKit cannot send clears the mark and shows on the card", async () => {
    const { store, fixture, root } = await parkedThread()
    vi.spyOn(store.interrupt, "resolve").mockRejectedValue(new Error("network down"))
    const cleared = vi.spyOn(store.turnsStore, "clearResuming")
    click(fixture, button(root, "Always allow"))
    await vi.waitFor(() => {
      fixture.detectChanges()
      expect(root.querySelector(".b4-approval__error")?.textContent).toContain("network down")
    })
    expect(cleared).toHaveBeenCalledOnce()
    expect(root.querySelector("section.b4-approval")?.getAttribute("data-state")).toBe("failed")
  })

  test("a gated call inside a subagent names the subagent", async () => {
    const ctx = setup()
    const { done } = await startRun(ctx.kit, ctx.agent)
    ctx.agent.emit(
      runStarted("r1"),
      toolStart("task1", "task"),
      toolEnd("task1"),
      {
        type: "SUBAGENT_STARTED",
        subagentRunId: "s1",
        name: "researcher",
        parentToolCallId: "task1",
      },
      toolStart("n1", "runBash", { subagentRunId: "s1" }),
      toolEnd("n1", { subagentRunId: "s1" }),
      step("n1", "running", "Fetch the source", { subagentRunId: "s1" }),
      { type: "SUBAGENT_FINISHED", subagentRunId: "s1", outcome: { type: "suspended" } },
      runFinished("r1", {
        outcome: {
          type: "interrupt",
          interrupts: [{ id: "i2", reason: "command", toolCallId: "n1", subagentRunId: "s1" }],
        },
      }),
    )
    await endRun(ctx.agent, done)
    const fixture = mount(B4ActivityApprovalsComponent, {})
    expect((fixture.nativeElement as HTMLElement).querySelector("h3")?.textContent).toBe(
      "researcher wants to fetch the source",
    )
  })
})

@Component({
  selector: "test-step-view",
  template: `<p class="test-step">custom view of {{ step().name }}</p>`,
})
class StepView {
  readonly step = input.required<ToolStep>()
}

describe("<b4-activity-assistant-message>: CopilotChat's assistant message slot", () => {
  async function thread(options: B4ActivityOptions = {}) {
    const ctx = setup(options)
    const { done } = await startRun(ctx.kit, ctx.agent)
    ctx.agent.emit(
      runStarted("r1"),
      ...text("m1", "Let me check."),
      toolStart("c1", "runBash"),
      toolArgs("c1", '{"command":"node x"}'),
      toolEnd("c1"),
      step("c1", "running", "Running node x"),
      toolResult("c1", "ok"),
      step("c1", "completed", "Ran node x"),
      toolStart("c2", "runBash"),
      toolEnd("c2"),
      toolResult("c2", "ok"),
      ...text("m2", "All done."),
      runFinished("r1"),
    )
    await endRun(ctx.agent, done)
    return ctx
  }

  /** Renders every assistant message through the slot, as `<copilot-chat>` does. */
  function slots(agent: ScriptedAgent) {
    const messages = agent.messages
    return messages
      .filter((m) => m.role === "assistant")
      .map((message) => {
        const fixture = mount(B4ActivityAssistantMessageComponent, { message, messages })
        return { message, root: fixture.nativeElement as HTMLElement, fixture }
      })
  }

  const visible = (root: HTMLElement | undefined) => markupWithoutComments(root)

  test("text through CopilotKit's assistant message; one activity block, on the turn's first assistant message", async () => {
    const { agent } = await thread()
    const rendered = slots(agent)
    expect(rendered).toHaveLength(4)
    const [first, call1, call2, answer] = rendered
    expect(first?.root.querySelectorAll("section.b4-turn")).toHaveLength(1)
    expect(first?.root.querySelector("copilot-chat-assistant-message")?.textContent).toContain(
      "Let me check.",
    )
    // Tool-only messages render nothing; CopilotKit's tool rows never show.
    expect(visible(call1?.root)).toBe("")
    expect(visible(call2?.root)).toBe("")
    expect(answer?.root.querySelector("section.b4-turn")).toBeNull()
    expect(answer?.root.querySelector("copilot-chat-assistant-message")?.textContent).toContain(
      "All done.",
    )
  })

  test("the slot renders the contract a host-agnostic slot renders for the same turns", async () => {
    const { agent, store } = await thread()
    const [first] = slots(agent)
    const viaEvents = mount(MessageActivityComponent, {
      store: store.turnsStore,
      messageId: first?.message.id,
      messages: agent.messages,
    })
    const activity = first?.root.querySelector("b4-turn-activity") as HTMLElement
    const wrapper = document.createElement("div")
    wrapper.append(activity.cloneNode(true))
    expect(serializeContract(wrapper)).toBe(serializeContract(viaEvents.nativeElement as Node))
  })

  test("renderStep: a tool's component replaces its detail panel and gets the step", async () => {
    const { agent } = await thread({ renderStep: { runBash: StepView } })
    const [first] = slots(agent)
    if (!first) throw new Error("no slot")
    await expandAll(first.root, (target) => click(first.fixture, target))
    const views = Array.from(first.root.querySelectorAll(".test-step")).map((p) => p.textContent)
    expect(views.length).toBeGreaterThan(0)
    expect(views[0]).toBe("custom view of runBash")
  })

  test("a subagent's message renders nothing", () => {
    setup()
    const message = { id: "x", role: "assistant", content: "child text", subagentRunId: "s1" }
    const fixture = mount(B4ActivityAssistantMessageComponent, { message, messages: [message] })
    expect(visible(fixture.nativeElement as HTMLElement)).toBe("")
  })
})

@Component({
  selector: "test-copilot-chat",
  imports: [CopilotChat],
  providers: [provideB4Activity({ now: () => 5000 })],
  template: `<copilot-chat [assistantMessageComponent]="assistant" [messageViewChildrenComponent]="approvals" />`,
})
class TestCopilotChat {
  // Created with the host, so it follows the agent before the first run.
  readonly activity = inject(B4ActivityStore)
  readonly assistant = B4ActivityAssistantMessageComponent
  readonly approvals = B4ActivityApprovalsComponent
}

describe("<copilot-chat> with the connector", () => {
  test("a parked thread renders one activity block and its card inside the chat; axe finds nothing serious", async () => {
    // jsdom has no ResizeObserver or scrollTo; the chat's stick-to-bottom scroller needs both.
    const proto = Element.prototype as { scrollTo?: unknown }
    proto.scrollTo = () => {}
    onTestFinished(() => {
      delete proto.scrollTo
      vi.unstubAllGlobals()
    })
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    )
    const agent = new ScriptedAgent()
    TestBed.configureTestingModule({
      providers: [provideCopilotKit({ agents: { default: agent }, enableInspector: false })],
    })
    const kit = TestBed.inject(CopilotKit)
    const fixture = mount(TestCopilotChat, {})
    const root = fixture.nativeElement as HTMLElement
    // An app's first tick after bootstrap; it connects CopilotKit's interrupt controller.
    TestBed.tick()
    agent.addMessage({ id: "u1", role: "user", content: "Clean the build" })
    const { done } = await startRun(kit, agent)
    agent.emit(...parkedRun())
    await endRun(agent, done)
    await vi.waitFor(() => {
      fixture.detectChanges()
      expect(root.querySelector("section.b4-approval")).not.toBeNull()
    })
    expect(root.querySelectorAll("section.b4-turn")).toHaveLength(1)
    expect(root.querySelector("section.b4-turn")?.getAttribute("data-state")).toBe("awaiting")
    expect(root.querySelector("h3.b4-approval__title")?.textContent).toBe(
      "The agent wants to run a command",
    )
    const result = await axe.run(root.querySelector("section.b4-turn")?.parentElement as Element, {
      rules: { "color-contrast": { enabled: false } },
      resultTypes: ["violations"],
    })
    const serious = result.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    )
    expect(serious.map((v) => v.id)).toEqual([])
  })
})

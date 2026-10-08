import { readFileSync } from "node:fs"
import { Component, Injector, input } from "@angular/core"
import { TestBed } from "@angular/core/testing"
import { pendingApprovals, type TranscriptMessage, toResumeEntries } from "@b4run/ag-ui/view"
import axe from "axe-core"
import { Subject } from "rxjs"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  ApprovalsComponent,
  type B4ApprovalDecision,
  type B4TurnEvent,
  B4TurnsStore,
  createB4Turns,
  MessageActivityComponent,
  provideB4Turns,
} from "../../src/angular/events/index.js"
import { TURN_FIXTURES } from "../fixtures/activity-fixtures.ts"
import {
  CONTRACT_SNAPSHOT_PATH,
  type ContractSnapshot,
  expandAll,
  serializeContract,
} from "../fixtures/contract-serializer.ts"
import {
  commandInterrupt,
  parked,
  parkedRun,
  runError,
  runFinished,
  runStarted,
  step,
  subagentFinished,
  subagentStarted,
  toolEnd,
  toolResult,
  toolStart,
} from "./agui-events.js"
import { button, click, mount, settle } from "./render.js"

const committed = JSON.parse(readFileSync(CONTRACT_SNAPSHOT_PATH, "utf8")) as ContractSnapshot

const user = (id: string): TranscriptMessage => ({ id, role: "user" })
const assistant = (id: string, ...calls: string[]): TranscriptMessage => ({
  id,
  role: "assistant",
  ...(calls.length > 0 ? { toolCalls: calls.map((c) => ({ id: c })) } : {}),
})

/** A host chat with one activity slot per message, the way a chat framework calls it. */
@Component({
  selector: "test-chat",
  imports: [MessageActivityComponent, ApprovalsComponent],
  template: `@for (m of messages(); track m.id) {<div class="msg" [attr.data-id]="m.id"><b4-message-activity [messageId]="m.id" [messages]="messages()" /></div>}<b4-approvals [resume]="resume()" (decide)="decided.push($event)" />`,
})
class TestChat {
  readonly messages = input<readonly TranscriptMessage[]>([])
  readonly resume = input<((d: B4ApprovalDecision) => Promise<void>) | undefined>(undefined)
  readonly decided: B4ApprovalDecision[] = []
}

function chat(store: B4TurnsStore, messages: readonly TranscriptMessage[]) {
  TestBed.configureTestingModule({ providers: [{ provide: B4TurnsStore, useValue: store }] })
  const fixture = mount(TestChat, { messages })
  const root = fixture.nativeElement as HTMLElement
  const slot = (id: string) => root.querySelector(`.msg[data-id="${id}"]`) as HTMLElement
  return { fixture, root, slot }
}

const live = (now = 5000) => {
  const events = new Subject<B4TurnEvent>()
  const store = new B4TurnsStore({ events$: events, now: () => now })
  return { events, store }
}

describe("B4TurnsStore", () => {
  test("folds a live stream into turns, with the injected clock", () => {
    const { events, store } = live(1000)
    events.next(runStarted("r1"))
    events.next(toolStart("c1", "runBash"))
    expect(store.turns().turns).toHaveLength(1)
    expect(store.turns().turns[0]).toMatchObject({
      runId: "r1",
      status: "working",
      startedAt: 1000,
    })
  })

  test("a replay is folded at each event's timestamp, so a restored turn keeps its duration", () => {
    const store = new B4TurnsStore({ now: () => 999_999 })
    for (const event of [
      runStarted("r1", { timestamp: 1000 }),
      toolStart("c1", "runBash", { timestamp: 2000 }),
      toolResult("c1", "ok", { timestamp: 3000 }),
      runFinished("r1", { timestamp: 193_000 }),
    ]) {
      store.apply(event)
    }
    const [turn] = store.turns().turns
    expect(turn).toMatchObject({ status: "done", startedAt: 1000, endedAt: 193_000 })
    expect(turn?.steps[0]).toMatchObject({ startedAt: 2000, settledAt: 3000 })
  })

  test("markResuming continues the last turn on the next run; clearResuming forgets it", () => {
    const store = new B4TurnsStore({ now: () => 0 })
    store.apply(runStarted("r1"))
    store.apply(runFinished("r1"))
    store.markResuming()
    store.apply(runStarted("r2"))
    expect(store.turns().turns.map((t) => t.runId)).toEqual(["r2"])
    store.apply(runFinished("r2"))
    store.markResuming()
    store.clearResuming()
    store.apply(runStarted("r3"))
    expect(store.turns().turns.map((t) => t.runId)).toEqual(["r2", "r3"])
  })

  test("connect starts over from the new stream; reset seeds a restored view; destroy unsubscribes", () => {
    const { events, store } = live()
    events.next(runStarted("r1"))
    const next = new Subject<B4TurnEvent>()
    store.connect(next)
    expect(store.turns().turns).toEqual([])
    events.next(runStarted("old"))
    expect(store.turns().turns).toEqual([])
    const restored = { threadId: "t", turns: [TURN_FIXTURES["done research turn"]?.turn ?? fail()] }
    store.reset(restored)
    expect(store.turns()).toBe(restored)
    store.destroy()
    next.next(runStarted("r9"))
    expect(store.turns()).toBe(restored)
  })

  test("createB4Turns needs an injection context or an injector, and stops on destroy", () => {
    expect(() => createB4Turns()).toThrow(/injection context/)
    const injector = Injector.create({ providers: [], parent: TestBed.inject(Injector) })
    const events = new Subject<B4TurnEvent>()
    const store = createB4Turns({ events$: events, injector })
    expect(events.observed).toBe(true)
    ;(injector as unknown as { destroy(): void }).destroy()
    expect(events.observed).toBe(false)
    expect(store.turns().turns).toEqual([])
  })

  test("provideB4Turns takes options or a function run in the injection context", () => {
    const events = new Subject<B4TurnEvent>()
    const labels = { runBash: { running: () => "Running it" } }
    TestBed.configureTestingModule({
      providers: [provideB4Turns(() => ({ events$: events, labels }))],
    })
    const store = TestBed.inject(B4TurnsStore)
    expect(store.labels).toBe(labels)
    events.next(runStarted("r1"))
    expect(store.turns().turns).toHaveLength(1)
  })
})

function fail(): never {
  throw new Error("missing fixture")
}

describe("<b4-message-activity>", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("live: renders the turn on its first assistant message only, and follows the stream", () => {
    const { events, store } = live()
    const { fixture, root, slot } = chat(store, [
      user("u1"),
      assistant("a1"),
      assistant("a2", "c1"),
      assistant("a3"),
    ])
    expect(root.querySelector("section.b4-turn")).toBeNull()
    events.next(runStarted("r1"))
    events.next(toolStart("c1", "runBash"))
    events.next(toolEnd("c1"))
    events.next(step("c1", "running", "Running node x"))
    fixture.detectChanges()
    expect(root.querySelectorAll("section.b4-turn")).toHaveLength(1)
    expect(slot("a1").querySelector("section.b4-turn")?.getAttribute("data-state")).toBe("working")
    expect(slot("u1").textContent).toBe("")
    expect(slot("a2").textContent).toBe("")
    expect(slot("a1").textContent).toContain("Running node x")
    events.next(toolResult("c1", "ok"))
    events.next(step("c1", "completed", "Ran node x"))
    events.next(runFinished("r1"))
    fixture.detectChanges()
    expect(slot("a1").querySelector("section.b4-turn")?.getAttribute("data-state")).toBe("done")
  })

  test("one block per turn across a thread; a failed run reads failed", () => {
    const { events, store } = live()
    for (const e of [
      runStarted("r1"),
      toolStart("c1", "runBash"),
      toolResult("c1", "ok"),
      runFinished("r1"),
      runStarted("r2"),
      toolStart("c2", "runBash"),
      runError("boom"),
    ]) {
      events.next(e)
    }
    const { root, slot } = chat(store, [
      user("u1"),
      assistant("a1", "c1"),
      assistant("a1b"),
      user("u2"),
      assistant("a2", "c2"),
    ])
    expect(root.querySelectorAll("section.b4-turn")).toHaveLength(2)
    expect(slot("a1").querySelector("section")?.getAttribute("data-state")).toBe("done")
    expect(slot("a2").querySelector("section")?.getAttribute("data-state")).toBe("failed")
    expect(slot("a1b").textContent).toBe("")
  })

  test("nested subagents render inside the turn, found by the subagent's calls", async () => {
    const { events, store } = live()
    for (const e of [
      runStarted("r1"),
      toolStart("task1", "task"),
      subagentStarted("s1", "researcher", { parentToolCallId: "task1" }),
      toolStart("n1", "readDoc", { subagentRunId: "s1" }),
      toolResult("n1", "…", { subagentRunId: "s1" }),
      subagentFinished("s1"),
      runFinished("r1"),
    ]) {
      events.next(e)
    }
    const { fixture, root } = chat(store, [user("u1"), assistant("a1", "task1")])
    await expandAll(root, (target) => click(fixture, target))
    const row = root.querySelector('li.b4-step[data-kind="subagent"]')
    expect(row?.textContent).toContain("researcher")
    expect(row?.querySelector(".b4-step__children section.b4-turn")).not.toBeNull()
  })

  test("a host transcript that lists toolCallIds instead of toolCalls gets the same blocks", () => {
    const { events, store } = live()
    for (const e of [
      runStarted("r1"),
      toolStart("c1", "runBash"),
      toolResult("c1", "ok"),
      runFinished("r1"),
      runStarted("r2"),
      toolStart("c2", "runBash"),
      runError("boom"),
    ]) {
      events.next(e)
    }
    const { root, slot } = chat(store, [
      user("u1"),
      { id: "a1", role: "assistant", toolCallIds: ["c1"] },
      { id: "a1b", role: "assistant", toolCallIds: [] },
      user("u2"),
      { id: "a2", role: "assistant", toolCallIds: ["c2"] },
    ])
    expect(root.querySelectorAll("section.b4-turn")).toHaveLength(2)
    expect(slot("a1").querySelector("section")?.getAttribute("data-state")).toBe("done")
    expect(slot("a2").querySelector("section")?.getAttribute("data-state")).toBe("failed")
    expect(slot("a1b").textContent).toBe("")
  })

  test("a store passed as [store] wins over the injected one", () => {
    const store = new B4TurnsStore({ now: () => 0 })
    store.apply(runStarted("r1"))
    const fixture = mount(MessageActivityComponent, {
      store,
      messageId: "a1",
      messages: [user("u1"), assistant("a1")],
    })
    expect((fixture.nativeElement as HTMLElement).querySelector("section.b4-turn")).not.toBeNull()
  })

  test("without a store it says how to provide one", () => {
    expect(() =>
      mount(MessageActivityComponent, { messageId: "a1", messages: [assistant("a1")] }),
    ).toThrow(/provideB4Turns/)
  })

  // Parity: the slot adds no DOM of its own, so a turn rendered through it is
  // the committed contract the React and Angular kits both render.
  for (const [name, fixture] of Object.entries(TURN_FIXTURES)) {
    if (fixture.nested !== undefined) continue
    test(`parity with the contract snapshot: ${name}`, async () => {
      const store = new B4TurnsStore({ now: () => fixture.now, labels: fixture.labels })
      store.reset({ turns: [fixture.turn] })
      const mounted = mount(MessageActivityComponent, {
        store,
        messageId: "a1",
        messages: [user("u1"), assistant("a1")],
      })
      const root = mounted.nativeElement as HTMLElement
      const initial = serializeContract(root)
      await expandAll(root, (target) => click(mounted, target))
      expect({ initial, expanded: serializeContract(root) }).toEqual(committed.turns[name])
    })
  }
})

describe("<b4-approvals>", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test("a parked run shows its card, in the contract the kits share", () => {
    const { events, store } = live()
    for (const e of parkedRun()) events.next(e)
    const { root } = chat(store, [user("u1"), assistant("a1", "c1")])
    const card = root.querySelector("b4-approvals") as HTMLElement
    expect(serializeContract(card)).toBe(committed.approvals["command, offers always"])
    expect(root.querySelector('section.b4-turn[data-state="awaiting"]')).not.toBeNull()
  })

  test("a decision marks the resume and emits; the resumed run continues the turn and the card goes", () => {
    const { events, store } = live()
    for (const e of parkedRun()) events.next(e)
    const { fixture, root } = chat(store, [user("u1"), assistant("a1", "c1")])
    const resuming = vi.spyOn(store, "markResuming")
    click(fixture, button(root, "Allow once"))
    expect(resuming).toHaveBeenCalledOnce()
    expect(fixture.componentInstance.decided).toEqual([{ interruptId: "i1", decision: "once" }])
    events.next(runStarted("r2"))
    fixture.detectChanges()
    expect(store.turns().turns.map((t) => t.runId)).toEqual(["r2"])
    expect(root.querySelector("section.b4-approval")).toBeNull()
  })

  test("deny emits deny; a failing [resume] clears the mark and shows on the card", async () => {
    const { events, store } = live()
    for (const e of parkedRun()) events.next(e)
    const { fixture, root } = chat(store, [user("u1"), assistant("a1", "c1")])
    const resume = vi.fn(async () => {
      throw new Error("network down")
    })
    fixture.componentRef.setInput("resume", resume)
    fixture.detectChanges()
    const cleared = vi.spyOn(store, "clearResuming")
    click(fixture, button(root, "Deny"))
    await settle(fixture)
    expect(resume).toHaveBeenCalledWith({ interruptId: "i1", decision: "deny" })
    expect(cleared).toHaveBeenCalledOnce()
    expect(root.querySelector("section.b4-approval")?.getAttribute("data-state")).toBe("failed")
    expect(root.querySelector(".b4-approval__error")?.textContent).toContain("network down")
  })

  test("[resume] with toResumeEntries: nothing goes out until every parked interrupt is decided, grants echoed", async () => {
    const { events, store } = live()
    const second = { ...commandInterrupt, id: "i2", toolCallId: "c2" }
    for (const e of [
      runStarted("r1"),
      toolStart("c1", "runBash"),
      toolEnd("c1"),
      toolStart("c2", "runBash"),
      toolEnd("c2"),
      parked("r1", [
        { ...commandInterrupt, metadata: { ...commandInterrupt.metadata, grant: "g1" } },
        second,
      ]),
    ]) {
      events.next(e)
    }
    const { fixture, root } = chat(store, [user("u1"), assistant("a1", "c1", "c2")])
    const sent: unknown[] = []
    const decisions: B4ApprovalDecision[] = []
    fixture.componentRef.setInput("resume", async (decision: B4ApprovalDecision) => {
      decisions.push(decision)
      const parkedSet = pendingApprovals(store.turns(), store.labels).map((card) => card.approval)
      const result = toResumeEntries(decisions, parkedSet)
      if (result.ok) sent.push(result.entries)
    })
    fixture.detectChanges()
    const cards = () => [...root.querySelectorAll("section.b4-approval")] as HTMLElement[]
    expect(cards()).toHaveLength(2)
    click(fixture, button(cards()[0] as HTMLElement, "Allow once"))
    await settle(fixture)
    expect(sent).toEqual([])
    click(fixture, button(cards()[1] as HTMLElement, "Deny"))
    await settle(fixture)
    expect(sent).toEqual([
      [
        { interruptId: "i1", status: "resolved", payload: "once", metadata: { grant: "g1" } },
        { interruptId: "i2", status: "cancelled" },
      ],
    ])
  })

  test("no card unless the thread is awaiting", () => {
    const { events, store } = live()
    events.next(runStarted("r1"))
    const { root } = chat(store, [user("u1")])
    expect(root.querySelector("section.b4-approval")).toBeNull()
  })
})

describe("accessibility (axe) of the connector's output", () => {
  test("a thread with a done turn, a parked turn and its card: no serious or critical violation", async () => {
    const store = new B4TurnsStore({ now: () => 5000 })
    for (const e of [
      runStarted("r0"),
      toolStart("c0", "runBash"),
      toolResult("c0", "ok"),
      runFinished("r0"),
    ]) {
      store.apply(e)
    }
    for (const e of parkedRun()) store.apply(e)
    const { fixture, root } = chat(store, [
      user("u0"),
      assistant("a0", "c0"),
      user("u1"),
      assistant("a1", "c1"),
    ])
    await expandAll(root, (target) => click(fixture, target))
    const result = await axe.run(root, {
      rules: { "color-contrast": { enabled: false } },
      resultTypes: ["violations"],
    })
    const serious = result.violations.filter(
      (v) => v.impact === "serious" || v.impact === "critical",
    )
    expect(serious.map((v) => v.id)).toEqual([])
  })
})

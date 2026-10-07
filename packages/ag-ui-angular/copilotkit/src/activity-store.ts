import {
  computed,
  DestroyRef,
  effect,
  inject,
  type Provider,
  type Signal,
  untracked,
} from "@angular/core"
import type { ApprovalDecision, StepLabelOverrides, TurnsView } from "@b4run/ag-ui/view"
import type { StepRenderers } from "@b4run/ag-ui-angular"
import { type B4EventStream, B4TurnsStore } from "@b4run/ag-ui-angular/events"
import {
  type AgentStore,
  COPILOT_CHAT_CONFIGURATION,
  type InterruptController,
  injectAgentStore,
  injectInterrupt,
} from "@copilotkit/angular"

export interface B4ActivityOptions {
  /**
   * The CopilotKit agent to follow; defaults to the ambient chat
   * configuration's agent, else CopilotKit's default agent. Give it the same
   * id as `<copilot-chat [agentId]>`.
   */
  readonly agentId?: string | undefined
  /** Per-tool label overrides (`stepLabel`); client wording wins over the server's. */
  readonly labels?: StepLabelOverrides | undefined
  /** Tools whose frames the view drops entirely. */
  readonly hiddenTools?: readonly string[] | undefined
  /** Per-tool step components (tool name → component given the step as its `step` input). */
  readonly renderStep?: StepRenderers | undefined
  /** The clock for live events; defaults to `Date.now`. Inject in tests. */
  readonly now?: (() => number) | undefined
}

/** A parked interrupt, as CopilotKit's interrupt controller holds it. */
export type B4Interrupt = ReturnType<InterruptController["interrupts"]>[number]

type Agent = AgentStore["agent"]

/** An agent's events as a stream: every event of every run and `connect` replay. */
const agentEvents = (agent: Agent): B4EventStream => ({
  subscribe: (observer) => agent.subscribe({ onEvent: ({ event }) => observer.next(event) }),
})

/**
 * The B4.run activity for one CopilotKit chat: the agent's thread as turns
 * (a `B4TurnsStore` following the agent from `injectAgentStore`, replayed
 * events folded at their `timestamp`) and its parked interrupts (from
 * `injectInterrupt`). Create it with `provideB4Activity` in the providers of
 * the component that renders `<copilot-chat>`; the connector's components
 * inject it.
 *
 * Grants: CopilotKit's `resolve(payload)` carries only the decision, so an
 * interrupt's `grant` (`ApprovalView.grant`) is never echoed on resume. The
 * connector supports `approvals.grants: "off"` today; with `"optional"` or
 * `"required"` the server answers the resume with 409.
 */
export class B4ActivityStore {
  /** The turns store the `./events` components also read (provided as `B4TurnsStore`). */
  readonly turnsStore: B4TurnsStore
  /** The thread as turns. */
  readonly turns: Signal<TurnsView>
  /** The agent store the turns follow. */
  readonly agentStore: Signal<AgentStore>
  /** The interrupt controller the approval cards decide through. */
  readonly interrupt: InterruptController
  /** The parked interrupts, one approval card each. */
  readonly interrupts: Signal<readonly B4Interrupt[]>
  readonly labels: StepLabelOverrides | undefined
  #agent: Agent | undefined

  /** Call in an injection context; `provideB4Activity` does. */
  constructor(options: B4ActivityOptions = {}) {
    this.labels = options.labels
    this.turnsStore = new B4TurnsStore({
      labels: options.labels,
      renderStep: options.renderStep,
      hiddenTools: options.hiddenTools,
      now: options.now,
    })
    this.turns = this.turnsStore.turns
    const chat = inject(COPILOT_CHAT_CONFIGURATION, { optional: true })
    const { agentId } = options
    this.agentStore = injectAgentStore(agentId ?? computed(() => chat?.agentId()))
    this.interrupt = agentId !== undefined ? injectInterrupt(agentId) : injectInterrupt()
    this.interrupts = this.interrupt.interrupts
    // A new agent (CopilotKit swaps its provisional agent for the registered
    // one) is a new stream: the view starts over from its replay.
    const follow = (): void => {
      const { agent } = this.agentStore()
      if (agent === this.#agent) return
      this.#agent = agent
      this.turnsStore.connect(agentEvents(agent))
    }
    // Subscribe now, so no event of a run that starts before the first effect
    // flush is missed; the effect follows later agent swaps (and reports an
    // agent CopilotKit cannot resolve, as `<copilot-chat>` does).
    try {
      untracked(follow)
    } catch {
      // The effect below runs it again and reports the failure.
    }
    effect(() => {
      this.agentStore()
      untracked(follow)
    })
    inject(DestroyRef).onDestroy(() => this.turnsStore.destroy())
  }

  /** See `B4TurnsStore.markResuming`. */
  markResuming(): void {
    this.turnsStore.markResuming()
  }

  /** See `B4TurnsStore.clearResuming`. */
  clearResuming(): void {
    this.turnsStore.clearResuming()
  }

  /**
   * Decide one parked interrupt: `once` and `always` resolve it with that
   * value, `deny` cancels it. Marks the resume first, so the resumed run
   * continues the awaiting turn, and clears the mark when CopilotKit throws
   * (no resume went out). CopilotKit resumes once every open interrupt is
   * decided.
   */
  async decide(interruptId: string, decision: ApprovalDecision): Promise<void> {
    this.markResuming()
    try {
      if (decision === "deny") await this.interrupt.cancel(interruptId)
      else await this.interrupt.resolve(decision, interruptId)
    } catch (cause) {
      this.clearResuming()
      throw cause
    }
  }
}

/**
 * Provides a `B4ActivityStore` (and its turns as `B4TurnsStore`) to a
 * component's subtree. Add it to the providers of the component that renders
 * `<copilot-chat>`, inside the app's `provideCopilotKit`, and inject the store
 * there: Angular creates a provider when something first injects it, and the
 * store sees only the events after it exists (the chat's own slots render
 * only once messages arrive, mid-run).
 *
 * ```ts
 * @Component({
 *   imports: [CopilotChat],
 *   providers: [provideB4Activity({ agentId: "navlog" })],
 *   template: `<copilot-chat agentId="navlog"
 *     [assistantMessageComponent]="assistant"
 *     [messageViewChildrenComponent]="approvals" />`,
 * })
 * export class ChatComponent {
 *   readonly activity = inject(B4ActivityStore) // follows the agent from now on
 *   readonly assistant = B4ActivityAssistantMessageComponent
 *   readonly approvals = B4ActivityApprovalsComponent
 * }
 * ```
 */
export function provideB4Activity(options: B4ActivityOptions = {}): Provider[] {
  return [
    { provide: B4ActivityStore, useFactory: () => new B4ActivityStore(options) },
    { provide: B4TurnsStore, useFactory: () => inject(B4ActivityStore).turnsStore },
  ]
}

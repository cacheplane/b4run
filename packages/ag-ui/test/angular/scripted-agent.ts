import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client"
import { Observable, Subject } from "rxjs"

/**
 * `@ag-ui/client` declares its streams with its own rxjs copy; Angular's is a
 * patch newer. The two interoperate at runtime, so only the type is bridged.
 */
type AgentStream = ReturnType<AbstractAgent["run"]>
const stream = (events: Observable<BaseEvent>): AgentStream => events as unknown as AgentStream

/**
 * An AG-UI agent driven by hand, for the CopilotKit connector tests: each run
 * streams whatever the test pushes through `live` until the test completes it;
 * `connect` (CopilotKit's thread restore) replays `replay`.
 */
export class ScriptedAgent extends AbstractAgent {
  /** The events of the run in progress; push with `emit`, end with `end`. */
  live: Subject<BaseEvent> | undefined
  /** Every run's input, in order (a resume carries `resume`). */
  readonly inputs: RunAgentInput[] = []
  /** What `connect` replays. */
  replay: BaseEvent[] = []

  constructor() {
    super({ agentId: "default", threadId: "t" })
  }

  override run(input: RunAgentInput): AgentStream {
    this.inputs.push(input)
    this.live = new Subject<BaseEvent>()
    return stream(this.live.asObservable())
  }

  protected override connect(_input: RunAgentInput): AgentStream {
    const events = this.replay
    return stream(
      new Observable<BaseEvent>((subscriber) => {
        for (const event of events) subscriber.next(event)
        subscriber.complete()
      }),
    )
  }

  emit(...events: readonly object[]): void {
    for (const event of events) this.live?.next(event as BaseEvent)
  }

  end(): void {
    this.live?.complete()
    this.live = undefined
  }

  override clone(): ScriptedAgent {
    return this
  }
}

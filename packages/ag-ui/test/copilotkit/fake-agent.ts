import type { BaseEvent } from "@ag-ui/core"

type Handler = (payload: { event: BaseEvent }) => void

/** The `subscribe` seam of an AG-UI agent, driven by hand: `emit` fans an event out to every subscriber. */
export class FakeAgent {
  private handlers: Handler[] = []

  /** How many subscriptions are live. */
  get subscribers(): number {
    return this.handlers.length
  }

  subscribe(subscriber: { onEvent?: Handler }): { unsubscribe: () => void } {
    const handler = subscriber.onEvent
    if (handler) this.handlers.push(handler)
    return {
      unsubscribe: () => {
        this.handlers = this.handlers.filter((h) => h !== handler)
      },
    }
  }

  emit(event: BaseEvent): void {
    for (const handler of this.handlers) handler({ event })
  }
}

import type { B4Message } from "./agent-protocol/metadata.js"
import type { RouteKind } from "./route-config.js"

/** Invocation-local owner bridge. Never supplied through graph input/config. */
export interface BackendActiveInput {
  beforeModel(): Promise<
    | {
        readonly messages: readonly B4Message[]
        readonly inputIds: readonly string[]
      }
    | undefined
  >
}

export interface BackendAdapter {
  readonly kind: RouteKind
  readonly protocol?: {
    readonly injection: "before_model" | false
    /** Non-executing revision; unsupported adapters omit this hook. */
    readonly rebindCheckpoint?: (
      entry: unknown,
      config: Readonly<Record<string, unknown>>,
    ) => Promise<Readonly<Record<string, unknown>>>
  }
  /** Managed Stop settles the current native superstep and required writes.
   * Opaque calls settle at their invocation boundary. Detached work and remote
   * effects are outside this guarantee; hard abort remains a distinct signal. */
  execute(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal; readonly stopSignal?: AbortSignal },
  ): Promise<unknown>
  stream(
    entry: unknown,
    input: unknown,
    context: { readonly signal: AbortSignal; readonly stopSignal?: AbortSignal },
  ): AsyncIterable<unknown>
}

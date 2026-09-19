import type { TransitionEvent } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import type { CommandLog } from "../registry/commands.js"
import type { EvidenceStore } from "../registry/evidence.js"
import type { WorkOrderPatch, WorkOrderStore } from "../registry/work-orders.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import type { Verifier } from "../verification/verifier.js"
import type { WorkerClient } from "../worker/client.js"
import type { StreamFrame } from "../worker/wire.js"
import type { WorkspaceReader } from "../worker/workspace-reader.js"
import type { ObserveRunOptions } from "./run-observer.js"

/** What reconciliation and the run observer need from the factory. Kept narrow on purpose. */
export interface ControllerContext {
  readonly store: WorkOrderStore
  readonly commands: CommandLog
  readonly evidence: EvidenceStore
  readonly artifacts: ArtifactStore
  readonly verifier: Verifier
  readonly workspaceReader: WorkspaceReader
  readonly worker: WorkerClient
  readonly workerRoute: string
  readonly exportDir: string
  readonly maxChangedBytes: number
  readonly signal: AbortSignal
  /**
   * A signal for container work on one work order: aborted when the factory closes and
   * when the row leaves `verifying` for any reason (an operator cancel, budget exhaustion).
   * The factory-wide `signal` is not enough — it aborts only on close(), so a cancelled
   * work order's verifier would otherwise run to its own deadline.
   */
  verificationSignal(id: string): AbortSignal
  now(): number
  iso(): string
  mustGet(id: string): WorkOrderRow
  recordEvent(id: string, type: string, payload?: Record<string, unknown>): void
  /** Compare-and-swap transition with active-time accounting. Throws on an illegal or stale move. */
  transition(
    id: string,
    event: TransitionEvent,
    patch?: WorkOrderPatch,
    payload?: Record<string, unknown>,
  ): WorkOrderRow
  /** Observe the worker turn to its end, applying the turn rules. */
  observeRun(
    id: string,
    frames: AsyncIterable<StreamFrame>,
    options?: ObserveRunOptions,
  ): Promise<void>
  /** Capture the controller's own baseline for a task. Injected so tests need no container. */
  captureBaseline(
    taskId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly digest: string
    readonly files: ReadonlyMap<string, string>
  }>
  /** Run the verifying phase for a work order whose turn has ended. */
  runVerification(id: string): Promise<void>
  /** Resolve every pending interrupt on the work order's thread with `deny`. */
  denyPending(id: string): Promise<void>
  /** Cancel the worker if needed, deny any pending gate, and apply the terminal cancel row. */
  finishCancel(id: string, cause: "operator" | "budget"): Promise<WorkOrderRow>
  /** Wait until the tracked background run for `id` (if any) has settled. */
  settleRun(id: string, timeoutMs: number): Promise<void>
  /** Track a background run so close() and cancel can wait for it. */
  track(id: string, run: Promise<void>): void
}

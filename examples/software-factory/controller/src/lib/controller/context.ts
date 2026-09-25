import type { TransitionEvent } from "../domain/states.js"
import type { WorkOrderRow } from "../domain/work-order.js"
import type { CommandLog } from "../registry/commands.js"
import type { EvidenceStore } from "../registry/evidence.js"
import type { WorkOrderPatch, WorkOrderStore } from "../registry/work-orders.js"
import type { ArtifactStore } from "../storage/artifacts.js"
import type { Verifier } from "../verification/verifier.js"
import type { WorkerClient } from "../worker/client.js"
import type { StreamFrame } from "../worker/wire.js"
import type { ObserveIntakeOptions } from "./intake.js"
import type { ObserveRunOptions } from "./run-observer.js"
import type { DrafterWorker, TargetWorker } from "./workers.js"

/** What reconciliation and the run observer need from the factory. Kept narrow on purpose. */
export interface ControllerContext {
  readonly store: WorkOrderStore
  readonly commands: CommandLog
  readonly evidence: EvidenceStore
  readonly artifacts: ArtifactStore
  readonly verifier: Verifier
  /**
   * The builder worker for the row's target (`row.targetId` for a generated task, the
   * catalog task's target for a shipped one): the one builder, which serves every target.
   */
  workerFor(row: WorkOrderRow): TargetWorker
  /** The drafter. Throws `DrafterUnconfiguredError` when none is configured. */
  drafter(): DrafterWorker
  /**
   * The worker holding `row.workerThreadId` right now. The column is shared by the intake
   * thread and the builder thread, and which is which is a fact about the row's phase: the
   * drafter's in the intake states, and in `received` while an approved draft's thread
   * lingers until dispatch replaces it; the target's from `dispatched` on. Where the state
   * no longer says (`cancel_requested`, `blocked`), the journal does: the thread `intake`
   * recorded as `intake_thread_created` is the drafter's.
   */
  workerOfThread(row: WorkOrderRow): { readonly client: WorkerClient; readonly route: string }
  /** Where issue work orders keep `issue.md` and where intake materialises the drafted task. */
  readonly generatedTasksDir: string
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
  /** The same, for the intake phase: aborted when the row leaves `intake_running`. */
  intakeSignal(id: string): AbortSignal
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
  /** Observe a drafter turn to its end, applying the intake turn rules. */
  observeIntakeTurn(
    id: string,
    frames: AsyncIterable<StreamFrame>,
    options?: ObserveIntakeOptions,
  ): Promise<void>
  /** Read, parse, materialise and prove the draft of a work order whose drafter turn has ended. */
  finishIntake(id: string): Promise<void>
  /** Resolve every pending interrupt on the work order's thread with `deny`. */
  denyPending(id: string, options?: { readonly cancel?: boolean }): Promise<void>
  /** Cancel the worker if needed, deny any pending gate, and apply the terminal cancel row. */
  finishCancel(id: string, cause: "operator" | "budget"): Promise<WorkOrderRow>
  /** Wait until the tracked background run for `id` (if any) has settled. */
  settleRun(id: string, timeoutMs: number): Promise<void>
  /** Track a background run so close() and cancel can wait for it. */
  track(id: string, run: Promise<void>): void
  /**
   * Is a background run for `id` tracked right now? Reconciliation asks before it reattaches:
   * `track` replaces the runs-map entry, so a second observer over one live turn evicts the
   * first, and nothing awaits the evicted one any more.
   */
  isTracked(id: string): boolean
}

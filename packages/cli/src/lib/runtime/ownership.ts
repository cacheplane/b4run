import type { RuntimeExecutionLease, RuntimeExecutionStorage } from "@b4run/sdk/agent-protocol"
import { type RuntimeStorageHost, runtimeStorageRegistration } from "./storage-host.js"

export const EXECUTION_HEARTBEAT_MS = 15_000
export const EXECUTION_POLL_MS = 1_000

/** Scheduler injection accelerates tests only. Postgres lease decisions always
 * use its authoritative database clock and built-in 60-second lease. */
export interface ExecutionClock {
  now(): string
  setInterval(callback: () => void, milliseconds: number): unknown
  clearInterval(handle: unknown): void
}
export const executionClock: ExecutionClock = {
  now: () => new Date().toISOString(),
  setInterval: (callback, milliseconds) => globalThis.setInterval(callback, milliseconds),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
}
export function executionStorage(storage: RuntimeStorageHost): RuntimeExecutionStorage {
  const execution = runtimeStorageRegistration(storage).execution
  if (!execution) throw new Error("Runtime storage does not support durable execution ownership")
  return execution
}
export function staleOwnership(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "stale_fence"
}
/** Process-local handles are only for actual provider unwind; durable backend
 * ownership is the sole authority for claims, recovery and writes. */
export interface LiveExecution {
  readonly lease: RuntimeExecutionLease
  readonly controller: AbortController
  readonly work: Promise<void>
}

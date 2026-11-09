import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createHostShellFixture, type HostShellFixture } from "./helpers/host-shell-fixture.ts"

// A real leaf with an opt-in IPC release, independent of workspace lifetime and
// collector-owned stdin. Its message handler is installed before READY.
const CONTROLLED_CHILD = `
const control = process.argv[1], mode = process.argv[2];
if (typeof process.send !== 'function') throw new Error('Missing controlled-child IPC channel');
let released = false;
process.on('message', (message) => {
  if (!message || message.type !== 'release' || message.id !== control || released) return;
  released = true;
  process.send({type:'release-ack', id:control}, (error) => {
    if (error) { process.stderr.write(String(error)); process.exitCode = 1; }
    if (process.connected) process.disconnect();
  });
});
process.on('SIGTERM', () => {
  process.stdout.write('ABORT\\n');
  if (mode === 'exit') process.exit(0);
});
process.stdout.write('READY\\n');
`

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** A failure bound around an observable event, not a sleep used as success. */
async function eventBeforeDeadline<T>(event: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      event,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Expected ${label} before lifecycle guard expired`)),
          1_500,
        )
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type Outcome<T> = { kind: "resolved"; value: T } | { kind: "rejected"; error: unknown }
function observe<T>(promise: Promise<T>, settled: () => void): Promise<Outcome<T>> {
  return promise.then(
    (value) => {
      settled()
      return { kind: "resolved", value }
    },
    (error: unknown) => {
      settled()
      return { kind: "rejected", error }
    },
  )
}

interface Scenario {
  fixture: HostShellFixture
  child: ChildProcessWithoutNullStreams
  ready: Promise<void>
  closed: Promise<void>
  error: Promise<Error>
  operation: Promise<Outcome<{ stdout: string; stderr: string; exitCode: number }>>
  state: { closed: boolean; operationSettled: boolean }
  release(): void
}

let nextScenario = 0

async function withControlledChild(
  mode: "exit" | "hold",
  body: (scenario: Scenario) => Promise<void>,
) {
  const scenario = ++nextScenario
  const events: Record<string, unknown>[] = []
  let childPid: number | undefined
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    const entry = { scenario, mode, pid: childPid ?? null, event, order: events.length, ...detail }
    events.push(entry)
    console.info(`B4_HOST_SHELL_LIFECYCLE ${JSON.stringify(entry)}`)
  }
  const fixture = createHostShellFixture({ ipc: true })
  const control = mkdtempSync(join(tmpdir(), "b4-read-control-"))
  const state = { closed: false, operationSettled: false }
  const ready = deferred<void>()
  const closed = deferred<void>()
  const error = deferred<Error>()
  let child: ChildProcessWithoutNullStreams | undefined
  let closeCode: number | null | undefined
  let closeSignal: NodeJS.Signals | null | undefined
  let operation: Scenario["operation"] | undefined
  let bodyFailure: unknown
  let bodyFailed = false
  const cleanupFailures: unknown[] = []
  let fallback = false
  let releaseRequested = false
  const releaseSent = deferred<void>()
  const releaseAck = deferred<void>()
  const release = () => {
    if (state.closed) {
      record("release-skipped", { reason: "already-closed" })
      return
    }
    if (releaseRequested) return
    if (!child?.connected) throw new Error("Controlled-child IPC channel is not connected")
    releaseRequested = true
    record("release-requested")
    let queued: boolean
    try {
      queued = child.send({ type: "release", id: control }, (failure) => {
        if (failure) {
          cleanupFailures.push(failure)
          record("release-send-error", { message: failure.message })
        } else record("release-sent")
        releaseSent.resolve()
      })
    } catch (failure) {
      cleanupFailures.push(failure)
      record("release-send-error", { message: String(failure) })
      releaseSent.resolve()
      throw failure
    }
    // false is backpressure, not receipt or failure; actual ACK is required below.
    record("release-queued", { queued })
  }
  try {
    operation = observe(
      fixture.run([process.execPath, "-e", CONTROLLED_CHILD, control, mode]),
      () => {
        state.operationSettled = true
        record("operation-settled")
      },
    )
    child = fixture.children.at(-1)
    if (!child) throw new Error("Controlled real child did not start")
    childPid = child.pid
    record("spawn", { ipcConnected: child.connected })
    child.on("message", (message: unknown) => {
      if (
        releaseRequested &&
        message !== null &&
        typeof message === "object" &&
        "type" in message &&
        message.type === "release-ack" &&
        "id" in message &&
        message.id === control
      ) {
        record("release-ack")
        releaseAck.resolve()
      } else {
        cleanupFailures.push(new Error("Unexpected controlled-child IPC message"))
        record("unexpected-ipc-message")
      }
    })
    child.once("disconnect", () => record("ipc-disconnect", { ipcConnected: child?.connected }))
    let stdout = ""
    let sawReady = false
    let sawAbort = false
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
      if (!sawReady && stdout.includes("READY\n")) {
        sawReady = true
        record("ready")
        ready.resolve()
      }
      if (!sawAbort && stdout.includes("ABORT\n")) {
        sawAbort = true
        record("child-abort-marker")
      }
    })
    child.once("error", (value: NodeJS.ErrnoException) => {
      record("child-error", { name: value.name, code: value.code ?? null })
      error.resolve(value)
    })
    child.once("close", (code, signal) => {
      state.closed = true
      closeCode = code
      closeSignal = signal
      record("close", {
        code,
        signal,
        stdoutDestroyed: child?.stdout.destroyed,
        stderrDestroyed: child?.stderr.destroyed,
        stdinDestroyed: child?.stdin.destroyed,
        ipcConnected: child?.connected,
      })
      closed.resolve()
    })
    await eventBeforeDeadline(ready.promise, "READY from the controlled real child")
    await body({
      fixture,
      child,
      ready: ready.promise,
      closed: closed.promise,
      error: error.promise,
      operation,
      state,
      release,
    })
  } catch (value) {
    bodyFailed = true
    bodyFailure = value
  } finally {
    // Release uses a separate IPC channel, never collector-owned stdin.
    // Body and cleanup failures remain distinct from actual child closure.
    try {
      release()
    } catch (value) {
      cleanupFailures.push(value)
    }
    if (child && !state.closed) {
      try {
        await eventBeforeDeadline(closed.promise, "controlled child close after release")
      } catch (value) {
        // The exact child is owned and spawns no descendants. No global kill.
        fallback = true
        record("fallback-kill", { signal: "SIGKILL" })
        try {
          child.kill("SIGKILL")
        } catch (killFailure) {
          cleanupFailures.push(killFailure)
        }
        try {
          await eventBeforeDeadline(closed.promise, "owned leaf close after force kill")
        } catch (closeFailure) {
          cleanupFailures.push(
            new AggregateError([value, closeFailure], "Owned leaf did not close"),
          )
        }
      }
    }
    if (releaseRequested) {
      try {
        await eventBeforeDeadline(releaseSent.promise, "actual IPC send callback")
      } catch (value) {
        cleanupFailures.push(value)
      }
      if (mode === "hold") {
        try {
          await eventBeforeDeadline(releaseAck.promise, "actual child IPC release acknowledgement")
        } catch (value) {
          cleanupFailures.push(value)
        }
      }
    }
    if (!child || state.closed) {
      try {
        if (operation) await operation
      } catch (value) {
        cleanupFailures.push(value)
      }
      try {
        await fixture.close()
      } catch (value) {
        cleanupFailures.push(value)
      }
      try {
        rmSync(control, { recursive: true, force: true })
      } catch (value) {
        cleanupFailures.push(value)
      }
    } else {
      cleanupFailures.push(
        new Error(
          `Retained owned roots because child close is unresolved: ${fixture.root}, ${control}`,
        ),
      )
    }
  }
  if (state.closed && (closeCode !== 0 || closeSignal !== null)) {
    cleanupFailures.push(
      new Error(`Controlled child did not close normally: ${closeCode}/${closeSignal}`),
    )
  }
  record("finally-summary", {
    fallback,
    closed: state.closed,
    operationSettled: state.operationSettled,
    fixtureRootExists: existsSync(fixture.root),
    controlRootExists: existsSync(control),
    cleanupFailures: cleanupFailures.length,
  })
  if (bodyFailed && cleanupFailures.length) {
    throw new AggregateError(
      [bodyFailure, ...cleanupFailures],
      "Lifecycle regression and owned cleanup failed",
    )
  }
  if (bodyFailed) throw bodyFailure
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, "Owned lifecycle regression cleanup failed")
}

describe("real-shell test fixture ownership", () => {
  it("forwards fixture cancellation to a ready child before out-of-band release", async () => {
    await withControlledChild("exit", async ({ fixture, closed, operation, state }) => {
      fixture.abort(new Error("cancel owned bounded-read fixture"))
      await eventBeforeDeadline(closed, "child close caused by fixture cancellation")
      expect(state.closed).toBe(true)
      const outcome = await operation
      expect(outcome.kind).toBe("rejected")
      if (outcome.kind === "rejected") expect(outcome.error).toMatchObject({ name: "AbortError" })
    })
  })

  it("keeps the workspace until an outstanding child has actually closed", async () => {
    await withControlledChild("hold", async ({ fixture, closed, error, state, release }) => {
      let disposed = false
      const disposal = observe(fixture.close(), () => {
        disposed = true
      })
      expect(existsSync(fixture.root)).toBe(true)
      expect(state.closed).toBe(false)
      await eventBeforeDeadline(error, "real abort error while close remains held")
      expect(disposed).toBe(false)
      expect(existsSync(fixture.root)).toBe(true)
      release()
      await eventBeforeDeadline(closed, "explicitly released child close")
      const outcome = await disposal
      expect(outcome.kind).toBe("resolved")
      expect(state.closed).toBe(true)
      expect(existsSync(fixture.root)).toBe(false)
    })
  })

  it("does not confuse an abort error with child close or settle the operation early", async () => {
    await withControlledChild(
      "hold",
      async ({ fixture, closed, error, operation, state, release }) => {
        fixture.abort(new Error("observe error before owned close"))
        await eventBeforeDeadline(error, "real abort error")
        expect(state.closed).toBe(false)
        expect(state.operationSettled).toBe(false)
        expect(existsSync(fixture.root)).toBe(true)
        release()
        await eventBeforeDeadline(closed, "child close after held error")
        expect((await operation).kind).toBe("rejected")
        await fixture.close()
        expect(existsSync(fixture.root)).toBe(false)
      },
    )
  })
})

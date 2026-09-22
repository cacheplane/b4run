import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"
import { writeBuilderManifest } from "./lib/builder-manifest.js"
import { type ControllerClient, ControllerHttpError, createControllerClient } from "./lib/client.js"
import { generatedTasksDirFor } from "./lib/config.js"
import type { WorkOrderState } from "./lib/domain/states.js"
import type { WorkOrderRow } from "./lib/domain/work-order.js"
import { openRegistryReader } from "./lib/registry/reader.js"
import type { RouteOutcome } from "./lib/routes/outcome.js"
import { configureCatalog, loadTask } from "./lib/targets/catalog.js"

const USAGE = `factory <command> [options]

  create    --task <id> [--key <operationKey>]
  dispatch  <workOrderId> [--key <operationKey>]
  approve   <workOrderId> --revision <n> --bundle <sha256> [--key <operationKey>]
  deny      <workOrderId> [--key <operationKey>]
  cancel    <workOrderId> [--key <operationKey>]   (uses BOTH variables)
  reconcile
  show      <workOrderId>
  events    <workOrderId>
  evidence  <workOrderId>
  list
  builder-manifest --task <id> --out <dir>

The commands that change something are requests to a running controller:
FACTORY_CONTROLLER_URL is its base URL. The commands that read do not go through the
controller at all: they open <FACTORY_STATE_DIR>/registry.sqlite read-only. The cancel command uses
both: it asks the controller to stop the run and then reads the row back.
builder-manifest needs neither.

Output is JSON on stdout; diagnostics go to stderr. Exit code 1 when a command is refused,
and when a dispatch settles somewhere that still owes the operator work.`

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const registryPath = (): string => {
  const stateDir = process.env.FACTORY_STATE_DIR
  if (!stateDir) throw new Error("FACTORY_STATE_DIR is required to read the registry")
  return join(stateDir, "registry.sqlite")
}

const client = (): ControllerClient => {
  const url = process.env.FACTORY_CONTROLLER_URL
  if (!url) throw new Error("FACTORY_CONTROLLER_URL is required: this command asks a controller")
  return createControllerClient(url)
}

/** Open, read, close: a reader is a connection to someone else's registry, never held. */
function read<T>(use: (reader: ReturnType<typeof openRegistryReader>) => T): T {
  const reader = openRegistryReader(registryPath())
  try {
    return use(reader)
  } finally {
    reader.close()
  }
}

/**
 * What a dispatching script may treat as success. Deliberately NOT reconciliation's
 * `settledOk`, which answers a different question ("is this work order finished?") and calls
 * a budget cancel a success: `blocked` for any reason, `failed`, `cancelled`, `denied` and
 * `cancel_requested` all mean the dispatch did not produce a reviewable result, and a script
 * that read them as exit 0 would ship nothing and say it worked. `exported` is here because
 * an auto-approving future would settle there; `awaiting_approval` is today's happy end.
 */
const DISPATCH_SUCCESS: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "awaiting_approval",
  "exported",
])

/**
 * Print every journal event for `id` that has not been printed yet, one JSON line each. The
 * first pass replays the work order's history so far (`created`, and anything a previous
 * dispatch left), and every pass after it is only what is new.
 */
function tailEvents(id: string, after: number): number {
  let last = after
  try {
    for (const event of read((reader) => reader.events(id))) {
      if (event.seq <= last) continue
      last = event.seq
      process.stderr.write(`${JSON.stringify(event)}\n`)
    }
  } catch {
    // The registry may not exist yet, or a write may be landing as this read opens. The
    // request is the command's outcome; the tail is a courtesy and must never fail it.
  }
  return last
}

/** Dispatch, tailing the journal to stderr while the request is in flight. */
async function dispatch(id: string, key: string | undefined): Promise<RouteOutcome> {
  let seq = 0
  // Aborted the moment the request resolves, so a dispatch that finishes in 200 ms does not
  // hold the process for the rest of a 500 ms tick.
  const stop = new AbortController()
  const tail = (async () => {
    while (!stop.signal.aborted) {
      seq = tailEvents(id, seq)
      if (stop.signal.aborted) break
      await sleep(500, undefined, { signal: stop.signal }).catch(() => undefined)
    }
  })()
  try {
    return await client().dispatch(id, key)
  } finally {
    stop.abort()
    await tail
    // The last events land between the final poll and the response; without this drain the
    // transition the outcome reports would be missing from the tail that explained it.
    tailEvents(id, seq)
  }
}

/** Poll the read-only registry until `done` accepts the row, or the deadline passes. */
async function pollRow(
  id: string,
  done: (row: WorkOrderRow | null) => boolean,
  timeoutMs: number,
): Promise<WorkOrderRow | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = read((reader) => reader.show(id))
    if (done(row) || Date.now() >= deadline) return row
    await sleep(100)
  }
}

/**
 * Cancelling depends on whether the work order has a live run. A dispatch holds its thread,
 * so the `cancel` route would be refused with `run_in_flight`: the runtime's cancel of the
 * thread is what stops it, and the route is for every other state.
 */
async function cancel(id: string, key: string | undefined): Promise<number> {
  const controller = client()
  if ((await controller.interrupt(id)) === "interrupted") {
    // The 200 says the run was aborted, not that the cancel it triggered has been recorded;
    // the row is what the operator asked about.
    let row: WorkOrderRow | null
    try {
      row = await pollRow(
        id,
        (r) => r?.state === "cancel_requested" || r?.state === "cancelled",
        5_000,
      )
    } catch (error) {
      // No state directory (or an unreadable registry): the cancel still happened, and
      // failing here would report a delivered cancel as an error.
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      print({ ok: true, message: "Cancel delivered; set FACTORY_STATE_DIR to read the row" })
      return 0
    }
    const recorded = row?.state === "cancel_requested" || row?.state === "cancelled"
    print({
      ok: recorded,
      ...(row ? { state: row.state } : {}),
      message: recorded
        ? "Cancelled"
        : "Cancel was delivered but the work order has not recorded it yet; run show",
      row,
    })
    return recorded ? 0 : 1
  }
  const outcome = await controller.cancel(id, key)
  print(outcome)
  return outcome.ok ? 0 : 1
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      key: { type: "string" },
      revision: { type: "string" },
      bundle: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", default: false },
    },
  })
  const [command, id] = positionals
  if (values.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  if (!command) {
    process.stdout.write(`${USAGE}\n`)
    return 1
  }
  const needId = () => {
    if (!id) throw new Error(`${command} requires a work order id`)
    return id
  }
  // Answered before anything is opened: writing a builder manifest reads the catalog and
  // captures an archive, and needs neither a controller nor a registry.
  if (command === "builder-manifest") {
    if (!values.task) throw new Error("builder-manifest requires --task")
    if (!values.out) throw new Error("builder-manifest requires --out")
    // Read directly rather than through the full config: this command needs no worker or
    // builder root, only the state directory's generated tasks, and only when there is one.
    const stateDir = process.env.FACTORY_STATE_DIR
    if (stateDir) configureCatalog({ generatedTasksDir: generatedTasksDirFor(stateDir) })
    print({ path: await writeBuilderManifest(loadTask(values.task), values.out) })
    return 0
  }
  try {
    switch (command) {
      case "create": {
        if (!values.task) throw new Error("create requires --task")
        const outcome = await client().create({
          taskId: values.task,
          ...(values.key ? { operationKey: values.key } : {}),
        })
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "dispatch": {
        const outcome = await dispatch(needId(), values.key)
        print(outcome)
        return outcome.ok && outcome.row && DISPATCH_SUCCESS.has(outcome.row.state) ? 0 : 1
      }
      case "approve": {
        if (!values.revision || !values.bundle)
          throw new Error("approve requires --revision and --bundle")
        const outcome = await client().approve(needId(), {
          revision: Number(values.revision),
          bundleDigest: values.bundle,
          ...(values.key ? { operationKey: values.key } : {}),
        })
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "deny": {
        const outcome = await client().deny(needId(), values.key)
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "cancel":
        return await cancel(needId(), values.key)
      case "reconcile": {
        const outcome = await client().reconcile()
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "show": {
        const row = read((reader) => reader.show(needId()))
        if (!row) throw new Error(`Unknown work order ${id}`)
        print(row)
        return 0
      }
      case "events":
        print(read((reader) => reader.events(needId())))
        return 0
      case "evidence":
        print(read((reader) => reader.evidence(needId())))
        return 0
      case "list":
        print(read((reader) => reader.list()))
        return 0
      default:
        throw new Error(`Unknown command ${command}\n${USAGE}`)
    }
  } catch (error) {
    // Two refusal shapes reach here. A route refusal is an HTTP 200 body handled above; this
    // is the runtime's own 409, whose code says which: `run_in_flight` for a second command
    // on a busy work order, `run_cancelled` for a dispatch whose thread was cancelled.
    if (error instanceof ControllerHttpError) {
      print(
        error.status === 409
          ? { ok: false, refusal: error.code ?? "conflict", message: error.message }
          : { ok: false, message: error.message },
      )
      return 1
    }
    throw error
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  },
)

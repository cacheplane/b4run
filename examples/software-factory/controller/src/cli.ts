import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"
import { writeBuilderManifest, writeBuilderTarget } from "./lib/builder-manifest.js"
import { type ControllerClient, ControllerHttpError, createControllerClient } from "./lib/client.js"
import { generatedTasksDirFor } from "./lib/config.js"
import type { WorkOrderState } from "./lib/domain/states.js"
import type { WorkOrderRow } from "./lib/domain/work-order.js"
import {
  execFileExec,
  fetchIssue,
  repositoryFromRemoteUrl,
  resolvePin,
} from "./lib/intake/issue.js"
import { openRegistryReader } from "./lib/registry/reader.js"
import type { RouteOutcome } from "./lib/routes/outcome.js"
import { configureCatalog, loadTarget, loadTask, repositoryRoot } from "./lib/targets/catalog.js"

const USAGE = `factory <command> [options]

  create    --task <id> [--key <operationKey>]
  create    --issue <n> [--repo <owner/name>] [--key <operationKey>]
  intake          <workOrderId> [--key <operationKey>]
  approve-intake  <workOrderId> --revision <n> --digest <sha256> [--key <operationKey>]
  reject-intake   <workOrderId> --note "<text>" [--key <operationKey>]
  dispatch  <workOrderId> [--key <operationKey>]
  approve   <workOrderId> --revision <n> --bundle <sha256> [--key <operationKey>]
  deny      <workOrderId> [--key <operationKey>]
  cancel    <workOrderId> [--key <operationKey>]   (uses BOTH variables)
  reconcile
  show      <workOrderId>
  events    <workOrderId>
  evidence  <workOrderId>
  list
  builder-target   --target <id> [--pin <sha>] --out <dir>
  builder-manifest --task <id> --out <dir> [--work-order <workOrderId>]

The commands that change something are requests to a running controller:
FACTORY_CONTROLLER_URL is its base URL. The commands that read do not go through the
controller at all: they open <FACTORY_STATE_DIR>/registry.sqlite read-only. The cancel command uses
both: it asks the controller to stop the run and then reads the row back.
builder-target and builder-manifest need neither.

builder-target writes <dir>/<id>.target.json, the file one builder process serving that target
boots from (FACTORY_BUILDER_TARGET), for the image prepared at --pin (default: the target's
default pin). One builder serves one pin; the controller reads the pin from that file (or a
FACTORY_WORKERS entry's pin) and refuses a dispatch whose task pin's environment differs. builder-manifest writes <dir>/<work-order>.json (the work
order defaults to the task id): the controller writes one per work order at dispatch into the
target's manifest directory, and this command is for driving a builder without a controller.

create --issue reads the issue through gh (FACTORY_GH names the executable; default gh) and pins
the work order to origin/main of the target checkout (FACTORY_REPO_ROOT; FACTORY_NO_FETCH=1 skips
the fetch). The repository is --repo, else FACTORY_REPOSITORY, else the checkout's origin remote.

intake runs the drafter turn and the oracle proof and waits for them, like dispatch. The draft
it parks is a task directory under <FACTORY_STATE_DIR>/tasks/<workOrderId>/ (task.json, spec.md,
checks.json, checks/, issue.md): read it, then approve-intake with the revision and the taskDigest
that show prints, or reject-intake with a note the next drafter turn quotes.

Output is JSON on stdout; diagnostics go to stderr. Exit code 1 when a command is refused,
when a dispatch settles somewhere that still owes the operator work, and when an intake or a
reject-intake settles anywhere but awaiting_intake_approval.`

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

/**
 * What an intake (or the redraft a rejection starts) may treat as success: the draft is
 * parked for a person. Everything else — `blocked` for any of the intake reasons, `cancelled`,
 * `cancel_requested`, "did not settle" — owes the operator work. The route already decides
 * this (its `ok` is exactly this test); the set documents the truth table beside
 * `DISPATCH_SUCCESS` so the exit code is read off one place.
 */
const INTAKE_SUCCESS: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "awaiting_intake_approval",
])

/**
 * Send a request that awaits a run (`dispatch`, `intake`, `reject-intake`), tailing the
 * journal to stderr while it is in flight.
 */
async function awaiting(
  id: string,
  request: (controller: ControllerClient) => Promise<RouteOutcome>,
): Promise<RouteOutcome> {
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
    return await request(client())
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

/**
 * What `create --issue` sends: the issue as gh reports it now, and main's tip as the pin. Both
 * are read before the controller is asked, so a refused create costs nothing on the controller.
 */
async function issueCreateInput(issueArg: string, repo: string | undefined) {
  const number = Number(issueArg)
  if (!/^\d+$/.test(issueArg) || !Number.isInteger(number) || number <= 0)
    throw new Error(`--issue must be a positive integer, got ${JSON.stringify(issueArg)}`)
  const root = repositoryRoot()
  const repository = repo ?? process.env.FACTORY_REPOSITORY ?? (await repositoryFromOrigin(root))
  if (!repository) throw new Error("cannot determine the repository; pass --repo <owner/name>")
  const gh = process.env.FACTORY_GH ?? "gh"
  const fetch = process.env.FACTORY_NO_FETCH !== "1"
  const issue = await fetchIssue({ repository, number, gh })
  const pin = await resolvePin({ repositoryRoot: root, fetch })
  return {
    origin: { kind: "issue" as const, repository, number, bodyDigest: issue.bodyDigest },
    pin,
    issue: { title: issue.title, body: issue.body },
  }
}

/** `owner/name` from the checkout's origin remote, or null when there is none or it is not GitHub. */
async function repositoryFromOrigin(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileExec("git", ["-C", root, "remote", "get-url", "origin"])
    return repositoryFromRemoteUrl(stdout)
  } catch {
    return null
  }
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: "string" },
      issue: { type: "string" },
      repo: { type: "string" },
      key: { type: "string" },
      revision: { type: "string" },
      bundle: { type: "string" },
      digest: { type: "string" },
      note: { type: "string" },
      out: { type: "string" },
      target: { type: "string" },
      pin: { type: "string" },
      "work-order": { type: "string" },
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
  // Answered before anything is opened: writing a builder target or manifest reads the
  // catalog (and, for a manifest, captures an archive), and needs neither a controller nor a
  // registry.
  if (command === "builder-target") {
    if (!values.target) throw new Error("builder-target requires --target")
    if (!values.out) throw new Error("builder-target requires --out")
    const pin = values.pin
    if (pin !== undefined && !/^[a-f0-9]{40}$/.test(pin))
      throw new Error(`builder-target --pin must be a full lowercase commit sha, got ${pin}`)
    // The image at that pin must be prepared; `loadTarget`'s `ImageUnpreparedError` names the
    // command that prepares it.
    const target = loadTarget(values.target, pin !== undefined ? { pin } : {})
    print({ path: await writeBuilderTarget(target, values.out), pin: target.pin })
    return 0
  }
  if (command === "builder-manifest") {
    if (!values.task) throw new Error("builder-manifest requires --task")
    if (!values.out) throw new Error("builder-manifest requires --out")
    // Read directly rather than through the full config: this command needs no worker or
    // builder root, only the state directory's generated tasks, and only when there is one.
    const stateDir = process.env.FACTORY_STATE_DIR
    if (stateDir) configureCatalog({ generatedTasksDir: generatedTasksDirFor(stateDir) })
    const workOrder = values["work-order"]
    const written = await writeBuilderManifest(
      loadTask(values.task),
      values.out,
      workOrder !== undefined ? { workOrderId: workOrder } : {},
    )
    print({ path: written.path, sourceDigest: written.sourceDigest })
    return 0
  }
  try {
    switch (command) {
      case "create": {
        if (values.task && values.issue) throw new Error("create takes --task or --issue, not both")
        const key = values.key ? { operationKey: values.key } : {}
        const input = values.task
          ? { taskId: values.task }
          : values.issue
            ? await issueCreateInput(values.issue, values.repo)
            : null
        if (!input) throw new Error("create requires --task or --issue")
        const outcome = await client().create({ ...input, ...key })
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "dispatch": {
        const id = needId()
        const outcome = await awaiting(id, (controller) => controller.dispatch(id, values.key))
        print(outcome)
        return outcome.ok && outcome.row && DISPATCH_SUCCESS.has(outcome.row.state) ? 0 : 1
      }
      case "intake": {
        const id = needId()
        const outcome = await awaiting(id, (controller) => controller.intake(id, values.key))
        print(outcome)
        return outcome.ok && outcome.row && INTAKE_SUCCESS.has(outcome.row.state) ? 0 : 1
      }
      case "approve-intake": {
        if (!values.revision || !values.digest)
          throw new Error("approve-intake requires --revision and --digest")
        const outcome = await client().approveIntake(needId(), {
          revision: Number(values.revision),
          taskDigest: values.digest,
          ...(values.key ? { operationKey: values.key } : {}),
        })
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "reject-intake": {
        const id = needId()
        const note = values.note
        if (!note) throw new Error("reject-intake requires --note")
        const outcome = await awaiting(id, (controller) =>
          controller.rejectIntake(id, {
            note,
            ...(values.key ? { operationKey: values.key } : {}),
          }),
        )
        print(outcome)
        return outcome.ok && outcome.row && INTAKE_SUCCESS.has(outcome.row.state) ? 0 : 1
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

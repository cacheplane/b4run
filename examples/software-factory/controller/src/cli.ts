import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { parseArgs } from "node:util"
import { captureBuilderHandoff, isFactoryImageId } from "./lib/builder-handoff.js"
import { type ControllerClient, ControllerHttpError, createControllerClient } from "./lib/client.js"
import { generatedTasksDirFor } from "./lib/config.js"
import { dispatchPreparing, imageWaitBoundMs } from "./lib/controller/images.js"
import type { WorkOrderState } from "./lib/domain/states.js"
import {
  COMMIT_PATTERN,
  DIGEST_PATTERN,
  type FactoryEvent,
  type WorkOrderRow,
} from "./lib/domain/work-order.js"
import {
  execFileExec,
  fetchIssue,
  repositoryFromRemoteUrl,
  resolvePin,
} from "./lib/intake/issue.js"
import { openRegistryReader } from "./lib/registry/reader.js"
import { exportReview, intakeReview, type OperatorReview } from "./lib/review/operator-review.js"
import { pinDiffBase } from "./lib/review/pin-diff-base.js"
import type { RouteOutcome } from "./lib/routes/outcome.js"
import { createArtifactStore } from "./lib/storage/artifacts.js"
import {
  configureCatalog,
  ensurePin,
  loadTaskRecipe,
  repositoryRoot,
  type TaskRecipe,
} from "./lib/targets/catalog.js"
import { openImageRegistryReader, recipeTag } from "./lib/targets/images.js"

const USAGE = `factory <command> [options]

  create    --task <id> [--key <operationKey>]
  create    --issue <n> [--repo <owner/name>] [--pin <sha>] [--key <operationKey>]
  intake          <workOrderId> [--key <operationKey>]
  review    <workOrderId> [--allow-missing-evidence]        (asks for at least the digest's first 8 hex digits)
  review    <workOrderId> --approve --digest <sha256> [--allow-missing-evidence] [--key <operationKey>]
  review    <workOrderId> --reject --note "<text>" [--key <operationKey>]
  approve-intake  <workOrderId> --revision <n> --digest <sha256> [--key <operationKey>]
  reject-intake   <workOrderId> --note "<text>" [--key <operationKey>]
  dispatch  <workOrderId> [--key <operationKey>]
  retry     <workOrderId> [--key <operationKey>]
  approve   <workOrderId> --revision <n> --bundle <sha256> [--key <operationKey>]
  deny      <workOrderId> [--key <operationKey>]
  cancel    <workOrderId> [--key <operationKey>]   (uses BOTH variables)
  reconcile
  show      <workOrderId>
  events    <workOrderId>
  evidence  <workOrderId>
  list
  builder-handoff --task <id> --out <dir> [--work-order <workOrderId>] [--image-id sha256:<64 hex>]

The commands that change something are requests to a running controller:
FACTORY_CONTROLLER_URL is its base URL. The commands that read do not go through the
controller at all: they open <FACTORY_STATE_DIR>/registry.sqlite read-only. The cancel command uses
both: it asks the controller to stop the run and then reads the row back.
builder-handoff needs neither.

builder-handoff writes <dir>/<work-order>.source.json and <dir>/<work-order>.handoff.json (the
work order defaults to the task id): the captured workspace's files, and the handoff naming
them with the target's image, pin, sandbox policy and permissions, which one builder serving
every target and pin runs that work order's thread in. The image is --image-id, or the one
<FACTORY_STATE_DIR>/images.sqlite records for the task's target at its pin (read-only); with
neither, the command refuses rather than guess. The controller stages both over the
builder's Agent Protocol port at dispatch; to drive a builder without a controller, PUT the
source to /workspace/sources/<sourceDigest>, then POST /threads with
{"metadata":{"factoryWorkOrderId":<work-order>,"factoryBuilder":<handoff>},"workspace":<handoff.workspace>},
both with the worker token.

create --issue reads the issue through gh (FACTORY_GH names the executable; default gh) and pins
the work order to origin/main of the target checkout (FACTORY_REPO_ROOT; FACTORY_NO_FETCH=1 skips
the fetch). The repository is --repo, else FACTORY_REPOSITORY, else the checkout's origin remote.
create --issue --pin <sha> replays the issue at that commit instead: origin/main is neither
fetched nor read. The pin is a full sha, or a short one the checkout resolves; a full sha not in
the object store is fetched from origin by sha, unless FACTORY_NO_FETCH=1, which refuses it.

intake runs the drafter turn and the oracle proof and waits for them, like dispatch. The draft
it parks is a task directory under <FACTORY_STATE_DIR>/tasks/<workOrderId>/ (task.json, spec.md,
checks.json, checks/, issue.md).

review shows what an approval covers and approves exactly that. For a draft parked in
awaiting_intake_approval it prints every file of the task directory and the oracle proof's
output, and digests the bytes it printed; for a bundle parked in awaiting_approval it prints
a unified diff of each changed file against the work order's pin (read from the object store
create uses, FACTORY_REPO_ROOT, and fetched from origin on a miss as create does unless
FACTORY_NO_FETCH=1; the whole file, with the reason, when the pin cannot be read), the
receipt with its check output and the frozen bundle, and
recomputes the bundle digest from the payload it printed. It refuses when what it printed does
not digest to the row's, and for a draft when the oracle proof's output is not in the
artifact store, and for a bundle when the receipt's check output is not
(--allow-missing-evidence approves without it, with a warning). Every line of
file content is shown behind a "│ " gutter, with hidden characters escaped, so no file can
fake a title or a digest line. At a terminal it then asks for at least the digest's first
eight hex digits and sends the revision and the full digest it displayed. Without one, --approve --digest
<sha256> must name that digest in full. --reject --note is reject-intake for a draft and deny
for a bundle (the deny route records no note; the note is echoed in the output). The display
goes to stderr; stdout is the outcome's JSON, as for every command. approve-intake and approve
remain the scripting contract underneath: the revision and the digest, with no display.

dispatch, intake, reject-intake and approve await the run (approve's re-verification is a run
too; its arrival and refusal are read from the journal). When the request itself ends first (an HTTP
timeout on a long wait, a dropped connection), the command says so on stderr and follows the
row in the registry (FACTORY_STATE_DIR) until it leaves its active state, for up to the row's
active budget plus 10 minutes, then answers from the row with the same exit codes. The row is
read before the request is sent: a row whose revision never moves past that reading within a
minute is a request that did not reach the controller, and the command says so and exits 1.
A dispatch that first builds its target's image (the first time this host needs it) is followed
through the build: its journal lines are the arrival, and dispatch_refused is its end when it
refuses.

retry returns a work order a candidate failure blocked (unexpected_interrupt, scope_violation,
encoding_violation, candidate_rejected, verification_failed, verification_inconclusive) to
received, while it has candidate attempts left (FACTORY_MAX_CANDIDATE_ATTEMPTS, fixed at create,
default 2): it denies and cancels whatever is left on the old builder thread and does not
dispatch. dispatch again to start a fresh builder thread from the approved task.

A draft intake refuses is kept for reading after the retry overwrites it: each refused
attempt's draft/ files and its reason.txt, under
<FACTORY_STATE_DIR>/tasks/.refused/<workOrderId>/attempt-<n>/ (journalled as keptAt).

Output is JSON on stdout; diagnostics go to stderr. Exit code 1 when a command is refused,
when a dispatch settles somewhere that still owes the operator work, and when an intake or a
reject-intake settles anywhere but awaiting_intake_approval.`

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

/**
 * The image `builder-handoff` names: `--image-id` (with this host's recipe tag for the task's
 * target), else the one `<stateDir>/images.sqlite` records for that target at its pin, read
 * without creating, migrating or writing the registry. With neither, a refusal: a handoff
 * naming a guessed image would run the builder in something no one bound.
 */
function builderHandoffImage(
  task: TaskRecipe,
  imageId: string | undefined,
  stateDir: string | undefined,
): { localId: string; tag: string } {
  if (imageId !== undefined) {
    if (!isFactoryImageId(imageId))
      throw new Error(`--image-id must be sha256:<64 hex>, got ${JSON.stringify(imageId)}`)
    return { localId: imageId, tag: recipeTag(task.target) }
  }
  if (!stateDir)
    throw new Error(
      "builder-handoff needs --image-id, or FACTORY_STATE_DIR whose images.sqlite records the task's image (target:prepare writes it)",
    )
  const reader = openImageRegistryReader(join(stateDir, "images.sqlite"))
  try {
    const recorded = reader.recorded(task.target)
    if (recorded === undefined)
      throw new Error(
        `builder-handoff needs --image-id, or FACTORY_STATE_DIR whose images.sqlite records the task's image: none is recorded for target ${task.target.id} at ${task.target.pin}`,
      )
    return { localId: recorded.image.localId, tag: recorded.tag }
  } finally {
    reader.close()
  }
}

const registryPath = (): string => {
  const stateDir = process.env.FACTORY_STATE_DIR
  if (!stateDir) throw new Error("FACTORY_STATE_DIR is required to read the registry")
  return join(stateDir, "registry.sqlite")
}

const client = (): ControllerClient => {
  const url = process.env.FACTORY_CONTROLLER_URL
  if (!url) throw new Error("FACTORY_CONTROLLER_URL is required: this command asks a controller")
  return createControllerClient(url, requestFetch())
}

/**
 * `fetch`, bounded per request by `FACTORY_CLI_REQUEST_TIMEOUT_MS` when it is set. Tests set
 * it to stand in for undici's own headers timeout (300 s), which is what cut the live run's
 * `intake` off mid-turn; nothing an operator runs sets it.
 */
function requestFetch(): typeof fetch {
  const raw = process.env.FACTORY_CLI_REQUEST_TIMEOUT_MS
  if (raw === undefined || raw === "") return fetch
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms <= 0)
    throw new Error(`FACTORY_CLI_REQUEST_TIMEOUT_MS must be a positive integer, got ${raw}`)
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms)
    return fetch(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    })
  }
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

/** The states an awaited `intake` or `reject-intake` is still working in. */
const INTAKE_ACTIVE: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>(["intake_running"])
/**
 * An approval re-verifies with the row still in `awaiting_approval`, then exports from
 * `exporting`; it has succeeded only when the row reads `exported`.
 */
const APPROVE_ACTIVE: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "awaiting_approval",
  "exporting",
])
const APPROVE_SUCCESS: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>(["exported"])
/** The states an awaited `dispatch` is still working in: the builder's turn and verification. */
const DISPATCH_ACTIVE: ReadonlySet<WorkOrderState> = new Set<WorkOrderState>([
  "dispatched",
  "running",
  "verifying",
])

/** Beyond the row's own active budget, how long a fallen-back command keeps polling. */
const POLL_GRACE_MS = 10 * 60_000

/**
 * How long a fallen-back command waits for the row to move past what it read before sending.
 * A request that reached the controller moves the row (every command's first transition
 * bumps the revision) long before any transport timeout fires; one that never arrived leaves
 * it where it was, which for `reject-intake` is its own success state. Tests shorten it with
 * `FACTORY_CLI_ARRIVAL_WINDOW_MS`; nothing an operator runs sets it.
 */
function arrivalWindowMs(): number {
  const raw = process.env.FACTORY_CLI_ARRIVAL_WINDOW_MS
  if (raw === undefined || raw === "") return 60_000
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms <= 0)
    throw new Error(`FACTORY_CLI_ARRIVAL_WINDOW_MS must be a positive integer, got ${raw}`)
  return ms
}

/** The row as it was before the request was sent: what "the request moved it" is measured from. */
interface RowMark {
  readonly state: WorkOrderState
  readonly revision: number
  /** The last journal line's seq: an event after it was written by (or after) this request. */
  readonly seq: number
}

/**
 * How a command that does not move its row for a long time is followed. `approve` holds the
 * row in `awaiting_approval` at its revision through the whole re-verification, so neither the
 * revision nor the state says it arrived: its first journal line does, and a refusal is a
 * journal line too, since the row it leaves is where it started.
 */
interface FollowEvents {
  /** Written as the command starts: the request arrived. */
  readonly arrived: string
  /** Written when the command refuses: it is over, whatever the row's state. */
  readonly refused?: string
  /**
   * Work the command does before its row moves (a dispatch's image build): while it holds of
   * the events after the mark, the row is not settled however it looks, and the follow's
   * deadline is extended by `workingGraceMs` of those events.
   */
  readonly working?: (events: readonly FactoryEvent[]) => boolean
  readonly workingGraceMs?: (events: readonly FactoryEvent[]) => number
}

/** Connection errors that mean nothing was sent: there is no work to wait for. */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"])

/**
 * The request failed in transport, not by the controller's answer: the connection ended or a
 * timeout fired (undici's 300 s headers timeout on a long `runs/wait` is the case this exists
 * for). A refused connection or an unresolvable host is not one: nothing reached the
 * controller, so there is no work to wait for. Everything else MAY have reached it, and
 * `followRow` decides from the row whether it did.
 */
function transportFailure(error: unknown): boolean {
  if (error instanceof ControllerHttpError || !(error instanceof Error)) return false
  const cause = (error as { cause?: { code?: unknown } }).cause
  if (typeof cause?.code === "string" && NEVER_SENT.has(cause.code)) return false
  return error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError
}

/** The row before the request, or undefined when the registry cannot say (no state dir yet). */
function markRow(id: string): RowMark | undefined {
  try {
    return read((reader) => {
      const row = reader.show(id)
      const seq = reader.events(id).at(-1)?.seq ?? 0
      return row ? { state: row.state, revision: row.revision, seq } : undefined
    })
  } catch {
    return undefined
  }
}

/**
 * Send a request that awaits a run (`dispatch`, `intake`, `reject-intake`, `approve`), tailing the
 * journal to stderr while it is in flight. The run is the controller's, not this request's:
 * when the request dies in transport while the work goes on, the command says so on stderr
 * and follows the row in the read-only registry until it leaves `active`, within the row's
 * own active budget plus {@link POLL_GRACE_MS}, then answers from the row as the route would.
 */
async function awaiting(
  id: string,
  request: (controller: ControllerClient) => Promise<RouteOutcome>,
  active: ReadonlySet<WorkOrderState>,
  success: ReadonlySet<WorkOrderState>,
  events?: FollowEvents,
): Promise<RouteOutcome> {
  // Read before the request leaves: the only evidence, if the request dies in transport, of
  // whether it ever reached the controller.
  const before = markRow(id)
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
  } catch (error) {
    if (!transportFailure(error)) throw error
    const reason = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `factory: the request ended before its answer (${reason}); the work goes on in the controller, following the row in the registry\n`,
    )
    return await followRow(id, active, success, before, events)
  } finally {
    stop.abort()
    await tail
    // The last events land between the final poll and the response; without this drain the
    // transition the outcome reports would be missing from the tail that explained it.
    tailEvents(id, seq)
  }
}

/**
 * Poll the read-only registry until `done` accepts the row, or the deadline passes. The
 * deadline may be a function of the row, read afresh each poll (`followRow`'s is the row's
 * own active budget).
 */
async function pollRow(
  id: string,
  done: (row: WorkOrderRow | null) => boolean,
  timeoutMs: number | ((row: WorkOrderRow | null) => number),
  intervalMs = 100,
): Promise<WorkOrderRow | null> {
  const started = Date.now()
  for (;;) {
    const row = read((reader) => reader.show(id))
    const limit = typeof timeoutMs === "number" ? timeoutMs : timeoutMs(row)
    if (done(row) || Date.now() - started >= limit) return row
    await sleep(intervalMs)
  }
}

/**
 * The answer an awaiting command gives once its request is gone. The row must first show the
 * request arrived: its revision moved past `before` (every command's first transition bumps
 * it), or it entered `active`. A row that has not moved within the arrival window is a
 * request that never reached the controller, however settled its state looks: `reject-intake`
 * starts from `awaiting_intake_approval`, its own success state. Once it has moved, the row
 * is followed until it leaves `active`, and `ok` is the command's own success set, exactly as
 * the route decides it.
 */
async function followRow(
  id: string,
  active: ReadonlySet<WorkOrderState>,
  success: ReadonlySet<WorkOrderState>,
  before: RowMark | undefined,
  events?: FollowEvents,
): Promise<RouteOutcome> {
  if (before === undefined)
    return {
      ok: false,
      message:
        "The request ended before its answer, and the row could not be read before it was sent, so whether it reached the controller is unknown; run show",
    }
  /** The first journal line of `type` after the mark, or undefined. */
  const journalled = (type: string | undefined) =>
    type === undefined
      ? undefined
      : read((reader) => reader.events(id)).find((e) => e.seq > before.seq && e.type === type)
  const after = () => read((reader) => reader.events(id)).filter((e) => e.seq > before.seq)
  const working = () => events?.working?.(after()) ?? false
  const moved = (r: WorkOrderRow) =>
    r.revision > before.revision ||
    (!active.has(before.state) && active.has(r.state)) ||
    journalled(events?.arrived) !== undefined
  const arrival = arrivalWindowMs()
  const arrived = await pollRow(id, (r) => r !== null && moved(r), arrival, 250)
  if (!arrived) throw new Error(`Unknown work order ${id}`)
  if (!moved(arrived))
    return {
      ok: false,
      state: arrived.state,
      message: `The request did not reach the controller: the row is still ${arrived.state} at revision ${arrived.revision} ${Math.round(arrival / 1_000)} s after it ended; nothing was done, run the command again`,
      row: arrived,
    }
  const row = await pollRow(
    id,
    (r) =>
      r !== null &&
      ((!active.has(r.state) && !working()) || journalled(events?.refused) !== undefined),
    (r) => (r?.maxActiveMs ?? 0) + POLL_GRACE_MS + (events?.workingGraceMs?.(after()) ?? 0),
    1_000,
  )
  if (!row) throw new Error(`Unknown work order ${id}`)
  const refusal = journalled(events?.refused)
  if (refusal === undefined && working()) {
    const waited = (row.maxActiveMs ?? 0) + POLL_GRACE_MS + (events?.workingGraceMs?.(after()) ?? 0)
    return {
      ok: false,
      state: row.state,
      message: `Still preparing its image after ${Math.round(waited / 60_000)} minutes (read from the registry after the request ended); run show ${id}`,
      row,
    }
  }
  // A dispatch refused after its image build leaves the row where it found it (`received`,
  // not active): the refusal is the answer there too, not a row that "settled".
  if (refusal !== undefined && (active.has(row.state) || row.state === before.state))
    return {
      ok: false,
      state: row.state,
      message: `Refused (read from the registry after the request ended): ${String(refusal.payload.message)}`,
      row,
    }
  const settled = !active.has(row.state)
  return {
    ok: settled && success.has(row.state),
    state: row.state,
    message: settled
      ? `Settled as ${row.state} (read from the registry after the request ended)`
      : `Still ${row.state} after the row's active budget and ${POLL_GRACE_MS / 60_000} minutes more; run show`,
    row,
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
 * What `create --issue` sends: the issue as gh reports it now, and main's tip as the pin (or
 * `--pin`, the replay mode). Both are read before the controller is asked, so a refused create
 * costs nothing on the controller.
 */
async function issueCreateInput(
  issueArg: string,
  repo: string | undefined,
  pinArg: string | undefined,
) {
  const number = Number(issueArg)
  if (!/^\d+$/.test(issueArg) || !Number.isInteger(number) || number <= 0)
    throw new Error(`--issue must be a positive integer, got ${JSON.stringify(issueArg)}`)
  const root = repositoryRoot()
  const repository = repo ?? process.env.FACTORY_REPOSITORY ?? (await repositoryFromOrigin(root))
  if (!repository) throw new Error("cannot determine the repository; pass --repo <owner/name>")
  const gh = process.env.FACTORY_GH ?? "gh"
  const fetch = process.env.FACTORY_NO_FETCH !== "1"
  const replayPin = pinArg !== undefined ? await replayPinOf(root, pinArg) : undefined
  const issue = await fetchIssue({ repository, number, gh })
  let pin: string
  if (replayPin !== undefined) {
    // A replay: the commit is named, so origin/main is never consulted. A full sha missing from
    // a shallow checkout is fetched by sha; FACTORY_NO_FETCH=1 refuses it instead, naming it.
    ensurePin(root, `issue-${number}`, replayPin, { label: `Issue ${number} (replay)` })
    pin = replayPin
  } else {
    pin = await resolvePin({ repositoryRoot: root, fetch })
  }
  return {
    origin: { kind: "issue" as const, repository, number, bodyDigest: issue.bodyDigest },
    pin,
    issue: { title: issue.title, body: issue.body },
  }
}

/**
 * The commit `--pin` names: a full sha as given (lowercased; `ensurePin` then finds or fetches
 * it), or a short one resolved in the checkout with `git rev-parse --verify`. A short sha
 * cannot be fetched by sha, so one the checkout does not know is refused, asking for the full.
 */
async function replayPinOf(root: string, pinArg: string): Promise<string> {
  if (/^[0-9a-fA-F]{40}$/.test(pinArg)) return pinArg.toLowerCase()
  if (!/^[0-9a-fA-F]{4,39}$/.test(pinArg))
    throw new Error(`--pin must be a commit sha, got ${JSON.stringify(pinArg)}`)
  let stdout: string
  try {
    ;({ stdout } = await execFileExec("git", [
      "-C",
      root,
      "rev-parse",
      "--verify",
      "--quiet",
      `${pinArg}^{commit}`,
    ]))
  } catch {
    throw new Error(
      `--pin ${pinArg} does not name a commit in ${root}; pass the full 40-hex sha, which is fetched from origin when it is missing`,
    )
  }
  const sha = stdout.trim()
  if (!COMMIT_PATTERN.test(sha))
    throw new Error(`--pin ${pinArg} resolved to ${JSON.stringify(sha)}, not a commit`)
  // `rev-parse` prefers a ref to an abbreviated sha: a branch or tag whose name is hex (`cafe`)
  // resolves to wherever it points. `--pin` names a commit, so the answer must extend it.
  if (!sha.startsWith(pinArg.toLowerCase()))
    throw new Error(
      `--pin ${pinArg} resolved to ${sha}, which is not a commit it abbreviates (a branch or tag of that name?); pass the full 40-hex sha`,
    )
  return sha
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

/**
 * Whether `review` may ask. A person at a terminal types the digest's prefix; anything else
 * must name the digest with `--digest`. Tests set `FACTORY_CLI_INTERACTIVE=1` to answer on a
 * pipe; nothing an operator runs sets it.
 */
function interactive(): boolean {
  return process.env.FACTORY_CLI_INTERACTIVE === "1" || process.stdin.isTTY === true
}

/** One line from stdin after `question` on stderr, or null when stdin ends first. */
async function ask(question: string): Promise<string | null> {
  process.stderr.write(question)
  const lines = createInterface({ input: process.stdin, terminal: false })
  try {
    return await new Promise<string | null>((resolve) => {
      lines.once("line", resolve)
      lines.once("close", () => resolve(null))
    })
  } finally {
    lines.close()
  }
}

/**
 * Read everything a review shows from the registry (one read-only connection) and the state
 * directory, and render it. The row is read once, here: the revision the approval is sent at
 * is the one the display was built from.
 */
async function buildReview(
  id: string,
  allowMissingEvidence: boolean,
): Promise<OperatorReview | { row: WorkOrderRow }> {
  const stateDir = process.env.FACTORY_STATE_DIR
  if (!stateDir) throw new Error("FACTORY_STATE_DIR is required to read the registry")
  const artifacts = createArtifactStore(
    process.env.FACTORY_ARTIFACTS_DIR ?? join(stateDir, "artifacts"),
  )
  const { row, evidence } = read((reader) => {
    const row = reader.show(id)
    if (!row) throw new Error(`Unknown work order ${id}`)
    const reviewable = row.state === "awaiting_intake_approval" || row.state === "awaiting_approval"
    return { row, evidence: reviewable ? reader.evidence(id) : null }
  })
  if (evidence === null) return { row }
  if (row.state === "awaiting_intake_approval")
    return intakeReview({
      row,
      generatedTasksDir: generatedTasksDirFor(stateDir),
      oracleReceipt: evidence.oracleReceipt,
      artifacts,
      allowMissingEvidence,
    })
  // A generated task is loaded from the state directory, as the controller loads it.
  configureCatalog({ generatedTasksDir: generatedTasksDirFor(stateDir) })
  return exportReview({
    row,
    ...evidence,
    artifacts,
    base: pinDiffBase(row),
    allowMissingEvidence,
  })
}

/** Send an export approval and follow it as `approve` does: re-verification outlives the request. */
function approveExport(
  id: string,
  input: { revision: number; bundleDigest: string; operationKey?: string },
): Promise<RouteOutcome> {
  return awaiting(
    id,
    (controller) => controller.approve(id, input),
    APPROVE_ACTIVE,
    APPROVE_SUCCESS,
    { arrived: "approve_started", refused: "approve_refused" },
  )
}

/** Send a rejection of a parked draft and await the redraft, as `reject-intake` does. */
function rejectDraft(id: string, note: string, key: string | undefined): Promise<RouteOutcome> {
  return awaiting(
    id,
    (controller) => controller.rejectIntake(id, { note, ...(key ? { operationKey: key } : {}) }),
    INTAKE_ACTIVE,
    INTAKE_SUCCESS,
  )
}

/**
 * `factory review <id>`: show what the approval covers, digest exactly what was shown, and
 * approve that digest at the revision the display was built from. The routes are unchanged:
 * `approve-intake` still recomputes the task digest from disk at call time and `approve`
 * still compares the frozen bundle, so a file edited after the display is refused there.
 */
async function review(
  id: string,
  options: {
    readonly approve: boolean
    readonly reject: boolean
    readonly digest: string | undefined
    readonly note: string | undefined
    readonly key: string | undefined
    readonly allowMissingEvidence: boolean
  },
): Promise<number> {
  const { approve, reject, digest, note, key, allowMissingEvidence } = options
  if (approve && reject) throw new Error("review takes --approve or --reject, not both")
  if (digest !== undefined && reject) throw new Error("review --reject takes --note, not --digest")
  // An approval is always asked for by name: a stray --digest is not one.
  if (digest !== undefined && !approve) throw new Error("review --digest goes with --approve")
  if (allowMissingEvidence && reject)
    throw new Error("review --allow-missing-evidence goes with an approval, not --reject")
  if (digest !== undefined && !DIGEST_PATTERN.test(digest))
    throw new Error(
      `review --digest must be a full lowercase sha256, got ${JSON.stringify(digest)}`,
    )
  if (note !== undefined && !reject) throw new Error("review --note goes with --reject")
  if (reject && !note) throw new Error('review --reject requires --note "<text>"')
  const refuse = (message: string, row?: WorkOrderRow) => {
    print({ ok: false, ...(row ? { state: row.state } : {}), message, ...(row ? { row } : {}) })
    return 1
  }

  if (reject && note) {
    const row = read((reader) => reader.show(id))
    if (!row) throw new Error(`Unknown work order ${id}`)
    if (row.state === "awaiting_intake_approval") {
      const outcome = await rejectDraft(id, note, key)
      print(outcome)
      return outcome.ok && outcome.row && INTAKE_SUCCESS.has(outcome.row.state) ? 0 : 1
    }
    if (row.state === "awaiting_approval") {
      const outcome = await client().deny(id, key)
      print({ ...outcome, note })
      return outcome.ok ? 0 : 1
    }
    return refuse(nothingToReview(id, row), row)
  }

  const built = await buildReview(id, allowMissingEvidence)
  if (!("digest" in built)) return refuse(nothingToReview(id, built.row), built.row)
  process.stderr.write(`${built.text}\n`)
  if (built.problems.length > 0)
    return refuse(
      `Not approvable as displayed: ${built.problems.join("; ")}. Nothing was sent`,
      built.row,
    )
  for (const warning of built.warnings) process.stderr.write(`\n!!! WARNING: ${warning} !!!\n\n`)

  if (digest !== undefined) {
    if (digest !== built.digest)
      return refuse(
        `--digest ${digest} is not the ${built.label} review displayed (${built.digest}); nothing was sent`,
        built.row,
      )
  } else {
    if (!interactive())
      return refuse(
        `There is no terminal to type the ${built.label}'s prefix into; pass --approve --digest <sha256> with the ${built.label} displayed above`,
        built.row,
      )
    const answer = await ask(
      `Approve ${built.kind === "intake" ? "this draft" : "this export"} at revision ${built.revision}? Type at least the first eight hex digits of the ${built.label} (or paste all of it) to approve; anything else sends nothing: `,
    )
    if (answer === null)
      return refuse("No answer: stdin ended before one was typed; nothing was sent", built.row)
    const typed = answer.trim().toLowerCase()
    // At least eight hex digits, and a prefix of the digest displayed: pasting the whole digest
    // works, and a short or mistyped answer sends nothing.
    if (!(/^[0-9a-f]{8,64}$/.test(typed) && built.digest.startsWith(typed)))
      return refuse(
        typed === ""
          ? "Nothing typed; nothing was sent"
          : `The typed prefix ${JSON.stringify(typed)} does not match the ${built.label} displayed (at least eight hex digits of it are needed); nothing was sent`,
        built.row,
      )
  }

  const operationKey = key ? { operationKey: key } : {}
  if (built.kind === "intake") {
    const outcome = await client().approveIntake(id, {
      revision: built.revision,
      taskDigest: built.digest,
      ...operationKey,
    })
    print(outcome)
    return outcome.ok ? 0 : 1
  }
  const outcome = await approveExport(id, {
    revision: built.revision,
    bundleDigest: built.digest,
    ...operationKey,
  })
  print(outcome)
  return outcome.ok ? 0 : 1
}

function nothingToReview(id: string, row: WorkOrderRow): string {
  return `Nothing to review: ${id} is ${row.state}. review reads a draft parked in awaiting_intake_approval or a bundle parked in awaiting_approval`
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
      pin: { type: "string" },
      "work-order": { type: "string" },
      "image-id": { type: "string" },
      approve: { type: "boolean", default: false },
      reject: { type: "boolean", default: false },
      "allow-missing-evidence": { type: "boolean", default: false },
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
  // Answered before anything is opened: writing a builder handoff reads the catalog and
  // captures an archive, and needs neither a controller nor a registry.
  if (command === "builder-handoff") {
    if (!values.task) throw new Error("builder-handoff requires --task")
    if (!values.out) throw new Error("builder-handoff requires --out")
    // Read directly rather than through the full config: this command needs no worker or
    // builder root, only the state directory's generated tasks, and only when there is one.
    const stateDir = process.env.FACTORY_STATE_DIR
    if (stateDir) configureCatalog({ generatedTasksDir: generatedTasksDirFor(stateDir) })
    const task = loadTaskRecipe(values.task)
    const image = builderHandoffImage(task, values["image-id"], stateDir)
    const workOrder = values["work-order"]
    // The capture is staged under the state directory when there is one (where the controller
    // stages its own), and otherwise under a temporary directory this command removes: never
    // under the controller package, which a `b4 dev` controller watches and would restart on.
    const captureRoot = stateDir
      ? resolve(stateDir)
      : mkdtempSync(join(tmpdir(), "factory-captures-"))
    try {
      const { handoff, workspace } = await captureBuilderHandoff(task, {
        captureRoot,
        image,
        ...(workOrder !== undefined ? { workOrderId: workOrder } : {}),
      })
      // The work order id is a catalog id (the capture refused anything else): a plain name.
      mkdirSync(values.out, { recursive: true })
      const source = join(values.out, `${handoff.workOrderId}.source.json`)
      const handoffPath = join(values.out, `${handoff.workOrderId}.handoff.json`)
      writeFileSync(source, `${JSON.stringify(workspace.source)}\n`)
      writeFileSync(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`)
      print({ handoff: handoffPath, source, sourceDigest: handoff.workspace.sourceDigest })
    } finally {
      if (!stateDir) rmSync(captureRoot, { recursive: true, force: true })
    }
    return 0
  }
  try {
    switch (command) {
      case "create": {
        if (values.task && values.issue) throw new Error("create takes --task or --issue, not both")
        if (values.pin !== undefined && !values.issue)
          throw new Error(
            values.task
              ? "create --pin replays an issue: it takes --issue, not --task (a catalog task's pin is its target's)"
              : "create --pin requires --issue",
          )
        const key = values.key ? { operationKey: values.key } : {}
        const input = values.task
          ? { taskId: values.task }
          : values.issue
            ? await issueCreateInput(values.issue, values.repo, values.pin)
            : null
        if (!input) throw new Error("create requires --task or --issue")
        const outcome = await client().create({ ...input, ...key })
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "dispatch": {
        const id = needId()
        const outcome = await awaiting(
          id,
          (controller) => controller.dispatch(id, values.key),
          DISPATCH_ACTIVE,
          DISPATCH_SUCCESS,
          {
            arrived: "image_prepare_started",
            refused: "dispatch_refused",
            working: dispatchPreparing,
            // The controller journals each wait's own bound (queue and build, from ITS
            // configuration), so the CLI never guesses the controller's settings.
            workingGraceMs: imageWaitBoundMs,
          },
        )
        print(outcome)
        return outcome.ok && outcome.row && DISPATCH_SUCCESS.has(outcome.row.state) ? 0 : 1
      }
      case "intake": {
        const id = needId()
        const outcome = await awaiting(
          id,
          (controller) => controller.intake(id, values.key),
          INTAKE_ACTIVE,
          INTAKE_SUCCESS,
        )
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
        const outcome = await rejectDraft(id, note, values.key)
        print(outcome)
        return outcome.ok && outcome.row && INTAKE_SUCCESS.has(outcome.row.state) ? 0 : 1
      }
      case "approve": {
        if (!values.revision || !values.bundle)
          throw new Error("approve requires --revision and --bundle")
        const id = needId()
        const input = {
          revision: Number(values.revision),
          bundleDigest: values.bundle,
          ...(values.key ? { operationKey: values.key } : {}),
        }
        // Approve re-verifies before it exports (about 20 minutes on the `cli` target), past
        // the HTTP request's own timeout: followed like dispatch, by its journal lines.
        const outcome = await approveExport(id, input)
        print(outcome)
        return outcome.ok ? 0 : 1
      }
      case "review":
        return await review(needId(), {
          approve: values.approve,
          reject: values.reject,
          digest: values.digest,
          note: values.note,
          key: values.key,
          allowMissingEvidence: values["allow-missing-evidence"],
        })
      case "retry": {
        const outcome = await client().retry(needId(), values.key)
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

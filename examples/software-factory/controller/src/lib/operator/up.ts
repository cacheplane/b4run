import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { connect, createServer } from "node:net"
import { basename, dirname, join, resolve } from "node:path"
import { createInterface } from "node:readline"
import { setTimeout as sleep } from "node:timers/promises"
import { promisify } from "node:util"
import { ControllerHttpError, createControllerClient } from "../client.js"
import { ACTIVE_STATES } from "../domain/states.js"
import { openRegistryReader } from "../registry/reader.js"
import {
  APP_DIRS,
  APP_NAMES,
  type AppName,
  EXAMPLE_ROOT,
  LOOPBACK,
  ownedVariableConflicts,
  type ResolvedFactoryConfig,
} from "./factory-config.js"

const run = promisify(execFile)
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** The prefix of up's own lines, padded like each app's (D10). */
export const UP = `${"up".padEnd(10)} │`

/** The environment of up's own subprocesses (git, ps, docker): neither secret, which none needs. */
export function ownSubprocessEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
  const own: Record<string, string | undefined> = { ...env }
  delete own.OPENAI_API_KEY
  delete own.FACTORY_WORKER_TOKEN
  return own
}

export interface UpSecrets {
  /** Every child gets it; nothing prints, logs or writes it. */
  readonly token: string
  /** The builder and the drafter get it; the controller never does. */
  readonly openaiApiKey: string
}

/** The workers' own rule (`server/src/thread-access.ts`): at least 32 characters, no whitespace. */
export function workerTokenFor(env: Readonly<Record<string, string | undefined>>): {
  readonly token: string
  readonly source: "environment" | "generated"
} {
  const set = env.FACTORY_WORKER_TOKEN
  if (set === undefined || set === "")
    return { token: randomBytes(32).toString("hex"), source: "generated" }
  if (set.length < 32) throw new Error("FACTORY_WORKER_TOKEN must be at least 32 characters")
  if (/\s/.test(set)) throw new Error("FACTORY_WORKER_TOKEN must contain no whitespace")
  return { token: set, source: "environment" }
}

/**
 * `OPENAI_API_KEY` from the environment, else that one line of the first `.env` in `dotenvPaths`
 * that exists (D6). Nothing else in the file is read, and the value is never in a message. Two
 * `OPENAI_API_KEY` lines are refused (review of Task 8): dotenv keeps the last, a first-match
 * reader the first, and a key that differs from the one the person meant fails only at the first
 * model call.
 */
export function openaiKeyFor(
  env: Readonly<Record<string, string | undefined>>,
  dotenvPaths: readonly string[],
): { readonly key: string; readonly source: string } | undefined {
  const set = env.OPENAI_API_KEY
  if (set !== undefined && set !== "") return { key: set, source: "the environment" }
  const dotenvPath = dotenvPaths.find((path) => existsSync(path))
  if (dotenvPath === undefined) return undefined
  let text: string
  try {
    text = readFileSync(dotenvPath, "utf8")
  } catch (error) {
    // The code only: a message from a read names the path, but nothing here risks more.
    throw new Error(`could not read ${dotenvPath} (${(error as NodeJS.ErrnoException).code})`)
  }
  const lines = text
    .split(/\r?\n/)
    .map((line) => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=(.*)$/.exec(line))
    .filter((match) => match !== null)
  if (lines.length > 1)
    throw new Error(
      `${dotenvPath} has more than one OPENAI_API_KEY line; keep exactly one (dotenv would read the last)`,
    )
  const [match] = lines
  if (match === undefined) return undefined
  const value = dotenvValue(match[1] ?? "", dotenvPath)
  return value === "" ? undefined : { key: value, source: dotenvPath }
}

/**
 * One `.env` value as dotenv reads it: wholly in matching single or double quotes (a comment may
 * follow), or bare up to a ` #` comment. A value still holding whitespace or a quote (a backtick
 * included: dotenv unquotes backticks too, this reader does not) is refused:
 * it is not one key, and a key sent mangled fails only at the first model call. The message
 * never carries the value.
 */
function dotenvValue(raw: string, path: string): string {
  const quoted = /^\s*(['"])(.*?)\1\s*(?:#.*)?$/.exec(raw)
  const value = quoted ? (quoted[2] ?? "") : raw.replace(/(?:^|\s)#.*$/, "").trim()
  if (/[\s'"`]/.test(value))
    throw new Error(
      `the OPENAI_API_KEY line of ${path} is not one value (it holds whitespace or a stray quote); fix that line`,
    )
  return value
}

/**
 * Where the key's `.env` may be (D6): this checkout's toplevel, then the main worktree's (a
 * linked worktree has none of its own). Never `FACTORY_REPO_ROOT`, which names the target
 * repository, possibly a copy.
 */
export function dotenvCandidates(): string[] {
  // Not GIT_DIR and friends: a stray export would answer for another repository.
  const gitEnv = Object.fromEntries(
    Object.entries(ownSubprocessEnv()).filter(([name]) => !name.startsWith("GIT_")),
  )
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", EXAMPLE_ROOT, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env: gitEnv,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  const candidates: string[] = []
  try {
    candidates.push(join(git("rev-parse", "--show-toplevel"), ".env"))
    candidates.push(
      join(dirname(git("rev-parse", "--path-format=absolute", "--git-common-dir")), ".env"),
    )
  } catch {
    // Not a git checkout: only the environment can supply the key.
  }
  return [...new Set(candidates)]
}

/** How one app is started. Tests substitute `launch` to start a stand-in instead. */
export type Launch = (
  name: AppName,
  cwd: string,
  port: number,
) => { readonly command: string; readonly args: readonly string[] }

/**
 * `b4 start` from the app's own dependency, on up's own Node, bound to loopback (D4). Not the
 * `.bin` shim and not `pnpm`: nothing stands between `up` and the process it signals.
 */
export const b4Start: Launch = (_name, cwd, port) => ({
  command: process.execPath,
  args: [
    join(cwd, "node_modules/@b4run/cli/bin/b4.js"),
    "start",
    "--host",
    LOOPBACK,
    "--port",
    String(port),
  ],
})

export interface AppProcess {
  readonly name: AppName
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly url: string
}

/** Inherited by every child except these: the key and token are set per app, HOST and PORT would move the bind. */
const NOT_INHERITED = ["OPENAI_API_KEY", "FACTORY_WORKER_TOKEN", "HOST", "PORT"] as const

/**
 * Never in the controller's environment (D7 as landed): it calls no model and no cloud, so any
 * provider key or cloud or GitHub credential in up's environment stays out of it. A deny-list by
 * design: the workers still inherit the operator's other variables.
 */
const controllerMayNotSee = (name: string) =>
  /_API_KEY$|^(?:OPENAI|ANTHROPIC|AWS)_|^(?:GH|GITHUB)_TOKEN$/i.test(name)

export function appProcesses(
  config: ResolvedFactoryConfig,
  secrets: UpSecrets,
  env: Readonly<Record<string, string | undefined>>,
  launch: Launch = b4Start,
): AppProcess[] {
  const base: Record<string, string | undefined> = { ...env }
  for (const name of NOT_INHERITED) delete base[name]
  const controllerEnv = {
    ...Object.fromEntries(Object.entries(base).filter(([name]) => !controllerMayNotSee(name))),
    FACTORY_WORKER_TOKEN: secrets.token,
    FACTORY_WORKER_URL: config.urls.builder,
    FACTORY_DRAFTER_URL: config.urls.drafter,
    FACTORY_STATE_DIR: config.stateDir,
  }
  const workerEnv = {
    ...base,
    FACTORY_WORKER_TOKEN: secrets.token,
    OPENAI_API_KEY: secrets.openaiApiKey,
  }
  return APP_NAMES.map((name) => {
    const cwd = resolve(EXAMPLE_ROOT, APP_DIRS[name])
    const { command, args } = launch(name, cwd, config.ports[name])
    return {
      name,
      command,
      args,
      cwd,
      env: name === "controller" ? controllerEnv : workerEnv,
      url: config.urls[name],
    }
  })
}

export interface UpDeps {
  readonly env: Readonly<Record<string, string | undefined>>
  /** Where the key's `.env` may be, in order (D6); only its `OPENAI_API_KEY` line is read. */
  readonly dotenvPaths: readonly string[]
  /** The checkout's lock (D12): `examples/software-factory/.up.lock`; tests use their own. */
  readonly checkoutLock: string
  readonly docker: {
    info(): Promise<void>
    imagePresent(reference: string): Promise<boolean>
  }
  /** The drafter's base image reference, which must already be on the daemon. */
  readonly drafterImage: string
  readonly portFree: (port: number) => Promise<boolean>
  /** Absent: `b4Start`, and each app's built `@b4run/cli` must exist. */
  readonly launch?: Launch
  readonly fetch: typeof fetch
  readonly out: (line: string) => void
  readonly readyTimeoutMs: number
  readonly stopTimeoutMs: number
}

/** Everything `up` can check before it starts anything, reported together (D8). */
export async function preflight(
  config: ResolvedFactoryConfig,
  deps: UpDeps,
): Promise<{ readonly problems: readonly string[]; readonly secrets?: UpSecrets }> {
  const problems = [...ownedVariableConflicts(deps.env, config)]
  if (deps.env.B4_PERMISSIONS_MODE !== undefined)
    problems.push(
      "B4_PERMISSIONS_MODE is set: it would override the workers' non-interactive permissions, and a worker that parks on a prompt blocks its work order; unset it",
    )
  let token: string | undefined
  try {
    const chosen = workerTokenFor(deps.env)
    token = chosen.token
    deps.out(
      `${UP} worker token: ${chosen.source === "generated" ? "generated for this start" : "FACTORY_WORKER_TOKEN"}`,
    )
  } catch (error) {
    problems.push(message(error))
  }
  let key: ReturnType<typeof openaiKeyFor>
  let keyUnreadable = false
  try {
    key = openaiKeyFor(deps.env, deps.dotenvPaths)
  } catch (error) {
    keyUnreadable = true
    problems.push(`OPENAI_API_KEY: ${message(error)}`)
  }
  if (key === undefined && !keyUnreadable) {
    const read = deps.dotenvPaths.find((path) => existsSync(path))
    const where =
      read !== undefined
        ? `${read} has no OPENAI_API_KEY line with a value (only the first .env found is read)`
        : `there is no .env at ${deps.dotenvPaths.join(" or ") || "a git toplevel (not a git checkout)"}`
    problems.push(
      `OPENAI_API_KEY is not set and ${where}: the builder and the drafter need it (only they receive it)`,
    )
  } else if (key !== undefined)
    deps.out(`${UP} OPENAI_API_KEY: from ${key.source} (builder and drafter only)`)
  for (const name of APP_NAMES) {
    if (deps.launch === undefined) {
      // The bin is a committed file; only a build produces what it imports (Trap 25).
      const built = join(
        resolve(EXAMPLE_ROOT, APP_DIRS[name]),
        "node_modules/@b4run/cli/dist/index.js",
      )
      if (!existsSync(built))
        problems.push(
          `${built} is missing: run pnpm install, then build the closure (README, Quickstart)`,
        )
    }
    if (!(await deps.portFree(config.ports[name])))
      problems.push(
        `${name}.port ${config.ports[name]} is in use on ${LOOPBACK}: stop whatever holds it, or choose another port in ${config.path}`,
      )
  }
  let docker = true
  try {
    await deps.docker.info()
  } catch (error) {
    docker = false
    problems.push(
      `Docker is not available (${message(error)}): the builder, the drafter and the verifier all run containers`,
    )
  }
  if (docker && !(await deps.docker.imagePresent(deps.drafterImage)))
    problems.push(
      `the drafter's base image is not on this Docker daemon: docker pull ${deps.drafterImage} (up never pulls)`,
    )
  if (problems.length > 0 || token === undefined || key === undefined) return { problems }
  return { problems, secrets: { token, openaiApiKey: key.key } }
}

/** Alive, or someone else's (EPERM): either way not ours to replace. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** A process a lock names: its pid, and a piece of its command line that a reused pid would not show. */
interface LockHolder {
  readonly pid: number
  readonly command: string
}

interface LockRecord {
  readonly up: LockHolder & { readonly startedAt: string }
  readonly ports: Readonly<Record<AppName, number>>
  /** The controller's effective settings, which `run` reads (D24). No secrets. */
  readonly controller: { readonly approvalTtlMs: number; readonly maxActiveMs: number }
  readonly children: Readonly<Partial<Record<AppName, LockHolder>>>
}

export interface UpLock {
  recordChildren(children: Partial<Record<AppName, LockHolder>>): void
  release(): void
}

/** `ps`'s whole command line for `pid` (`-ww`: never truncated), or undefined when ps cannot say. */
export function commandOf(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5_000,
      env: ownSubprocessEnv(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

/** Alive and still the process the lock recorded; a reused pid is not a holder (D12). */
function holds(holder: LockHolder): boolean {
  if (!pidAlive(holder.pid)) return false
  const command = commandOf(holder.pid)
  return command === undefined || command.includes(holder.command)
}

/** The piece of `up`'s own command line a later `up` looks for under its pid. */
const UP_COMMAND = `${basename(process.argv[1] ?? "")} ${process.argv.slice(2).join(" ")}`.trim()

const isHolder = (value: unknown): value is LockHolder =>
  typeof value === "object" &&
  value !== null &&
  Number.isSafeInteger((value as LockHolder).pid) &&
  (value as LockHolder).pid > 0 &&
  typeof (value as LockHolder).command === "string"

/** A lock `up` wrote, as far as judging it needs: its holder and its children. */
function isLockRecord(value: unknown): value is LockRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const { up, children } = value as Partial<LockRecord>
  return (
    isHolder(up) &&
    typeof children === "object" &&
    children !== null &&
    !Array.isArray(children) &&
    Object.values(children).every((child) => child === undefined || isHolder(child))
  )
}

/**
 * The controller settings a lock records, only while the `up` that wrote it still runs (D12's
 * held check: its pid alive and still showing its command). A stale lock (an `up` that was
 * SIGKILLed, then a controller started by hand with other settings) says nothing about the
 * controller now answering, so it answers undefined, as does anything that is not up's lock.
 */
export function heldLockController(path: string): LockRecord["controller"] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
  if (!isLockRecord(parsed) || !holds(parsed.up)) return undefined
  const controller = (parsed as { controller?: unknown }).controller
  return typeof controller === "object" && controller !== null
    ? (controller as LockRecord["controller"])
    : undefined
}

let written = 0
/** A temporary sibling of `path` no other writer names. */
const tempFor = (path: string) => `${path}.new-${process.pid}-${written++}`

/**
 * Creates `path` holding `text` whole, or fails with EEXIST: the text goes to a temporary file
 * first and a hard link makes it `path`, so no reader ever sees a half-written lock, and a lock
 * that appeared meanwhile is never overwritten (a link, unlike a rename, refuses).
 */
function createWhole(path: string, text: string): void {
  const temp = tempFor(path)
  writeFileSync(temp, text, { flag: "wx" })
  try {
    linkSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Replaces `path` with `text` whole: a temporary file renamed over it. */
function replaceWhole(path: string, text: string): void {
  const temp = tempFor(path)
  try {
    writeFileSync(temp, text, { flag: "wx" })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/** Blocks this thread for `ms`: the locks are taken before anything else runs. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const notOurs = (path: string) => ({
  refused: `${path} is not a lock up wrote; remove it if no factory up is running`,
})

type Judged =
  | { readonly kind: "gone" }
  | { readonly kind: "refused"; readonly refused: string }
  | { readonly kind: "stale" }

/** What the lock file at `path` says: gone, a reason to refuse (held, orphans, not ours), or stale. */
function judgeLock(path: string): Judged {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "gone" }
    throw error
  }
  let held: LockRecord
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isLockRecord(parsed)) return { kind: "refused", ...notOurs(path) }
    held = parsed
  } catch {
    return { kind: "refused", ...notOurs(path) }
  }
  if (holds(held.up))
    return {
      kind: "refused",
      refused: `factory up is already running (pid ${held.up.pid}, since ${held.up.startedAt}, lock ${path}); stop it first`,
    }
  const orphans = Object.entries(held.children).filter(
    (entry): entry is [string, LockHolder] => entry[1] !== undefined && holds(entry[1]),
  )
  if (orphans.length > 0)
    return {
      kind: "refused",
      refused: `a previous up (pid ${held.up.pid}) is gone but its ${orphans.map(([n, h]) => `${n} pid ${h.pid}`).join(", ")} still run. Check each with ps -ww -p ${orphans.map(([, h]) => h.pid).join(",")} -o command= and stop the ones that are b4 start, then run up again`,
    }
  return { kind: "stale" }
}

/**
 * Both locks judged read-only, before anything else (review I2): a held lock or a previous up's
 * orphans are what explain busy ports, so they are reported first, and the port check's advice
 * ("choose another port") never reaches a person whose second set of apps would share the app
 * roots' stores with the first.
 */
function lockRefusals(paths: readonly string[]): string[] {
  const refusals: string[] = []
  for (const path of paths)
    try {
      const judged = judgeLock(path)
      if (judged.kind === "refused") refusals.push(judged.refused)
    } catch (error) {
      refusals.push(`cannot read ${path}: ${message(error)}`)
    }
  return refusals
}

/**
 * The takeover mutex `${lock}.takeover`, which serializes takeovers of one stale lock (of three
 * ups racing, two could otherwise both judge it stale and each replace the other's new lock).
 * Created like the lock; one a crashed up left behind is judged by its pid and command like the
 * lock, and taken over by rename. "busy": another up holds it, or it moved under us; try again.
 */
function takeMutex(
  path: string,
): { readonly release: () => void } | "busy" | { readonly refused: string } {
  const mine = `${JSON.stringify({ pid: process.pid, command: UP_COMMAND, startedAt: new Date().toISOString() })}\n`
  try {
    createWhole(path, mine)
    return {
      release: () => {
        // Only our own: one we did not write is some other up's to remove.
        try {
          if (readFileSync(path, "utf8") === mine) rmSync(path, { force: true })
        } catch {
          // Already gone.
        }
      },
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "busy"
    throw error
  }
  let holder: unknown
  try {
    holder = JSON.parse(text)
  } catch {
    return notOurs(path)
  }
  if (!isHolder(holder)) return notOurs(path)
  if (holds(holder)) return "busy"
  const aside = `${path}.stale-${process.pid}-${written++}`
  try {
    renameSync(path, aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "busy"
    throw error
  }
  // Renamed a live mutex some other up created after our read: put it back (a link, so it
  // never overwrites a third one), and wait our turn.
  if (readFileSync(aside, "utf8") !== text)
    try {
      linkSync(aside, path)
    } catch {
      // A third up already holds a fresh one; the renamed one's owner re-judges under it.
    }
  rmSync(aside, { force: true })
  return "busy"
}

/** How long a live takeover by another up is waited for before refusing. */
const TAKEOVER_WAIT_MS = 1_000

/**
 * One lock file (D12, amended after the Task 7 review): created whole and exclusively; a stale
 * one is taken over only under its takeover mutex, re-judged there, and replaced by a rename of
 * a whole record over it, never by remove-then-create.
 */
function acquireOne(
  path: string,
  record: (children: LockRecord["children"]) => string,
): UpLock | { readonly refused: string } {
  const ours = (): UpLock => ({
    recordChildren: (children) => replaceWhole(path, record(children)),
    release: () => rmSync(path, { force: true }),
  })
  const deadline = Date.now() + TAKEOVER_WAIT_MS
  for (;;) {
    try {
      createWhole(path, record({}))
      return ours()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const judged = judgeLock(path)
    if (judged.kind === "refused") return judged
    if (judged.kind === "stale") {
      const mutex = takeMutex(`${path}.takeover`)
      if (typeof mutex === "object" && "refused" in mutex) return mutex
      if (mutex !== "busy")
        try {
          // Under the mutex, judge again: another up may have taken it over and released since.
          const again = judgeLock(path)
          if (again.kind === "refused") return again
          if (again.kind === "stale") {
            replaceWhole(path, record({}))
            return ours()
          }
        } finally {
          mutex.release()
        }
    }
    if (Date.now() > deadline)
      return {
        refused: `${path} is stale but another up is taking it over (${path}.takeover); run up again in a moment, or remove that file if no factory up is running`,
      }
    pause(25)
  }
}

/**
 * `<state>/up.lock` and the checkout's `.up.lock` (D12): the registry takes no process lock, and
 * the apps' own stores live in their app roots, so one up per state directory and per checkout.
 * Records pids, command lines, ports and the controller's settings; never a secret.
 */
export function acquireLock(
  config: ResolvedFactoryConfig,
  controller: LockRecord["controller"] = { approvalTtlMs: 900_000, maxActiveMs: 1_200_000 },
  checkoutLock: string = join(EXAMPLE_ROOT, ".up.lock"),
): UpLock | { readonly refused: string } {
  mkdirSync(config.stateDir, { recursive: true })
  const startedAt = new Date().toISOString()
  const record = (children: LockRecord["children"]): string =>
    `${JSON.stringify({ up: { pid: process.pid, command: UP_COMMAND, startedAt }, ports: config.ports, controller, children } satisfies LockRecord)}\n`
  const taken: UpLock[] = []
  // Every lock, even when removing one throws: a lock left behind by a partial release would
  // refuse the next up for a reason no longer true. The first failure is rethrown after.
  const releaseTaken = () => {
    const failures: unknown[] = []
    for (const held of taken)
      try {
        held.release()
      } catch (error) {
        failures.push(error)
      }
    if (failures.length > 0) throw failures[0]
  }
  for (const path of [join(config.stateDir, "up.lock"), checkoutLock]) {
    let lock: UpLock | { readonly refused: string }
    try {
      lock = acquireOne(path, record)
    } catch (error) {
      try {
        releaseTaken()
      } catch {
        // The acquisition's own failure is the one to report.
      }
      throw error
    }
    if ("refused" in lock) {
      releaseTaken()
      return lock
    }
    taken.push(lock)
  }
  return {
    recordChildren: (children) => {
      for (const lock of taken) lock.recordChildren(children)
    },
    release: releaseTaken,
  }
}

/** Free on loopback: nothing accepts a connection there, and a listen there succeeds. */
export async function portFree(port: number): Promise<boolean> {
  const accepts = await new Promise<boolean>((done) => {
    const socket = connect({ port, host: LOOPBACK })
    socket.once("connect", () => {
      socket.destroy()
      done(true)
    })
    socket.once("error", () => done(false))
  })
  if (accepts) return false
  return new Promise<boolean>((done) => {
    const server = createServer()
    server.once("error", () => done(false))
    server.listen(port, LOOPBACK, () => server.close(() => done(true)))
  })
}

interface Running {
  readonly app: AppProcess
  readonly child: ChildProcess
  /** How it ended: its code, or the signal that ended it; code -1 when it could not start. */
  readonly exited: Promise<{ readonly code: number | null; readonly signal: string | null }>
  readonly tail: string[]
  hasExited: boolean
  /** Set when up had to SIGKILL it: never a clean stop. */
  killed: boolean
}

const pad = (name: string) => name.padEnd(10)
const describeExit = (exit: { code: number | null; signal: string | null }) =>
  exit.signal !== null ? `by signal ${exit.signal}` : `with code ${exit.code}`

/** Appends to a log file (private to its owner); a log that cannot be written never ends supervision. */
function appendLog(path: string, text: string): void {
  try {
    appendFileSync(path, text, { mode: 0o600 })
  } catch {
    // The line still went to stdout, while stdout is open.
  }
}

/**
 * Replaces the token and the key wherever they appear in a line (review I3): a child that prints
 * its environment, or a stack that quotes a request, must not put a secret on up's stdout, in its
 * logs or in the tail up prints when a child dies. The longer secret first, in case one holds the
 * other.
 */
export function redactor(secrets: UpSecrets): (line: string) => string {
  const pairs = (
    [
      [secrets.token, "[FACTORY_WORKER_TOKEN]"],
      [secrets.openaiApiKey, "[OPENAI_API_KEY]"],
    ] as const
  )
    .filter(([secret]) => secret.length > 0)
    .sort((a, b) => b[0].length - a[0].length)
  return (line) =>
    pairs.reduce((redacted, [secret, name]) => redacted.split(secret).join(name), line)
}

/**
 * Each line of `stream` to `onLine`. A read error on the pipe (on the stream, or re-emitted by the
 * readline interface) goes to `onError` and never throws: an unhandled 'error' would crash up and
 * orphan its detached children.
 */
export function followLines(
  stream: NodeJS.ReadableStream,
  onLine: (line: string) => void,
  onError: (error: Error) => void,
): void {
  stream.on("error", onError)
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
  lines.on("line", onLine)
  lines.on("error", onError)
}

/**
 * Spawns one app. Its lines, redacted, go to `childOut` prefixed with its name and to
 * `<state>/logs/<app>.log`; up's own lines about it go to `say`.
 */
function start(
  app: AppProcess,
  stateDir: string,
  childOut: (line: string) => void,
  say: (line: string) => void,
  redact: (line: string) => string,
): Running {
  const log = join(stateDir, "logs", `${app.name}.log`)
  appendLog(log, `--- up started ${app.name} at ${new Date().toISOString()} ---\n`)
  // Detached (D11, review C1): its own process group, out of the terminal's reach, so the only
  // signal it ever gets is up's one SIGTERM. b4 start's handlers are process.once and close()
  // removes both, so a second signal mid-close would kill it by default action.
  const child = spawn(app.command, [...app.args], {
    cwd: app.cwd,
    env: app.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  const running: Running = {
    app,
    child,
    tail: [],
    hasExited: false,
    killed: false,
    exited: new Promise((done) => {
      child.once("error", (error) => {
        running.hasExited = true
        say(`${UP} ${app.name} could not start: ${message(error)}`)
        done({ code: -1, signal: null })
      })
      child.once("exit", (code, signal) => {
        running.hasExited = true
        const exit = { code, signal }
        say(`${UP} ${app.name} exited ${describeExit(exit)}`)
        appendLog(log, `--- ${app.name} exited ${describeExit(exit)} ---\n`)
        done(exit)
      })
    }),
  }
  const onLine = (raw: string) => {
    const line = redact(raw)
    appendLog(log, `${line}\n`)
    running.tail.push(line)
    if (running.tail.length > 20) running.tail.shift()
    childOut(`${pad(app.name)} │ ${line}`)
  }
  let readFailed = false
  const onReadError = (error: Error) => {
    if (readFailed) return
    readFailed = true
    say(
      `${UP} WARNING: reading ${app.name}'s output failed (${message(error)}); it is still supervised`,
    )
  }
  for (const stream of [child.stdout, child.stderr])
    if (stream) followLines(stream, onLine, onReadError)
  return running
}

/** Resolves when the signal aborts (never rejects). */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) done()
    else signal.addEventListener("abort", () => done(), { once: true })
  })

/** `/readyz` answers 200, or why not: the child exited, or the bound passed. */
async function waitReady(running: Running, deps: UpDeps): Promise<void> {
  const deadline = Date.now() + deps.readyTimeoutMs
  for (;;) {
    if (running.hasExited) {
      const exit = await running.exited
      const tail = running.tail.map((l) => `  ${l}`).join("\n")
      throw new Error(
        `${running.app.name} exited ${describeExit(exit)} before it was ready${tail === "" ? "" : `:\n${tail}`}`,
      )
    }
    try {
      const response = await deps.fetch(`${running.app.url}/readyz`, {
        signal: AbortSignal.timeout(2_000),
      })
      await response.body?.cancel()
      if (response.status === 200) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline)
      throw new Error(`${running.app.name} was not ready within ${deps.readyTimeoutMs / 1_000} s`)
    await sleep(250)
  }
}

/** Anything left in the process group `pgid` (a detached child's pid): alive, or someone else's. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** SIGKILL a detached child's whole group (its own `docker` clients included). */
function killGroup(running: Running): void {
  const pid = running.child.pid
  if (pid === undefined || running.hasExited) return
  running.killed = true
  try {
    process.kill(-pid, "SIGKILL")
  } catch {
    running.child.kill("SIGKILL")
  }
}

/**
 * Exactly one SIGTERM to the child's own pid (it closes gracefully, and a second signal would
 * kill it mid-close: Trap 8), the grace, then SIGKILL to its group. No-op for a child gone or
 * already killed.
 */
async function stopOne(
  running: Running,
  deps: UpDeps,
  force: AbortSignal,
  say: (line: string) => void,
): Promise<void> {
  if (running.hasExited || running.killed || force.aborted) {
    killGroup(running)
    await running.exited
    return
  }
  running.child.kill("SIGTERM")
  const grace = new AbortController()
  const stopped = await Promise.race([
    running.exited.then(() => true),
    sleep(deps.stopTimeoutMs, undefined, { signal: grace.signal }).then(
      () => false,
      () => true,
    ),
    aborted(force).then(() => false),
  ])
  grace.abort()
  if (stopped) return
  if (!force.aborted)
    say(`${UP} ${running.app.name} did not stop within ${deps.stopTimeoutMs / 1_000} s: SIGKILL`)
  killGroup(running)
  await running.exited
}

/**
 * The controller first, so it sends the workers nothing more; then both workers (D11). A second
 * signal (`force`) SIGKILLs every group still running at once. Clean means every child exited
 * with code 0 and none had to be killed.
 */
async function stopAll(
  running: ReadonlyMap<AppName, Running>,
  deps: UpDeps,
  force: AbortSignal,
  say: (line: string) => void,
): Promise<boolean> {
  const killAll = () => {
    const alive = [...running.values()].filter((r) => !r.hasExited)
    if (alive.length === 0) return
    say(`${UP} second signal: SIGKILL to ${alive.map((r) => r.app.name).join(", ")}`)
    for (const r of alive) killGroup(r)
  }
  if (force.aborted) killAll()
  else force.addEventListener("abort", killAll, { once: true })
  try {
    const controller = running.get("controller")
    if (controller) await stopOne(controller, deps, force, say)
    await Promise.all(
      (["builder", "drafter"] as const)
        .map((name) => running.get(name))
        .filter((r): r is Running => r !== undefined)
        .map((r) => stopOne(r, deps, force, say)),
    )
  } finally {
    force.removeEventListener("abort", killAll)
  }
  let clean = true
  for (const r of running.values()) {
    // Whether it exited, never pidAlive(pid): a child that could not be spawned has no pid, and
    // kill(-1, 0) (or kill(undefined)) would answer for other processes (review I1).
    if (!r.hasExited) {
      say(`${UP} WARNING: ${r.app.name} (pid ${r.child.pid ?? "unknown"}) is still running`)
      clean = false
      continue
    }
    const exit = await r.exited
    if (r.killed || exit.code !== 0) clean = false
    const pid = r.child.pid
    if (pid === undefined) continue
    // A leader that exited can leave members in its group (review I4): a helper it spawned, a
    // docker client. A group already SIGKILLed is given a moment to empty first.
    const settle = Date.now() + 250
    while (groupAlive(pid) && Date.now() < settle) await sleep(25)
    if (!groupAlive(pid)) continue
    clean = false
    say(`${UP} ${r.app.name} left processes in its group (pgid ${pid}): SIGKILL`)
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // Emptied meanwhile.
    }
    const deadline = Date.now() + 2_000
    while (groupAlive(pid) && Date.now() < deadline) await sleep(25)
    if (groupAlive(pid))
      say(`${UP} WARNING: process group ${pid} (${r.app.name}) still has members: ps -g ${pid}`)
  }
  return clean
}

/** The controller's settings `run` reads from the lock (D24): the environment's, else its defaults. */
export function controllerSettings(env: Readonly<Record<string, string | undefined>>): {
  readonly approvalTtlMs: number
  readonly maxActiveMs: number
} {
  const positive = (raw: string | undefined, fallback: number) => {
    const value = Number(raw)
    return raw !== undefined && Number.isInteger(value) && value > 0 ? value : fallback
  }
  return {
    approvalTtlMs: positive(env.FACTORY_APPROVAL_TTL_MS, 900_000),
    maxActiveMs: positive(env.FACTORY_MAX_ACTIVE_MS, 1_200_000),
  }
}

/** Work orders the controller is working on, for the stop line (D11); read-only, never fatal. */
function activeWorkOrders(stateDir: string): string[] {
  try {
    const reader = openRegistryReader(join(stateDir, "registry.sqlite"))
    try {
      return reader
        .list()
        .filter((row) => ACTIVE_STATES.has(row.state))
        .map((row) => `${row.id} (${row.state})`)
    } finally {
      reader.close()
    }
  } catch {
    return []
  }
}

/** Releases both locks; a failure is said, never thrown (up is stopping). False when one stayed. */
function releaseLock(lock: UpLock, say: (line: string) => void): boolean {
  try {
    lock.release()
    return true
  } catch (error) {
    say(`${UP} WARNING: could not remove a lock (${message(error)}); remove it by hand`)
    return false
  }
}

/** Bound on the reconcile at boot (review I4): a controller that never answers must not hold up. */
const RECONCILE_TIMEOUT_MS = 120_000

/**
 * `factory up`: preflight, lock, start, wait for ready, reconcile, then supervise until `stop`
 * aborts (0 when every child then exits with code 0) or a child exits (1). `force` (a second
 * signal) cuts every grace short.
 */
export async function up(
  config: ResolvedFactoryConfig,
  deps: UpDeps,
  stop: AbortSignal,
  force: AbortSignal,
): Promise<number> {
  // The locks first, read-only (review I2): a held lock or a previous up's orphans explain busy
  // ports, and must be named before the port check suggests another port.
  const refusals = lockRefusals([join(config.stateDir, "up.lock"), deps.checkoutLock])
  if (refusals.length > 0) {
    for (const refusal of refusals) deps.out(`${UP} refused: ${refusal}`)
    return 1
  }
  const { problems, secrets } = await preflight(config, deps)
  if (secrets === undefined) {
    for (const problem of problems) deps.out(`${UP} refused: ${problem}`)
    return 1
  }
  const lock = acquireLock(config, controllerSettings(deps.env), deps.checkoutLock)
  if ("refused" in lock) {
    deps.out(`${UP} refused: ${lock.refused}`)
    return 1
  }
  const redact = redactor(secrets)
  const logs = join(config.stateDir, "logs")
  try {
    // Private to the operator (review I3): the logs are post-mortems of processes holding secrets.
    mkdirSync(logs, { recursive: true, mode: 0o700 })
    chmodSync(logs, 0o700)
  } catch (error) {
    deps.out(`${UP} refused: cannot create ${logs} (${message(error)})`)
    releaseLock(lock, deps.out)
    return 1
  }
  // up's own lines are kept beside the apps' logs, so they survive a stdout that closed (D10).
  const upLog = join(logs, "up.log")
  appendLog(upLog, `--- up started at ${new Date().toISOString()} (pid ${process.pid}) ---\n`)
  const say = (raw: string) => {
    const line = redact(raw)
    deps.out(line)
    appendLog(upLog, `${line}\n`)
  }
  const running = new Map<AppName, Running>()
  // Until stop aborts (0) or something fails (1); the stop below runs after either.
  const supervise = async (): Promise<number> => {
    if (stop.aborted) {
      say(`${UP} asked to stop before anything started`)
      return 0
    }
    for (const app of appProcesses(config, secrets, deps.env, deps.launch))
      running.set(app.name, start(app, config.stateDir, deps.out, say, redact))
    // Only children that have a pid (review I1): one that could not be spawned has none, and a
    // made-up pid would make the lock one no later up recognises.
    lock.recordChildren(
      Object.fromEntries(
        [...running].flatMap(([name, r]) =>
          r.child.pid === undefined
            ? []
            : [[name, { pid: r.child.pid, command: r.app.args.join(" ") }]],
        ),
      ),
    )
    const readiness = Promise.all([...running.values()].map((r) => waitReady(r, deps)))
    readiness.catch(() => undefined) // Its failure is read below, unless a stop came first.
    const first = await Promise.race([
      readiness.then(() => "ready" as const),
      aborted(stop).then(() => "stopped" as const),
    ])
    if (first === "stopped") return 0
    // Bounded, and abandoned on a stop (review I4): a controller that never answers must not
    // hold up past a Ctrl-C.
    const reconcileSignal = AbortSignal.any([AbortSignal.timeout(RECONCILE_TIMEOUT_MS), stop])
    const reconciled = await Promise.race([
      createControllerClient(config.urls.controller, (input, init) =>
        deps.fetch(input, { ...init, signal: reconcileSignal }),
      )
        .reconcile()
        .then(
          (outcome) => (outcome.ok ? "ok" : `reconcile failed: ${outcome.message ?? "not ok"}`),
          (error: unknown) =>
            stop.aborted
              ? "stopped"
              : `reconcile failed: ${error instanceof ControllerHttpError ? error.message : message(error)}`,
        ),
      aborted(stop).then(() => "stopped"),
    ])
    if (reconciled === "stopped") return 0
    if (reconciled !== "ok") throw new Error(reconciled)
    say(
      `${UP} ready: controller ${config.urls.controller} (reconciled), builder ${config.urls.builder}, drafter ${config.urls.drafter}; state ${config.stateDir}`,
    )
    say(`${UP} next, in another terminal: pnpm factory run --issue <n> [--pin <sha>]`)
    const ended = await Promise.race([
      aborted(stop).then(() => undefined),
      ...[...running.values()].map((r) => r.exited.then((exit) => ({ name: r.app.name, exit }))),
    ])
    if (ended === undefined) return 0
    say(`${UP} ${ended.name} exited ${describeExit(ended.exit)}; stopping the others`)
    return 1
  }
  let code: number
  try {
    code = await supervise()
  } catch (error) {
    say(`${UP} ${message(error)}`)
    code = 1
  }
  if (running.size > 0) {
    const active = activeWorkOrders(config.stateDir)
    say(
      `${UP} stopping: the controller, then the workers.${active.length > 0 ? ` In flight, reconciled at the next up (a turn cut short can spend an attempt): ${active.join(", ")}` : " No work order is in flight."}`,
    )
  }
  const clean = await stopAll(running, deps, force, say)
  // A survivor keeps the locks, so the next up names it instead of starting beside it. Whether
  // each exited, never pidAlive of a pid it may not have (review I1).
  if ([...running.values()].every((r) => r.hasExited) && !releaseLock(lock, say)) code = 1
  if (!clean) code = 1
  say(`${UP} stopped (${code === 0 ? "clean" : "with errors"})`)
  return code
}

/**
 * up's stdout as a line sink that survives a closed pipe (`up | head`, Trap 24): after any error
 * on the stream it stops writing there, and up's lines still reach `<state>/logs/`. Never throws,
 * so a pipe cannot end supervision and orphan the detached children.
 */
export function lineWriter(stream: NodeJS.WritableStream): (line: string) => void {
  let open = true
  stream.on("error", () => {
    open = false
  })
  return (line) => {
    if (!open) return
    try {
      stream.write(`${line}\n`)
    } catch {
      open = false
    }
  }
}

/**
 * `stop` on the first SIGINT, SIGTERM or SIGHUP (a closed terminal: the detached children would
 * otherwise outlive it); `force` on another more than a second later. One Ctrl-C can arrive more
 * than once through pnpm and tsx (Trap 8), and must not kill.
 */
export function stopOnSignals(
  source: { on(event: "SIGINT" | "SIGTERM" | "SIGHUP", listener: () => void): unknown },
  out: (line: string) => void,
  now: () => number = Date.now,
): { readonly stop: AbortSignal; readonly force: AbortSignal } {
  const stop = new AbortController()
  const force = new AbortController()
  let firstAt = 0
  for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    source.on(name, () => {
      if (!stop.signal.aborted) {
        firstAt = now()
        out(`${UP} ${name}: stopping (again, after a second, to kill)`)
        stop.abort()
      } else if (now() - firstAt > 1_000 && !force.signal.aborted) {
        out(`${UP} ${name} again: killing`)
        force.abort()
      }
    })
  return { stop: stop.signal, force: force.signal }
}

/** The drafter's pinned base image, read as text (not imported: the controller shares no source with a worker). */
export function drafterImageReference(env: Readonly<Record<string, string | undefined>>): string {
  if (env.FACTORY_DRAFTER_IMAGE) return env.FACTORY_DRAFTER_IMAGE
  const source = readFileSync(resolve(EXAMPLE_ROOT, "drafter/src/drafter-image.ts"), "utf8")
  const match = /"([a-z0-9.:/_-]+@sha256:[a-f0-9]{64})"/.exec(source)
  if (!match?.[1])
    throw new Error("cannot read the drafter's base image from drafter/src/drafter-image.ts")
  return match[1]
}

export function realUpDeps(out: (line: string) => void): UpDeps {
  return {
    env: process.env,
    dotenvPaths: dotenvCandidates(),
    checkoutLock: join(EXAMPLE_ROOT, ".up.lock"),
    docker: {
      info: async () => {
        await run("docker", ["info", "--format", "{{.ServerVersion}}"], {
          timeout: 15_000,
          env: ownSubprocessEnv(),
        })
      },
      imagePresent: (reference) =>
        run("docker", ["image", "inspect", "--format", "{{.Id}}", "--", reference], {
          timeout: 15_000,
          env: ownSubprocessEnv(),
        }).then(
          () => true,
          () => false,
        ),
    },
    drafterImage: drafterImageReference(process.env),
    portFree,
    fetch,
    out,
    readyTimeoutMs: 120_000,
    stopTimeoutMs: 20_000,
  }
}

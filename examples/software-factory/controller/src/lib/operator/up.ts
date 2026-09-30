import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { connect, createServer } from "node:net"
import { basename, dirname, join, resolve } from "node:path"
import {
  APP_DIRS,
  APP_NAMES,
  type AppName,
  EXAMPLE_ROOT,
  LOOPBACK,
  ownedVariableConflicts,
  type ResolvedFactoryConfig,
} from "./factory-config.js"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
/** The prefix of up's own lines, padded like each app's (D10). */
export const UP = `${"up".padEnd(10)} │`

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
 * that exists (D6). Nothing else in the file is read, and the value is never in a message.
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
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*)$/.exec(line)
    if (!match) continue
    const value = (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2")
    return value === "" ? undefined : { key: value, source: dotenvPath }
  }
  return undefined
}

/**
 * Where the key's `.env` may be (D6): this checkout's toplevel, then the main worktree's (a
 * linked worktree has none of its own). Never `FACTORY_REPO_ROOT`, which names the target
 * repository, possibly a copy.
 */
export function dotenvCandidates(): string[] {
  // Not GIT_DIR and friends: a stray export would answer for another repository.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  )
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", EXAMPLE_ROOT, ...args], {
      encoding: "utf8",
      timeout: 10_000,
      env,
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

export function appProcesses(
  config: ResolvedFactoryConfig,
  secrets: UpSecrets,
  env: Readonly<Record<string, string | undefined>>,
  launch: Launch = b4Start,
): AppProcess[] {
  const base: Record<string, string | undefined> = { ...env }
  for (const name of NOT_INHERITED) delete base[name]
  const controllerEnv = {
    ...base,
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

/** One lock file: taken by `wx`, a stale one taken over by rename (D12). */
function acquireOne(
  path: string,
  record: (children: LockRecord["children"]) => string,
): UpLock | { readonly refused: string } {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx")
      writeSync(fd, record({}))
      closeSync(fd)
      return {
        recordChildren: (children) => {
          // Whole or not at all: a reader must never judge a half-written lock.
          const next = `${path}.next-${process.pid}`
          writeFileSync(next, record(children))
          renameSync(next, path)
        },
        release: () => rmSync(path, { force: true }),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    let text: string
    let held: LockRecord
    const notOurs = {
      refused: `${path} is not a lock up wrote (or another up is writing it this instant); remove it if no factory up is running`,
    }
    try {
      text = readFileSync(path, "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    try {
      const parsed: unknown = JSON.parse(text)
      if (!isLockRecord(parsed)) return notOurs
      held = parsed
    } catch {
      return notOurs
    }
    if (holds(held.up))
      return {
        refused: `factory up is already running (pid ${held.up.pid}, since ${held.up.startedAt}, lock ${path}); stop it first`,
      }
    const orphans = Object.entries(held.children).filter(
      (entry): entry is [string, LockHolder] => entry[1] !== undefined && holds(entry[1]),
    )
    if (orphans.length > 0)
      return {
        refused: `a previous up (pid ${held.up.pid}) is gone but its ${orphans.map(([n, h]) => `${n} pid ${h.pid}`).join(", ")} still run. Check each with ps -ww -p ${orphans.map(([, h]) => h.pid).join(",")} -o command= and stop the ones that are b4 start, then run up again`,
      }
    // Take the stale lock over by rename, never remove-then-create: of two ups racing here one
    // rename wins and the other finds no file (ENOENT) and retries wx.
    const aside = `${path}.stale-${process.pid}`
    try {
      renameSync(path, aside)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    // The file renamed must be the stale one judged above; if another up replaced it meanwhile,
    // put its live lock back and let the next attempt find it held.
    if (readFileSync(aside, "utf8") !== text) renameSync(aside, path)
    else rmSync(aside, { force: true })
  }
  return { refused: `could not take ${path}` }
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
  for (const path of [join(config.stateDir, "up.lock"), checkoutLock]) {
    const lock = acquireOne(path, record)
    if ("refused" in lock) {
      for (const held of taken) held.release()
      return lock
    }
    taken.push(lock)
  }
  return {
    recordChildren: (children) => {
      for (const lock of taken) lock.recordChildren(children)
    },
    release: () => {
      for (const lock of taken) lock.release()
    },
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

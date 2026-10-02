import { existsSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { MAX_KEY_PATH_LENGTH, notAKeyPath } from "../delivery/github/jwt.js"
import { BRANCH_PATTERN, REPOSITORY_PATTERN } from "../domain/work-order.js"

/**
 * What `examples/software-factory/factory.config.ts` default-exports: the one file `factory up`
 * starts the factory from and every `factory` command reads its controller and state from.
 * Validated at load by {@link parseFactoryConfig}, which is the contract; this type only lets
 * the file say `satisfies FactoryUpConfig`.
 */
export interface FactoryUpConfig {
  /** The controller's state directory: relative to the config file, or absolute. */
  readonly state: string
  readonly controller: { readonly port: number }
  readonly builder: { readonly port: number }
  readonly drafter: { readonly port: number }
  /** Draft-PR delivery (rung 4 §8.1). Absent: `--deliver draft-pr` is refused at create. */
  readonly delivery?: {
    readonly draftPr: {
      readonly repository: string
      readonly baseBranch: string
      /** The GitHub App: its id, and where its private key is (never the key). */
      readonly app:
        | { readonly id: number; readonly privateKeyFile: string }
        | { readonly id: number; readonly privateKeyEnv: string }
    }
  }
}

/** `examples/software-factory`: this file is `controller/src/lib/operator/factory-config.ts`. */
export const EXAMPLE_ROOT = resolve(import.meta.dirname, "../../../..")
export const DEFAULT_CONFIG_PATH = resolve(EXAMPLE_ROOT, "factory.config.ts")
/** Every process binds here: the controller has no authorization and must not be reachable. */
export const LOOPBACK = "127.0.0.1"

export type AppName = "controller" | "builder" | "drafter"
/** Start order is irrelevant; stop order is the controller first (see `up`). */
export const APP_NAMES: readonly AppName[] = ["controller", "builder", "drafter"]
/** Each app's root, under the example: the builder is the `server` package. */
export const APP_DIRS: Readonly<Record<AppName, string>> = {
  controller: "controller",
  builder: "server",
  drafter: "drafter",
}

export interface ResolvedFactoryConfig {
  readonly path: string
  readonly stateDir: string
  readonly ports: Readonly<Record<AppName, number>>
  readonly urls: Readonly<Record<AppName, string>>
  /** Resolved: the key file absolute (`~` expanded), or the variable `up` reads it from. */
  readonly delivery?: {
    readonly repository: string
    readonly baseBranch: string
    readonly appId: number
    readonly key: { readonly file: string } | { readonly env: string }
  }
}

const Port = z.number().int().min(1024).max(65535)
const App = z.object({ port: Port }).strict()
const AppCredential = z
  .object({
    id: z.number().int().positive(),
    // Refused by name, never quoted: a key pasted here would be printed by every message
    // that names the path (review of Task 20).
    privateKeyFile: z
      .string()
      .min(1)
      .refine(
        (value) => !notAKeyPath(value),
        `must be the key file's path, not the key (it holds a PEM header or a line break, or is over ${MAX_KEY_PATH_LENGTH} characters)`,
      )
      .optional(),
    privateKeyEnv: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable's name")
      .optional(),
  })
  .strict()
  .refine(
    (app) => (app.privateKeyFile === undefined) !== (app.privateKeyEnv === undefined),
    "name exactly one of privateKeyFile or privateKeyEnv",
  )
const Delivery = z
  .object({
    draftPr: z
      .object({
        repository: z.string().regex(REPOSITORY_PATTERN, "must be owner/name"),
        baseBranch: z.string().regex(BRANCH_PATTERN, "must be a branch name"),
        app: AppCredential,
      })
      .strict(),
  })
  .strict()
const ConfigSchema = z
  .object({
    state: z.string().refine((s) => s.trim() !== "", "must name a directory"),
    controller: App,
    builder: App,
    drafter: App,
    delivery: Delivery.optional(),
  })
  .strict()

/**
 * Near-misses inside `delivery.draftPr` and its `app`, refused by name like `REPLACED`: a key
 * the reader might write must never be read as unset (spec §8.1).
 */
const DELIVERY_REPLACED: Readonly<Record<string, string>> = {
  token: "delivery uses a GitHub App; the config names an app id and where its key is",
  githubToken: "delivery uses a GitHub App; the config names an app id and where its key is",
  pat: "delivery uses a GitHub App; the config names an app id and where its key is",
  installationId: "read from the repository at each delivery",
  branchPrefix: "fixed at factory/; the CI guards key on it",
}
const APP_REPLACED: Readonly<Record<string, string>> = {
  privateKey: "the config names no secret; use privateKeyFile or privateKeyEnv",
  token: "delivery uses a GitHub App; the config names an app id and where its key is",
  installationId: "read from the repository at each delivery",
}

function deliveryNearMisses(value: Record<string, unknown>): string[] {
  const draftPr = (value.delivery as { draftPr?: unknown } | undefined)?.draftPr
  if (!isPlainObject(draftPr)) return []
  const problems = Object.keys(draftPr)
    .filter((key) => Object.hasOwn(DELIVERY_REPLACED, key))
    .map((key) => `delivery.draftPr.${key}: ${DELIVERY_REPLACED[key]}`)
  const app = draftPr.app
  if (isPlainObject(app))
    problems.push(
      ...Object.keys(app)
        .filter((key) => Object.hasOwn(APP_REPLACED, key))
        .map((key) => `delivery.draftPr.app.${key}: ${APP_REPLACED[key]}`),
    )
  return problems
}

/**
 * Keys a reader of the spec's first sketch would write, refused with what replaced them
 * rather than as a bare "unrecognized key": each once meant something, and silently dropping
 * one would leave an operator believing it still does.
 */
const REPLACED: Readonly<Record<string, string>> = {
  worker:
    "the factory has two workers: set builder.port and drafter.port (up starts both on 127.0.0.1 and derives their URLs)",
  token:
    "up generates the worker token for each start, or uses FACTORY_WORKER_TOKEN when it is set; the config names no secret",
  host: "up binds every process to 127.0.0.1: the controller has no authorization and must not be exposed",
}

function describeValue(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  if (value instanceof Promise)
    return "a promise: export the object itself (top-level await is allowed)"
  if (typeof value === "object") {
    const name = (Object.getPrototypeOf(value) as { constructor?: { name?: unknown } } | null)
      ?.constructor?.name
    return typeof name === "string" && name !== "" ? `an instance of ${name}` : "an object"
  }
  return typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Lexically inside (or equal to) `root`: `..x` is a child, only `..` or `../…` leaves. */
function lexicallyInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
}

/**
 * Whether `path` (absolute, normalized, possibly not yet existing) is `root` or under it on
 * disk. Compared by identity (device and inode), not by name: the nearest existing ancestor
 * of `path` is resolved through its symlinks, then it and each of its ancestors is compared
 * with `root`. The components below that ancestor do not exist, so none is a link, and
 * `resolve` has already removed every `..`. Identity rather than a case-folded string compare
 * because case sensitivity is a property of each volume (APFS and NTFS can be either, and a
 * case-sensitive volume can be mounted under a case-insensitive one), and folding cannot see
 * Unicode normalization; the inode answers for whichever volume the path is on. A root that
 * does not exist cannot contain anything on disk.
 */
function physicallyInside(root: string, path: string): boolean {
  let rootStat: ReturnType<typeof statSync>
  try {
    rootStat = statSync(root)
  } catch {
    return false
  }
  let existing = path
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) return false
    existing = parent
  }
  let at = realpathSync.native(existing)
  for (;;) {
    const here = statSync(at)
    if (here.dev === rootStat.dev && here.ino === rootStat.ino) return true
    const parent = dirname(at)
    if (parent === at) return false
    at = parent
  }
}

/** Validate a config's default export, failing closed on anything but the exact shape. */
export function parseFactoryConfig(value: unknown, path: string): ResolvedFactoryConfig {
  const fail = (problems: readonly string[]) =>
    new Error(`Invalid factory config ${path}:\n${problems.join("\n")}`)
  if (!isPlainObject(value))
    throw fail([`the default export must be a plain object, got ${describeValue(value)}`])
  const problems = Object.keys(value)
    .filter((key) => Object.hasOwn(REPLACED, key))
    .map((key) => `${key}: ${REPLACED[key]}`)
  problems.push(...deliveryNearMisses(value))
  const parsed = ConfigSchema.safeParse(value)
  if (!parsed.success)
    problems.push(
      ...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    )
  if (!parsed.success || problems.length > 0) throw fail(problems)
  const { state, controller, builder, drafter, delivery } = parsed.data
  const ports: Record<AppName, number> = {
    controller: controller.port,
    builder: builder.port,
    drafter: drafter.port,
  }
  const taken = new Map<number, AppName>()
  for (const name of APP_NAMES) {
    const other = taken.get(ports[name])
    if (other !== undefined)
      problems.push(
        `${name}.port: ${ports[name]} is also ${other}.port; each process needs its own port`,
      )
    else taken.set(ports[name], name)
  }
  const stateDir = isAbsolute(state) ? resolve(state) : resolve(dirname(path), state)
  for (const name of APP_NAMES) {
    const appRoot = resolve(EXAMPLE_ROOT, APP_DIRS[name])
    if (lexicallyInside(appRoot, stateDir) || physicallyInside(appRoot, stateDir))
      problems.push(
        `state: ${stateDir} is inside the ${name}'s app root ${appRoot}; keep run-time files out of every app root`,
      )
  }
  if (problems.length > 0) throw fail(problems)
  const urls = Object.fromEntries(
    APP_NAMES.map((name) => [name, `http://${LOOPBACK}:${ports[name]}`]),
  ) as Record<AppName, string>
  if (delivery === undefined) return { path, stateDir, ports, urls }
  const { app } = delivery.draftPr
  const file = app.privateKeyFile
  const key =
    file !== undefined
      ? {
          file: file.startsWith("~/")
            ? resolve(homedir(), file.slice(2))
            : isAbsolute(file)
              ? resolve(file)
              : resolve(dirname(path), file),
        }
      : { env: app.privateKeyEnv as string }
  return {
    path,
    stateDir,
    ports,
    urls,
    delivery: {
      repository: delivery.draftPr.repository,
      baseBranch: delivery.draftPr.baseBranch,
      appId: app.id,
      key,
    },
  }
}

/**
 * What is wrong with the delivery key file `up` would give the controller (spec §8.1): it must
 * exist, be a regular file, be private to its owner (no group or other bits), and lie outside
 * every app root and the state directory, compared by identity. Empty when it is usable or
 * when the config names a variable instead. Checked by `up`, not at load: every CLI command
 * loads the config, and none of them needs the key.
 */
export function deliveryKeyProblems(config: ResolvedFactoryConfig): string[] {
  const key = config.delivery?.key
  if (key === undefined || !("file" in key)) return []
  const where = `delivery.draftPr.app.privateKeyFile ${key.file}`
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(key.file)
  } catch {
    return [`${where} does not exist`]
  }
  const problems: string[] = []
  if (!stat.isFile()) problems.push(`${where} is not a regular file`)
  if ((stat.mode & 0o077) !== 0)
    problems.push(
      `${where} is readable by group or other (mode ${(stat.mode & 0o777).toString(8)}): chmod 600 it`,
    )
  const roots = [...APP_NAMES.map((name) => resolve(EXAMPLE_ROOT, APP_DIRS[name])), config.stateDir]
  for (const root of roots)
    if (lexicallyInside(root, key.file) || physicallyInside(root, key.file))
      problems.push(
        `${where} is inside ${root}; keep the key outside every app root and the state directory`,
      )
  return problems
}

/** Import a config file (tsx compiles it) and validate its default export. */
export async function loadFactoryConfig(path: string): Promise<ResolvedFactoryConfig> {
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new Error(`No factory config at ${absolute}`)
  let loaded: Record<string, unknown>
  try {
    loaded = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new Error(`factory config ${absolute} failed to load: ${cause}`, { cause: error })
  }
  if (!("default" in loaded))
    throw new Error(`Invalid factory config ${absolute}:\nit has no default export`)
  return parseFactoryConfig(loaded.default, absolute)
}

/**
 * Which config a command reads: `--config`, else `FACTORY_CONFIG`, else the example's own when
 * it exists. `none` reads none. A named file must exist (the loader refuses otherwise); the
 * default is optional, so the CLI still works where the example's file is absent. A relative
 * name is relative to where the person ran `pnpm factory` (pnpm's `INIT_CWD`; the process's own
 * directory is the controller's), else `cwd`. An empty `--config` is refused, not a fallback:
 * `--config "$UNSET_VAR"` must not silently read another file.
 */
export function factoryConfigPath(
  env: Readonly<Record<string, string | undefined>>,
  flag: string | undefined,
  cwd: string = process.cwd(),
): { readonly path: string; readonly named: boolean } | undefined {
  if (flag === "") throw new Error("--config needs a path")
  const named = flag ?? env.FACTORY_CONFIG
  if (named === "none") return undefined
  if (named !== undefined && named !== "") {
    const base = env.INIT_CWD !== undefined && env.INIT_CWD !== "" ? env.INIT_CWD : cwd
    return { path: resolve(base, named), named: true }
  }
  return existsSync(DEFAULT_CONFIG_PATH) ? { path: DEFAULT_CONFIG_PATH, named: false } : undefined
}

const sameUrl = (a: string, b: string) => a.replace(/\/+$/, "") === b.replace(/\/+$/, "")
const sameDir = (a: string, b: string) => resolve(a) === resolve(b)

/**
 * The CLI's two variables, filled from the config where the environment leaves them unset.
 * The environment wins where it sets one (the manual runbook's exports keep working); each
 * disagreement is returned as a line for stderr, so a stale export is seen, not guessed at.
 * Mutates `env`, which is `process.env` in the CLI: every command reads it there.
 */
export function applyConfigDefaults(
  env: Record<string, string | undefined>,
  config: ResolvedFactoryConfig,
): string[] {
  const wanted = [
    ["FACTORY_CONTROLLER_URL", config.urls.controller, sameUrl],
    ["FACTORY_STATE_DIR", config.stateDir, sameDir],
  ] as const
  const warnings: string[] = []
  const origins: Record<string, "environment" | "config"> = {}
  for (const [name, value, same] of wanted) {
    const set = env[name]
    if (set === undefined || set === "") {
      env[name] = value
      origins[name] = "config"
    } else {
      origins[name] = "environment"
      if (!same(set, value))
        warnings.push(
          `${name} is ${set} in the environment but ${value} in ${config.path}; using the environment's`,
        )
    }
  }
  const [[firstName], [secondName]] = wanted
  if (origins[firstName] !== origins[secondName]) {
    const describe = (name: string) =>
      origins[name] === "environment" ? "the environment" : config.path
    warnings.push(
      `${firstName} is from ${describe(firstName)} but ${secondName} is from ${describe(secondName)}: reads may come from one registry and writes go to another controller`,
    )
  }
  return warnings
}

/**
 * Variables `up` decides from the config, set in its environment to something else. `up`
 * refuses them rather than override: a later command in the same shell would read the stale
 * one (the environment wins in the CLI) and talk to another controller or registry.
 */
export function ownedVariableConflicts(
  env: Readonly<Record<string, string | undefined>>,
  config: ResolvedFactoryConfig,
): string[] {
  const owned = [
    ["FACTORY_CONTROLLER_URL", config.urls.controller, "starts the controller at", sameUrl],
    ["FACTORY_WORKER_URL", config.urls.builder, "starts the builder at", sameUrl],
    ["FACTORY_DRAFTER_URL", config.urls.drafter, "starts the drafter at", sameUrl],
    ["FACTORY_STATE_DIR", config.stateDir, "keeps the controller's state in", sameDir],
  ] as const
  return owned
    .filter(([name, value, , same]) => {
      const set = env[name]
      return set !== undefined && set !== "" && !same(set, value)
    })
    .map(
      ([name, value, what]) =>
        `${name} is ${env[name]} in the environment but up ${what} ${value}: unset it (the CLI reads ${config.path}) or make them equal`,
    )
}

import { existsSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { z } from "zod"

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
}

const Port = z.number().int().min(1024).max(65535)
const App = z.object({ port: Port }).strict()
const ConfigSchema = z
  .object({
    state: z.string().refine((s) => s.trim() !== "", "must name a directory"),
    controller: App,
    builder: App,
    drafter: App,
  })
  .strict()

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
  return typeof value
}

/** Validate a config's default export, failing closed on anything but the exact shape. */
export function parseFactoryConfig(value: unknown, path: string): ResolvedFactoryConfig {
  const fail = (problems: readonly string[]) =>
    new Error(`Invalid factory config ${path}:\n${problems.join("\n")}`)
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw fail([`the default export must be an object, got ${describeValue(value)}`])
  const problems = Object.keys(value)
    .filter((key) => key in REPLACED)
    .map((key) => `${key}: ${REPLACED[key]}`)
  const parsed = ConfigSchema.safeParse(value)
  if (!parsed.success)
    problems.push(
      ...parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    )
  if (!parsed.success || problems.length > 0) throw fail(problems)
  const { state, controller, builder, drafter } = parsed.data
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
    const rel = relative(appRoot, stateDir)
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)))
      problems.push(
        `state: ${stateDir} is inside the ${name}'s app root ${appRoot}; keep run-time files out of every app root`,
      )
  }
  if (problems.length > 0) throw fail(problems)
  const urls = Object.fromEntries(
    APP_NAMES.map((name) => [name, `http://${LOOPBACK}:${ports[name]}`]),
  ) as Record<AppName, string>
  return { path, stateDir, ports, urls }
}

/** Import a config file (tsx compiles it) and validate its default export. */
export async function loadFactoryConfig(path: string): Promise<ResolvedFactoryConfig> {
  const absolute = resolve(path)
  if (!existsSync(absolute)) throw new Error(`No factory config at ${absolute}`)
  const loaded = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>
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
  for (const [name, value, same] of wanted) {
    const set = env[name]
    if (set === undefined || set === "") env[name] = value
    else if (!same(set, value))
      warnings.push(
        `${name} is ${set} in the environment but ${value} in ${config.path}; using the environment's`,
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

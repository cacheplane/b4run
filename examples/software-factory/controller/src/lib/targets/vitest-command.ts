/**
 * A target's `commands.test` for a vitest suite: `pnpm exec vitest <flags> [files...]
 * [--exclude <glob>...]`. The base is the package's own `test` script; the files are a scope a
 * person chose; the excludes are what `target:measure` proposed, each with its failure output
 * in the measurement's report. The verifier appends its reporter flags after all of it
 * (`verification/checks-runner.ts`), so nothing here may depend on being last.
 */
export interface VitestCommand {
  /** `pnpm exec vitest` and every flag, in order. */
  readonly base: readonly string[]
  /** The `--config` value, when the command names one. */
  readonly config: string | undefined
  /** Positional filters: the files a narrowed suite runs. */
  readonly files: readonly string[]
  readonly excludes: readonly string[]
}

const SHELL = /[&|;<>$`"'\\()]/
/**
 * The only switches read, in a test script (plan D3) or a test command: what this repository's
 * packages pass. Anything else might select other files or change the run, and is refused by
 * name rather than guessed at. `run` is read only as the first word; `--config` and `--exclude`
 * are the only flags with a value.
 */
const SWITCHES = new Set(["--run", "--no-cache", "--passWithNoTests"])

/** A literal path under the package: no glob, no flag, no `..`, nothing absolute. */
function packagePath(value: string): boolean {
  return (
    /^[A-Za-z0-9._/-]+$/.test(value) &&
    !value.startsWith("-") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
  )
}

function configValue(value: string | undefined, where: string): string {
  if (value === undefined || !packagePath(value))
    throw new Error(
      `${where} names --config ${JSON.stringify(value ?? "")}; target:init reads only a package-relative config file`,
    )
  return value
}

/** `pkg`'s `test` script as a target's test command: through `pnpm exec`, in run mode, cacheless. */
export function vitestTestArgv(pkg: {
  readonly name: string
  readonly dir: string
  readonly manifest: { readonly scripts?: Readonly<Record<string, string>> | undefined }
}): string[] {
  const script = pkg.manifest.scripts?.test
  if (script === undefined) throw new Error(`${pkg.name} (${pkg.dir}) has no test script`)
  if (SHELL.test(script))
    throw new Error(
      `${pkg.name}: its test script is a shell line (${script}); target:init takes a plain \`vitest ...\` invocation`,
    )
  const [runner, ...words] = script.trim().split(/\s+/)
  if (runner !== "vitest")
    throw new Error(
      `${pkg.name}: its test script runs ${JSON.stringify(runner)}; target:init generates vitest targets only (every pnpm package in this repository tests with vitest)`,
    )
  const args: string[] = []
  for (let i = 0; i < words.length; i++) {
    const word = words[i] as string
    if ((i === 0 && word === "run") || SWITCHES.has(word)) args.push(word)
    else if (word.startsWith("--config=")) {
      configValue(word.slice("--config=".length), `${pkg.name}'s test script`)
      args.push(word)
    } else if (word === "--config")
      args.push(word, configValue(words[++i], `${pkg.name}'s test script`))
    else
      throw new Error(
        `${pkg.name}: its test script passes ${JSON.stringify(word)}; target:init reads only run, --run, --config <file>, --no-cache and --passWithNoTests, and will not guess what anything else selects`,
      )
  }
  let runAt = args[0] === "run" ? 0 : args.indexOf("--run")
  if (runAt === -1) {
    args.unshift("--run")
    runAt = 0
  }
  // vitest writes its results cache under the nearest node_modules, which in the sandbox is
  // the image's read-only one.
  if (!args.includes("--no-cache")) args.splice(runAt + 1, 0, "--no-cache")
  return ["pnpm", "exec", "vitest", ...args]
}

/** Read `argv` back into its parts. Refuses any shape it would have to guess at. */
export function parseVitestCommand(argv: readonly string[]): VitestCommand {
  if (argv[0] !== "pnpm" || argv[1] !== "exec" || argv[2] !== "vitest")
    throw new Error(
      `A generated target's test command is \`pnpm exec vitest ...\`; this one is ${JSON.stringify(argv.join(" "))}`,
    )
  const base = ["pnpm", "exec", "vitest"]
  const files: string[] = []
  const excludes: string[] = []
  let config: string | undefined
  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i] as string
    if (arg === "--exclude" || arg.startsWith("--exclude=")) {
      const value = arg === "--exclude" ? argv[++i] : arg.slice("--exclude=".length)
      if (value === undefined || value === "" || value.startsWith("-"))
        throw new Error("The test command ends in --exclude with no value")
      excludes.push(value)
    } else if (arg === "--config") {
      config = configValue(argv[++i], "The test command")
      base.push(arg, config)
    } else if (arg.startsWith("--config=")) {
      config = configValue(arg.slice("--config=".length), "The test command")
      base.push(arg)
    } else if ((i === 3 && arg === "run") || SWITCHES.has(arg)) base.push(arg)
    else if (!arg.startsWith("-") && arg !== "run") files.push(arg)
    else
      throw new Error(
        `The test command passes ${JSON.stringify(arg)}; a generated target's command reads only run, --run, --no-cache, --passWithNoTests, --config <file>, --exclude <file> and files, and will not guess what anything else selects`,
      )
  }
  return { base, config, files, excludes }
}

/**
 * `command` with exactly `excludes` (sorted, de-duplicated) in place of its own. Each must be one
 * file, named literally: vitest reads an exclude as a glob.
 */
export function withExcludes(command: VitestCommand, excludes: readonly string[]): string[] {
  for (const exclude of excludes)
    if (!packagePath(exclude))
      throw new Error(
        `Exclude ${JSON.stringify(exclude)} is not a literal, package-relative path (no glob, flag, \`..\` or absolute path): an exclude names one test file`,
      )
  return [
    ...command.base,
    ...command.files,
    ...[...new Set(excludes)].sort().flatMap((glob) => ["--exclude", glob]),
  ]
}

/** `file` run alone: the base and the file. The scope and the excludes do not apply to it. */
export function perFileArgv(command: VitestCommand, file: string): string[] {
  return [...command.base, file]
}

/**
 * `vitest list --filesOnly` over what `command` runs, its excludes ignored: `measure` measures
 * every file the config and the scope select, and proposes the excludes from scratch (a
 * person's own additions show as removed in the diff, to be restored by hand if intended).
 */
export function listArgv(command: VitestCommand): string[] {
  const flags = command.base.slice(3)
  return [
    "pnpm",
    "exec",
    "vitest",
    "list",
    "--filesOnly",
    ...(flags[0] === "run" ? flags.slice(1) : flags),
    ...command.files,
  ]
}

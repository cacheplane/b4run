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
 * The only test-script flags read (plan D3): what this repository's packages pass. Anything
 * else might select other files or change the run, and is refused rather than guessed at.
 */
const SCRIPT_FLAGS = new Set(["--run", "--no-cache", "--passWithNoTests"])
/** Flags that take a value and would change which files run: refused rather than half-read. */
const UNREAD = ["--project", "--root", "--dir", "-r"]

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
    if ((i === 0 && word === "run") || SCRIPT_FLAGS.has(word) || word.startsWith("--config="))
      args.push(word)
    else if (word === "--config") {
      const value = words[++i]
      if (value === undefined) throw new Error(`${pkg.name}: its test script ends in --config`)
      args.push(word, value)
    } else
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
    if (arg === "--exclude") {
      const value = argv[++i]
      if (value === undefined) throw new Error("The test command ends in --exclude with no value")
      excludes.push(value)
    } else if (arg.startsWith("--exclude=")) excludes.push(arg.slice("--exclude=".length))
    else if (arg === "--config") {
      const value = argv[++i]
      if (value === undefined) throw new Error("The test command ends in --config with no value")
      config = value
      base.push(arg, value)
    } else if (arg.startsWith("--config=")) {
      config = arg.slice("--config=".length)
      base.push(arg)
    } else if (i === 3 && arg === "run") base.push(arg)
    else if (UNREAD.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))
      throw new Error(
        `The test command passes ${arg}, which changes which files run: not read here`,
      )
    else if (arg.startsWith("-")) base.push(arg)
    else files.push(arg)
  }
  return { base, config, files, excludes }
}

/** `command` with exactly `excludes` (sorted, de-duplicated) in place of its own. */
export function withExcludes(command: VitestCommand, excludes: readonly string[]): string[] {
  return [
    ...command.base,
    ...command.files,
    ...[...new Set(excludes)].sort().flatMap((glob) => ["--exclude", glob]),
  ]
}

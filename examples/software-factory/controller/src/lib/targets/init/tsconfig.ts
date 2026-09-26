import { posix } from "node:path"
import type { PinTree } from "./pin-tree.js"
import type { WorkspacePackage } from "./workspace-graph.js"

/**
 * The build script's compile: one `tsc -b <file>` (or `--build`) at its start or after `&&`. The
 * target's own build script is not run as a whole: `cli`'s ends in a docs generator that reads
 * `apps/web`, and `ag-ui`'s moves files around its compile. The compile is what a target needs,
 * so it is read only when it is exactly that: one config, nothing after it, and no `cd` anywhere
 * in the chain to change what the config path is relative to. Quoted strings (`ag-ui`'s
 * `node -e "..."`) are set aside first, so an `&&` inside one does not split a command.
 */
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g
const CD = /(?:^|[;&|(])\s*cd(?:\s|$)/
const CONFIG = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.json$/

export interface BuildConfig {
  /** Package-relative: the file the build script's `tsc -b` names. */
  readonly tsconfig: string
  /** Repository-relative: that file and the files it extends inside the package, in order. */
  readonly files: readonly string[]
  /** Repository-relative directory prefix the build writes, with its trailing slash. */
  readonly outDir: string
  /**
   * Repository-relative files outside the package the chain extends, in order: a config
   * package's, which the target must capture (`deriveTarget` checks).
   */
  readonly externalExtends: readonly string[]
  /**
   * Repository-relative: the build config's own `references` paths, as written (a directory or a
   * file). Not inherited through `extends`, as in TypeScript.
   */
  readonly references: readonly string[]
}

/** The tsconfig `pkg`'s build compiles; undefined when it has no build script. */
export function buildScriptTsconfig(
  pkg: Pick<WorkspacePackage, "name" | "dir" | "manifest">,
): string | undefined {
  const script = pkg.manifest.scripts?.build
  if (script === undefined) return undefined
  const refuse = (why: string) =>
    new Error(`${pkg.name} (${pkg.dir}): ${why}; target:init cannot build it: ${script}`)
  const bare = script.replace(QUOTED, "_quoted_")
  if (/["'`]/.test(bare)) throw refuse("its build script has an unbalanced quote")
  if (CD.test(bare))
    throw refuse(
      "its build script changes directory with `cd`, so its tsconfig path is not relative to the package",
    )
  const found: string[] = []
  for (const segment of bare.split("&&")) {
    const words = segment.trim().split(/\s+/)
    if (words[0] !== "tsc") continue
    if (words[1] !== "-b" && words[1] !== "--build")
      throw refuse(
        `its build script runs \`${segment.trim()}\`, which is not a \`tsc -b <tsconfig>\` and which the target would not run`,
      )
    const config = words[2]
    if (words.length !== 3 || config === undefined)
      throw refuse(
        `its \`${segment.trim()}\` must name exactly one tsconfig and nothing after it but \`&&\` or the end of the script`,
      )
    if (!CONFIG.test(config) || config.split("/").some((s) => s === "." || s === ".."))
      throw refuse(`its build compiles ${config}, not a package-relative tsconfig`)
    found.push(config)
  }
  if (found.length !== 1)
    throw refuse(
      `its build script must run exactly one \`tsc -b <tsconfig>\` (found ${found.length})`,
    )
  return found[0]
}

/** Every `tsconfig*.json` directly in `pkg`'s directory at the pin, repository-relative. */
export function packageTsconfigs(tree: PinTree, pkg: Pick<WorkspacePackage, "dir">): string[] {
  return tree
    .children(pkg.dir)
    .filter((entry) => entry.kind === "file" && /^tsconfig.*\.json$/.test(entry.name))
    .map((entry) => `${pkg.dir}/${entry.name}`)
}

const MAX_EXTENDS = 8

/** The compilerOptions that say where a build reads its layout from or writes to. */
const PATH_OPTIONS = ["outDir", "rootDir", "tsBuildInfoFile", "declarationDir", "outFile"] as const
type PathOption = (typeof PATH_OPTIONS)[number]

/** `path` equals `dir`, or lies under it. */
const within = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`)
const withoutExtension = (path: string) => path.replace(/\.[^./]*$/, "")

/**
 * What `pkg`'s build reads and writes: its build tsconfig, the whole chain it `extends` (the
 * files inside the package, and those of the config package it leaves for, which `deriveTarget`
 * checks the target captures), and where the build writes. Each path option is the nearest one
 * along the chain, resolved against the file that sets it, as TypeScript resolves it. Everything
 * the build writes must land in its outDir, which is recorded as a snapshotIgnore prefix: the
 * outDir itself, declarations, a bundle, and the build info `tsc -b` always emits. tsconfig files
 * are read as plain JSON: every one in this repository is, and a JSONC one is refused rather than
 * misread. `${configDir}` substitution is refused rather than evaluated.
 */
export function buildConfig(tree: PinTree, pkg: WorkspacePackage): BuildConfig {
  const tsconfig = buildScriptTsconfig(pkg)
  if (tsconfig === undefined) throw new Error(`${pkg.name} (${pkg.dir}) has no build script`)
  const top = posix.normalize(`${pkg.dir}/${tsconfig}`)
  const files: string[] = []
  const externalExtends: string[] = []
  const options: Partial<Record<PathOption, string>> = {}
  let references: string[] = []
  const verbatim = (file: string, what: string, value: string) => {
    if (value.includes("${"))
      throw new Error(
        `${pkg.name}: ${file} sets ${what} to ${JSON.stringify(value)}; target:init does not evaluate \${...} substitution`,
      )
    return value
  }
  const literal = (file: string, what: string, value: string) =>
    posix.normalize(posix.join(posix.dirname(file), verbatim(file, what, value)))
  let current = top
  for (let depth = 0; ; depth++) {
    if (files.includes(current) || externalExtends.includes(current))
      throw new Error(`${pkg.name}: ${top} has an extends cycle through ${current}`)
    if (depth === MAX_EXTENDS)
      throw new Error(`${pkg.name}: ${top} extends more than ${MAX_EXTENDS} deep`)
    const text = tree.read(current)
    if (text === undefined) throw new Error(`${pkg.name}: ${current} does not exist at ${tree.pin}`)
    let parsed: { extends?: unknown; compilerOptions?: unknown; references?: unknown }
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch (error) {
      throw new Error(
        `${current} is not plain JSON (target:init reads tsconfig files with JSON.parse): ${String(error)}`,
      )
    }
    ;(within(current, pkg.dir) ? files : externalExtends).push(current)
    if (depth === 0) references = readReferences(pkg, current, parsed.references, literal)
    const compilerOptions = parsed.compilerOptions ?? {}
    if (typeof compilerOptions !== "object" || compilerOptions === null)
      throw new Error(`${pkg.name}: ${current}'s compilerOptions is not an object`)
    for (const name of PATH_OPTIONS) {
      const value = (compilerOptions as Record<string, unknown>)[name]
      if (value === undefined || options[name] !== undefined) continue
      if (typeof value !== "string")
        throw new Error(`${pkg.name}: ${current}'s ${name} is ${JSON.stringify(value)}, not a path`)
      options[name] = literal(current, name, value)
    }
    const parent = parsed.extends
    if (parent === undefined) break
    if (typeof parent !== "string" || !/^\.\.?\//.test(verbatim(current, "extends", parent)))
      throw new Error(
        `${current} extends ${JSON.stringify(parent)}: target:init follows only relative extends`,
      )
    let next = literal(current, "extends", parent)
    if (next === ".." || next.startsWith("../"))
      throw new Error(`${current} extends ${parent}, outside the repository`)
    // TypeScript's getExtendsConfigPath: the path as written, else the path plus ".json".
    if (tree.kind(next) !== "file" && !next.endsWith(".json")) next = `${next}.json`
    current = next
  }
  const { outDir, rootDir, tsBuildInfoFile, declarationDir, outFile } = options
  if (outDir === undefined)
    throw new Error(
      `${pkg.name}: ${top} (and what it extends) sets no compilerOptions.outDir, so target:init cannot tell where its build writes`,
    )
  if (!within(outDir, pkg.dir))
    throw new Error(`${pkg.name}: its build writes ${outDir}, outside the package`)
  // The capture takes these directories whole; an outDir among them would hide their edits
  // behind its snapshotIgnore prefix.
  for (const captured of [`${pkg.dir}/src`, `${pkg.dir}/test`])
    if (within(outDir, captured) || within(captured, outDir))
      throw new Error(
        `${pkg.name}: its build writes ${outDir}, which overlaps ${captured}, a directory the target captures`,
      )
  // TypeScript's getTsBuildInfoEmitOutputFilePath: `tsc -b` always emits build info, by default
  // at <outDir>/<the config's path relative to rootDir> (or its basename, with no rootDir).
  const configStem = withoutExtension(top)
  const buildInfo =
    tsBuildInfoFile ??
    `${
      outFile !== undefined
        ? withoutExtension(outFile)
        : rootDir !== undefined
          ? posix.normalize(posix.join(outDir, posix.relative(rootDir, configStem)))
          : posix.join(outDir, posix.basename(configStem))
    }.tsbuildinfo`
  // snapshotIgnore holds directory prefixes: anything written outside the outDir would read,
  // after a builder's build, as a file the baseline lacks.
  for (const written of [declarationDir, outFile, buildInfo])
    if (written !== undefined && !within(written, outDir))
      throw new Error(
        `${pkg.name}: its build writes ${written}, outside its outDir ${outDir}, where snapshotIgnore cannot cover it`,
      )
  return { tsconfig, files, outDir: `${outDir}/`, externalExtends, references }
}

function readReferences(
  pkg: WorkspacePackage,
  file: string,
  value: unknown,
  literal: (file: string, what: string, value: string) => string,
): string[] {
  if (value === undefined) return []
  const paths = Array.isArray(value)
    ? value.map((entry: unknown) =>
        typeof entry === "object" && entry !== null
          ? (entry as { path?: unknown }).path
          : undefined,
      )
    : undefined
  if (paths === undefined || !paths.every((path): path is string => typeof path === "string"))
    throw new Error(
      `${pkg.name}: ${file}'s references is not a list of { "path": string }: ${JSON.stringify(value)}`,
    )
  return paths.map((path) => literal(file, "a reference", path))
}

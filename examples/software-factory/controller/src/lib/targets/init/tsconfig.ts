import { posix } from "node:path"
import type { PinTree } from "./pin-tree.js"
import type { WorkspacePackage } from "./workspace-graph.js"

/**
 * One `tsc -b <file>` (or `--build`) in a build script, at its start or after `&&`. The target's
 * own build script is not run as a whole: `cli`'s ends in a docs generator that reads
 * `apps/web`, and `ag-ui`'s moves files around its compile. The compile is what a target needs.
 */
const TSC_BUILD = /(?:^|&&)\s*tsc\s+(?:-b|--build)\s+([A-Za-z0-9._/-]+\.json)(?=\s|$)/g

export interface BuildConfig {
  /** Package-relative: the file the build script's `tsc -b` names. */
  readonly tsconfig: string
  /** Repository-relative: that file and the files it extends inside the package, in order. */
  readonly files: readonly string[]
  /** Repository-relative directory prefix the build writes, with its trailing slash. */
  readonly outDir: string
  /** Repository-relative files outside the package the chain extends (a config package's). */
  readonly externalExtends: readonly string[]
}

/** The tsconfig `pkg`'s build compiles; undefined when it has no build script. */
export function buildScriptTsconfig(
  pkg: Pick<WorkspacePackage, "name" | "dir" | "manifest">,
): string | undefined {
  const script = pkg.manifest.scripts?.build
  if (script === undefined) return undefined
  const found = [...script.matchAll(TSC_BUILD)].map((match) => match[1] as string)
  if (found.length !== 1)
    throw new Error(
      `${pkg.name} (${pkg.dir}): its build script must run exactly one \`tsc -b <tsconfig>\` for target:init to build it (found ${found.length}): ${script}`,
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

/**
 * What `pkg`'s build reads and writes: its build tsconfig, the chain it `extends` inside the
 * package, and the nearest `outDir` along that chain (a child's overrides its parent's). The
 * chain stops at the first `extends` that leaves the package; that file must belong to a config
 * package the target captures, which `deriveTarget` checks. tsconfig files are read as plain
 * JSON: every one in this repository is, and a JSONC one is refused rather than misread.
 */
export function buildConfig(tree: PinTree, pkg: WorkspacePackage): BuildConfig {
  const tsconfig = buildScriptTsconfig(pkg)
  if (tsconfig === undefined) throw new Error(`${pkg.name} (${pkg.dir}) has no build script`)
  const files: string[] = []
  const externalExtends: string[] = []
  let outDir: string | undefined
  let buildInfo: string | undefined
  let current = posix.normalize(`${pkg.dir}/${tsconfig}`)
  for (let depth = 0; ; depth++) {
    if (depth === MAX_EXTENDS)
      throw new Error(`${pkg.name}: ${files[0]} extends more than ${MAX_EXTENDS} deep`)
    const text = tree.read(current)
    if (text === undefined) throw new Error(`${pkg.name}: ${current} does not exist at ${tree.pin}`)
    let parsed: {
      extends?: unknown
      compilerOptions?: { outDir?: unknown; tsBuildInfoFile?: unknown }
    }
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch (error) {
      throw new Error(
        `${current} is not plain JSON (target:init reads tsconfig files with JSON.parse): ${String(error)}`,
      )
    }
    files.push(current)
    const own = parsed.compilerOptions?.outDir
    if (outDir === undefined && typeof own === "string")
      outDir = posix.normalize(posix.join(posix.dirname(current), own))
    const info = parsed.compilerOptions?.tsBuildInfoFile
    if (buildInfo === undefined && typeof info === "string")
      buildInfo = posix.normalize(posix.join(posix.dirname(current), info))
    const parent = parsed.extends
    if (parent === undefined) break
    if (typeof parent !== "string" || !parent.startsWith("."))
      throw new Error(
        `${current} extends ${JSON.stringify(parent)}: target:init follows only relative extends`,
      )
    const next = posix.normalize(posix.join(posix.dirname(current), parent))
    if (!next.startsWith(`${pkg.dir}/`)) {
      externalExtends.push(next)
      break
    }
    current = next
  }
  if (outDir === undefined)
    throw new Error(
      `${pkg.name}: ${files[0]} (and what it extends inside the package) sets no compilerOptions.outDir, so target:init cannot tell where its build writes`,
    )
  if (!outDir.startsWith(`${pkg.dir}/`))
    throw new Error(`${pkg.name}: its build writes ${outDir}, outside the package`)
  // snapshotIgnore holds directory prefixes: a build-info file outside the outDir would read,
  // after a builder's build, as a file the baseline lacks.
  if (buildInfo !== undefined && !buildInfo.startsWith(`${outDir}/`))
    throw new Error(
      `${pkg.name}: its build writes ${buildInfo}, outside its outDir ${outDir}, where snapshotIgnore cannot cover it`,
    )
  return { tsconfig, files, outDir: `${outDir}/`, externalExtends }
}

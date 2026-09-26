import { posix } from "node:path"
import type { TargetManifest } from "../catalog.js"
import { parseVitestCommand, vitestTestArgv, withExcludes } from "../vitest-command.js"
import type { DockerfileSpec } from "./dockerfile.js"
import type { EntryKind, PinTree } from "./pin-tree.js"
import { type BuildConfig, buildConfig, buildScriptTsconfig, packageTsconfigs } from "./tsconfig.js"
import {
  closure,
  INSTALL,
  isConfigPackage,
  PROD,
  topologicalOrder,
  type WorkspaceGraph,
  type WorkspacePackage,
  workspaceDependencies,
} from "./workspace-graph.js"

/** The base every shipped target pins (`targets-catalog.test.ts`): the drafter's, by digest. */
export const DEFAULT_BASE_IMAGE =
  "node:24-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6"

/** Generous until `target:measure` replaces them: a person reviews the numbers it proposes. */
export const PLACEHOLDER_RESOURCES: TargetManifest["resources"] = {
  memoryMb: 2048,
  cpus: 2,
  commandTimeoutMs: 600_000,
  verifierDeadlineMs: 3_600_000,
}

/** Are `resources` `init`'s placeholders, never measured? (Detected by value, not by origin.) */
export function isPlaceholderResources(resources: TargetManifest["resources"]): boolean {
  return (Object.keys(PLACEHOLDER_RESOURCES) as (keyof TargetManifest["resources"])[]).every(
    (key) => resources[key] === PLACEHOLDER_RESOURCES[key],
  )
}

/** What a re-generation keeps from the target already on disk (plan D8). */
export interface CarriedFields {
  readonly baseImage?: string
  readonly resources?: TargetManifest["resources"]
  readonly draftingNotes?: readonly string[]
  /** The test command's positional files: a scope a person chose. */
  readonly scope?: readonly string[]
  /** The test command's `--exclude` entries: what a measurement proposed. */
  readonly excludes?: readonly string[]
  readonly expectedPromoted?: readonly string[]
  /** Kept as supersets: a person's additions survive a re-generation (plan D8). */
  readonly imageAssertResolves?: readonly string[]
  readonly captureInclude?: readonly string[]
  readonly runnerConfig?: readonly string[]
}

export interface DeriveOptions {
  readonly id: string
  readonly carried: CarriedFields
  /** Build and capture the target's workspace devDependencies that have builds (plan D16). */
  readonly withDevBuilds?: boolean
}

export interface DerivedTarget {
  readonly manifest: TargetManifest
  readonly dockerfile: DockerfileSpec
  /** Facts the person reviewing the proposal should read, one line each. */
  readonly notes: readonly string[]
}

/** The files vitest looks for, in its order (`vitest/dist` `CONFIG_NAMES` x `CONFIG_EXTENSIONS`). */
const VITEST_CONFIGS = ["vitest.config", "vite.config"].flatMap((name) =>
  [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((extension) => `${name}${extension}`),
)

/**
 * `@b4run/workspace`'s portable source path (`packages/workspace/src/source-validation.ts`,
 * not exported): the capture refuses any other, so `init` refuses it first, by name.
 */
function portable(path: string): boolean {
  return (
    /^[A-Za-z0-9._ /-]+$/.test(path) &&
    path
      .split("/")
      .every(
        (s) =>
          s.length > 0 &&
          s.length <= 255 &&
          s !== "." &&
          s !== ".." &&
          !s.startsWith(" ") &&
          !/[ .]$/.test(s) &&
          !s.includes("  ") &&
          !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s),
      )
  )
}

const KIND_NAMES: Readonly<Record<EntryKind, string>> = {
  file: "file",
  dir: "directory",
  link: "link (a symlink)",
  submodule: "submodule",
}

const sortPaths = (paths: Iterable<string>): string[] =>
  [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
/** `paths` without any entry another entry already covers (a file inside a captured directory). */
const withoutCovered = (paths: readonly string[]): string[] =>
  paths.filter((path) => !paths.some((other) => other !== path && path.startsWith(`${other}/`)))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/** The config vitest loads run from `dir`: each directory up to the repository root, names in order. */
function findVitestConfig(tree: PinTree, dir: string): string | undefined {
  for (let at = dir; ; at = posix.dirname(at) === "." ? "" : posix.dirname(at)) {
    const found = VITEST_CONFIGS.map((name) => (at === "" ? name : `${at}/${name}`)).find(
      (path) => tree.kind(path) !== undefined,
    )
    if (found !== undefined || at === "") return found
  }
}

/**
 * The major version of the TypeScript `pnpm exec tsc` resolves from the package: its own
 * declaration first (a nested install), then the root's. An unreadable one is refused, since it
 * decides whether the build passes `--builders`.
 */
function typescriptMajor(graph: WorkspaceGraph, pkg: WorkspacePackage, pin: string): number {
  const declared = [
    [`${pkg.dir}/package.json`, pkg.manifest.devDependencies],
    [`${pkg.dir}/package.json`, pkg.manifest.dependencies],
    ["The root package.json", graph.root.devDependencies],
    ["The root package.json", graph.root.dependencies],
  ] as const
  const [where, deps] = declared.find(([, deps]) => deps?.typescript !== undefined) ?? []
  const spec = deps?.typescript
  if (spec === undefined)
    throw new Error(
      `${pkg.dir}/package.json and the root package.json at ${pin} name no typescript: target:init cannot tell which tsc builds several projects, and whether to pass --builders`,
    )
  const major = /^[\^~]?(\d+)\.(?:\d+|x|\*)/.exec(spec)?.[1]
  if (major === undefined)
    throw new Error(
      `${where} at ${pin} declares typescript ${JSON.stringify(spec)}: target:init cannot tell its major version, which decides --builders (TypeScript 7 builds projects in parallel)`,
    )
  return Number(major)
}

/**
 * Every relative path the vitest config's text names (`./x`, `../x`), resolved against the
 * config's directory, that the capture does not hold: one note each, a workspace package once.
 */
function runnerReads(
  tree: PinTree,
  graph: WorkspaceGraph,
  runner: string,
  holds: (path: string) => boolean,
  touches: (path: string) => boolean,
): string[] {
  const from = posix.dirname(runner) === "." ? "" : posix.dirname(runner)
  const reads = new Map<string, string>()
  for (const [, reference] of tree.read(runner)?.matchAll(/["'`](\.{1,2}\/[^"'`\s]*)["'`]/g) ??
    []) {
    const ref = reference as string
    if (ref.includes("${")) continue
    const resolved = posix.normalize(posix.join(from, ref)).replace(/\/+$/, "")
    if (resolved === "." || resolved === "..") continue
    if (resolved.startsWith("../")) {
      reads.set(
        ref,
        `${runner} reads ${ref}, outside the repository: a test that reaches it fails, and target:measure proposes excluding it`,
      )
      continue
    }
    if (holds(resolved)) continue
    // A workspace package the capture takes nothing of is named once, as the package.
    const sibling = [...graph.packages.values()].find(
      (p) => resolved === p.dir || resolved.startsWith(`${p.dir}/`),
    )
    if (sibling !== undefined && !touches(sibling.dir)) {
      const relative = `${posix.relative(from || ".", sibling.dir)}/`
      reads.set(
        relative,
        `${runner} reads ${relative} (${sibling.dir}), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it`,
      )
    } else
      reads.set(
        ref,
        `${runner} reads ${ref} (${resolved}), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it`,
      )
  }
  return [...reads].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, note]) => note)
}

export function deriveTarget(
  tree: PinTree,
  graph: WorkspaceGraph,
  pkg: WorkspacePackage,
  options: DeriveOptions,
): DerivedTarget {
  const { id, carried } = options
  const notes: string[] = []
  const manager = graph.root.packageManager ?? ""
  if (!/^pnpm@\d+\.\d+\.\d+$/.test(manager))
    throw new Error(
      `The root package.json at ${tree.pin} names packageManager ${JSON.stringify(manager)}: target:init generates pnpm targets only, and the image installs the pnpm@<x.y.z> it names`,
    )
  // A symlink here would be read by pnpm through the link; the image context copies the path.
  // Name what the pin holds rather than calling it absent.
  const rootFile = (file: string, required: boolean): boolean => {
    const kind = tree.kind(file)
    if (kind === "file") return true
    if (kind === undefined && !required) return false
    throw new Error(
      kind === undefined
        ? `${file} does not exist at ${tree.pin}`
        : `${file} at ${tree.pin} is a ${KIND_NAMES[kind]}, not a file: target:init copies root files the pin holds as regular files only`,
    )
  }
  for (const file of ["pnpm-workspace.yaml", "pnpm-lock.yaml"]) rootFile(file, true)
  const npmrc = rootFile(".npmrc", false)
  const rootManifests = ["package.json", "pnpm-workspace.yaml", ...(npmrc ? [".npmrc"] : [])]

  // The closures (plan D4, D16).
  const installed = closure(graph, pkg, INSTALL)
  const configs = installed.filter((p) => p !== pkg && isConfigPackage(p))
  const devBuilt = new Set<WorkspacePackage>()
  for (const dev of workspaceDependencies(graph, pkg, ["devDependencies"]))
    if (!isConfigPackage(dev))
      for (const p of closure(graph, dev, PROD)) if (!isConfigPackage(p)) devBuilt.add(p)
  const builtByName = new Map<string, WorkspacePackage>()
  for (const p of [...closure(graph, pkg, PROD), ...(options.withDevBuilds ? devBuilt : [])])
    if (!isConfigPackage(p)) builtByName.set(p.name, p)
  // Runtime edges order the build (a devDependency edge never orders a compile); the target
  // itself compiles last, from its own directory.
  const ordered = topologicalOrder(graph, [...builtByName.values()], PROD)
  const built = [...ordered.filter((p) => p !== pkg), ...ordered.filter((p) => p === pkg)]
  const captured = [...new Set([pkg, ...configs, ...built])].sort((a, b) =>
    a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0,
  )
  for (const p of captured)
    if (!/^packages\/[^/]+$/.test(p.dir))
      throw new Error(
        `${p.name} lives at ${p.dir}: target:init captures packages under packages/ only (the Dockerfile's CAPTURED list and target:prepare's check name them by that directory)`,
      )
  for (const p of installed)
    if (!captured.includes(p))
      notes.push(
        `${p.name} (${p.dir}) is installed, not captured: a test importing it resolves the image's manifest-only copy and fails, and target:measure proposes excluding that test${devBuilt.has(p) ? " (or pass --with-dev-builds)" : ""}`,
      )

  // The build (plan D5).
  const builds = new Map<WorkspacePackage, BuildConfig>(built.map((p) => [p, buildConfig(tree, p)]))
  // What `tsc -b` compiles for each reference: a directory's tsconfig.json, else the file named.
  const buildConfigs = new Set([...builds].map(([p, config]) => `${p.dir}/${config.tsconfig}`))
  for (const [p, config] of builds) {
    const top = `${p.dir}/${config.tsconfig}`
    // Every external file along the chain, wherever it sits in it: each must be captured.
    for (const file of config.externalExtends)
      if (!configs.some((c) => file.startsWith(`${c.dir}/`)))
        throw new Error(
          `${p.name}'s build (${top}) extends ${file}, which no captured config package holds`,
        )
    // `tsc -b` builds every referenced project too: one outside the closure (or another config
    // of a built package) reads files the capture omits and writes where snapshotIgnore does not
    // look.
    for (const reference of config.references) {
      const project = tree.kind(reference) === "dir" ? `${reference}/tsconfig.json` : reference
      if (!buildConfigs.has(project))
        throw new Error(
          `${top} references ${project}, which is not the build config of a package this target builds (${[...buildConfigs].sort().join(", ")}): tsc -b would build it too`,
        )
    }
    const script = (p.manifest.scripts?.build ?? "").trim()
    if (
      script !== `tsc -b ${buildScriptTsconfig(p)}` &&
      script !== `tsc --build ${buildScriptTsconfig(p)}`
    )
      notes.push(
        `${p.name}'s build script does more than compile (${script}): the target runs only its \`tsc -b ${config.tsconfig}\``,
      )
  }
  const projects = built.map((p) => {
    const config = builds.get(p) as BuildConfig
    if (p === pkg) return config.tsconfig
    const relative = posix.relative(pkg.dir, p.dir)
    return config.tsconfig === "tsconfig.json" ? relative : `${relative}/${config.tsconfig}`
  })
  const build =
    projects.length === 0
      ? []
      : [
          "pnpm",
          "exec",
          "tsc",
          "-b",
          ...(projects.length > 1 && typescriptMajor(graph, pkg, tree.pin) >= 7
            ? ["--builders", "1"]
            : []),
          ...projects,
        ]

  // The test command and the runner configuration it reads.
  const command = parseVitestCommand(vitestTestArgv(pkg))
  let runner: string | undefined
  if (command.config !== undefined) {
    runner = `${pkg.dir}/${command.config}`
    const kind = tree.kind(runner)
    if (kind !== "file")
      throw new Error(
        kind === undefined
          ? `${pkg.name}: its test script names --config ${command.config}, which does not exist at ${tree.pin}`
          : `${pkg.name}: its test script names --config ${command.config}, which at ${tree.pin} is a ${KIND_NAMES[kind]}, not a file`,
      )
  } else {
    // vitest looks in the package directory, then each parent, trying every name in its order
    // in one directory before the next: the first the pin holds is the config it loads. A link
    // there is refused rather than passed over for a later name vitest would never read.
    runner = findVitestConfig(tree, pkg.dir)
    const kind = runner === undefined ? undefined : tree.kind(runner)
    if (kind !== undefined && kind !== "file")
      throw new Error(
        `${runner} at ${tree.pin} is a ${KIND_NAMES[kind]}, not a file: vitest would load it as ${pkg.name}'s config, and target:init reads configs the pin holds as regular files only`,
      )
    if (runner !== undefined && !runner.startsWith(`${pkg.dir}/`)) {
      // A root file is captured like the root manifests; anywhere between the package and the
      // root it would read as a package directory to the Dockerfile's CAPTURED check.
      if (runner.includes("/"))
        throw new Error(
          `${runner} is the vitest config ${pkg.name}'s tests load, outside the package and not at the repository root: target:init captures a config there only at the root or inside the package`,
        )
      notes.push(
        `${runner} is the vitest config ${pkg.name}'s tests load (none in ${pkg.dir}; vitest looks up from there): captured and kept immutable`,
      )
    }
  }
  const present = (file: string) => tree.kind(`${pkg.dir}/${file}`) === "file"
  for (const file of [...(carried.scope ?? []), ...(carried.excludes ?? [])])
    if (!present(file))
      notes.push(`dropped ${file} from the test command: no such file under ${pkg.dir} at the pin`)
  const scope = (carried.scope ?? []).filter(present)
  // `withExcludes` refuses an exclude vitest would read as a glob: a carried one is dropped with
  // a note instead, like one the pin no longer holds.
  const excludes = (carried.excludes ?? []).filter(present).filter((file) => {
    try {
      withExcludes(command, [file])
      return true
    } catch {
      notes.push(
        `dropped ${file} from the test command: ${JSON.stringify(file)} is not a literal, package-relative path an exclude can name`,
      )
      return false
    }
  })
  const test = withExcludes({ ...command, files: scope }, excludes)

  // The capture. A carried scope keeps the carried capture of the test directory rather than
  // widening it to the whole directory the command does not run (plan D8).
  const scoped = scope.length > 0 && carried.captureInclude !== undefined
  // A `src` or `test` the pin holds as a link or submodule is refused, never passed over: the
  // capture would silently lack what the build or the suite reads.
  const dir = (path: string) => {
    const kind = tree.kind(path)
    if (kind === "link" || kind === "submodule")
      throw new Error(
        `${path} at ${tree.pin} is a ${KIND_NAMES[kind]}: target:init captures directories the pin holds as directories only`,
      )
    return kind === "dir" ? [path] : []
  }
  const own = [
    `${pkg.dir}/package.json`,
    ...packageTsconfigs(tree, pkg),
    ...(builds.get(pkg)?.files ?? []),
    ...(runner === undefined ? [] : [runner]),
    ...dir(`${pkg.dir}/src`),
    ...(scoped ? [] : dir(`${pkg.dir}/test`)),
  ]
  const dependencies = built
    .filter((p) => p !== pkg)
    .flatMap((p) => [
      `${p.dir}/package.json`,
      ...(builds.get(p) as BuildConfig).files,
      ...dir(`${p.dir}/src`),
    ])
  const carriedCapture = (carried.captureInclude ?? []).filter((path) => {
    if (rootManifests.includes(path)) return false
    const owner = captured.find((p) => path === p.dir || path.startsWith(`${p.dir}/`))
    const kind = tree.kind(path)
    if (kind === undefined) notes.push(`dropped ${path} from capture.include: not at the pin`)
    else if (kind === "link" || kind === "submodule")
      notes.push(
        `dropped ${path} from capture.include: at the pin it is a ${KIND_NAMES[kind]}, which the capture refuses`,
      )
    else if (owner === undefined && path.includes("/"))
      notes.push(
        `dropped ${path} from capture.include: it belongs to no package this target captures`,
      )
    else return true
    return false
  })
  const include = [
    ...rootManifests,
    ...withoutCovered(
      sortPaths([...own, ...dependencies, ...configs.map((c) => c.dir), ...carriedCapture]),
    ).filter((path) => !rootManifests.includes(path)),
  ]
  const files = include.flatMap((path) => tree.files(path))
  const refused = files.filter(
    (f) => !portable(f.path) || f.mode === "120000" || f.mode === "160000",
  )
  if (refused.length > 0)
    throw new Error(
      `target:init cannot capture ${refused.length} path(s) the workspace capture refuses (portable ASCII names only; no symlinks or submodules): ${refused
        .slice(0, 10)
        .map((f) => f.path)
        .join(", ")}${refused.length > 10 ? ", ..." : ""}`,
    )
  notes.push(`capture: ${files.length} files, ${files.reduce((sum, f) => sum + f.bytes, 0)} bytes`)

  // What the capture leaves out, so an omission is visible before a test trips on it (I5).
  const touches = (path: string) =>
    include.some((e) => e === path || e.startsWith(`${path}/`) || path.startsWith(`${e}/`))
  const holds = (path: string) => include.some((e) => e === path || path.startsWith(`${e}/`))
  for (const file of scope)
    if (!holds(`${pkg.dir}/${file}`))
      notes.push(
        `${file} is in the test command, but the capture does not hold ${pkg.dir}/${file}: the suite cannot run it`,
      )
  for (const p of captured.filter((c) => !configs.includes(c))) {
    const omitted = tree
      .children(p.dir)
      .filter((entry) => entry.kind === "dir" && !touches(`${p.dir}/${entry.name}`))
      .map(
        (entry) =>
          `${entry.name}/ (${plural(tree.files(`${p.dir}/${entry.name}`).length, "file")})`,
      )
    if (omitted.length > 0) notes.push(`${p.dir}: not captured: ${omitted.join(", ")}`)
  }
  // The target package's own top-level files: a setup file, an env file or a shared config a
  // test or the vitest config reads is otherwise invisible.
  const looseFiles = tree
    .children(pkg.dir)
    .filter((entry) => entry.kind !== "dir" && !touches(`${pkg.dir}/${entry.name}`))
    .map((entry) => entry.name)
  if (looseFiles.length > 0) notes.push(`${pkg.dir}: files not captured: ${looseFiles.join(", ")}`)
  if (runner !== undefined) notes.push(...runnerReads(tree, graph, runner, holds, touches))

  const typesNode = [
    graph.root.devDependencies,
    graph.root.dependencies,
    pkg.manifest.devDependencies,
    pkg.manifest.dependencies,
  ].some((deps) => deps?.["@types/node"] !== undefined)
  const derivedAsserts = [
    "vitest",
    ...(build.length > 0 ? ["typescript"] : []),
    ...(typesNode ? ["@types/node/package.json"] : []),
  ]
  const resources = { ...(carried.resources ?? PLACEHOLDER_RESOURCES) }
  if (isPlaceholderResources(resources))
    notes.push("resources are placeholders until target:measure proposes them")
  if (parseVitestCommand(test).excludes.length === 0)
    notes.push(
      "no test is excluded: target:measure runs each file alone and proposes the excludes (none, if every file passes)",
    )
  const carriedRunner = (carried.runnerConfig ?? []).filter((path) => {
    const kind = tree.kind(path)
    if (kind === "file" || kind === "dir") return true
    notes.push(
      kind === undefined
        ? `dropped ${path} from runnerConfig: not at the pin`
        : `dropped ${path} from runnerConfig: at the pin it is a ${KIND_NAMES[kind]}, which the capture refuses`,
    )
    return false
  })
  const runnerConfig = [
    ...rootManifests,
    ...sortPaths([
      `${pkg.dir}/package.json`,
      ...packageTsconfigs(tree, pkg),
      ...(runner === undefined ? [] : [runner]),
      ...configs.map((c) => c.dir),
      ...carriedRunner,
    ]).filter((path) => !rootManifests.includes(path)),
  ]

  const snapshotIgnore = sortPaths([...builds.values()].map((config) => config.outDir))
  for (const [field, entries] of [
    ["capture.include", include],
    ["runnerConfig", runnerConfig],
  ] as const)
    for (const entry of entries)
      for (const prefix of snapshotIgnore)
        if (`${entry}/`.startsWith(prefix) || prefix.startsWith(`${entry}/`))
          throw new Error(
            `The ${field} entry ${entry} overlaps snapshotIgnore ${prefix}: the snapshot passes over the build's output, so an edit to a captured or immutable file there would go unseen`,
          )

  const manifest: TargetManifest = {
    id,
    pin: tree.pin,
    root: ".",
    capture: { include },
    snapshotIgnore,
    baseImage: carried.baseImage ?? DEFAULT_BASE_IMAGE,
    imageContext: [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      ...(npmrc ? [".npmrc"] : []),
      ...sortPaths([
        ...configs.map((c) => c.dir),
        ...installed.filter((p) => !configs.includes(p)).map((p) => `${p.dir}/package.json`),
      ]),
    ],
    lockfile: "pnpm-lock.yaml",
    imageAssertResolves: [...new Set([...derivedAsserts, ...(carried.imageAssertResolves ?? [])])],
    environmentLinks: [{ path: "node_modules", target: `/opt/targets/${id}/node_modules` }],
    commands: { cwd: pkg.dir, build, test, nodeTestExecArgv: [] },
    runnerConfig,
    ...(carried.draftingNotes !== undefined && carried.draftingNotes.length > 0
      ? { draftingNotes: [...carried.draftingNotes] }
      : {}),
    resources,
  }
  return {
    manifest,
    dockerfile: {
      id,
      filter: pkg.name,
      captured: captured.map((p) => ({ dir: p.dir.slice("packages/".length), name: p.name })),
      expectedPromoted: [...(carried.expectedPromoted ?? [])],
      npmrc,
    },
    notes,
  }
}

import { z } from "zod"
import type { PinTree } from "./pin-tree.js"

const Dependencies = z.record(z.string(), z.string()).optional()

/** A workspace package's `package.json`, as far as `init` reads it. */
const PackageManifestSchema = z.looseObject({
  name: z.string().min(1).optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: Dependencies,
  devDependencies: Dependencies,
  optionalDependencies: Dependencies,
})
export type PackageManifest = z.infer<typeof PackageManifestSchema>

const RootManifestSchema = z.looseObject({
  packageManager: z.string().optional(),
  dependencies: Dependencies,
  devDependencies: Dependencies,
})
export type RootManifest = z.infer<typeof RootManifestSchema>

export interface WorkspacePackage {
  readonly name: string
  /** Repository-relative: `packages/devkit`. */
  readonly dir: string
  readonly manifest: PackageManifest
}

export interface WorkspaceGraph {
  readonly root: RootManifest
  /** By package name. */
  readonly packages: ReadonlyMap<string, WorkspacePackage>
}

export type DependencyKind = "dependencies" | "devDependencies" | "optionalDependencies"
/** What a package's build compiles against: its runtime dependencies. */
export const PROD: readonly DependencyKind[] = ["dependencies"]
/** What `pnpm install --filter <pkg>...` installs: every kind, transitively (`--filter-prod` is the other). */
export const INSTALL: readonly DependencyKind[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
]

const byDir = (a: WorkspacePackage, b: WorkspacePackage) =>
  a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
const under = (dir: string, name: string) => (dir === "" ? name : `${dir}/${name}`)

/**
 * The `packages:` globs of a `pnpm-workspace.yaml`. Deliberately not a YAML parser (the example
 * carries none, and adding a dependency to an example re-keys the lockfile): the block form,
 * `packages:` then `  - <glob>` lines, quoted or not, is what pnpm documents and what this
 * repository writes. Anything else under `packages:` is refused by line, never guessed.
 */
export function workspaceGlobs(yaml: string): string[] {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line))
  if (start === -1) throw new Error("pnpm-workspace.yaml has no block `packages:` list")
  const globs: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    if (!/^\s/.test(line)) break
    const match = /^\s+-\s+(?:"([^"]+)"|'([^']+)'|([^\s#"':]+))\s*(?:#.*)?$/.exec(line)
    if (!match)
      throw new Error(
        `pnpm-workspace.yaml: unsupported line under packages: ${JSON.stringify(line)}`,
      )
    globs.push((match[1] ?? match[2] ?? match[3]) as string)
  }
  if (globs.length === 0) throw new Error("pnpm-workspace.yaml lists no packages")
  return globs
}

/**
 * The package directories `glob` names at the pin. Literal segments and whole-segment `*` only:
 * the patterns this repository's workspace file uses. A negation, `**`, a partial wildcard or a
 * brace is refused, because expanding it wrongly would silently add or drop a package.
 */
export function expandGlob(tree: PinTree, glob: string): string[] {
  const clean = glob.replace(/\/+$/, "")
  const segments = clean.split("/")
  if (
    clean.startsWith("!") ||
    clean.startsWith("/") ||
    /[?[\]{}]/.test(clean) ||
    segments.some((s) => s === "" || s === "." || s === ".." || (s.includes("*") && s !== "*"))
  )
    throw new Error(
      `pnpm-workspace.yaml glob ${JSON.stringify(glob)}: target:init reads literal segments and whole-segment * only`,
    )
  let found = [""]
  for (const segment of segments)
    found = found.flatMap((dir) =>
      segment === "*"
        ? tree
            .children(dir)
            .filter((entry) => entry.kind === "dir")
            .map((entry) => under(dir, entry.name))
        : tree.kind(under(dir, segment)) === "dir"
          ? [under(dir, segment)]
          : [],
    )
  return found.filter((dir) => tree.kind(`${dir}/package.json`) === "file")
}

function parseManifest<T>(schema: z.ZodType<T>, tree: PinTree, path: string): T {
  const text = tree.read(path)
  if (text === undefined) throw new Error(`${path} does not exist at ${tree.pin}`)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path} at ${tree.pin} is not JSON: ${String(error)}`)
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) throw new Error(`${path} at ${tree.pin}: ${parsed.error.message}`)
  return parsed.data
}

/** The root manifest and every named workspace package at the pin. */
export function readWorkspace(tree: PinTree): WorkspaceGraph {
  const root = parseManifest(RootManifestSchema, tree, "package.json")
  const yaml = tree.read("pnpm-workspace.yaml")
  if (yaml === undefined)
    throw new Error(
      `pnpm-workspace.yaml does not exist at ${tree.pin}: target:init generates targets for pnpm workspaces`,
    )
  const packages = new Map<string, WorkspacePackage>()
  const found = [...new Set(workspaceGlobs(yaml).flatMap((glob) => expandGlob(tree, glob)))].sort()
  for (const dir of found) {
    const manifest = parseManifest(PackageManifestSchema, tree, `${dir}/package.json`)
    // An unnamed package (an orchestration-only manifest) cannot be depended on by name.
    if (manifest.name === undefined) continue
    const other = packages.get(manifest.name)
    if (other)
      throw new Error(`Two workspace packages are named ${manifest.name}: ${other.dir} and ${dir}`)
    packages.set(manifest.name, { name: manifest.name, dir, manifest })
  }
  return { root, packages }
}

/** The package `ref` names: a package name, or its directory (`packages/devkit`, `./packages/devkit/`). */
export function resolvePackage(graph: WorkspaceGraph, ref: string): WorkspacePackage {
  const named = graph.packages.get(ref)
  if (named) return named
  const dir = ref.replace(/^\.\//, "").replace(/\/+$/, "")
  for (const pkg of graph.packages.values()) if (pkg.dir === dir) return pkg
  throw new Error(`No workspace package is named or lives at ${JSON.stringify(ref)}`)
}

/** `pkg`'s `workspace:` dependencies of `kinds`, sorted by directory. */
export function workspaceDependencies(
  graph: WorkspaceGraph,
  pkg: WorkspacePackage,
  kinds: readonly DependencyKind[],
): WorkspacePackage[] {
  const found = new Map<string, WorkspacePackage>()
  for (const kind of kinds)
    for (const [name, spec] of Object.entries(pkg.manifest[kind] ?? {})) {
      if (!spec.startsWith("workspace:")) continue
      const dep = graph.packages.get(name)
      if (!dep)
        throw new Error(
          `${pkg.name} (${pkg.dir}) depends on ${name} as ${spec}, which no workspace package is named`,
        )
      found.set(name, dep)
    }
  return [...found.values()].sort(byDir)
}

/** `from` and every workspace package it reaches through `kinds`, transitively, by directory. */
export function closure(
  graph: WorkspaceGraph,
  from: WorkspacePackage,
  kinds: readonly DependencyKind[],
): WorkspacePackage[] {
  const seen = new Map([[from.name, from]])
  const queue = [from]
  for (let next = queue.pop(); next !== undefined; next = queue.pop())
    for (const dep of workspaceDependencies(graph, next, kinds))
      if (!seen.has(dep.name)) {
        seen.set(dep.name, dep)
        queue.push(dep)
      }
  return [...seen.values()].sort(byDir)
}

/**
 * A package with nothing to build: `@b4run/config-typescript`, which tsconfig files read by a
 * relative `extends`. Captured and put into the image whole, never compiled.
 */
export function isConfigPackage(pkg: WorkspacePackage): boolean {
  return pkg.manifest.scripts?.build === undefined
}

/**
 * `packages` with every package after the ones it depends on through `kinds` (among
 * `packages`), ties broken by directory, so the order is a function of the manifests alone.
 * A build orders by runtime edges (`PROD`): a devDependency never orders a compile.
 */
export function topologicalOrder(
  graph: WorkspaceGraph,
  packages: readonly WorkspacePackage[],
  kinds: readonly DependencyKind[],
): WorkspacePackage[] {
  const members = new Set(packages.map((p) => p.name))
  const edges = new Map(
    packages.map((p) => [
      p.name,
      workspaceDependencies(graph, p, kinds)
        .map((d) => d.name)
        .filter((name) => members.has(name)),
    ]),
  )
  const done = new Set<string>()
  const order: WorkspacePackage[] = []
  while (order.length < packages.length) {
    const next = packages
      .filter((p) => !done.has(p.name) && (edges.get(p.name) ?? []).every((d) => done.has(d)))
      .sort(byDir)[0]
    if (next === undefined)
      throw new Error(
        `Workspace dependency cycle: none of ${packages
          .filter((p) => !done.has(p.name))
          .map((p) => p.name)
          .sort()
          .join(", ")} can be built first`,
      )
    done.add(next.name)
    order.push(next)
  }
  return order
}

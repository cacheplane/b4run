import { join } from "node:path"
import { parseArgs } from "node:util"
import {
  commitSha,
  covers,
  ensurePin,
  isCatalogId,
  type TargetManifest,
  TargetSchema,
} from "../catalog.js"
import { capturedListMismatch, firstMissingPath, pathsRequiredAtPin } from "../prepare.js"
import { type FileProposal, formatManifest, readIfPresent } from "../proposal.js"
import { parseVitestCommand } from "../vitest-command.js"
import { type CarriedFields, deriveTarget } from "./derive.js"
import { expectedPromotedOf, renderDockerfile } from "./dockerfile.js"
import { gitPinTree, type PinTree } from "./pin-tree.js"
import { readWorkspace, resolvePackage, type WorkspacePackage } from "./workspace-graph.js"

export interface InitOptions {
  /** A package name (`@b4run/devkit`) or its directory (`packages/devkit`). */
  readonly packageRef: string
  /** The target id; the package directory's name when absent. */
  readonly id?: string
  readonly pin: string
  readonly repositoryRoot: string
  readonly targetsDir: string
  /** Build and capture the package's workspace devDependencies that have builds (plan D16). */
  readonly withDevBuilds?: boolean
}

export interface InitResult {
  readonly id: string
  readonly directory: string
  /** `target.json`, then the `Dockerfile`. */
  readonly files: readonly FileProposal[]
  readonly notes: readonly string[]
}

/**
 * The target a package at a pin would have: `targets/<id>/target.json` and its `Dockerfile`,
 * as proposals against what is on disk. Deterministic: the manifests at the pin and what the
 * existing target carries (plan D8) decide every byte. The pin is made present first (fetched
 * by sha on a miss, as every catalog read does), so a shallow checkout can generate. The
 * proposal is refused, before anything is written, for anything `target:prepare` would refuse
 * before a build.
 */
export function initTarget(options: InitOptions): InitResult {
  ensurePin(options.repositoryRoot, "target:init", options.pin, {
    label: `target:init ${options.packageRef}`,
  })
  const tree = gitPinTree(options.repositoryRoot, options.pin)
  const graph = readWorkspace(tree)
  const pkg = resolvePackage(graph, options.packageRef)
  const id = options.id ?? pkg.dir.slice(pkg.dir.lastIndexOf("/") + 1)
  if (!isCatalogId(id))
    throw new Error(`${JSON.stringify(id)} is not a target id: it must be a plain directory name`)
  const directory = join(options.targetsDir, id)
  const manifestPath = join(directory, "target.json")
  const dockerfilePath = join(directory, "Dockerfile")
  const beforeManifest = readIfPresent(manifestPath)
  const beforeDockerfile = readIfPresent(dockerfilePath)
  const carried = carriedFrom(beforeManifest, beforeDockerfile, pkg, id)
  const derived = deriveTarget(tree, graph, pkg, {
    id,
    carried: carried.fields,
    ...(options.withDevBuilds ? { withDevBuilds: true } : {}),
  })
  const manifest: TargetManifest = TargetSchema.parse(derived.manifest)
  const dockerfile = renderDockerfile(derived.dockerfile)
  const problem = proposalProblem(manifest, dockerfile, tree)
  if (problem !== undefined) throw new Error(problem)
  return {
    id,
    directory,
    notes: [...carried.notes, ...derived.notes],
    files: [
      {
        path: manifestPath,
        before: beforeManifest,
        after: formatManifest(`${JSON.stringify(manifest, null, 2)}\n`),
      },
      { path: dockerfilePath, before: beforeDockerfile, after: dockerfile },
    ],
  }
}

/** What `recipeProblem` (`targets/prepare.ts`) would refuse, asked of the proposal itself. */
function proposalProblem(
  manifest: TargetManifest,
  dockerfile: string,
  tree: PinTree,
): string | undefined {
  const missing = firstMissingPath(
    pathsRequiredAtPin(manifest),
    (path) => tree.kind(path) !== undefined,
  )
  if (missing !== undefined)
    return `The proposal names ${missing}, which does not exist at ${tree.pin}`
  const captured = capturedListMismatch(manifest, dockerfile)
  if (captured !== undefined) return captured
  if (!covers(manifest.imageContext, manifest.lockfile))
    return `The proposal's imageContext does not cover its lockfile ${manifest.lockfile}`
  return undefined
}

/**
 * What the target already on disk decided and a re-generation keeps (plan D8). A target of
 * another package at this id is refused; one that does not parse carries nothing, and says so.
 * `deriveTarget` drops what names nothing at the pin, with a note each.
 */
function carriedFrom(
  manifestText: string | null,
  dockerfileText: string | null,
  pkg: WorkspacePackage,
  id: string,
): { readonly fields: CarriedFields; readonly notes: string[] } {
  const notes: string[] = []
  const promoted = dockerfileText === null ? undefined : expectedPromotedOf(dockerfileText)
  const fromDockerfile: CarriedFields = promoted === undefined ? {} : { expectedPromoted: promoted }
  if (manifestText === null) return { fields: fromDockerfile, notes }
  let raw: unknown
  try {
    raw = JSON.parse(manifestText)
  } catch {
    notes.push(`targets/${id}/target.json is not JSON; nothing is carried from it`)
    return { fields: fromDockerfile, notes }
  }
  const parsed = TargetSchema.safeParse(raw)
  if (!parsed.success) {
    notes.push(`targets/${id}/target.json does not parse; nothing is carried from it`)
    return { fields: fromDockerfile, notes }
  }
  const existing = parsed.data
  if (existing.commands.cwd !== pkg.dir)
    throw new Error(
      `targets/${id} is the target of ${existing.commands.cwd}, not ${pkg.dir}: pass --id to name another`,
    )
  let scope: readonly string[] = []
  let excludes: readonly string[] = []
  try {
    const command = parseVitestCommand(existing.commands.test)
    scope = command.files
    excludes = command.excludes
  } catch (error) {
    notes.push(
      `the existing test command is not read (${(error as Error).message}); its scope and excludes are not carried`,
    )
  }
  notes.push(
    `carried from targets/${id}: baseImage, resources${existing.draftingNotes ? ", draftingNotes" : ""}, ${scope.length} scoped file(s), ${excludes.length} exclude(s), imageAssertResolves, capture.include and runnerConfig as supersets${promoted === undefined ? "" : ", EXPECTED_PROMOTED"}`,
  )
  return {
    notes,
    fields: {
      ...fromDockerfile,
      baseImage: existing.baseImage,
      resources: existing.resources,
      ...(existing.draftingNotes !== undefined ? { draftingNotes: existing.draftingNotes } : {}),
      scope,
      excludes,
      imageAssertResolves: existing.imageAssertResolves,
      captureInclude: existing.capture.include,
      runnerConfig: existing.runnerConfig,
    },
  }
}

export interface InitArgs {
  readonly packageRef: string
  readonly id?: string
  readonly pin?: string
  /** The target catalog to propose into; the controller's `targets/` when absent. */
  readonly targetsDir?: string
  readonly withDevBuilds: boolean
  readonly write: boolean
}

export function parseInitArgs(argv: readonly string[]): InitArgs {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      pin: { type: "string" },
      id: { type: "string" },
      "targets-dir": { type: "string" },
      "with-dev-builds": { type: "boolean", default: false },
      write: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  })
  const [packageRef, ...extra] = positionals
  if (!packageRef || extra.length > 0)
    throw new Error(
      "usage: target-init.ts <package name or directory> [--pin <sha>] [--id <id>] [--targets-dir <dir>] [--with-dev-builds] [--write]",
    )
  if (values.pin !== undefined && !commitSha.safeParse(values.pin).success)
    throw new Error(`--pin must be a full lowercase commit sha, got ${JSON.stringify(values.pin)}`)
  return {
    packageRef,
    withDevBuilds: values["with-dev-builds"],
    write: values.write,
    ...(values.pin !== undefined ? { pin: values.pin } : {}),
    ...(values.id !== undefined ? { id: values.id } : {}),
    ...(values["targets-dir"] !== undefined ? { targetsDir: values["targets-dir"] } : {}),
  }
}

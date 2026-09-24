import { randomUUID } from "node:crypto"
import { rmSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"
import { writeFileAtomic } from "./storage/atomic-file.js"
import { captureDirectory } from "./targets/archive.js"
import { imageTag, isCatalogId, type Target, type Task } from "./targets/catalog.js"
import { builderPermissions } from "./targets/permissions.js"
import { builderSandboxScope, targetSandboxPolicy, targetWorkspace } from "./targets/workspace.js"

/**
 * A work order's id and a target's id are catalog ids: a plain directory name, no slash, no
 * leading dot, nothing a path could smuggle. Spelled out here rather than imported from
 * `catalog.ts` because the schemas below refer to it by name and their text is kept identical
 * to the builder's copy; the test that pins the schema text pins this regex's source too.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Everything the builder app's `b4.config.ts` needs, as data, in two files. The builder
 * imports no controller code: it verifies these files and serves them. The workspace is
 * captured HERE, so the builder never sees the target archive or the task catalog, only the
 * bytes the controller decided it should start from.
 *
 * The TARGET file is per builder process (the framework's provider, sandbox policy and
 * permissions are one per app), written once by `factory builder-target`. The MANIFEST is per
 * work order, written by `dispatch` into the target worker's manifest directory before it
 * creates the thread. Deliberately a SECOND copy of the builder's schemas
 * (`server/src/builder-manifest.ts`) rather than an import, kept identical by test
 * (`test/builder-manifest.test.ts`).
 */
export const BuilderTargetSchema = z
  .object({
    version: z.literal(1),
    target: z
      .object({
        id: z.string().regex(CATALOG_ID),
        /** The two options `dockerSandbox` receives, and the whole of the provider's identity. */
        scope: z.string().min(1),
        image: z.string().min(1),
        /** The commit that image was prepared at; the controller compares each task's pin with it. */
        pin: z.string().regex(/^[a-f0-9]{40}$/),
        /**
         * The sandbox policy, modelled key by key and `.strict()` throughout rather than as an
         * opaque record. A misspelled `netwrok` or `modee` would otherwise parse, drop out of
         * the spread into `b4.config.ts`, and leave the builder running under the provider's
         * DEFAULT network instead of the denial the controller intended: a fail-open on a
         * typo. Strict parsing makes that a startup error instead.
         *
         * `network` is a discriminated union of the one key the controller emits, so a policy
         * carrying an `allowlist` or a `denylist` is refused rather than quietly honoured:
         * widening what the builder may be told costs an edit to both copies of this schema.
         * The framework's own `SandboxPolicy` is wider on purpose; this is the subset one
         * untrusted builder is allowed to be configured with.
         */
        policy: z
          .object({
            network: z.discriminatedUnion("mode", [
              z.object({ mode: z.literal("deny") }).strict(),
              z.object({ mode: z.literal("allow") }).strict(),
            ]),
            env: z.record(z.string(), z.string()),
            resources: z
              .object({
                memoryMb: z.number().int().positive(),
                cpus: z.number().positive(),
                timeoutMs: z.number().int().positive(),
              })
              .strict(),
          })
          .strict(),
        /** Keyed by tool name, so the key set is open; the values are always patterns. */
        permissions: z.record(z.string(), z.array(z.string())),
      })
      .strict(),
  })
  .strict()
export type BuilderTarget = z.infer<typeof BuilderTargetSchema>

/**
 * One work order's workspace: the target's pinned subtree with the task's defect applied,
 * captured by the controller. No prompt: the task's prompt is the run's user message, which
 * the controller sends with the run. `targetId` is what lets a builder refuse a work order
 * routed to the wrong process; `workspace` is left to `verifyCapturedWorkspaceDefinition`,
 * which checks it byte for byte against its own digest.
 */
export const BuilderManifestSchema = z
  .object({
    version: z.literal(1),
    workOrderId: z.string().regex(CATALOG_ID),
    taskId: z.string().regex(CATALOG_ID),
    targetId: z.string().regex(CATALOG_ID),
    /**
     * Not modelled key by key, unlike the drafter's: a builder workspace carries
     * `baseline: "git"` and environment links (the drafter's has neither), and the
     * framework's `verifyCapturedWorkspaceDefinition` already parses the whole definition
     * with a strict shape (unknown keys refused) and checks every byte against the digest.
     * A second model here could only drift from that one.
     */
    workspace: z.unknown(),
  })
  .strict()
export type BuilderManifest = z.infer<typeof BuilderManifestSchema>

/** Where the target file for `targetId` lives under `dir`. */
function builderTargetPath(dir: string, targetId: string): string {
  return join(dir, `${targetId}.target.json`)
}

/** Where the manifest for `workOrderId` lives under `dir`: the name the builder's resolver reads. */
function builderManifestPath(dir: string, workOrderId: string): string {
  if (!CATALOG_ID.test(workOrderId))
    throw new Error(`builder manifest workOrderId must be a catalog id, got ${workOrderId}`)
  return join(dir, `${workOrderId}.json`)
}

/**
 * Write `<dir>/<targetId>.target.json` and return its path: the one file a builder process
 * serving `target` boots from (`FACTORY_BUILDER_TARGET`). The file records the pin `target`
 * was loaded at, whose image the builder runs: one builder serves one pin at a time.
 */
export async function writeBuilderTarget(target: Target, dir: string): Promise<string> {
  // Parsed, not merely typed: the controller validates what it writes against the SAME schema
  // the builder will apply to it, so a file the builder would refuse cannot be produced here
  // in the first place. It is also what narrows the framework's wider `SandboxPolicy` to the
  // subset a builder may be configured with — a policy that grew a key this schema does not
  // model fails here, loudly, instead of being dropped there, silently.
  const file: BuilderTarget = BuilderTargetSchema.parse({
    version: 1,
    target: {
      id: target.id,
      scope: builderSandboxScope,
      image: imageTag(target),
      pin: target.pin,
      policy: targetSandboxPolicy(target),
      permissions: builderPermissions(target),
    },
  })
  await mkdir(dir, { recursive: true })
  const path = builderTargetPath(dir, target.id)
  await writeFileAtomic(path, `${JSON.stringify(file, null, 2)}\n`)
  return path
}

interface WriteBuilderManifestOptions {
  /** The file name and the id the builder's resolver is asked for; the task's id by default. */
  readonly workOrderId?: string
  /**
   * The capture root the staging directory lives under: the controller's `FACTORY_STATE_DIR`,
   * never its app root, which `b4 dev` watches (see `CaptureTargetOptions.captureRoot`).
   */
  readonly captureRoot: string
  readonly signal?: AbortSignal
}

export interface WrittenBuilderManifest {
  readonly path: string
  /** The captured source's digest: what the builder thread's workspace intent will carry. */
  readonly sourceDigest: string
}

/**
 * Capture `task`'s workspace (the target's pinned subtree with the task's defect applied) and
 * write `<dir>/<workOrderId>.json`. The staging directory is per call
 * (`captureDirectory(taskId, "builder", instance)`) and removed once the capture has read the
 * bytes into the definition, on failure too: two work orders of one task dispatched at once
 * must never share (and so tamper with each other's) archive directory.
 *
 * Written compact: it is machine-read only, and lives until the builder thread's first run
 * admits it (`dispatch` removes it once the row leaves the build states).
 */
export async function writeBuilderManifest(
  task: Task,
  dir: string,
  options: WriteBuilderManifestOptions,
): Promise<WrittenBuilderManifest> {
  const workOrderId = options.workOrderId ?? task.id
  if (!isCatalogId(workOrderId))
    throw new Error(`builder manifest workOrderId must be a catalog id, got ${workOrderId}`)
  options.signal?.throwIfAborted()
  const { captureRoot } = options
  const instance = randomUUID()
  let workspace: Awaited<ReturnType<typeof captureWorkspaceDefinition>>
  try {
    const definition = targetWorkspace(task, "builder", { instance, captureRoot })
    workspace = await captureWorkspaceDefinition(captureRoot, definition, {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
  } finally {
    rmSync(join(captureRoot, captureDirectory(task.id, "builder", instance)), {
      recursive: true,
      force: true,
    })
  }
  const manifest: BuilderManifest = BuilderManifestSchema.parse({
    version: 1,
    workOrderId,
    taskId: task.id,
    targetId: task.target.id,
    workspace,
  })
  await mkdir(dir, { recursive: true })
  const path = builderManifestPath(dir, workOrderId)
  await writeFileAtomic(path, `${JSON.stringify(manifest)}\n`)
  return { path, sourceDigest: workspace.source.digest }
}

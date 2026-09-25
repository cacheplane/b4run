import { execFile } from "node:child_process"
import type { CapturedWorkspaceDefinition } from "@b4run/workspace"
import { verifyCapturedWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"

/**
 * A work order's id and a target's id are catalog ids: a plain name, no slash, no leading dot.
 * Copied from the controller's `isCatalogId` rather than imported: the builder is the
 * untrusted side and shares no source with the code that judges what it leaves behind.
 */
const CATALOG_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The recipe tag's shape: `b4-factory-<target>:<pin[:12]>-<key[:12]>`, with the target, the pin
 * prefix and the key prefix captured. A handoff carries its bound image's tag beside the id, as
 * its name; the handoff schema requires the captured target and pin prefix to be the handoff's
 * own `targetId` and `pin`. Nothing runs the tag: a tag can move, so the builder runs the id.
 */
const FACTORY_IMAGE = /^b4-factory-([A-Za-z0-9][A-Za-z0-9._-]*):([0-9a-f]{12})-([0-9a-f]{12})$/

/**
 * An image by its id, `sha256:<64 hex>`: what a handoff names and the builder's provider runs.
 * The framework records `docker image inspect <id>`'s `.Id` as the thread's environment
 * identity, which for an id is the id itself, so the builder runs exactly the image the
 * controller bound, whatever any tag names by then.
 */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/

/**
 * The builder's one input per thread besides its staged workspace, carried in thread metadata
 * under `factoryBuilder`. Deliberately a SECOND copy of the controller's schema rather than an
 * import: the two packages share no source, and the controller's own
 * `builder-handoff.test.ts` asserts the two schema texts are identical.
 *
 * The HANDOFF is per work order: the controller uploads the work order's captured workspace
 * (`PUT /workspace/sources/<digest>`), then creates the thread naming that source, with this
 * handoff in its metadata. The builder's `sandbox.thread` resolver hands the staged workspace,
 * image, policy and permissions to the framework, which records them at the thread's first
 * admission. One builder process serves every target at every pin.
 */
/**
 * One work order's builder thread, whole: the reference its workspace is staged under (the
 * target's pinned subtree with the task's defect applied, captured by the controller), and
 * what the retired per-process target file carried: the image the task is verified in, the pin
 * it was prepared at, the sandbox policy and the permission allow-list. No prompt: the task's
 * prompt is the run's user message, which the controller sends with the run.
 *
 * Strict throughout, and narrower than the framework: a key this schema does not model is a
 * refusal at admission, never a silent drop to a broader default (a misspelled `netwrok` would
 * otherwise leave the thread under the app's network rather than the one the controller
 * wrote). The network is `deny` only (the builder app denies it too, and a thread may not open
 * what its app denies), with no `allowlist` or `denylist`; the image is named by its id, never
 * a tag, and the tag beside it must name the handoff's own target and pin; a pattern that is
 * empty or only whitespace, which names nothing, is refused.
 */
export const BuilderHandoffSchema = z
  .object({
    version: z.literal(4),
    workOrderId: z.string().regex(CATALOG_ID),
    taskId: z.string().regex(CATALOG_ID),
    targetId: z.string().regex(CATALOG_ID),
    target: z
      .object({
        /** The bound image, by id: the one the controller prepared and verifies in. */
        image: z.string().regex(IMAGE_ID),
        /** Its recipe tag; target and pin segments must be this handoff's own. */
        tag: z.string().regex(FACTORY_IMAGE),
        /** The commit that image was prepared at. */
        pin: z.string().regex(/^[a-f0-9]{40}$/),
        policy: z
          .object({
            network: z.object({ mode: z.literal("deny") }).strict(),
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
        /** Keyed by tool name, so the key set is open; the values are always patterns naming something. */
        permissions: z.record(z.string(), z.array(z.string().regex(/\S/))),
      })
      .strict(),
    /**
     * The reference the thread is created with (`POST /threads` `workspace`): the source's
     * digest, and the links and baseline, which the digest does not cover. The builder serves
     * the staged workspace only when all three are these (`stagedBuilderWorkspace`).
     */
    workspace: z
      .object({
        sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
        environmentLinks: z.array(
          z.object({ path: z.string().min(1), target: z.string().min(1) }).strict(),
        ),
        baseline: z.literal("git").optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((handoff, ctx) => {
    // The tag's target and pin segments must be this handoff's own: a work order may not
    // name another target's image, or its own target's image at another pin.
    const [, target, pin] = FACTORY_IMAGE.exec(handoff.target.tag) ?? []
    if (target !== handoff.targetId || pin !== handoff.target.pin.slice(0, 12))
      ctx.addIssue({
        code: "custom",
        path: ["target", "tag"],
        message: `tag ${handoff.target.tag} is not target ${handoff.targetId} at pin ${handoff.target.pin}: a factory tag names b4-factory-${handoff.targetId}:${handoff.target.pin.slice(0, 12)}-<key>`,
      })
  })
export type BuilderHandoff = z.infer<typeof BuilderHandoffSchema>

/** Whether `reference` is an image id: the builder's `dockerSandbox({ images })`. */
export const isFactoryImageId = (reference: string): boolean => IMAGE_ID.test(reference)

const describe = (error: unknown) =>
  error instanceof z.ZodError
    ? z.prettifyError(error)
    : error instanceof Error
      ? error.message
      : String(error)

/**
 * Refuse, by name, a variable an older builder read. `FACTORY_BUILDER_TARGET` chose the
 * process's image, policy and permissions; each work order's handoff does now.
 * `FACTORY_BUILDER_MANIFEST_DIR` was where the controller wrote each work order's manifest;
 * the controller stages the workspace over the Agent Protocol now. An operator still setting
 * either must not believe it does anything.
 *
 * Under `turbo run` (the root `pnpm check` and `pnpm build`) this refusal does not fire:
 * turbo 2 runs tasks in strict env mode and `turbo.json` lists neither retired variable, so it
 * is stripped before the task starts (as `FACTORY_WORKER_TOKEN` is: `turbo.json` passes no
 * variable through to this app's tasks). It fires wherever the variable reaches the process:
 * `pnpm --filter <this app> check|build|dev`, `b4 start`, a served runtime.
 */
export function refuseRetiredVariables(env: NodeJS.ProcessEnv = process.env): void {
  if (env.FACTORY_BUILDER_TARGET !== undefined)
    throw new Error(
      "FACTORY_BUILDER_TARGET is retired: the builder boots with no target file; each work order's handoff carries its target's image, policy and permissions. Unset it",
    )
  if (env.FACTORY_BUILDER_MANIFEST_DIR !== undefined)
    throw new Error(
      "FACTORY_BUILDER_MANIFEST_DIR is retired: the controller stages each work order's workspace over the Agent Protocol. Unset it",
    )
}

/**
 * The one fact a builder thread is created with. Thread metadata is client input: nothing in
 * it is trusted beyond this one key being a catalog-id string.
 */
export function workOrderIdOf(metadata: Readonly<Record<string, unknown>>): string {
  const id = metadata.factoryWorkOrderId
  if (typeof id !== "string" || !CATALOG_ID.test(id))
    throw new Error(
      "thread metadata factoryWorkOrderId must be a catalog id: a plain name with no slash and no leading dot",
    )
  return id
}

/**
 * The work order's target, from the thread's metadata. Metadata is client input, and only
 * the controller can create a thread (src/thread-access.ts), so this key is as
 * controller-authored as the manifest file was; it is still parsed strictly, and a key this
 * schema does not model is a refusal at admission, never a drop to a broader default.
 */
export function builderHandoffOf(metadata: Readonly<Record<string, unknown>>): BuilderHandoff {
  const workOrderId = workOrderIdOf(metadata)
  const raw = Object.hasOwn(metadata, "factoryBuilder") ? metadata.factoryBuilder : undefined
  if (raw === undefined)
    throw new Error(
      "thread metadata factoryBuilder is required: the controller creates a builder thread with its work order's target",
    )
  let handoff: BuilderHandoff
  try {
    handoff = BuilderHandoffSchema.parse(raw)
  } catch (error) {
    throw new Error(`thread metadata factoryBuilder is invalid: ${describe(error)}`, {
      cause: error,
    })
  }
  if (handoff.workOrderId !== workOrderId)
    throw new Error(
      `thread metadata factoryBuilder names work order ${handoff.workOrderId}, not ${workOrderId}`,
    )
  return handoff
}

/**
 * The staged workspace, only when it is the one the handoff names: its digest, its links and
 * its baseline, all three, since the links and the baseline change what the thread runs and
 * the digest covers only the files. A thread created with another workspace, or with none, is
 * refused at admission, by name.
 */
export function stagedBuilderWorkspace(
  staged: CapturedWorkspaceDefinition | undefined,
  handoff: BuilderHandoff,
): CapturedWorkspaceDefinition {
  if (staged === undefined)
    throw new Error(
      `work order ${handoff.workOrderId}'s thread was created without a staged workspace`,
    )
  // The framework hands the links sorted by path; the handoff's are sorted the same way here.
  const named = JSON.stringify([
    handoff.workspace.sourceDigest,
    [...handoff.workspace.environmentLinks]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((link) => ({ path: link.path, target: link.target })),
    handoff.workspace.baseline ?? null,
  ])
  const got = JSON.stringify([
    staged.source.digest,
    staged.environmentLinks.map((link) => ({ path: link.path, target: link.target })),
    staged.baseline ?? null,
  ])
  if (got !== named)
    throw new Error(
      `the staged workspace ${got} is not the one work order ${handoff.workOrderId} names (${named})`,
    )
  return verifyCapturedWorkspaceDefinition(staged)
}

/**
 * The labels every factory image build stamps (the controller's `dockerImageBuilder`): the
 * target and full pin the image was prepared for, and its full recipe key. They live in the
 * image config, which the image id content-addresses.
 */
export const FACTORY_LABELS = {
  target: "b4.factory.target",
  pin: "b4.factory.pin",
  key: "b4.factory.key",
} as const

/** An image id's labels (`{}` when it has none), or null when the daemon does not hold it. */
export type InspectLabels = (id: string) => Promise<Readonly<Record<string, string>> | null>

/**
 * The daemon's answer for `id`, read by id. Fails closed: any error other than the daemon
 * saying it holds no such image, and any answer that is not a string-valued object, rejects.
 */
export const dockerLabels: InspectLabels = (id) =>
  new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["image", "inspect", "--format", "{{json .Config.Labels}}", id],
      { timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          if (/No such image/i.test(String(stderr))) resolve(null)
          else
            reject(
              new Error(
                `docker image inspect ${id} failed: ${String(stderr).trim() || error.message}`,
                { cause: error },
              ),
            )
          return
        }
        try {
          const parsed: unknown = JSON.parse(stdout)
          if (parsed === null) return resolve({})
          if (
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !Object.values(parsed).every((value) => typeof value === "string")
          )
            throw new Error("labels are not a string map")
          resolve(parsed as Record<string, string>)
        } catch (cause) {
          reject(new Error(`docker image inspect ${id} answered unreadable labels`, { cause }))
        }
      },
    )
  })

const RECIPE_KEY = /^[0-9a-f]{64}$/

/**
 * Refuse, by name, the handoff's image when its build labels are not the handoff's own target,
 * full pin and a recipe key whose prefix is the tag's key segment. An id alone binds no target:
 * the provider admits any id the daemon holds. Read by id, so the labels are the image's own
 * (the id content-addresses the config they live in) and nothing can change between this check
 * and the run. Whoever can build or load images on the daemon can forge labels; that is the
 * bound the tag shape had before.
 */
export async function assertFactoryImage(
  handoff: BuilderHandoff,
  inspect: InspectLabels = dockerLabels,
): Promise<void> {
  const id = handoff.target.image
  const labels = await inspect(id)
  if (labels === null) throw new Error(`image ${id} is not on this daemon`)
  if (!Object.hasOwn(labels, FACTORY_LABELS.target))
    throw new Error(`image ${id} carries no factory labels: it was not built by the factory`)
  const label = (name: string) => (Object.hasOwn(labels, name) ? labels[name] : undefined)
  const [, , , key] = FACTORY_IMAGE.exec(handoff.target.tag) ?? []
  const problems: string[] = []
  const target = label(FACTORY_LABELS.target)
  if (target !== handoff.targetId) problems.push(`target ${target}, not ${handoff.targetId}`)
  const pin = label(FACTORY_LABELS.pin)
  if (pin !== handoff.target.pin) problems.push(`pin ${pin}, not ${handoff.target.pin}`)
  const built = label(FACTORY_LABELS.key) ?? ""
  if (key === undefined || !RECIPE_KEY.test(built) || !built.startsWith(key))
    problems.push(`recipe key ${built.slice(0, 12)}…, not ${key ?? "(no key in the tag)"}…`)
  if (problems.length > 0) throw new Error(`image ${id} was built for ${problems.join("; ")}`)
}

/**
 * The builder's whole per-thread sandbox, from the thread's handoff: what `b4.config.ts`'s
 * `sandbox.thread` returns. The handoff is parsed and the staged workspace verified first (no
 * daemon needed to refuse either), then the image's build labels are checked against the
 * handoff, all before the framework resolves the image or starts anything. `inspect` is a test
 * seam; the config passes none, so the daemon is asked.
 */
export async function builderThreadSandbox(
  thread: {
    readonly metadata: Readonly<Record<string, unknown>>
    readonly staged?: CapturedWorkspaceDefinition | undefined
  },
  options: { readonly inspect?: InspectLabels } = {},
) {
  const handoff = builderHandoffOf(thread.metadata)
  const workspace = stagedBuilderWorkspace(thread.staged, handoff)
  await assertFactoryImage(handoff, options.inspect)
  return {
    workspace,
    environment: { image: handoff.target.image },
    policy: handoff.target.policy,
    permissions: { allow: handoff.target.permissions },
  }
}

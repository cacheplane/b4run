import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { z } from "zod"
import { taskPrompt } from "./prompts.js"
import { appRoot, imageTag, type Task } from "./targets/catalog.js"
import { builderPermissions } from "./targets/permissions.js"
import { builderSandboxScope, targetSandboxPolicy, targetWorkspace } from "./targets/workspace.js"

/**
 * Everything the builder app's `b4.config.ts` needs, as data. The builder imports no
 * controller code: it verifies this file and serves it. The workspace is captured HERE,
 * so the builder never sees the target archive or the task catalog, only the bytes the
 * controller decided it should start from.
 */
export const BuilderManifestSchema = z
  .object({
    version: z.literal(1),
    taskId: z.string().min(1),
    target: z
      .object({
        id: z.string().min(1),
        /** The two options `dockerSandbox` receives, and the whole of the provider's identity. */
        scope: z.string().min(1),
        image: z.string().min(1),
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
    workspace: z.unknown(),
    prompt: z.string().min(1),
  })
  .strict()
export type BuilderManifest = z.infer<typeof BuilderManifestSchema>

/** Write `<dir>/<taskId>.json` and return its path. */
export async function writeBuilderManifest(task: Task, dir: string): Promise<string> {
  const workspace = await captureWorkspaceDefinition(appRoot, targetWorkspace(task, "builder"))
  // Parsed, not merely typed: the controller validates what it writes against the SAME schema
  // the builder will apply to it, so a manifest the builder would refuse cannot be produced
  // here in the first place. It is also what narrows the framework's wider `SandboxPolicy`
  // to the subset a builder may be configured with — a policy that grew a key this schema
  // does not model fails here, loudly, instead of being dropped there, silently.
  const manifest: BuilderManifest = BuilderManifestSchema.parse({
    version: 1,
    taskId: task.id,
    target: {
      id: task.target.id,
      scope: builderSandboxScope,
      image: imageTag(task.target),
      policy: targetSandboxPolicy(task.target),
      permissions: builderPermissions(task.target),
    },
    workspace,
    prompt: taskPrompt(task),
  })
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${task.id}.json`)
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)
  return path
}

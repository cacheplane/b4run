import { readFileSync } from "node:fs"
import { z } from "zod"

/**
 * Everything this builder app's `b4.config.ts` needs, as data. Deliberately a SECOND copy of
 * the controller's schema rather than an import: the two packages share no source, and the
 * controller's own `builder-manifest.test.ts` asserts the two schema texts are identical.
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

/** The manifest this builder process serves. One builder process per task, as before. */
export function loadBuilderManifest(): BuilderManifest {
  const path = process.env.FACTORY_BUILDER_MANIFEST
  if (!path)
    throw new Error(
      "FACTORY_BUILDER_MANIFEST is required: the controller writes it with `factory builder-manifest`",
    )
  return BuilderManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
}

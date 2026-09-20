import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

/** The package root, derived from this module rather than the working directory. */
export const appRoot = fileURLToPath(new URL("../../", import.meta.url))
export const fixturesDir = join(appRoot, "fixtures")
// Bridge until src/fixtures is retired (task 9): the task-shaped files (spec, checks,
// reference patch, independent check) now live under tasks/<id>/, alongside the target
// catalog's own tasks. Only fixtures/<id>/project/ is still read from fixturesDir.
const tasksDir = join(appRoot, "tasks")

/**
 * A path the builder may change. Never a test, a check, or config: the factory's
 * completion policy must not be reachable from the builder's own inventory.
 */
const allowedSourcePath = z
  .string()
  .min(1)
  .regex(/^src\/[\w./-]+\.ts$/, "allowed source paths live under src/ and end in .ts")
  .refine((p) => !p.endsWith(".test.ts"), "a test file cannot be an allowed source path")

export const ManifestSchema = z
  .object({
    id: z.string().min(1),
    allowedSourcePaths: z.array(allowedSourcePath).min(1),
    immutablePaths: z.array(z.string().min(1)),
  })
  .refine(
    (m) => m.allowedSourcePaths.every((p) => !m.immutablePaths.includes(p)),
    "allowed and immutable paths must be disjoint",
  )
export type Manifest = z.infer<typeof ManifestSchema>

const SuiteSchema = z.object({
  file: z.string().regex(/^(?:test|checks)\/[\w-]+\.test\.ts$/),
  assertions: z.array(z.string().min(1)).min(1),
})
export const ChecksSchema = z.object({ visible: SuiteSchema, independent: SuiteSchema })
export type Checks = z.infer<typeof ChecksSchema>
export type Suite = z.infer<typeof SuiteSchema>

export interface Fixture {
  readonly id: string
  readonly directory: string
  // Bridge until src/fixtures is retired: the task-shaped files (task.json, checks.json,
  // spec.md, reference.patch, checks/) live here now, not under `directory`.
  readonly tasksDirectory: string
  readonly manifest: Manifest
  readonly checks: Checks
  readonly taskText: string
}

/** Fixture ids present on disk, sorted. A new fixture is a directory, not a code change. */
export function loadFixtureIds(): string[] {
  return readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export function loadFixture(id: string): Fixture {
  if (!loadFixtureIds().includes(id)) throw new Error(`Unknown fixture: ${id}`)
  const directory = join(fixturesDir, id)
  const tasksDirectory = join(tasksDir, id)
  // Bridge until src/fixtures is retired: task.json carries `target` too, which this
  // (non-strict) schema simply ignores.
  const manifest = ManifestSchema.parse(
    JSON.parse(readFileSync(join(tasksDirectory, "task.json"), "utf8")),
  )
  if (manifest.id !== id) throw new Error(`Fixture ${id} declares a different id: ${manifest.id}`)
  const checks = ChecksSchema.parse(
    JSON.parse(readFileSync(join(tasksDirectory, "checks.json"), "utf8")),
  )
  const taskText = readFileSync(join(tasksDirectory, "spec.md"), "utf8")
  return { id, directory, tasksDirectory, manifest, checks, taskText }
}

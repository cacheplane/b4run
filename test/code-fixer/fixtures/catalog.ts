import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const fixtureId = z.enum(["cli-flags", "nullable-inputs"])
const path = z
  .string()
  .regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine((value) => value.split("/").every((part) => part !== "." && part !== ".."))
const paths = z
  .array(path)
  .min(1)
  .refine((values) => new Set(values).size === values.length)
const schema = z
  .object({
    id: fixtureId,
    version: z.literal(1),
    sourcePr: z.string().regex(/^https:\/\/github\.com\/cacheplane\/b4run\/pull\/\d+$/),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    extractionNotes: z.string().min(1),
    allowedSourcePaths: paths.refine((values) =>
      values.every(
        (value) =>
          value.startsWith("src/") &&
          value.endsWith(".ts") &&
          !/(?:^|\/)(?:test|tests|checks|config)(?:\/|\.)|\.(?:test|spec)\.ts$/.test(value),
      ),
    ),
    immutablePaths: paths,
    command: z.tuple([z.literal("npm"), z.literal("test")]),
    failurePattern: z.string().min(1),
  })
  .strict()
  .refine((value) => value.allowedSourcePaths.every((p) => !value.immutablePaths.includes(p)))

export type FixtureManifest = z.infer<typeof schema>
export function parseManifest(value: unknown): FixtureManifest {
  return schema.parse(value)
}
export function validateDependencies(pkg: unknown, lock: unknown): void {
  const dependencies = z.record(
    z.string(),
    z.string().regex(/^(?:npm:[@a-zA-Z0-9/_.-]+@)?\d+\.\d+\.\d+$/),
  )
  const parsed = z.object({ dependencies }).parse(pkg)
  const locked = z.object({ packages: z.record(z.string(), z.unknown()) }).parse(lock)
  const root = z.object({ dependencies }).parse(locked.packages[""])
  if (
    JSON.stringify(Object.entries(parsed.dependencies).sort()) !==
    JSON.stringify(Object.entries(root.dependencies).sort())
  ) {
    throw new Error("Dependency lock does not match the fixture")
  }
}
export async function validateProject(root: string, manifest: FixtureManifest): Promise<string[]> {
  const found: string[] = []
  async function walk(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      if (!relative && entry.name === "node_modules" && entry.isDirectory()) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new Error(`Fixture symlink: ${path}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) found.push(path)
      else throw new Error(`Not a regular fixture file: ${path}`)
    }
  }
  await walk("")
  const expected = [...manifest.allowedSourcePaths, ...manifest.immutablePaths].sort()
  found.sort()
  if (JSON.stringify(found) !== JSON.stringify(expected))
    throw new Error("Fixture inventory mismatch")
  return found
}
export function selectFixture(id: string): "cli-flags" | "nullable-inputs" {
  if (id !== "cli-flags" && id !== "nullable-inputs") throw new Error(`Unknown fixture: ${id}`)
  return id
}
export function fixtureDirectory(id: string): string {
  return fileURLToPath(
    selectFixture(id) === "cli-flags"
      ? new URL("../../../examples/code-fixer/server/sample/", import.meta.url)
      : new URL("./nullable-inputs/", import.meta.url),
  )
}
export async function loadManifest(id: string) {
  const root = fixtureDirectory(id)
  const manifest = parseManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")))
  if (manifest.id !== id) throw new Error("Fixture ID mismatch")
  await validateProject(join(root, "project"), manifest)
  return manifest
}

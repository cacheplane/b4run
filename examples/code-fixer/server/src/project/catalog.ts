import { fileURLToPath } from "node:url"
import { z } from "zod"
import project from "../../sample/manifest.json" with { type: "json" }

const projectId = z.string().regex(/^[a-z][a-z0-9-]*$/)
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
    id: projectId,
    allowedSourcePaths: paths.refine((values) =>
      values.every(
        (value) =>
          value.startsWith("src/") &&
          value.endsWith(".ts") &&
          !/(?:^|\/)(?:test|tests|checks|config)(?:\/|\.)|\.(?:test|spec)\.ts$/.test(value),
      ),
    ),
    immutablePaths: paths,
  })
  .refine((value) => value.allowedSourcePaths.every((p) => !value.immutablePaths.includes(p)))

export type ProjectManifest = z.infer<typeof schema>
export const projectDirectory = fileURLToPath(new URL("../../sample/", import.meta.url))
export function parseManifest(value: unknown): ProjectManifest {
  return schema.parse(value)
}
export function selectProject(id: string): z.infer<typeof projectId> {
  if (id !== project.id) throw new Error(`Unknown project: ${id}`)
  return projectId.parse(id)
}
export function projectManifest(id: string): ProjectManifest {
  selectProject(id)
  return parseManifest(project)
}

export const configuredProject = parseManifest(project)

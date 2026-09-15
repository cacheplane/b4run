import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { expect, it } from "vitest"
import { appRoot, projectWorkspace } from "../src/project/workspace.ts"

it.each(["cli-flags"])("captures only declared agent source for %s", async (id) => {
  const definition = projectWorkspace(id)
  const captured = await captureWorkspaceDefinition(appRoot, definition)
  const paths = captured.source.files.map((file) => file.path)
  expect(paths).toContain("project.json")
  expect(paths).toContain("TASK.md")
  expect(
    paths.some((path) => path.includes("independent") || path.includes("reference.patch")),
  ).toBe(false)
  expect(captured.environmentLinks).toEqual([
    { path: "node_modules", target: `/opt/fixtures/${id}/node_modules` },
  ])
})

it("accepts app project configuration without historical qualification metadata", async () => {
  const { parseManifest, projectManifest } = await import("../src/project/catalog.ts")
  expect(
    parseManifest({
      id: "my-project",
      allowedSourcePaths: ["src/index.ts"],
      immutablePaths: ["package.json", "test/index.test.ts"],
    }).id,
  ).toBe("my-project")
  expect(() => projectManifest("nullable-inputs")).toThrow("Unknown project")
  expect(() =>
    parseManifest({
      id: "my-project",
      allowedSourcePaths: ["../test/index.test.ts"],
      immutablePaths: ["package.json"],
    }),
  ).toThrow()
})

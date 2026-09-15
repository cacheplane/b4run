import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { expect, it } from "vitest"
import { appRoot, fixtureWorkspace } from "../src/fixtures/workspace.ts"

it.each(["cli-flags", "nullable-inputs"])(
  "captures only declared agent source for %s",
  async (id) => {
    const definition = fixtureWorkspace(id)
    const captured = await captureWorkspaceDefinition(appRoot, definition)
    const paths = captured.source.files.map((file) => file.path)
    expect(paths).toContain("fixture.json")
    expect(paths).toContain("TASK.md")
    expect(
      paths.some((path) => path.includes("independent") || path.includes("reference.patch")),
    ).toBe(false)
    expect(captured.environmentLinks).toEqual([
      { path: "node_modules", target: `/opt/fixtures/${id}/node_modules` },
    ])
  },
)

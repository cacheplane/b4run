import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureWorkspaceDefinition } from "@b4run/workspace/node"
import { expect, it } from "vitest"
import { appRoot, projectWorkspace, sandboxImage } from "../src/project/workspace.ts"

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

it("names a content-addressed image built from every Docker input", async () => {
  const { baseImage, imageInputs, preparedImageTag } = await import("../src/project/image.ts")
  expect(sandboxImage).toBe(preparedImageTag(appRoot))
  expect(sandboxImage).toMatch(/^b4-code-fixer:[a-f0-9]{32}$/)
  // The context allowlist admits exactly the hashed files, so none can change unhashed.
  const directories = new Set(["sample", "sample/project"])
  const admitted = (await readFile(join(appRoot, ".dockerignore"), "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("!"))
    .map((line) => line.slice(1))
    .filter((path) => !directories.has(path))
  expect(admitted.sort()).toEqual(imageInputs.filter((path) => path !== ".dockerignore").sort())
  expect(baseImage(await readFile(join(appRoot, "Dockerfile"), "utf8"))).toMatch(
    /^node:24-slim@sha256:[a-f0-9]{64}$/,
  )
  expect(() => baseImage("FROM node:24-slim\n")).toThrow("pinned by sha256 digest")

  const copy = await mkdtemp(join(tmpdir(), "b4-code-fixer-image-"))
  try {
    await mkdir(join(copy, "sample/project"), { recursive: true })
    for (const path of imageInputs) await cp(join(appRoot, path), join(copy, path))
    expect(preparedImageTag(copy)).toBe(sandboxImage)
    for (const path of imageInputs) {
      const original = await readFile(join(copy, path))
      await writeFile(join(copy, path), Buffer.concat([original, Buffer.from("\n")]))
      expect(preparedImageTag(copy), path).not.toBe(sandboxImage)
      await writeFile(join(copy, path), original)
    }
  } finally {
    await rm(copy, { recursive: true, force: true })
  }
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

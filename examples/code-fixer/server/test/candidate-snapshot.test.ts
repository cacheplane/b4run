import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { B4ToolContext } from "@b4run/sdk"
import { expect, it } from "vitest"
import { projectDirectory, projectManifest } from "../src/project/catalog.ts"
import { inspectCandidate } from "../src/review/inspect.ts"

async function fixtureContext() {
  const manifest = projectManifest("cli-flags")
  const initial: Record<string, string> = {
    "TASK.md": "Repair the fixture",
    ".gitignore": "node_modules/\n",
    "project.json": '{"id":"cli-flags"}',
  }
  for (const path of [...manifest.allowedSourcePaths, ...manifest.immutablePaths])
    initial[path] = await readFile(join(projectDirectory, "project", path), "utf8")
  const current: Record<string, string> = {
    ...initial,
    "src/cli.ts": `${initial["src/cli.ts"]}\n// repair\n`,
  }
  const links: Record<string, string> = { node_modules: "/opt/fixtures/cli-flags/node_modules" }
  const ctx: B4ToolContext = {
    signal: new AbortController().signal,
    workspace: {
      id: "operation",
      sourceDigest: "captured",
      environment: {
        binding: { provider: "docker", scope: "test", account: "local" },
        identity: "sha256:image",
      },
      async readInitialFile(path) {
        if (!(path in initial)) throw new Error("missing")
        return Buffer.from(initial[path] ?? "")
      },
    },
    fs: {
      async readFile(path) {
        return current[path] ?? ""
      },
      async readBinaryFile(path) {
        return Buffer.from(current[path] ?? "")
      },
      async writeFile() {
        throw new Error("not used")
      },
      async listDir(path = "") {
        const prefix = path && path !== "." ? `${path}/` : ""
        return [
          ...new Set(
            [...Object.keys(current), ...Object.keys(links), ".git/HEAD"]
              .filter((entry) => entry.startsWith(prefix))
              .map((entry) => entry.slice(prefix.length).split("/")[0] ?? ""),
          ),
        ]
      },
      async stat(path) {
        if (links[path]) return { kind: "symlink", size: 0, executable: false, target: links[path] }
        if (Object.hasOwn(current, path))
          return { kind: "file", size: Buffer.byteLength(current[path] ?? ""), executable: false }
        return { kind: "directory", size: 0, executable: false }
      },
    },
  }
  return { ctx, current, links }
}
it("uses captured source identity and ignores mutable Git metadata", async () => {
  const { ctx, current } = await fixtureContext()
  current[".git/HEAD"] = "forged baseline"
  const result = await inspectCandidate(ctx)
  expect(result.candidate.workspaceId).toBe("operation")
  expect(result.candidate.sourceDigest).toBe("captured")
  expect(Object.keys(result.candidate.changes)).toEqual(["src/cli.ts"])
  expect(result.initial.image).toBe("sha256:image")
})
it("rejects same-byte source symlinks and redirected dependencies", async () => {
  for (const path of ["src/cli.ts", "node_modules"]) {
    const { ctx, links } = await fixtureContext()
    links[path] = "/other"
    await expect(inspectCandidate(ctx)).rejects.toThrow()
  }
})
it("rejects altered fixture identity, tests, added and deleted files", async () => {
  for (const change of [
    (files: Record<string, string>) => {
      files["project.json"] = '{"id":"nullable-inputs"}'
    },
    (files: Record<string, string>) => {
      files["test/cli.test.ts"] = "pass"
    },
    (files: Record<string, string>) => {
      files["src/extra.ts"] = "extra"
    },
    (files: Record<string, string>) => {
      delete files["package.json"]
    },
  ]) {
    const { ctx, current } = await fixtureContext()
    change(current)
    await expect(inspectCandidate(ctx)).rejects.toThrow()
  }
})

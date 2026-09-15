import { createHash } from "node:crypto"
import { lstat, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SourceFile, SourceManifest } from "./types.ts"

export type { SourceFile, SourceManifest } from "./types.ts"

function validatePath(path: string): void {
  if (
    typeof path !== "string" ||
    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) ||
    path.split("/").some((part) => [".", "..", ".git", "node_modules"].includes(part))
  ) {
    throw new Error(`Invalid source path: ${path}`)
  }
}
export function makeManifest(
  files: readonly SourceFile[],
  dependencyTarget: string,
): SourceManifest {
  if (
    ![
      "/opt/fixtures/cli-flags/node_modules",
      "/opt/fixtures/nullable-inputs/node_modules",
    ].includes(dependencyTarget)
  )
    throw new Error("Invalid dependency target")
  const canonical = files
    .map((file) => {
      validatePath(file.path)
      if (
        typeof file.content !== "string" ||
        typeof file.executable !== "boolean" ||
        Buffer.from(file.content, "utf8").toString("utf8") !== file.content
      )
        throw new Error("Invalid UTF-8 source file")
      return {
        path: file.path,
        content: file.content,
        executable: file.executable,
      }
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const paths = new Set<string>()
  for (const file of canonical) {
    if (
      paths.has(file.path) ||
      file.path
        .split("/")
        .slice(0, -1)
        .some((_, i) =>
          paths.has(
            file.path
              .split("/")
              .slice(0, i + 1)
              .join("/"),
          ),
        )
    )
      throw new Error(`Conflicting source path: ${file.path}`)
    paths.add(file.path)
  }
  const digest = createHash("sha256")
    .update(JSON.stringify({ files: canonical, dependencyTarget }))
    .digest("hex")
  return { digest, files: canonical, dependencyTarget }
}

export async function loadFixtureManifest(
  id: "cli-flags" | "nullable-inputs",
  root?: string,
): Promise<SourceManifest> {
  if (id !== "cli-flags" && id !== "nullable-inputs") throw new Error("Unknown fixture")
  const base = root
    ? join(root, id)
    : fileURLToPath(
        new URL(
          id === "cli-flags"
            ? "../../../../../examples/code-fixer/server/sample/"
            : "../../../../../test/code-fixer/fixtures/nullable-inputs/",
          import.meta.url,
        ),
      )
  async function regular(path: string): Promise<{ content: string; executable: boolean }> {
    const info = await lstat(path)
    if (!info.isFile()) throw new Error(`Not a regular source file: ${path}`)
    const bytes = await readFile(path)
    return {
      content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      executable: !!(info.mode & 0o111),
    }
  }
  const inventory = JSON.parse((await regular(join(base, "manifest.json"))).content) as {
    allowedSourcePaths: string[]
    immutablePaths: string[]
  }
  const expected = [...inventory.allowedSourcePaths, ...inventory.immutablePaths]
  makeManifest(
    expected.map((path) => ({ path, content: "", executable: false })),
    `/opt/fixtures/${id}/node_modules`,
  )
  const found: string[] = []
  async function walk(relative: string): Promise<void> {
    const directory = join(base, "project", relative)
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid fixture directory")
    for (const name of await readdir(directory)) {
      const path = relative ? `${relative}/${name}` : name
      const info = await lstat(join(directory, name))
      if (path === "node_modules" && info.isDirectory()) continue
      validatePath(path)
      if (info.isDirectory()) await walk(path)
      else if (info.isFile()) found.push(path)
      else throw new Error(`Not a regular source file: ${path}`)
    }
  }
  await walk("")
  if (JSON.stringify(found.sort()) !== JSON.stringify(expected.sort()))
    throw new Error("Fixture inventory mismatch")
  const files: SourceFile[] = []
  for (const path of expected) files.push({ path, ...(await regular(join(base, "project", path))) })
  files.push(
    { path: "TASK.md", ...(await regular(join(base, "task.md"))) },
    { path: ".gitignore", content: "/node_modules\n", executable: false },
  )
  return makeManifest(files, `/opt/fixtures/${id}/node_modules`)
}

import { cp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { isolatedApp as copyApp } from "../../../examples/code-fixer/server/test/isolated-app.js"
import { fixtureDirectory, selectFixture } from "../fixtures/catalog.js"
export async function isolatedApp(destination?: string, fixture = "cli-flags"): Promise<string> {
  const id = selectFixture(fixture)
  const root = await copyApp(destination)
  await rm(join(root, "sample"), { recursive: true, force: true })
  await cp(fixtureDirectory(id), join(root, "sample"), {
    recursive: true,
    filter: (path) => basename(path) !== "biome.json" && basename(path) !== "node_modules",
  })
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8")
  await writeFile(
    join(root, "Dockerfile"),
    dockerfile.replaceAll("/opt/fixtures/cli-flags", `/opt/fixtures/${id}`),
  )
  return root
}

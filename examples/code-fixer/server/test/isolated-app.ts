import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { appRoot } from "../src/project/workspace.js"

/** Copy author files into a private evaluation installation, sharing only dependencies. */
export async function isolatedApp(destination?: string): Promise<string> {
  const root = destination ?? (await mkdtemp(join(tmpdir(), "b4-code-fixer-app-")))
  await mkdir(root, { recursive: true })
  const include = (path: string) =>
    !["node_modules", ".b4", "artifacts"].includes(basename(path)) &&
    !basename(path).startsWith(".env")
  // Copy entries individually: default artifact outputs are beneath appRoot,
  // while artifacts themselves are excluded from this source inventory.
  for (const name of await readdir(appRoot)) {
    if (include(name))
      await cp(join(appRoot, name), join(root, name), { recursive: true, filter: include })
  }
  await symlink(join(appRoot, "node_modules"), join(root, "node_modules"), "dir")
  return root
}

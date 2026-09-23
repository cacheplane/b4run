import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { repositoryRoot } from "../src/lib/targets/catalog.ts"

// As `isolated-builder.ts`: the wide capture is taken out of the repository by `git ls-tree`
// at the pin, and a copy of this package outside it would find nothing. Resolved here, where
// this module does run inside the repository, and never overriding an operator's own value.
process.env.FACTORY_REPO_ROOT ??= repositoryRoot()

/** The drafter package's root: the sibling app that isolatedDrafter() copies. */
const drafterRoot = fileURLToPath(new URL("../../drafter/", import.meta.url))

/**
 * Copy the DRAFTER's author files into a private installation, sharing only dependencies.
 * The lane that boots a real drafter must not boot the checked-out package directory: the
 * served runtime writes its installation store (`.b4/workspaces`) and checkpoints under the
 * root it is given, and those are this test's and nobody else's. `.factory/` is left out
 * too: it is where the checked-out package keeps manifests, and the served drafter is told
 * its own directory.
 */
export async function isolatedDrafter(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-software-factory-drafter-"))
  await mkdir(root, { recursive: true })
  const include = (path: string) =>
    !["node_modules", ".b4", ".factory", ".turbo", "artifacts"].includes(basename(path)) &&
    !basename(path).startsWith(".env")
  for (const name of await readdir(drafterRoot)) {
    if (include(name))
      await cp(join(drafterRoot, name), join(root, name), { recursive: true, filter: include })
  }
  await symlink(join(drafterRoot, "node_modules"), join(root, "node_modules"), "dir")
  return root
}

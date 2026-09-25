import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { repositoryRoot } from "../src/lib/targets/catalog.ts"

// The controller's own captures resolve a pin out of the repository, and a copy of an app
// outside it would find nothing by `git rev-parse` from there. Resolved here, where this
// module does run inside the repository, and never overriding an operator's own value.
process.env.FACTORY_REPO_ROOT ??= repositoryRoot()

/**
 * Copy a sibling app's author files into a private installation, sharing only dependencies.
 * The integration lanes boot a real builder or drafter, and it must not be the checked-out
 * package directory: a served runtime (and the harness, which runs typegen) writes its
 * installation store, checkpoints and build output under the root it is given, and those
 * are the test's and nobody else's. `.factory/` is left out too: a checked-out package from
 * before workspaces were handed over the Agent Protocol may still hold manifests there, and the
 * end-to-end lanes assert that the copy has none.
 */
export async function isolatedApp(appRoot: string, prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  await mkdir(root, { recursive: true })
  const include = (path: string) =>
    !["node_modules", ".b4", ".factory", ".turbo", "artifacts"].includes(basename(path)) &&
    !basename(path).startsWith(".env")
  for (const name of await readdir(appRoot)) {
    if (include(name))
      await cp(join(appRoot, name), join(root, name), { recursive: true, filter: include })
  }
  await symlink(join(appRoot, "node_modules"), join(root, "node_modules"), "dir")
  return root
}

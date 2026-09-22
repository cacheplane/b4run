import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import { repositoryRoot } from "../src/lib/targets/catalog.ts"

// The controller's own captures resolve the pin out of the repository, and a copy of this
// package lives outside it, so `git rev-parse` from there finds nothing. Resolved here, where
// this module does run inside the repository, and never overriding an operator's own value.
process.env.FACTORY_REPO_ROOT ??= repositoryRoot()

/** The builder package's root: the sibling app that isolatedBuilder() copies. */
const builderRoot = fileURLToPath(new URL("../../server/", import.meta.url))

/**
 * Copy the BUILDER's author files into a private installation, sharing only dependencies.
 * The controller's integration lanes boot a real builder, and it must not be the checked-out
 * package directory: the harness runs typegen against whatever root it is given.
 */
export async function isolatedBuilder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-software-factory-builder-"))
  await mkdir(root, { recursive: true })
  const include = (path: string) =>
    !["node_modules", ".b4", ".factory", ".turbo", "artifacts"].includes(basename(path)) &&
    !basename(path).startsWith(".env")
  for (const name of await readdir(builderRoot)) {
    if (include(name))
      await cp(join(builderRoot, name), join(root, name), { recursive: true, filter: include })
  }
  await symlink(join(builderRoot, "node_modules"), join(root, "node_modules"), "dir")
  return root
}

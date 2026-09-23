import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

// A deliberate copy of the controller's `test/isolated-app.ts`, not an import: the drafter
// package is understood, typechecked and tested without the controller's source, tests
// included. Keep the two in step by hand.

/** This package's root: the app that isolatedDrafter() copies. */
const packageRoot = fileURLToPath(new URL("../", import.meta.url))

/**
 * Copy this app's author files into a private installation, sharing only dependencies. A
 * served runtime writes its installation store (`.b4/workspaces`) and checkpoints under the
 * root it is given, and a lane that boots the app must own those rather than write them
 * into the checked-out package. `.factory/` is left out too: the served copy is told its
 * own manifest directory.
 */
export async function isolatedDrafter(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-software-factory-drafter-"))
  await mkdir(root, { recursive: true })
  const include = (path: string) =>
    !["node_modules", ".b4", ".factory", ".turbo", "artifacts"].includes(basename(path)) &&
    !basename(path).startsWith(".env")
  for (const name of await readdir(packageRoot)) {
    if (include(name))
      await cp(join(packageRoot, name), join(root, name), { recursive: true, filter: include })
  }
  await symlink(join(packageRoot, "node_modules"), join(root, "node_modules"), "dir")
  return root
}

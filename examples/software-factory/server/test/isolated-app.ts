import { cp, mkdir, mkdtemp, readdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"

/** This package's own root: the builder app that isolatedApp() copies. */
const appRoot = fileURLToPath(new URL("../", import.meta.url))

/**
 * Copy author files into a private installation, sharing only dependencies.
 *
 * The builder no longer needs the target repository: the controller captures the workspace
 * and hands it over as bytes in the manifest, so nothing here resolves a pin.
 */
export async function isolatedApp(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "b4-software-factory-app-"))
  await mkdir(root, { recursive: true })
  const include = (path: string) =>
    !["node_modules", ".b4", ".factory", ".turbo", "artifacts"].includes(basename(path)) &&
    !basename(path).startsWith(".env")
  // Copy entries individually: generated state lives beneath appRoot, and the
  // harness runs typegen against whatever root it is given, so the package
  // directory itself must never be that root.
  for (const name of await readdir(appRoot)) {
    if (include(name))
      await cp(join(appRoot, name), join(root, name), { recursive: true, filter: include })
  }
  await symlink(join(appRoot, "node_modules"), join(root, "node_modules"), "dir")
  return root
}

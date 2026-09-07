import { execFileSync } from "node:child_process"

// Historical authorization is evaluated at this immutable, pre-rename source.
export const HISTORICAL_RELEASE_REF = "2a4ffd994db9ce97f21b4e6c41beee393fadd298"
export function readHistoricalReleaseFile(path, ref = HISTORICAL_RELEASE_REF) {
  return execFileSync("git", ["show", `${ref}:${path}`], {
    cwd: new URL("../../../../", import.meta.url),
    maxBuffer: 8 * 1024 * 1024,
  })
}

let historicalRoot
export async function historicalReleaseModuleUrl(path) {
  if (!historicalRoot) {
    historicalRoot = (async () => {
      const { mkdtemp, mkdir, symlink, rm } = await import("node:fs/promises")
      const { tmpdir } = await import("node:os")
      const { join } = await import("node:path")
      const root = await mkdtemp(join(tmpdir(), "b4-frozen-release-"))
      const bytes = execFileSync(
        "git",
        [
          "archive",
          HISTORICAL_RELEASE_REF,
          "scripts",
          ".github",
          "package.json",
          "packages/core/package.json",
        ],
        {
          cwd: new URL("../../../../", import.meta.url),
          maxBuffer: 32 * 1024 * 1024,
        },
      )
      execFileSync("tar", ["-x", "-C", root], { input: bytes })
      await symlink(
        new URL("../../../../node_modules", import.meta.url).pathname,
        join(root, "node_modules"),
      )
      await mkdir(join(root, "packages/core"), { recursive: true })
      await symlink(
        new URL("../../../../packages/core/node_modules", import.meta.url).pathname,
        join(root, "packages/core/node_modules"),
      )
      const { after } = await import("node:test")
      after(() => rm(root, { recursive: true, force: true }))
      return root
    })()
  }
  const { pathToFileURL } = await import("node:url")
  return pathToFileURL(`${await historicalRoot}/${path}`).href
}

export async function importHistoricalReleaseModule(path) {
  return import(await historicalReleaseModuleUrl(path))
}

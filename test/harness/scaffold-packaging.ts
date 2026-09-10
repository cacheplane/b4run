import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * Version specifiers for all @b4run packages that the scaffold templates declare.
 * Every dep resolves from the test registry at the `latest` dist-tag, exactly what
 * a real `npm install` does against the Verdaccio uplink.
 */
export function registryLatestSpecifiers() {
  return {
    b4Cli: "latest",
    b4ConfigTypescript: "latest",
    b4Core: "latest",
    b4Evals: "latest",
    b4Inspector: "latest",
    b4Langchain: "latest",
    b4Sandbox: "latest",
    b4Sdk: "latest",
    b4Testing: "latest",
  }
}

export function candidateRegistryNpmArgs(registryUrl: string): readonly string[] {
  return [`--registry=${registryUrl}`, "--scope=", `--@b4run:registry=${registryUrl}`]
}

/**
 * Point a scaffolded app at the ephemeral test registry. Real users install from
 * a registry; the generated app does exactly that — no overrides, no tarball pins.
 * A genuinely missing @b4run package now 404s from Verdaccio (the registry is
 * local-only for that scope), preserving fail-closed behavior.
 */
export async function writeRegistryNpmrc(appRoot: string, registryUrl: string): Promise<void> {
  const host = registryUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
  const npmrc = [
    `registry=${registryUrl}`,
    // A user-level default scope selects that scope's registry even for an
    // unscoped install. Clear it at project precedence so candidate installs
    // cannot escape the ephemeral registry.
    "scope=",
    // Override a user-level registry mapping for B4.run's scoped packages.
    `@b4run:registry=${registryUrl}`,
    // Parity with a private-registry user; harmless for read-only installs.
    `//${host}/:_authToken="fake"`,
    "",
  ].join("\n")
  await writeFile(join(appRoot, ".npmrc"), npmrc, "utf8")
  await writePnpmWorkspaceBuildPolicy(appRoot)
}

export async function writePnpmWorkspaceBuildPolicy(appRoot: string): Promise<void> {
  const workspacePath = join(appRoot, "pnpm-workspace.yaml")
  const existing = await readFile(workspacePath, "utf8").catch(() => "")

  if (
    existing.includes("onlyBuiltDependencies:") &&
    existing.includes("allowBuilds:") &&
    existing.includes("esbuild: true")
  ) {
    return
  }

  const base = existing.trimEnd() || ["packages:", "  - ."].join("\n")
  await writeFile(
    workspacePath,
    [
      base,
      "",
      "onlyBuiltDependencies:",
      "  - esbuild",
      "",
      "allowBuilds:",
      "  esbuild: true",
      "",
    ].join("\n"),
    "utf8",
  )
}

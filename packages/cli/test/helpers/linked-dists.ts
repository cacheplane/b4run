import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")

// ---------------------------------------------------------------------------
// Freshness of the linked `dist` — READ THIS BEFORE CHANGING ANYTHING BELOW.
//
// These suites run BUILT OUTPUT. `buildFixture` imports `runBuildCommand` from
// `../../src`, and this package's vitest config aliases every `@b4run/*`
// specifier to `src` too — so the build LOGIC is always whatever vitest just
// transformed, while the runtime UNDER TEST is whatever `dist` happens to hold.
// The two can be arbitrarily far apart, and a stale `dist` yields either a red
// or a green that looks completely genuine.
//
// Not hypothetical: during review the workerd lane failed once and could not be
// reproduced. A `dist` built before dccae091 (the compiled-graph-cache fix)
// reproduces that exact failure 5/5, deterministically. Nothing warned.
//
// WHY THIS BUILDS INSTEAD OF ASSERTING ON mtimes. Both were measured:
//
//   • `tsc` rewrites only the outputs whose contents changed, so on a perfectly
//     current tree the OLDEST `dist` mtime is routinely older than the NEWEST
//     `src` mtime. The obvious assertion is red on a correct checkout.
//   • `touch`ing a source file without changing its contents leaves turbo's
//     hash unchanged, so `turbo run build` reports FULL TURBO and does not
//     rewrite `dist` at all. An mtime guard tripped by an editor save, a
//     `git stash pop`, or a reverted edit would tell the reader to run
//     `pnpm build` — and running it would not clear the failure. A guard that
//     its own remediation cannot satisfy gets deleted by the next person, which
//     is worse than no guard.
//
// Building is a guarantee rather than an inference, it has no false positive to
// misfire on, and it is cheap: ~200ms once turbo is warm, ~3.5s from cold.
// ---------------------------------------------------------------------------

/**
 * The packages these suites enter through. Everything else is reached from
 * here by following `workspace:` edges, which is the whole point — see
 * {@link edgeDistPackages}.
 */
const DIST_ROOT_PACKAGES: readonly string[] = [
  // Linked into the fixture by LINKED_PACKAGES, so the emitted files resolve
  // their `dist` for real.
  "@b4run/cli",
  "@b4run/postgres-storage",
  "@b4run/sdk",
  // Imported straight out of `dist` by the suites themselves (aimock).
  "@b4run/testing",
]

interface WorkspacePackage {
  /** Does it emit a `dist` at all? `config-*` do not. */
  readonly builds: boolean
  readonly deps: readonly string[]
  readonly dir: string
}

/** Every `packages/*` manifest, by package name. */
async function readWorkspacePackages(): Promise<Map<string, WorkspacePackage>> {
  const packagesDir = join(repoRoot, "packages")
  const entries = await readdir(packagesDir, { withFileTypes: true })
  const packages = new Map<string, WorkspacePackage>()
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const dir = join(packagesDir, entry.name)
        const manifestPath = join(dir, "package.json")
        if (!existsSync(manifestPath)) return
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
          dependencies?: Record<string, string>
          name?: unknown
          peerDependencies?: Record<string, string>
          scripts?: Record<string, unknown>
        }
        if (typeof manifest.name !== "string") return
        const deps = [
          ...Object.entries(manifest.dependencies ?? {}),
          ...Object.entries(manifest.peerDependencies ?? {}),
        ]
          .filter(([, range]) => range.startsWith("workspace:"))
          .map(([name]) => name)
        packages.set(manifest.name, {
          builds: typeof manifest.scripts?.build === "string",
          deps,
          dir,
        })
      }),
  )
  return packages
}

/**
 * The workspace packages whose `dist` these suites actually execute: the roots
 * above plus the transitive closure of their `workspace:` dependencies.
 *
 * DERIVED RATHER THAN LISTED, on purpose. `@b4run/langchain` appears nowhere
 * in the LINKED_PACKAGES list in hono-edge-fixture.ts — it arrives through
 * `packages/cli/node_modules`,
 * one edge down from `@b4run/cli` — so a reader auditing that list would not
 * even know it is in play. It is also the package whose stale `dist` produced
 * the phantom review failure. A hand-maintained list would have missed it; a
 * closure cannot.
 */
export async function edgeDistPackages(): Promise<readonly { dir: string; name: string }[]> {
  const packages = await readWorkspacePackages()
  const reached = new Set<string>()
  const queue = [...DIST_ROOT_PACKAGES]
  while (queue.length > 0) {
    const name = queue.pop()
    if (name === undefined || reached.has(name)) continue
    const workspacePackage = packages.get(name)
    if (workspacePackage === undefined) {
      throw new Error(
        `${name} is depended on with the \`workspace:\` protocol but is not a package in ` +
          `${join(repoRoot, "packages")}. The dist-freshness guard cannot resolve the closure.`,
      )
    }
    reached.add(name)
    queue.push(...workspacePackage.deps)
  }

  // The invariant this guard exists for. If the closure ever stops reaching
  // langchain — a dropped dependency edge, a rewritten walk — the guard has
  // silently stopped covering the only case anyone has actually been burned by,
  // and would go on passing while doing nothing.
  if (!reached.has("@b4run/langchain")) {
    throw new Error(
      "the dist-freshness closure no longer reaches @b4run/langchain, whose stale `dist` is " +
        "the failure this guard was written for. Check the `workspace:` dependency edges from " +
        `${DIST_ROOT_PACKAGES.join(", ")}.`,
    )
  }

  return [...reached]
    .map((name) => ({ name, workspacePackage: packages.get(name) }))
    .filter((entry) => entry.workspacePackage?.builds === true)
    .map((entry) => ({ dir: entry.workspacePackage?.dir ?? "", name: entry.name }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export async function buildLinkedDists(): Promise<readonly { dir: string; name: string }[]> {
  const packages = await edgeDistPackages()
  const turbo = join(repoRoot, "node_modules", ".bin", "turbo")
  if (!existsSync(turbo)) {
    throw new Error(`no turbo at ${turbo} — run \`pnpm install\` at the repo root.`)
  }

  // `--output-logs=errors-only` so a failure's message is the compiler's
  // diagnostics and nothing else: at full verbosity turbo replays the cached
  // logs of every task that PASSED, and the one line that matters ends up
  // buried thirty lines deep.
  const args = [
    "run",
    "build",
    "--output-logs=errors-only",
    ...packages.map(({ name }) => `--filter=${name}`),
  ]
  try {
    await promisify(execFile)(turbo, args, {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 900_000,
    })
  } catch (error) {
    const { stderr, stdout } = error as { stderr?: string; stdout?: string }
    const output = `${stdout ?? ""}${stderr ?? ""}`.trim().split("\n").slice(-40).join("\n")
    throw new Error(
      "these suites run BUILT OUTPUT, and building it failed — so there is no `dist` worth " +
        `testing. Fix the build, then re-run. Command: \`pnpm build\` (this ran \`turbo ` +
        `${args.join(" ")}\` from ${repoRoot}).\n\n${output}`,
    )
  }

  // Cheap cross-check that the filter really produced outputs, in case turbo's
  // `outputs` globs ever drift away from `dist/**`.
  for (const { dir, name } of packages) {
    if (!existsSync(join(dir, "dist"))) {
      throw new Error(
        `${name} reported a successful build but has no \`dist\` at ${join(dir, "dist")}. ` +
          "Run `pnpm build` at the repo root.",
      )
    }
  }
  return packages
}

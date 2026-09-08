import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const gatePath = "test/security-dependencies/brand-migration.test.ts"
const inventoryPath = "test/security-dependencies/fixtures/brand-migration-exceptions.json"

const reasons = {
  "historical-changelog": "Published release notes retain the names of the released artifacts.",
  "archived-design": "Dated designs and developer analyses describe their original implementation.",
  "migration-explanation": "Migration decisions explain the original identity without enabling it.",
  "frozen-release-evidence": "Original release records remain bound to the identity they attest.",
  "historical-release-tool":
    "Incident tools and protocols operate on the original release identity.",
  "historical-fixture": "Incident fixtures and their tests exercise the original evidence exactly.",
  "negative-regression-fixture": "Negative tests must name the identity they reject.",
  "retired-domain-detection": "The existing documentation guard must recognize retired domains.",
} as const

type ExceptionReason = keyof typeof reasons
type ExceptionEntry = {
  readonly path: string
  readonly reason: ExceptionReason
  readonly sha256: string
}

// Match identifiers, filenames, plain URLs, and escaped URL regexes. No active
// documentation or package directory is exempt from this check.
const forbiddenBrand = /dawn|b4(?:\\+)?\.sh/i

function legacyLines(source: string): readonly string[] {
  return source.split(/\r?\n/).filter((line) => forbiddenBrand.test(line))
}

function legacyDigest(source: string): string {
  // Line numbers are excluded so new, correctly branded release notes can be
  // added above historical entries without changing their approved content.
  return createHash("sha256")
    .update(JSON.stringify(legacyLines(source)))
    .digest("hex")
}

function violation(
  path: string,
  source: string,
  exceptions: ReadonlyMap<string, ExceptionEntry>,
): string | undefined {
  const exception = exceptions.get(path)
  const hasLegacyBrand = forbiddenBrand.test(path) || legacyLines(source).length > 0
  if (exception) {
    return !hasLegacyBrand || legacyDigest(source) !== exception.sha256
      ? `${path}: approved legacy lines changed; review this exact exception`
      : undefined
  }
  return hasLegacyBrand ? `${path}: stale brand in tracked filename or text` : undefined
}

function loadExceptions(): ReadonlyMap<string, ExceptionEntry> {
  // Only this inventory is treated as control data rather than product text.
  // Its exact schema permits reviewed paths, reason IDs, and digests only.
  const inventory = JSON.parse(readFileSync(resolve(repoRoot, inventoryPath), "utf8")) as {
    readonly schemaVersion: number
    readonly exceptions: readonly ExceptionEntry[]
  }
  expect(Object.keys(inventory).sort()).toEqual(["exceptions", "schemaVersion"])
  expect(inventory.schemaVersion).toBe(1)
  expect(Array.isArray(inventory.exceptions)).toBe(true)
  const indexed = new Map<string, ExceptionEntry>()
  for (const entry of inventory.exceptions) {
    expect(Object.keys(entry).sort()).toEqual(["path", "reason", "sha256"])
    expect(entry.path).toMatch(/^[a-zA-Z0-9_.][a-zA-Z0-9_./-]*$/)
    expect(entry.path.split("/")).not.toContain("..")
    expect(entry.path).not.toBe(inventoryPath)
    expect(Object.hasOwn(reasons, entry.reason)).toBe(true)
    expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(indexed.has(entry.path), `${entry.path}: duplicate exception`).toBe(false)
    indexed.set(entry.path, entry)
  }
  return indexed
}

describe("tracked repository brand migration", () => {
  it.each([
    ["packages/sdk/src/index.ts", "export type DawnAgent = unknown"],
    ["packages/cli/src/config.ts", 'const file = "dawn.config.ts"'],
    ["packages/cli/src/env.ts", "process.env.DAWN_PERMISSIONS_MODE"],
    ["apps/web/content/docs/setup.mdx", "Install @dawn-ai/sdk"],
    ["apps/web/content/docs/setup.mdx", "https://dawnai.org/docs"],
    ["apps/web/content/docs/setup.mdx", "https://dawn-ai.org/docs"],
    ["packages/sdk/src/index.ts", 'export * from "@b4.sh/sdk"'],
    ["apps/web/content/docs/setup.mdx", "https://b4.sh/docs"],
    ["packages/cli/test/url.test.ts", String.raw`/b4\.sh\/docs/`],
    ["packages/core/src/discovery/find-dawn-app.ts", "export {}"],
    ["examples/chat/server/.dawn/state.json", "{}"],
    ["docs/b4.sh/setup.md", "Setup"],
  ])("rejects an unapproved identity in %s", (path, source) => {
    expect(violation(path, source, new Map())).toContain("stale brand")
  })

  it("accepts the chosen package, CLI, domain, configuration, and state names", () => {
    expect(
      violation(
        "packages/create-b4-app/src/index.ts",
        "B4.run https://b4.run @b4run/sdk b4 dev b4.config.ts .b4 loadB4Config B4_PERMISSIONS_MODE",
        new Map(),
      ),
    ).toBeUndefined()
  })

  it("does not turn an exact historical exception into a directory or file-wide exemption", () => {
    const path = "packages/sdk/CHANGELOG.md"
    const historical = "Released @dawn-ai/sdk at the original version."
    const exceptions = new Map<string, ExceptionEntry>([
      [path, { path, reason: "historical-changelog", sha256: legacyDigest(historical) }],
    ])
    expect(violation(path, `New @b4run/sdk release.\n${historical}`, exceptions)).toBeUndefined()
    expect(violation(path, `${historical}\nInstall @dawn-ai/sdk today.`, exceptions)).toContain(
      "approved legacy lines changed",
    )
    expect(violation("packages/sdk/README.md", historical, exceptions)).toContain("stale brand")
    expect(violation(path, `${historical}\nhttps://b4.sh`, exceptions)).toContain(
      "approved legacy lines changed",
    )
  })

  it("rejects stale tracked filenames and text, including tracked generated files", () => {
    const tracked = new Set(
      execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
        .split("\0")
        .filter(Boolean),
    )
    // Exercise the new files even before staging; CI sees them through ls-files.
    tracked.add(gatePath)
    tracked.add(inventoryPath)
    const exceptions = loadExceptions()
    for (const path of exceptions.keys()) {
      expect(tracked.has(path), `${path}: exception must name an existing tracked file`).toBe(true)
    }
    const failures: string[] = []
    for (const path of [...tracked].sort()) {
      if (path === inventoryPath) continue
      const bytes = readFileSync(resolve(repoRoot, path))
      let source = ""
      if (!bytes.includes(0)) {
        try {
          source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
        } catch {
          // Binary assets are not text; their tracked filenames are still checked.
        }
      }
      const failure = violation(path, source, exceptions)
      if (failure) failures.push(failure)
    }
    expect(failures).toEqual([])
  })
})

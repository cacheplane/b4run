import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as generatorModule from "../../scripts/generate-seo-lastmod.mjs"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(testDirectory, "..", "..")
const repoRoot = resolve(appRoot, "..", "..")
const generator = join(appRoot, "scripts", "generate-seo-lastmod.mjs")
const generatedManifest = join(appRoot, "app", "seo", "lastmod.generated.json")
const temporaryDirectories: string[] = []

function runGenerator(...args: string[]) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: appRoot,
    encoding: "utf8",
  })
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true })
})

/**
 * Why every `--check` assertion carries the child's own output: a stale
 * manifest is the single most common way this file fails, the generator
 * already prints the exact command that fixes it, and asserting on the exit
 * code alone threw that message away. CI showed "expected 1 to be +0" and
 * nothing else, which says neither what is wrong nor what to run (#710).
 */
const checkFailure = (result: { readonly stderr: string; readonly stdout: string }): string =>
  [result.stderr, result.stdout].filter(Boolean).join("\n").trim() ||
  "the generator exited non-zero and printed nothing"

describe("generate-seo-lastmod", () => {
  // The committed manifest is regenerated on main by .github/workflows/seo-lastmod.yml,
  // not by whoever edits a page, so these assert the generator's own round trip
  // rather than that the checked-in file is currently up to date. Asserting the
  // latter made every docs branch regenerate a shared artifact and conflict with
  // every other docs branch inside it.
  it("accepts a manifest it just generated from today's production visibility", () => {
    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const output = join(directory, "lastmod.generated.json")

    expect(runGenerator("--output", output).status).toBe(0)
    expect(runGenerator("--check", "--output", output).status).toBe(0)
  })

  it("checks an unchanged manifest without consulting Git history", () => {
    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const output = join(directory, "lastmod.generated.json")
    const withoutGit = { ...process.env, PATH: "" }

    expect(
      spawnSync(process.execPath, [generator, "--output", output], {
        cwd: appRoot,
        encoding: "utf8",
        env: withoutGit,
      }).status,
    ).toBe(0)

    const result = spawnSync(process.execPath, [generator, "--check", "--output", output], {
      cwd: appRoot,
      encoding: "utf8",
      env: withoutGit,
    })

    expect(result.status, checkFailure(result)).toBe(0)
  })

  it("covers every route the site renders", () => {
    // The gate a pull request still has to satisfy. Timestamps drift harmlessly
    // and are corrected on main; a missing route has no timestamp at all and
    // makes requireValidLastModified throw during the build.
    const result = runGenerator("--check-routes")

    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
  })

  it("keeps the manifest unmergeable so a conflict leaves regenerable JSON", () => {
    // The guard for `.gitattributes`. Git writes conflict markers into a file
    // it tries to merge, and markers inside the manifest make it unparseable —
    // so the generator cannot run, and the one command that resolves the
    // conflict is blocked until someone hand-edits generated content. `-merge`
    // keeps one clean side in the worktree instead. Asserted through
    // `check-attr`, which reads whatever a real clone would apply.
    const attribute = spawnSync(
      "git",
      ["check-attr", "merge", "--", "apps/web/app/seo/lastmod.generated.json"],
      { cwd: repoRoot, encoding: "utf8" },
    )

    expect(attribute.status, attribute.stderr).toBe(0)
    expect(attribute.stdout.trim()).toMatch(/merge: unset$/)
  })

  it("reports a route the manifest has never seen", () => {
    const manifest = JSON.parse(readFileSync(generatedManifest, "utf8"))
    const [droppedRoute] = Object.keys(manifest.routes).filter((route) =>
      route.startsWith("/docs/"),
    )
    expect(droppedRoute).toBeDefined()
    delete manifest.routes[droppedRoute as string]

    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const incomplete = join(directory, "lastmod.generated.json")
    writeFileSync(incomplete, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = runGenerator("--check-routes", "--output", incomplete)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("missing routes")
    expect(result.stderr).toContain(droppedRoute as string)
    expect(result.stderr).toContain("pnpm --dir apps/web seo:lastmod")
  })

  it("reports a route the manifest still covers after removal", () => {
    const manifest = JSON.parse(readFileSync(generatedManifest, "utf8"))
    manifest.routes["/docs/removed-page"] = {
      lastModified: "2026-01-01T00:00:00.000Z",
      sourceDigest: "0".repeat(64),
      recordDigest: "0".repeat(64),
    }

    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const stale = join(directory, "lastmod.generated.json")
    writeFileSync(stale, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = runGenerator("--check-routes", "--output", stale)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("removed routes")
    expect(result.stderr).toContain("/docs/removed-page")
  })

  it("tolerates a timestamp that main has not refreshed yet", () => {
    // The whole point of moving regeneration to main: an edited page whose
    // timestamp is still the old one must not fail a pull request.
    const manifest = JSON.parse(readFileSync(generatedManifest, "utf8"))
    const [route] = Object.keys(manifest.routes)
    manifest.routes[route as string].sourceDigest = "1".repeat(64)

    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const drifted = join(directory, "lastmod.generated.json")
    writeFileSync(drifted, `${JSON.stringify(manifest, null, 2)}\n`)

    expect(runGenerator("--check-routes", "--output", drifted).status).toBe(0)
  })

  it("preserves a timestamp while the sources behind a route are unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const output = join(directory, "lastmod.generated.json")

    expect(runGenerator("--output", output).status).toBe(0)
    const first = JSON.parse(readFileSync(output, "utf8"))

    expect(runGenerator("--output", output).status).toBe(0)
    const second = JSON.parse(readFileSync(output, "utf8"))

    // This is the property that forces the manifest to stay committed: the
    // file is the only record of when a route last changed, so a regeneration
    // over an existing manifest must carry its timestamps forward unchanged.
    expect(second).toEqual(first)
  })

  it("generates timestamps for new content state without consulting Git history", () => {
    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const output = join(directory, "lastmod.generated.json")
    const startedAt = Date.now()
    const result = spawnSync(process.execPath, [generator, "--output", output], {
      cwd: appRoot,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
    })
    const finishedAt = Date.now()

    expect(result.status).toBe(0)

    const manifest = JSON.parse(readFileSync(output, "utf8"))
    const generatedTimestamp = Date.parse(manifest.routes["/"].lastModified)

    expect(generatedTimestamp).toBeGreaterThanOrEqual(startedAt)
    expect(generatedTimestamp).toBeLessThanOrEqual(finishedAt)
  })

  it("normalizes Windows-style relative paths before deriving manifest keys", () => {
    expect(generatorModule.normalizeRelativePath("content\\docs\\api\\sdk.mdx")).toBe(
      "content/docs/api/sdk.mdx",
    )
  })

  it("derives homepage metadata from the current homepage component tree", () => {
    expect(
      generatorModule
        .homepageSourceFiles(appRoot)
        .map((source: string) => source.slice(appRoot.length + 1)),
    ).toContain("app/components/homepage/DeveloperHome.tsx")
  })

  it("preserves a generated timestamp when the source digest still matches", () => {
    expect(
      generatorModule.selectLastModified(
        {
          lastModified: "2026-08-26T20:23:52.000Z",
          sourceDigest: "same-content",
          recordDigest: generatorModule.recordDigest(
            "/docs/example",
            "2026-08-26T20:23:52.000Z",
            "same-content",
          ),
        },
        "/docs/example",
        "same-content",
        "2026-08-31T23:34:54.000Z",
      ),
    ).toBe("2026-08-26T20:23:52.000Z")
  })

  it("uses the current generation timestamp when the source digest changes", () => {
    expect(
      generatorModule.selectLastModified(
        {
          lastModified: "2026-08-26T20:23:52.000Z",
          sourceDigest: "old-content",
          recordDigest: generatorModule.recordDigest(
            "/docs/example",
            "2026-08-26T20:23:52.000Z",
            "old-content",
          ),
        },
        "/docs/example",
        "new-content",
        "2026-08-31T23:34:54.000Z",
      ),
    ).toBe("2026-08-31T23:34:54.000Z")
  })

  it("uses the current generation timestamp when the preserved timestamp is malformed", () => {
    expect(
      generatorModule.selectLastModified(
        {
          lastModified: "not-a-date",
          sourceDigest: "same-content",
          recordDigest: "invalid",
        },
        "/docs/example",
        "same-content",
        "2026-08-31T23:34:54.000Z",
      ),
    ).toBe("2026-08-31T23:34:54.000Z")
  })

  it("recognizes a symlinked direct invocation of the generator", () => {
    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const symlink = join(directory, "generate-seo-lastmod.mjs")
    symlinkSync(generator, symlink)

    expect(generatorModule.isDirectExecution(symlink, generator)).toBe(true)
  })

  it("fails check mode for a stale target without changing the checked-in manifest", () => {
    const originalManifest = readFileSync(generatedManifest, "utf8")
    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const staleManifest = join(directory, "lastmod.generated.json")
    writeFileSync(staleManifest, "stale\n")

    const result = runGenerator("--as-of", "2026-08-26", "--check", "--output", staleManifest)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("SEO last-modified manifest is stale")
    expect(result.stderr).toContain("pnpm --dir apps/web seo:lastmod --as-of 2026-08-26")
    expect(readFileSync(generatedManifest, "utf8")).toBe(originalManifest)
  })

  it("fails check mode when a preserved timestamp is moved into the future", () => {
    const directory = mkdtempSync(join(tmpdir(), "b4-lastmod-"))
    temporaryDirectories.push(directory)
    const tamperedManifest = join(directory, "lastmod.generated.json")
    const manifest = JSON.parse(readFileSync(generatedManifest, "utf8"))
    manifest.routes["/"].lastModified = "2099-01-01T00:00:00.000Z"
    manifest.routes["/"].recordDigest = generatorModule.recordDigest(
      "/",
      manifest.routes["/"].lastModified,
      manifest.routes["/"].sourceDigest,
    )
    writeFileSync(tamperedManifest, `${JSON.stringify(manifest, null, 2)}\n`)

    const result = runGenerator("--check", "--output", tamperedManifest)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("SEO last-modified manifest is stale")
  })

  it("uses the explicit as-of date when checking the checked-in manifest", () => {
    const beforeJune = runGenerator("--as-of", "2026-05-18", "--check")

    expect(beforeJune.status).toBe(1)
    expect(beforeJune.stderr).toContain("SEO last-modified manifest is stale")
  })
})

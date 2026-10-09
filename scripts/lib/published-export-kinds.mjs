import { execFileSync } from "node:child_process"

/**
 * The `typeof` of every export of `specifier` as a consumer resolves it: a fresh
 * Node process imports the package by name from `packageDir`, so the package's own
 * `exports` map and built `dist/` answer, as they will once installed from npm.
 * Packages compare this with scripts/release/smoke/published-surface.mjs.
 */
export function publishedExportKinds(packageDir, specifier) {
  const source = `const namespace = await import(${JSON.stringify(specifier)})
process.stdout.write(JSON.stringify(Object.fromEntries(
  Object.keys(namespace).sort().map((name) => [name, typeof namespace[name]]),
)))
`
  return JSON.parse(
    execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: packageDir,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  )
}

/** The probe's expectations for `specifier`, beside what the package really exports. */
export function publishedProbeExpectation(packageDir, specifier, expected) {
  const actual = publishedExportKinds(packageDir, specifier)
  return {
    actual: Object.fromEntries(Object.keys(expected).map((name) => [name, actual[name]])),
    expected: { ...expected },
  }
}

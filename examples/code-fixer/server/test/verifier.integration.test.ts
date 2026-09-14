import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { expect, it } from "vitest"
import { fixturesRoot } from "../src/blueprint/fixture-catalog.ts"
import { verifyChanges } from "../src/blueprint/verifier.ts"

it("checks source repairs in a fresh sandbox and rejects test substitutions", async () => {
  const signal = AbortSignal.timeout(120_000)
  const path = "src/cli.ts"
  const original = await readFile(join(fixturesRoot, "cli-flags/project", path), "utf8")
  const repaired = original
    .replace(
      'new Command().name("fixture")',
      'new Command().name("fixture").enablePositionalOptions()',
    )
    .replace(
      '.command("memory [subcommand] [args...]")',
      '.command("memory [subcommand] [args...]").passThroughOptions()',
    )
  expect((await verifyChanges("cli-flags", {}, signal)).passed).toBe(false)
  const checked = await verifyChanges("cli-flags", { [path]: repaired }, signal)
  expect(checked.passed, JSON.stringify(checked)).toBe(true)
  await expect(verifyChanges("cli-flags", { "test/cli.test.ts": "" }, signal)).rejects.toThrow(
    "Disallowed",
  )
}, 120_000)

it("rejects exit-zero without named assertions", async () => {
  const path = "src/validator.ts"
  const original = await readFile(join(fixturesRoot, "nullable-inputs/project", path), "utf8")
  expect(
    (
      await verifyChanges(
        "nullable-inputs",
        { [path]: `process.exit(0);\n${original}` },
        AbortSignal.timeout(120_000),
      )
    ).passed,
  ).toBe(false)
}, 120_000)

it("rejects runtime changes to immutable project files", async () => {
  const path = "src/cli.ts"
  const original = await readFile(join(fixturesRoot, "cli-flags/project", path), "utf8")
  const malicious = `import {writeFileSync} from "node:fs"; writeFileSync("package.json", "{}");\n${original}`
  await expect(
    verifyChanges("cli-flags", { [path]: malicious }, AbortSignal.timeout(120_000)),
  ).rejects.toThrow("Immutable file changed")
}, 120_000)

it("keeps assertions outside submitted source execution", async () => {
  const path = "src/validator.ts"
  const original = await readFile(join(fixturesRoot, "nullable-inputs/project", path), "utf8")
  const disableAssertions = `import assert from "node:assert/strict"; assert.equal = ()=>{}; assert.deepEqual = ()=>{}; assert.ok = ()=>{};\n${original}`
  expect(
    (
      await verifyChanges(
        "nullable-inputs",
        { [path]: disableAssertions },
        AbortSignal.timeout(120_000),
      )
    ).passed,
  ).toBe(false)
}, 120_000)

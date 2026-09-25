import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { TargetSchema, targetsDir } from "../src/lib/targets/catalog.ts"
import {
  parseVitestCommand,
  vitestTestArgv,
  withExcludes,
} from "../src/lib/targets/vitest-command.ts"

const pkg = (test: string | undefined) => ({
  name: "@m/x",
  dir: "packages/x",
  manifest: { name: "@m/x", ...(test === undefined ? {} : { scripts: { test } }) },
})
const shipped = (id: string) =>
  TargetSchema.parse(JSON.parse(readFileSync(join(targetsDir, id, "target.json"), "utf8")))

describe("a package's test script as a target's test command", () => {
  it("runs it through pnpm exec, once, without vitest's cache", () => {
    expect(vitestTestArgv(pkg("vitest --run --config vitest.config.ts"))).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--no-cache",
      "--config",
      "vitest.config.ts",
    ])
    expect(vitestTestArgv(pkg("vitest run"))).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--no-cache",
    ])
    expect(vitestTestArgv(pkg("vitest"))).toEqual(["pnpm", "exec", "vitest", "--run", "--no-cache"])
    expect(vitestTestArgv(pkg("vitest --run --no-cache --passWithNoTests"))).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--no-cache",
      "--passWithNoTests",
    ])
  })

  it("refuses what is not a plain vitest run", () => {
    expect(() => vitestTestArgv(pkg(undefined))).toThrow(/has no test script/)
    expect(() => vitestTestArgv(pkg("node --test test"))).toThrow(/vitest targets only/)
    expect(() => vitestTestArgv(pkg("vitest --run && echo done"))).toThrow(/is a shell line/)
    expect(() => vitestTestArgv(pkg("vitest watch"))).toThrow(/passes "watch"/)
    expect(() => vitestTestArgv(pkg("vitest --run --coverage"))).toThrow(/passes "--coverage"/)
    expect(() => vitestTestArgv(pkg("vitest --run test/a.test.ts"))).toThrow(
      /passes "test\/a.test.ts"/,
    )
  })
})

describe("reading a test command back", () => {
  it("splits the shipped devkit command into its base and nine excludes, and rebuilds it exactly", () => {
    const test = shipped("devkit").commands.test
    const command = parseVitestCommand(test)
    expect(command.base).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--no-cache",
      "--config",
      "vitest.config.ts",
    ])
    expect(command.config).toBe("vitest.config.ts")
    expect(command.files).toEqual([])
    expect(command.excludes).toHaveLength(9)
    expect(withExcludes(command, command.excludes)).toEqual(test)
  })

  it("keeps the shipped cli command's scope of eight files", () => {
    const test = shipped("cli").commands.test
    const command = parseVitestCommand(test)
    expect(command.files).toHaveLength(8)
    expect(command.excludes).toEqual([])
    expect(withExcludes(command, [])).toEqual(test)
  })

  it("sorts and de-duplicates excludes, and refuses a shape it cannot read", () => {
    const command = parseVitestCommand([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--exclude=b",
      "a.test.ts",
    ])
    expect(command.excludes).toEqual(["b"])
    expect(withExcludes(command, ["z", "b", "z"])).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "a.test.ts",
      "--exclude",
      "b",
      "--exclude",
      "z",
    ])
    expect(() => parseVitestCommand(["npm", "test"])).toThrow(/pnpm exec vitest/)
    expect(() => parseVitestCommand(["pnpm", "exec", "vitest", "--exclude"])).toThrow(
      /--exclude with no value/,
    )
    expect(() => parseVitestCommand(["pnpm", "exec", "vitest", "--project", "a"])).toThrow(
      /--project/,
    )
  })
})

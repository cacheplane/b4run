import { describe, expect, expectTypeOf, test } from "vitest"
import {
  BUILD_TARGET_NAMES,
  type BuildTargetName,
  isBuildTargetName,
} from "../src/build-targets.ts"
import { config } from "../src/config-helper.ts"
import type { B4Config } from "../src/types.ts"

describe("BuildTargetName", () => {
  test("is exactly the union of the registered target names", () => {
    expectTypeOf<BuildTargetName>().toEqualTypeOf<"node" | "langsmith" | "hono" | "vercel">()
  })

  test("build.targets accepts known target names", () => {
    const c = config({ build: { targets: ["node", "langsmith", "hono", "vercel"] } })
    expect(c.build?.targets).toEqual(["node", "langsmith", "hono", "vercel"])
    expectTypeOf<NonNullable<NonNullable<B4Config["build"]>["targets"]>>().toEqualTypeOf<
      readonly BuildTargetName[]
    >()
  })

  test("build.targets rejects a misspelled target at compile time", () => {
    // @ts-expect-error "vercell" is not a known build target (issue #686).
    const c = config({ build: { targets: ["vercell"] } })
    expect(c.build?.targets).toEqual(["vercell"])
  })

  test("build.targets rejects arbitrary strings (no plugin escape hatch)", () => {
    const targets: string[] = ["node"]
    // @ts-expect-error a plain string[] is not narrowed to the known names.
    const c: B4Config = { build: { targets } }
    expect(c.build?.targets).toBe(targets)
  })
})

describe("isBuildTargetName", () => {
  test("accepts every registered name and narrows the type", () => {
    for (const name of BUILD_TARGET_NAMES) expect(isBuildTargetName(name)).toBe(true)
    const candidate: string = "node"
    if (isBuildTargetName(candidate)) expectTypeOf(candidate).toEqualTypeOf<BuildTargetName>()
  })

  test("rejects unknown and near-miss names", () => {
    expect(isBuildTargetName("vercell")).toBe(false)
    expect(isBuildTargetName("")).toBe(false)
    expect(isBuildTargetName("NODE")).toBe(false)
  })
})

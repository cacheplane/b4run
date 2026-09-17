import { BUILD_TARGET_NAMES, type BuildTargetName } from "@b4run/core"
import { describe, expect, expectTypeOf, test } from "vitest"

import {
  type BuildTarget,
  buildTargets,
  DEFAULT_BUILD_TARGETS,
  knownTargetNames,
} from "../src/lib/build/targets/index.js"

describe("build target registry", () => {
  test("registers exactly the names @b4run/core types build.targets with", () => {
    // The type keeps the two in sync at compile time; this pins it at runtime
    // too, so a future `as` cast in the registry cannot quietly reopen the gap.
    expect(new Set(Object.keys(buildTargets))).toEqual(new Set(BUILD_TARGET_NAMES))
    expect(new Set(knownTargetNames())).toEqual(new Set(BUILD_TARGET_NAMES))
  })

  test("every registered target reports the name it is keyed by", () => {
    for (const [key, target] of Object.entries(buildTargets)) expect(target.name).toBe(key)
  })

  test("the registry is keyed by the core union, not by string", () => {
    expectTypeOf(buildTargets).toEqualTypeOf<Readonly<Record<BuildTargetName, BuildTarget>>>()
    expectTypeOf(DEFAULT_BUILD_TARGETS).toEqualTypeOf<readonly BuildTargetName[]>()
    expectTypeOf(knownTargetNames()).toEqualTypeOf<readonly BuildTargetName[]>()
  })
})

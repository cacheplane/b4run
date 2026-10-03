import { describe, expect, test } from "vitest"

import { impliedToolDenials, resolveToolScope, toolOrigin } from "../src/tool-scope.js"

const A = (name: string) => ({ name, origin: "authored" as const })
const C = (name: string) => ({ name, origin: "capability" as const })

describe("toolOrigin", () => {
  test("capability filePath marker → capability", () => {
    expect(toolOrigin({ filePath: "<capability:runBash>" })).toBe("capability")
  })
  test("real path → authored", () => {
    expect(toolOrigin({ filePath: "/app/src/app/research/tools/search.ts" })).toBe("authored")
  })
})

describe("resolveToolScope", () => {
  const tools = [
    A("search"),
    A("writeNote"),
    C("readFile"),
    C("writeFile"),
    C("runBash"),
    C("task"),
  ]

  test("top route, no scope → all tools", () => {
    const keep = resolveToolScope(tools, undefined, { isSubagent: false, routeId: "/r" })
    expect([...keep].sort()).toEqual([
      "readFile",
      "runBash",
      "search",
      "task",
      "writeFile",
      "writeNote",
    ])
  })

  test("subagent, no scope → authored only (capabilities withheld)", () => {
    const keep = resolveToolScope(tools, undefined, { isSubagent: true, routeId: "/r" })
    expect([...keep].sort()).toEqual(["search", "writeNote"])
  })

  test("subagent allow grants a capability tool, keeps authored", () => {
    const keep = resolveToolScope(
      tools,
      { allow: ["readFile"] },
      { isSubagent: true, routeId: "/r" },
    )
    expect([...keep].sort()).toEqual(["readFile", "search", "writeNote"])
  })

  test("top route deny revokes", () => {
    const keep = resolveToolScope(
      tools,
      { deny: ["runBash"] },
      { isSubagent: false, routeId: "/r" },
    )
    expect(keep.has("runBash")).toBe(false)
    expect(keep.has("readFile")).toBe(true)
  })

  test("deny wins over allow", () => {
    const keep = resolveToolScope(
      tools,
      { allow: ["readFile"], deny: ["readFile"] },
      { isSubagent: true, routeId: "/r" },
    )
    expect(keep.has("readFile")).toBe(false)
  })

  test("subagent deny can drop an authored tool", () => {
    const keep = resolveToolScope(
      tools,
      { deny: ["writeNote"] },
      { isSubagent: true, routeId: "/r" },
    )
    expect([...keep].sort()).toEqual(["search"])
  })

  test("unknown name throws with available list", () => {
    expect(() =>
      resolveToolScope(tools, { allow: ["serch"] }, { isSubagent: true, routeId: "/research" }),
    ).toThrow(/unknown tool\(s\): serch/)
  })

  test("throws on an unknown approve name (typos fail loud like allow/deny)", () => {
    expect(() =>
      resolveToolScope(
        [{ name: "deployProd", origin: "authored" }],
        { approve: ["deployPord"] },
        { isSubagent: false, routeId: "/ops" },
      ),
    ).toThrow(/unknown tool.*deployPord/s)
  })

  test("a known approve name does not affect which tools survive scoping", () => {
    const kept = resolveToolScope(
      [
        { name: "deployProd", origin: "authored" },
        { name: "runBash", origin: "capability" },
      ],
      { approve: ["deployProd"] },
      { isSubagent: false, routeId: "/ops" },
    )
    expect([...kept].sort()).toEqual(["deployProd", "runBash"])
  })
})

describe("resolveToolScope — denying writeFile also withholds editFile", () => {
  const tools = [A("search"), C("readFile"), C("writeFile"), C("editFile"), C("runBash")]
  const top = { isSubagent: false, routeId: "/r" }
  const sub = { isSubagent: true, routeId: "/r/subagents/s" }

  test("top route deny writeFile removes editFile too", () => {
    const keep = resolveToolScope(tools, { deny: ["writeFile"] }, top)
    expect([...keep].sort()).toEqual(["readFile", "runBash", "search"])
  })

  test("an explicit allow of editFile opts back in while writeFile stays denied", () => {
    const keep = resolveToolScope(tools, { deny: ["writeFile"], allow: ["editFile"] }, top)
    expect(keep.has("editFile")).toBe(true)
    expect(keep.has("writeFile")).toBe(false)
    const subKeep = resolveToolScope(
      tools,
      { allow: ["readFile", "editFile"], deny: ["writeFile"] },
      sub,
    )
    expect([...subKeep].sort()).toEqual(["editFile", "readFile", "search"])
  })

  test("an allow-list naming writeFile does not grant editFile", () => {
    const keep = resolveToolScope(tools, { allow: ["writeFile"] }, sub)
    expect([...keep].sort()).toEqual(["search", "writeFile"])
  })

  test("denying editFile alone leaves writeFile", () => {
    const keep = resolveToolScope(tools, { deny: ["editFile"] }, top)
    expect(keep.has("writeFile")).toBe(true)
    expect(keep.has("editFile")).toBe(false)
  })

  test("a scope without editFile available still resolves (older tool sets)", () => {
    const keep = resolveToolScope([C("readFile"), C("writeFile")], { deny: ["writeFile"] }, top)
    expect([...keep]).toEqual(["readFile"])
  })

  test("impliedToolDenials reports only what deny implies and allow did not reclaim", () => {
    expect(impliedToolDenials({ deny: ["writeFile"] })).toEqual(["editFile"])
    expect(impliedToolDenials({ deny: ["writeFile"], allow: ["editFile"] })).toEqual([])
    expect(impliedToolDenials({ deny: ["writeFile", "editFile"] })).toEqual([])
    expect(impliedToolDenials({ allow: ["writeFile"] })).toEqual([])
    expect(impliedToolDenials(undefined)).toEqual([])
  })
})

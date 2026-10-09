import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, it } from "vitest"
import { publishedExportKinds } from "../../../scripts/lib/published-export-kinds.mjs"
import {
  AG_UI_REMOVED_ROOT_TYPES,
  AG_UI_REMOVED_ROOT_VALUES,
  AG_UI_ROOT_CONSTANTS,
  AG_UI_ROOT_EXPORTS,
  AG_UI_ROOT_FUNCTIONS,
  AG_UI_ROOT_TYPES,
  PUBLISHED_PROBE_IMPORTS,
} from "../../../scripts/release/smoke/published-surface.mjs"
import * as api from "../src/index.js"

it("exports only the canonical runtime adapter surface from the package root", () => {
  expect(Object.keys(api).sort()).toEqual([
    "B4_CONTENT_PARTS_DROPPED_EVENT",
    "B4_PLAN_ACTIVITY_TYPE",
    "createCounterIdFactory",
    "createDefaultIdFactory",
    "fromRunAgentInput",
    "toAguiEvents",
  ])
})

it("exports the stable activity type literal", () => {
  expect(api.B4_PLAN_ACTIVITY_TYPE).toBe("b4.plan")
  expect(api.B4_CONTENT_PARTS_DROPPED_EVENT).toBe("b4.content_parts_dropped")
})

// The published-harness lane installs @b4run/ag-ui from npm and holds it to the
// surface declared in scripts/release/smoke/published-surface.mjs. That lane first
// runs at release time, from the frozen candidate, so a stale declaration fails a
// release that cannot be fixed in place (v0.14.0). Hold the declaration to the
// package here, where every pull request runs.
const packageDir = fileURLToPath(new URL("..", import.meta.url))

it("matches the root surface the release smoke expects of the published package", () => {
  expect([...AG_UI_ROOT_EXPORTS]).toEqual(Object.keys(api).sort())
})

it("publishes, through its exports map and build, the values the release smoke probes", () => {
  const root = publishedExportKinds(packageDir, "@b4run/ag-ui")
  expect(Object.keys(root)).toEqual([...AG_UI_ROOT_EXPORTS])
  for (const name of AG_UI_ROOT_FUNCTIONS) expect(root[name], name).toBe("function")
  for (const name of Object.keys(AG_UI_ROOT_CONSTANTS)) expect(root[name], name).toBe("string")
  for (const specifier of ["@b4run/ag-ui", "@b4run/ag-ui/sse"]) {
    const expected = PUBLISHED_PROBE_IMPORTS[specifier] ?? {}
    expect(Object.keys(expected), specifier).not.toHaveLength(0)
    const actual = publishedExportKinds(packageDir, specifier)
    expect(
      Object.fromEntries(Object.keys(expected).map((name) => [name, actual[name]])),
      specifier,
    ).toEqual({ ...expected })
  }
}, 30_000)

it("holds the root constants at the values the release smoke asserts", () => {
  const values: Record<string, unknown> = { ...api }
  for (const [name, value] of Object.entries(AG_UI_ROOT_CONSTANTS)) {
    expect(values[name], name).toBe(value)
  }
})

it("declares the root types the release smoke's TypeScript probe imports, and none it rejects", () => {
  // The probe compiles against the published declarations: read the same file
  // the exports map hands a consumer.
  const declarations = fileURLToPath(new URL("../dist/index.d.ts", import.meta.url))
  const program = ts.createProgram([declarations], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  })
  const checker = program.getTypeChecker()
  const source = program.getSourceFile(declarations)
  const moduleSymbol = source && checker.getSymbolAtLocation(source)
  expect(moduleSymbol, "dist/index.d.ts must be built").toBeDefined()
  const exported = new Map(
    checker.getExportsOfModule(moduleSymbol as ts.Symbol).map((symbol) => {
      const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol
      return [symbol.getName(), target.flags] as const
    }),
  )
  for (const name of AG_UI_ROOT_TYPES) {
    expect((exported.get(name) ?? 0) & ts.SymbolFlags.Type, `type ${name}`).not.toBe(0)
  }
  for (const name of AG_UI_ROOT_EXPORTS) {
    expect((exported.get(name) ?? 0) & ts.SymbolFlags.Value, `value ${name}`).not.toBe(0)
  }
  for (const name of [...AG_UI_REMOVED_ROOT_TYPES, ...AG_UI_REMOVED_ROOT_VALUES]) {
    expect(exported.has(name), `${name} must stay out of the root`).toBe(false)
  }
})

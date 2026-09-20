import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { UnresolvedToolInputTypeError } from "../src/compiler/index.js"
import { extractToolSchemasForRoute } from "../src/typegen/extract-tool-schema.js"

let appRoot: string

beforeEach(() => {
  appRoot = mkdtempSync(join(tmpdir(), "b4-extract-schema-tsconfig-"))
})

afterEach(() => {
  rmSync(appRoot, { recursive: true, force: true })
})

function writeFile(relativePath: string, content: string): string {
  const filePath = join(appRoot, relativePath)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
  return filePath
}

const CONTRACTS_SOURCE = `
export interface RenderInput {
  /** Markdown shown above the components. */
  readonly text: string
  readonly components: ReadonlyArray<{ readonly kind: "card" | "chart"; readonly id: string }>
}
`

const ALIASED_TOOL_SOURCE = `
import type { RenderInput } from "@fixture/contracts"

/** Render a set of components. */
export default async function render(input: RenderInput) {
  return { ok: true, count: input.components.length }
}
`

function expectRenderSchema(schemas: Awaited<ReturnType<typeof extractToolSchemasForRoute>>) {
  expect(schemas).toHaveLength(1)
  const parameters = schemas[0]?.parameters
  expect(parameters?.required).toEqual(["text", "components"])
  expect(parameters?.properties.text).toEqual({
    type: "string",
    description: "Markdown shown above the components.",
  })
  expect(parameters?.properties.components?.type).toBe("array")
}

// These suites build a TypeScript program per case; see the sibling
// extract-tool-schema.test.ts for why the timeout is generous.
describe("extractToolSchemasForRoute with the app's tsconfig", {
  timeout: 30_000,
}, () => {
  test("resolves an input type imported through a tsconfig `paths` alias", async () => {
    writeFile(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: { "@fixture/contracts": ["./shared/src/contracts.ts"] },
        },
      }),
    )
    writeFile("shared/src/contracts.ts", CONTRACTS_SOURCE)
    writeFile("src/app/assistant/tools/render.ts", ALIASED_TOOL_SOURCE)

    const schemas = await extractToolSchemasForRoute({
      routeDir: join(appRoot, "src/app/assistant"),
      sharedToolsDir: join(appRoot, "src"),
    })

    expectRenderSchema(schemas)
  })

  test("honors `extends` when the alias lives in a base config", async () => {
    writeFile(
      "tsconfig.base.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@fixture/*": ["./shared/src/*"] },
        },
      }),
    )
    writeFile(
      "server/tsconfig.json",
      JSON.stringify({
        extends: "../tsconfig.base.json",
        compilerOptions: {
          strict: true,
          module: "ESNext",
          moduleResolution: "Bundler",
        },
      }),
    )
    writeFile("shared/src/contracts.ts", CONTRACTS_SOURCE)
    writeFile("server/src/app/assistant/tools/render.ts", ALIASED_TOOL_SOURCE)

    const schemas = await extractToolSchemasForRoute({
      appRoot: join(appRoot, "server"),
      routeDir: join(appRoot, "server/src/app/assistant"),
      sharedToolsDir: join(appRoot, "server/src"),
    })

    expectRenderSchema(schemas)
  })

  test("uses an explicit `tsconfig` option instead of searching", async () => {
    const tsconfig = writeFile(
      "config/tsconfig.tools.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          baseUrl: "..",
          paths: { "@fixture/contracts": ["./shared/src/contracts.ts"] },
        },
      }),
    )
    writeFile("shared/src/contracts.ts", CONTRACTS_SOURCE)
    writeFile("src/app/assistant/tools/render.ts", ALIASED_TOOL_SOURCE)

    const schemas = await extractToolSchemasForRoute({
      routeDir: join(appRoot, "src/app/assistant"),
      sharedToolsDir: join(appRoot, "src"),
      tsconfig,
    })

    expectRenderSchema(schemas)
  })

  test("fails loudly when the declared input type does not resolve", async () => {
    // No tsconfig at all: the alias cannot resolve and the type becomes `any`.
    writeFile("shared/src/contracts.ts", CONTRACTS_SOURCE)
    const toolFile = writeFile("src/app/assistant/tools/render.ts", ALIASED_TOOL_SOURCE)

    const error = await extractToolSchemasForRoute({
      routeDir: join(appRoot, "src/app/assistant"),
      sharedToolsDir: join(appRoot, "src"),
    }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(UnresolvedToolInputTypeError)
    const message = (error as Error).message
    expect(message).toContain(toolFile)
    expect(message).toContain("render")
    expect(message).toContain("RenderInput")
    expect(message).toContain("@fixture/contracts")
  })

  test("fails when the tsconfig exists but does not declare the alias", async () => {
    writeFile("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true } }))
    writeFile("shared/src/contracts.ts", CONTRACTS_SOURCE)
    writeFile("src/app/assistant/tools/render.ts", ALIASED_TOOL_SOURCE)

    await expect(
      extractToolSchemasForRoute({
        routeDir: join(appRoot, "src/app/assistant"),
        sharedToolsDir: join(appRoot, "src"),
      }),
    ).rejects.toThrow(/RenderInput/)
  })

  test("fails when an imported member is missing from a module that does resolve", async () => {
    writeFile("shared/src/contracts.ts", "export interface Other { readonly x: number }\n")
    writeFile(
      "src/app/assistant/tools/render.ts",
      `
import type { RenderInput } from "../../../../shared/src/contracts.js"
export default async function render(input: RenderInput) { return input }
`,
    )

    await expect(
      extractToolSchemasForRoute({
        routeDir: join(appRoot, "src/app/assistant"),
        sharedToolsDir: join(appRoot, "src"),
      }),
    ).rejects.toThrow(UnresolvedToolInputTypeError)
  })

  test.each([
    ["no parameter", "export default async function ping() { return 'pong' }"],
    ["an empty `{}` literal", "export default async function ping(_input: {}) { return 'pong' }"],
    [
      "`Record<string, never>`",
      "export default async function ping(_input: Record<string, never>) { return 'pong' }",
    ],
    ["an explicit `unknown`", "export default async function ping(_input: unknown) { return 1 }"],
    ["an explicit `any`", "export default async function ping(_input: any) { return 1 }"],
    [
      "an alias that the author resolved to `{}`",
      "type Empty = {}\nexport default async function ping(_input: Empty) { return 1 }",
    ],
  ])("keeps working for a tool with %s", async (_label, source) => {
    writeFile("src/app/assistant/tools/ping.ts", source)

    const schemas = await extractToolSchemasForRoute({
      routeDir: join(appRoot, "src/app/assistant"),
      sharedToolsDir: join(appRoot, "src"),
    })

    expect(schemas).toHaveLength(1)
    expect(schemas[0]?.parameters.properties).toEqual({})
  })

  test("keeps the built-in defaults when the app has no tsconfig", async () => {
    writeFile(
      "src/app/assistant/tools/echo.ts",
      "export default async function echo(input: { readonly text: string }) { return input }",
    )

    const schemas = await extractToolSchemasForRoute({
      routeDir: join(appRoot, "src/app/assistant"),
      sharedToolsDir: join(appRoot, "src"),
    })

    expect(schemas[0]?.parameters.properties).toEqual({
      text: { type: "string" },
    })
  })
})

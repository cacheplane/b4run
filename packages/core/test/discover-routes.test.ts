import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { B4AppError } from "../src/discovery/b4-app-error.ts"
import { explainUnrecognisedRouteExports } from "../src/discovery/discover-routes.ts"
import { discoverRoutes } from "../src/node.js"

const SDK_PATH = resolve(fileURLToPath(import.meta.url), "../../../sdk")

let workspaceRoot: string

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), "b4-discover-"))
})

afterEach(async () => {
  await rm(workspaceRoot, { recursive: true, force: true })
})

async function writeApp(
  files: Readonly<Record<string, string>>,
  options: { readonly packageJson?: string } = {},
): Promise<string> {
  const appRoot = workspaceRoot

  await writeFile(
    join(appRoot, "package.json"),
    options.packageJson ?? `{"type":"module"}\n`,
    "utf8",
  )
  await writeFile(join(appRoot, "b4.config.ts"), `export default { appDir: "src/app" }\n`, "utf8")

  // Symlink @b4run/sdk so fixture files can import it
  await mkdir(join(appRoot, "node_modules/@b4run"), { recursive: true })
  await symlink(SDK_PATH, join(appRoot, "node_modules/@b4run/sdk"))

  for (const [relative, content] of Object.entries(files)) {
    const absolute = join(appRoot, relative)
    await mkdir(join(absolute, ".."), { recursive: true })
    await writeFile(absolute, content, "utf8")
  }

  return appRoot
}

describe("discoverRoutes", () => {
  it("discovers a workflow route from index.ts", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes).toHaveLength(1)
    expect(manifest.routes[0]).toMatchObject({
      pathname: "/hello",
      kind: "workflow",
    })
  })

  it("discovers a graph route from index.ts", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `export const graph = { invoke: async () => ({}) }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0]?.kind).toBe("graph")
  })

  it("throws when index.ts exports both workflow and graph", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `export async function workflow() { return {} }\nexport const graph = { invoke: async () => ({}) }\n`,
    })

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(
      /Route index\.ts must export exactly one of "agent", "workflow", "graph", or "chain"/,
    )
  })

  it("throws naming the file when index.ts has no recognisable export", async () => {
    const appRoot = await writeApp({
      "src/app/util/index.ts": `export const helper = 1\n`,
    })

    const error = await discoverRoutes({ appRoot }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(B4AppError)
    expect((error as B4AppError).code).toBe("B4_E1007")
    expect((error as Error).message).toContain(join(appRoot, "src/app/util/index.ts"))
    expect((error as Error).message).toContain("helper")
    expect((error as Error).message).toMatch(/prefix .*"_"/)
  })

  it('rejects an app root whose package.json lacks "type": "module"', async () => {
    const appRoot = await writeApp(
      {
        "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
      },
      { packageJson: `{"name":"no-type"}\n` },
    )

    const error = await discoverRoutes({ appRoot }).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(B4AppError)
    expect((error as B4AppError).code).toBe("B4_E1006")
    expect((error as Error).message).toContain(join(appRoot, "package.json"))
    expect((error as Error).message).toContain('"type": "module"')
  })

  it('rejects an app root whose package.json sets "type": "commonjs"', async () => {
    const appRoot = await writeApp(
      {
        "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
      },
      { packageJson: `{"type":"commonjs"}\n` },
    )

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(/"type": "module"/)
  })

  it("rejects an app root whose package.json is not valid JSON", async () => {
    const appRoot = await writeApp(
      {
        "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
      },
      { packageJson: `{ not json\n` },
    )

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(/package\.json is not valid JSON/)
  })

  it("strips route groups from pathnames", async () => {
    const appRoot = await writeApp({
      "src/app/(public)/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0]?.pathname).toBe("/hello")
  })

  it("preserves dynamic segments in pathnames", async () => {
    const appRoot = await writeApp({
      "src/app/hello/[tenant]/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes[0]?.pathname).toBe("/hello/[tenant]")
    expect(manifest.routes[0]?.segments).toEqual([
      { kind: "static", raw: "hello" },
      { kind: "dynamic", name: "tenant", raw: "[tenant]" },
    ])
  })

  it("skips private segments", async () => {
    const appRoot = await writeApp({
      "src/app/_internal/index.ts": `export async function workflow() { return {} }\n`,
      "src/app/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes.map((r) => r.pathname)).toEqual(["/hello"])
  })

  it("detects duplicate pathnames across route groups", async () => {
    const appRoot = await writeApp({
      "src/app/(a)/hello/index.ts": `export async function workflow() { return {} }\n`,
      "src/app/(b)/hello/index.ts": `export async function workflow() { return {} }\n`,
    })

    await expect(discoverRoutes({ appRoot })).rejects.toThrow(/Duplicate B4.run route pathname/)
  })

  it("discovers an agent route from export default agent()", async () => {
    const appRoot = await writeApp({
      "src/app/hello/index.ts": `import { agent } from "@b4run/sdk"\nexport default agent({ model: "gpt-4o-mini", systemPrompt: "hi" })\n`,
    })

    const manifest = await discoverRoutes({ appRoot })

    expect(manifest.routes).toHaveLength(1)
    expect(manifest.routes[0]).toMatchObject({
      pathname: "/hello",
      kind: "agent",
    })
  })
})

describe("explainUnrecognisedRouteExports", () => {
  const indexFile = "/app/src/app/assistant/index.ts"

  it("names the CommonJS interop shape and the nearest package.json as the likely cause", () => {
    const message = explainUnrecognisedRouteExports(
      indexFile,
      {
        default: { __esModule: true, default: {} },
        "module.exports": { __esModule: true, default: {} },
      },
      "/app/src/app/assistant/package.json",
    )

    expect(message).toContain(indexFile)
    expect(message).toContain("CommonJS")
    expect(message).toContain("/app/src/app/assistant/package.json")
    expect(message).toContain('"type": "module"')
  })

  it("detects the interop shape from the module.exports key alone", () => {
    const message = explainUnrecognisedRouteExports(
      indexFile,
      { default: 1, "module.exports": 1 },
      undefined,
    )

    expect(message).toContain("CommonJS")
    expect(message).toContain('"type": "module"')
  })

  it("lists the exports it found and the private-segment escape hatch otherwise", () => {
    const message = explainUnrecognisedRouteExports(indexFile, { helper: 1, other: 2 }, undefined)

    expect(message).toContain(indexFile)
    expect(message).toContain("helper, other")
    expect(message).not.toContain("CommonJS")
    expect(message).toMatch(/prefix .*"_"/)
  })

  it("says so when the module has no exports at all", () => {
    const message = explainUnrecognisedRouteExports(indexFile, {}, undefined)

    expect(message).toContain("no exports")
  })
})

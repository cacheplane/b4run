import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, test } from "vitest"
import { discoverToolDefinitions } from "../src/lib/runtime/tool-discovery.js"

describe("tool discovery error messages", () => {
  let appRoot: string
  let toolsDir: string

  beforeEach(() => {
    appRoot = mkdtempSync(join(tmpdir(), "b4-tooldisc-"))
    toolsDir = join(appRoot, "route", "tools")
    mkdirSync(toolsDir, { recursive: true })
  })
  afterEach(() => {
    rmSync(appRoot, { recursive: true, force: true })
  })

  function writeTool(name: string, source: string): void {
    writeFileSync(join(toolsDir, name), source, "utf8")
  }

  async function discover() {
    return discoverToolDefinitions({ appRoot, routeDir: join(appRoot, "route") })
  }

  it("names a LangChain StructuredTool-shaped default export and shows the wrapper fix", async () => {
    writeTool(
      "search.ts",
      `export default {
        name: "web_search",
        schema: {},
        invoke: async () => "results",
      }`,
    )
    await expect(discover()).rejects.toThrow(
      /default-exports a LangChain tool\(\) \(StructuredTool "web_search"\)/,
    )
    await expect(discover()).rejects.toThrow(/export default async/)
    await expect(discover()).rejects.toThrow(/b4\.run\/docs\/tools/)
  })

  it("describes a plain-object default export by its keys", async () => {
    writeTool("config.ts", `export default { apiKey: "x", region: "us" }`)
    await expect(discover()).rejects.toThrow(/an object with keys \[apiKey, region\]/)
    await expect(discover()).rejects.toThrow(/b4\.run\/docs\/tools/)
  })

  it("describes a missing default export", async () => {
    writeTool("nothing.ts", `export const helper = 1`)
    await expect(discover()).rejects.toThrow(/no default export/)
  })

  it("describes a primitive default export by type", async () => {
    writeTool("oops.ts", `export default "just a string"`)
    await expect(discover()).rejects.toThrow(/a string/)
  })

  it("still accepts a plain default-exported function", async () => {
    writeTool("greet.ts", `export default async (input: { name: string }) => input.name`)
    const tools = await discover()
    expect(tools.map((t) => t.name)).toEqual(["greet"])
  })

  it("still accepts an object with a run function", async () => {
    writeTool("runner.ts", `export default { run: async () => "ok" }`)
    const tools = await discover()
    expect(tools.map((t) => t.name)).toEqual(["runner"])
  })

  it("reads a boolean returnDirect export onto the definition", async () => {
    writeTool(
      "render.ts",
      `export const returnDirect = true
       export default async (input: { text: string }) => ({ rendered: true })`,
    )
    const tools = await discover()
    expect(tools.map((t) => [t.name, t.returnDirect])).toEqual([["render", true]])
  })

  it("leaves returnDirect absent when a tool does not export it", async () => {
    writeTool("greet.ts", `export default async (input: { name: string }) => input.name`)
    const tools = await discover()
    expect(tools[0]).not.toHaveProperty("returnDirect")
  })

  it("rejects a returnDirect export that is not a boolean", async () => {
    writeTool(
      "render.ts",
      `export const returnDirect = "yes"
       export default async () => ({ rendered: true })`,
    )
    await expect(discover()).rejects.toThrow(
      /exports returnDirect, which must be a boolean \(got a string\)/,
    )
    await expect(discover()).rejects.toThrow(/b4\.run\/docs\/tools/)
  })

  it("keeps a valid display export on the definition", async () => {
    writeTool(
      "search.ts",
      `export const display = {
        icon: "search",
        running: (input) => "Searching for " + input.query,
        done: (input, output) => "Found " + output.length + " results",
      }
      export default async (input) => [input.query]`,
    )
    const [tool] = await discover()
    expect(tool?.display?.icon).toBe("search")
    expect(tool?.display?.running?.({ query: "agents" })).toBe("Searching for agents")
  })

  it("rejects a display export whose label is not a function", async () => {
    writeTool(
      "search.ts",
      `export const display = { running: "Searching" }
      export default async () => "ok"`,
    )
    await expect(discover()).rejects.toThrow(
      /display\.running must be a function \(got "Searching"\)/,
    )
  })

  it("keeps a display export when the default export is a { run } object", async () => {
    writeTool(
      "search.ts",
      `export const display = { icon: "search" }
      export default { run: async () => "ok" }`,
    )
    const [tool] = await discover()
    expect(tool?.display?.icon).toBe("search")
  })
})

test("discovers custom tool-display icons unchanged", async () => {
  const appRoot = mkdtempSync(join(tmpdir(), "b4-open-icon-"))
  const routeDir = join(appRoot, "route")
  const toolsDir = join(routeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(
    join(toolsDir, "radar.ts"),
    'export const display = { icon: "weather-radar" }; export default async () => "clear"',
  )

  try {
    const tools = await discoverToolDefinitions({ appRoot, routeDir })

    expect(tools[0]?.display?.icon).toBe("weather-radar")
  } finally {
    rmSync(appRoot, { recursive: true, force: true })
  }
})

test("rejects an empty display icon with the field and diagnostic code", async () => {
  const appRoot = mkdtempSync(join(tmpdir(), "b4-empty-icon-"))
  const routeDir = join(appRoot, "route")
  const toolsDir = join(routeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(
    join(toolsDir, "radar.ts"),
    'export const display = { icon: "" }; export default async () => "clear"',
  )

  try {
    const discover = () => discoverToolDefinitions({ appRoot, routeDir })

    await expect(discover()).rejects.toThrow(
      /exports display, but display\.icon must be a nonempty string/,
    )
    await expect(discover()).rejects.toThrow(/B4_E5002/)
  } finally {
    rmSync(appRoot, { recursive: true, force: true })
  }
})

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { RouteToolTypes } from "@b4run/core"
import { renderB4Types, renderScenarioTypes, SCENARIO_TYPES_FILE } from "@b4run/core"
import { analyzeToolSource } from "@b4run/core/internal/compiler"
import { discoverRoutes, extractToolTypesForRoute, findB4App } from "@b4run/core/node"

import { createGeneratedIdentifierAllocator } from "./generated-identifiers.js"
import { generateZodSchema } from "./zod-generator.js"

export { generateZodSchema } from "./zod-generator.js"

const TOOLS_DIR_PATTERN = /\/tools\/[^/]+\.ts$/
const OUTPUT_FILE = "b4.generated.d.ts"

export interface B4PluginOptions {
  readonly appRoot?: string
}

export function b4ToolSchemaPlugin(options?: B4PluginOptions): {
  name: string
  configureServer?(server: {
    readonly watcher: {
      on(event: string, callback: (path: string) => void): void
    }
  }): void | Promise<void>
  buildStart?(): void | Promise<void>
  transform(code: string, id: string): { code: string } | null
} {
  return {
    name: "b4-tool-schema",

    async configureServer(server) {
      // Run typegen once on startup
      await runTypegen(options?.appRoot)

      // Debounce helper
      let debounceTimer: ReturnType<typeof setTimeout> | undefined

      const scheduleTypegen = () => {
        clearTimeout(debounceTimer)
        debounceTimer = setTimeout(() => {
          void runTypegen(options?.appRoot)
        }, 300)
      }

      // Watch tool files for changes
      server.watcher.on("change", (path) => {
        if (TOOLS_DIR_PATTERN.test(path)) {
          scheduleTypegen()
        }
      })
      server.watcher.on("add", (path) => {
        if (TOOLS_DIR_PATTERN.test(path)) {
          scheduleTypegen()
        }
      })
      server.watcher.on("unlink", (path) => {
        if (TOOLS_DIR_PATTERN.test(path)) {
          scheduleTypegen()
        }
      })
    },

    async buildStart() {
      await runTypegen(options?.appRoot)
    },

    transform(code: string, id: string): { code: string } | null {
      if (!TOOLS_DIR_PATTERN.test(id)) {
        return null
      }

      const transformed = transformToolSource(code, id)

      if (!transformed) {
        return null
      }

      return { code: transformed }
    },
  }
}

async function runTypegen(appRoot?: string): Promise<void> {
  try {
    const app = await findB4App(appRoot ? { appRoot } : {})
    const manifest = await discoverRoutes(appRoot ? { appRoot } : {})

    const sharedToolsDir = join(app.appRoot, "src")
    const toolTypesPerRoute: RouteToolTypes[] = []
    for (const route of manifest.routes) {
      const tools = await extractToolTypesForRoute({
        routeDir: route.routeDir,
        sharedToolsDir,
        typeReferenceFileName: join(app.b4Dir, SCENARIO_TYPES_FILE),
      })
      toolTypesPerRoute.push({ pathname: route.pathname, tools })
    }

    const content = renderB4Types(manifest, toolTypesPerRoute)
    const scenarioContent = renderScenarioTypes(manifest, toolTypesPerRoute)
    const outputPath = join(app.b4Dir, OUTPUT_FILE)
    const scenarioOutputPath = join(app.b4Dir, SCENARIO_TYPES_FILE)

    await mkdir(app.b4Dir, { recursive: true })
    await Promise.all([
      writeFile(outputPath, content, "utf-8"),
      writeFile(scenarioOutputPath, scenarioContent, "utf-8"),
    ])
  } catch {
    // Silently catch errors — typegen during dev should not crash the server
  }
}

export function transformToolSource(source: string, fileName: string): string | null {
  const analysis = analyzeToolSource(source, fileName)
  if (!analysis) {
    return null
  }

  const needsDescription = !analysis.exports.description && analysis.description.length > 0
  const needsSchema =
    !analysis.exports.schema && analysis.parameter !== null && analysis.parameter.kind !== "unknown"

  if (!needsDescription && !needsSchema) {
    return null
  }

  const allocateIdentifier = createGeneratedIdentifierAllocator(source)
  const descriptionIdentifier = needsDescription
    ? allocateIdentifier("__b4GeneratedDescription")
    : undefined
  const schemaIdentifier = needsSchema ? allocateIdentifier("__b4GeneratedSchema") : undefined
  const zodIdentifier = needsSchema ? allocateIdentifier("__b4GeneratedZ") : undefined
  const injections: string[] = []

  if (zodIdentifier) {
    injections.push(`import { z as ${zodIdentifier} } from "zod"`)
  }

  if (descriptionIdentifier) {
    injections.push(`const ${descriptionIdentifier} = ${JSON.stringify(analysis.description)}`)
    injections.push(`export { ${descriptionIdentifier} as description }`)
  }

  if (schemaIdentifier && zodIdentifier && analysis.parameter) {
    const zodCode = generateZodSchema(
      analysis.parameter,
      analysis.parameterDescriptions,
      zodIdentifier,
    )
    injections.push(`const ${schemaIdentifier} = ${zodCode}`)
    injections.push(`export { ${schemaIdentifier} as schema }`)
  }

  return `${injections.join("\n")}\n${source}`
}

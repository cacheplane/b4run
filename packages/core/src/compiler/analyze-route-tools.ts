import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

import type { AnalyzedTool } from "./model.js"
import { analyzeToolFiles } from "./typescript-backend.js"

export interface AnalyzeRouteToolsOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
  /** Declaration location used as the base for emitted type references. */
  readonly typeReferenceFileName?: string
  /**
   * The app root the nearest `tsconfig.json` is searched up from, so the tool
   * program compiles with the app's own `paths`, `baseUrl`, and `extends`
   * chain. Defaults to `routeDir`.
   */
  readonly appRoot?: string
  /** An explicit tsconfig to build the tool program with, instead of searching. */
  readonly tsconfig?: string
}

/** How the backend finds the compiler options for a route's tool program. */
export interface ToolCompilerConfig {
  /** Explicit tsconfig path; when set, no search happens. */
  readonly tsconfig?: string
  /** Directory the nearest-`tsconfig.json` search starts from. */
  readonly searchDir: string
}

export function createAnalyzeRouteTools(
  analyzeEffectiveToolFiles: (
    toolFiles: ReadonlyMap<string, string>,
    typeReferenceFileName?: string,
    compilerConfig?: ToolCompilerConfig,
  ) => readonly AnalyzedTool[],
): (options: AnalyzeRouteToolsOptions) => readonly AnalyzedTool[] {
  return (options) => {
    const routeToolFiles = discoverToolFiles(join(options.routeDir, "tools"))
    const sharedToolFiles = options.sharedToolsDir
      ? discoverToolFiles(join(options.sharedToolsDir, "tools"))
      : new Map<string, string>()

    const effectiveToolFiles = new Map(sharedToolFiles)
    for (const [name, filePath] of routeToolFiles) {
      effectiveToolFiles.set(name, filePath)
    }

    const sortedToolFiles = new Map(
      [...effectiveToolFiles].sort(([left], [right]) => left.localeCompare(right)),
    )
    const compilerConfig: ToolCompilerConfig = {
      searchDir: options.appRoot ?? options.routeDir,
      ...(options.tsconfig !== undefined ? { tsconfig: options.tsconfig } : {}),
    }
    return analyzeEffectiveToolFiles(sortedToolFiles, options.typeReferenceFileName, compilerConfig)
  }
}

const analyzeRouteToolsWithBackend = createAnalyzeRouteTools(analyzeToolFiles)

export function analyzeRouteTools(options: AnalyzeRouteToolsOptions): readonly AnalyzedTool[] {
  return analyzeRouteToolsWithBackend(options)
}

function discoverToolFiles(toolsDir: string): Map<string, string> {
  const files = new Map<string, string>()
  if (!existsSync(toolsDir)) return files

  for (const entry of readdirSync(toolsDir)) {
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts")) continue
    files.set(entry.slice(0, -".ts".length), join(toolsDir, entry))
  }

  return files
}

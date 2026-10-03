import type { ExtractedToolSchema, ExtractedToolType } from "../types.js"
import {
  type AnalyzeRouteToolsOptions,
  analyzeRouteTools,
  type ToolCompilerConfig,
} from "./analyze-route-tools.js"
import { typeInfoToToolParameters } from "./json-schema.js"

export type { UnresolvedImport, UnresolvedToolInputTypeDetails } from "./errors.js"
export { UnresolvedToolInputTypeError } from "./errors.js"
export type { AnalyzedTool, PropertyInfo, TypeInfo } from "./model.js"
export { analyzeToolSource } from "./typescript-backend.js"
export {
  type AnalyzeRouteToolsOptions,
  analyzeRouteTools,
  type ToolCompilerConfig,
  typeInfoToToolParameters,
}

export interface ExtractedToolArtifacts {
  readonly types: readonly ExtractedToolType[]
  readonly schemas: readonly ExtractedToolSchema[]
}

export function extractToolArtifactsForRoute(
  options: AnalyzeRouteToolsOptions,
): ExtractedToolArtifacts {
  const analyzedTools = analyzeRouteTools(options)

  return {
    types: analyzedTools.map(({ name, description, inputType, outputType }) => ({
      name,
      description,
      inputType,
      outputType,
    })),
    schemas: analyzedTools.map(({ name, description, parameter }) => ({
      name,
      description,
      parameters: typeInfoToToolParameters(parameter),
    })),
  }
}

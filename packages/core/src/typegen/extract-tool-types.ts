import { extractToolArtifactsForRoute } from "../compiler/index.js"
import type { ExtractedToolType } from "../types.js"

export interface ExtractToolTypesOptions {
  readonly routeDir: string
  readonly sharedToolsDir: string | undefined
  /**
   * The app root the nearest `tsconfig.json` is searched up from, so aliased
   * imports (`paths`, `baseUrl`, `extends`) resolve the way they do for the
   * app's own compiler. Defaults to `routeDir`.
   */
  readonly appRoot?: string
  /** An explicit tsconfig to build the tool program with, instead of searching. */
  readonly tsconfig?: string
  /** Declaration location used as the base for emitted type references. */
  readonly typeReferenceFileName?: string
}

export async function extractToolTypesForRoute(
  options: ExtractToolTypesOptions,
): Promise<readonly ExtractedToolType[]> {
  return extractToolArtifactsForRoute(options).types
}

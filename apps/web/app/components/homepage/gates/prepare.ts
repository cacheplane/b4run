import "server-only"
import { highlightCode } from "../highlight"
import {
  CONFIG_FILES,
  type ConfigFileId,
  gateScenarios,
  linesContaining,
  type ScenarioId,
} from "./gate-scenarios"
import { gateSources } from "./gate-sources"

/** One fixture file, highlighted: one HTML string per line. */
export interface GateConfigFile {
  readonly path: string
  readonly lines: readonly string[]
}

export interface GatesData {
  readonly files: Readonly<Record<ConfigFileId, GateConfigFile>>
  /** For each scenario, the 0-based lines of its file that explain the result. */
  readonly whyLines: Readonly<Record<ScenarioId, readonly number[]>>
}

/** Everything the tracer renders, highlighted on the server. */
export async function prepareGates(): Promise<GatesData> {
  const ids = Object.keys(CONFIG_FILES) as ConfigFileId[]
  const highlighted = await Promise.all(
    ids.map(async (id) => {
      const { path } = CONFIG_FILES[id]
      const code = await highlightCode(gateSources[id], "typescript", path, "")
      return [id, { path, lines: code.lines }] as const
    }),
  )
  const whyLines = Object.fromEntries(
    gateScenarios.map((scenario) => [
      scenario.id,
      linesContaining(gateSources[scenario.file], scenario.why),
    ]),
  ) as Record<ScenarioId, readonly number[]>
  return {
    files: Object.fromEntries(highlighted) as Record<ConfigFileId, GateConfigFile>,
    whyLines,
  }
}

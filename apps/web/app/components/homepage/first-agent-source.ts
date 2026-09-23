import "server-only"
import data from "./first-agent-source.json"
import { highlightCode } from "./highlight"
import type { DisplayCode } from "./types"

export const firstAgentSource = data
export type FirstAgentKey = keyof typeof data.sources

/** The basic template's agent and tool, as a new app scaffolds them. */
export async function prepareFirstAgent(): Promise<Record<FirstAgentKey, DisplayCode>> {
  const [agent, tool] = await Promise.all(
    (["agent", "tool"] as const).map(async (key) => {
      const { path, text } = data.sources[key]
      const code = await highlightCode(text.trimEnd(), "typescript", path, "")
      return { ...code, wrap: true }
    }),
  )
  return { agent, tool } as Record<FirstAgentKey, DisplayCode>
}

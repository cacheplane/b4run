import "server-only"
import { highlightCode } from "../highlight"
import { buildFor, deployTargets, type TargetId } from "./ship-data"

/** Each target's b4.config.ts, highlighted on the server: one HTML string per line. */
export async function prepareDeployTargets(): Promise<
  Readonly<Record<TargetId, readonly string[]>>
> {
  const entries = await Promise.all(
    deployTargets.map(async (target) => {
      const code = await highlightCode(
        buildFor(target.build).config,
        "typescript",
        "b4.config.ts",
        "",
      )
      return [target.id, code.lines] as const
    }),
  )
  return Object.fromEntries(entries) as Record<TargetId, readonly string[]>
}

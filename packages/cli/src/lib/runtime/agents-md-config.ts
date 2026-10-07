import { B4AppError, type B4Config } from "@b4run/core"

/** Every key `agentsMd` accepts. Anything else is an authoring error. */
const AGENTS_MD_KEYS: readonly string[] = ["writable"]

export interface ResolvedAgentsMdConfig {
  /** Whether the agent is told to update `workspace/AGENTS.md` itself. */
  readonly writable: boolean
}

function invalidAgentsMdConfig(detail: string): B4AppError {
  return new B4AppError(`Invalid agentsMd config:\n${detail}`, "B4_E1010")
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validates `agentsMd` and returns whether `workspace/AGENTS.md` is presented
 * to the agent as writable memory (the default) or read-only guidance.
 *
 * `B4Config` has no runtime schema, and a `b4.config.js` (or an untyped
 * `export default {}`) gets no excess-property check, so a near miss would
 * otherwise read as configured while the file stayed writable. Rejected, with
 * B4_E1010: an `agentsMd` that isn't a plain object (`false`, `null`, an
 * array), an unknown key in it (`writeable`, `Writable`), and a `writable`
 * that isn't a boolean.
 *
 * `b4 check` and route preparation both call this, and the agents-md marker
 * reads the value it returns, so the validated shape and the honored value
 * cannot diverge.
 */
export function resolveAgentsMdConfig(
  config: Pick<B4Config, "agentsMd"> | undefined,
): ResolvedAgentsMdConfig {
  const agentsMd: unknown = config?.agentsMd
  if (agentsMd === undefined) return { writable: true }
  if (!isRecord(agentsMd)) {
    throw invalidAgentsMdConfig(
      `agentsMd must be an object; received ${JSON.stringify(agentsMd)}. Use agentsMd: { writable: false } to make workspace/AGENTS.md read-only.`,
    )
  }
  const unknownKeys = Object.keys(agentsMd)
    .filter((key) => !AGENTS_MD_KEYS.includes(key))
    .sort()
  if (unknownKeys.length > 0) {
    throw invalidAgentsMdConfig(
      `Unknown agentsMd option(s): ${unknownKeys.join(", ")}. Known options: ${AGENTS_MD_KEYS.join(", ")}.`,
    )
  }
  const writable = Object.hasOwn(agentsMd, "writable") ? agentsMd.writable : undefined
  if (writable === undefined) return { writable: true }
  if (typeof writable !== "boolean") {
    throw invalidAgentsMdConfig(
      `agentsMd.writable must be a boolean; received ${JSON.stringify(writable)}.`,
    )
  }
  return { writable }
}

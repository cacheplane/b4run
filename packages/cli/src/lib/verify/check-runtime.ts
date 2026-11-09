import { agentProtocolDefaultAgentId, type B4Config } from "@b4run/core"
import type { B4ErrorCode } from "@b4run/sdk"
import type { SandboxProvider } from "@b4run/workspace"
import type { RuntimeRegistryEntry } from "../dev/runtime-registry-core.js"
import { createRouteAssistantId, isPublicRunnableRoute } from "../runtime/route-identity.js"

/** Shared check/build/boot gate. Multiple routes without a default remain valid. */
export function checkAgentProtocolDefault(
  config: B4Config | undefined,
  routes: readonly RuntimeRegistryEntry[],
): string | undefined {
  const publicRoutes = routes.filter(isPublicRunnableRoute)
  for (const route of publicRoutes) {
    if (route.assistantId !== createRouteAssistantId(route.routeId, route.mode)) {
      throw new Error("Runtime contains a noncanonical Agent ID")
    }
  }
  const configured = agentProtocolDefaultAgentId(config)
  if (configured !== undefined) {
    if (!publicRoutes.some((route) => route.assistantId === configured)) {
      throw new Error(
        "server.agentProtocol.defaultAgentId must name an exact public runnable Agent ID",
      )
    }
    return configured
  }
  return publicRoutes.length === 1 ? publicRoutes[0]?.assistantId : undefined
}

/**
 * Minimum Node version B4.run requires at runtime: the active LTS line. Node 24
 * bundles npm ≥ 11, whose dependency resolver installs B4.run's scaffold graph
 * correctly (npm 10's arborist crashes on it), and ships `node:sqlite` (used by
 * @b4run/sqlite-storage / @b4run/memory) without an experimental flag.
 * This check must not itself require Node ≥ floor to run — it is a pure string
 * compare with no `node:sqlite` import.
 */
const NODE_FLOOR = "24.0.0"

export interface RuntimeCheckResult {
  readonly name: "runtime"
  readonly node: {
    readonly version: string
    readonly ok: boolean
    readonly floor: string
    /** Present only when `ok` is false — B4_E5101 (Node below the supported floor). */
    readonly code?: B4ErrorCode
  }
  /** Present only when a sandbox provider is configured. */
  readonly docker?: {
    readonly ok: boolean
    readonly detail: string
    /** Present only when `ok` is false — B4_E2002 (sandbox preflight failed). */
    readonly code?: B4ErrorCode
  }
  readonly status: "passed" | "warning" | "failed"
}

function parseVersion(version: string): readonly [number, number, number] {
  const parts = version.split(".")
  const major = Number.parseInt(parts[0] ?? "", 10)
  const minor = Number.parseInt(parts[1] ?? "", 10)
  const patch = Number.parseInt(parts[2] ?? "", 10)
  return [
    Number.isNaN(major) ? 0 : major,
    Number.isNaN(minor) ? 0 : minor,
    Number.isNaN(patch) ? 0 : patch,
  ]
}

/** Pure numeric MAJOR.MINOR.PATCH comparison: is `a` ≥ `b`? No deps. */
export function gte(a: string, b: string): boolean {
  const [aMajor, aMinor, aPatch] = parseVersion(a)
  const [bMajor, bMinor, bPatch] = parseVersion(b)
  if (aMajor !== bMajor) return aMajor > bMajor
  if (aMinor !== bMinor) return aMinor > bMinor
  return aPatch >= bPatch
}

export async function checkRuntime(input: {
  readonly nodeVersion?: string
  readonly sandboxProvider?: Pick<SandboxProvider, "preflight" | "name">
}): Promise<RuntimeCheckResult> {
  const version = input.nodeVersion ?? process.versions.node
  const nodeOk = gte(version, NODE_FLOOR)
  const node: RuntimeCheckResult["node"] = {
    version,
    ok: nodeOk,
    floor: NODE_FLOOR,
    ...(nodeOk ? {} : { code: "B4_E5101" as const }),
  }

  let docker: RuntimeCheckResult["docker"]
  if (input.sandboxProvider?.preflight) {
    // Reuse the provider preflight contract ({ ok, detail?, warnings? }) — the
    // same one `b4 check` runs via collect-sandbox-errors. Surface detail verbatim.
    const result = await input.sandboxProvider.preflight()
    docker = {
      ok: result.ok,
      detail: result.detail ?? (result.ok ? "reachable" : "unreachable"),
      ...(result.ok ? {} : { code: "B4_E2002" as const }),
    }
  }

  const failed = !nodeOk || docker?.ok === false
  return {
    name: "runtime",
    node,
    ...(docker ? { docker } : {}),
    status: failed ? "failed" : "passed",
  }
}

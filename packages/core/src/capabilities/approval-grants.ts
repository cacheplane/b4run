/**
 * The park-site half of approval grants.
 *
 * Design: `docs/superpowers/specs/2026-09-18-approval-capability-design.md`
 * (cacheplane/b4run#738); contract and crypto: `@b4run/sdk`'s
 * `interrupt-grants.ts`; motivation: cacheplane/b4run#736.
 *
 * Two facts have to reach `emitPermissionInterrupt`, and they arrive by
 * deliberately different routes because they are deliberately different kinds
 * of fact:
 *
 *   • **The minter** is per-run. It is closed over the thread whose resume
 *     endpoint will answer this interrupt and over the storage handle core
 *     does not hold, so it can only come from the caller. It rides in
 *     LangGraph's `config.configurable`, the same channel this repo already
 *     uses for live per-call identity (see the `threadId` note on
 *     `B4ToolDefinition`'s run context, forwarded from `config.configurable`
 *     by the langchain tool-converter). Reading it with `getConfig()` means
 *     nothing in core's call graph grows a storage parameter.
 *
 *   • **The mode** is a deployment fact — `approvals.grants` in
 *     `b4.config.ts` — and it is what makes the minter's absence detectable.
 *     It CANNOT travel the same way, and that is the whole point: injection
 *     through the run config is optional by construction (pre-wrap and legacy
 *     invokers omit it, exactly as they omit `threadId`), so a mode carried
 *     only in `configurable` would go missing from precisely the invokers
 *     whose missing minter it is supposed to catch. "No mode and no minter"
 *     would be indistinguishable from "grants are off", and `"required"`
 *     would silently degrade to a park with no grant.
 *
 * So the mode is a process-wide latch, set by the route-preparation path from
 * the resolved config, and the park site refuses to park when the latch says
 * `"required"` and no minter is present. That is the property CLI-minting
 * cannot have: the park site is the one place that knows a grant is about to
 * be needed, so it is the one place that can refuse.
 */

import {
  APPROVAL_GRANT_MINTER_KEY,
  type ApprovalGrantMinter,
  type ApprovalGrantMode,
} from "@b4run/sdk"
import { getConfig } from "@langchain/langgraph"

const ORDER: Readonly<Record<ApprovalGrantMode, number>> = { off: 0, optional: 1, required: 2 }

let mode: ApprovalGrantMode = "off"

/**
 * Raise the process-wide approval-grant mode to at least `next`.
 *
 * **Monotonic, deliberately.** The latch ratchets up and never down. One
 * process can prepare routes for more than one app root (the dev server does,
 * and so does a test suite), and a second config with a weaker setting must
 * not be able to weaken a stricter one that is already in force — that would
 * be a downgrade attack expressible as an ordinary config file. The cost is
 * stated rather than hidden: two app roots in one process share the strictest
 * mode either of them asks for. A process that needs two different modes needs
 * two processes.
 */
export function configureApprovalGrants(next: ApprovalGrantMode): void {
  if (ORDER[next] > ORDER[mode]) mode = next
}

/** The mode currently in force in this process. */
export function approvalGrantMode(): ApprovalGrantMode {
  return mode
}

/** Test-only: drop the latch so a suite can exercise every mode in isolation. */
export function __resetApprovalGrantsForTests(): void {
  mode = "off"
}

/**
 * The per-run minter from the ambient LangGraph run config, or `undefined`.
 *
 * Structurally type-checked rather than cast: `configurable` also carries the
 * route's URL params, which are attacker-influenced strings, and a value that
 * merely occupies the key must not be called.
 */
function readMinter(): ApprovalGrantMinter | undefined {
  let configurable: Record<string, unknown> | undefined
  try {
    // `getConfig()` throws outside a running graph. B4.run's own non-graph
    // paths already fail closed before they reach a park (see
    // `interruptCapable`), so this is defence in depth rather than a path
    // taken in practice — but it must not turn a missing config into a crash
    // with a LangGraph-internal message.
    configurable = getConfig()?.configurable as Record<string, unknown> | undefined
  } catch {
    return undefined
  }
  const candidate = configurable?.[APPROVAL_GRANT_MINTER_KEY]
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    typeof (candidate as ApprovalGrantMinter).mint === "function"
  ) {
    return candidate as ApprovalGrantMinter
  }
  return undefined
}

/** LangGraph's namespace for the parked task — the preimage of `resumeKey`. */
function readCheckpointNs(): string {
  try {
    const ns = getConfig()?.configurable?.checkpoint_ns
    return typeof ns === "string" ? ns : ""
  } catch {
    return ""
  }
}

/**
 * Thrown at the park site when grants are required and no minter reached this
 * run. Never caught by B4.run: it aborts the turn instead of parking, so the
 * operator sees the misconfiguration rather than an approval prompt that
 * cannot be answered safely.
 */
export class MissingApprovalGrantMinterError extends Error {
  readonly code = "approval_grant_minter_missing"
  constructor(interruptId: string) {
    super(
      `B4: approvals.grants is "required" but no approval-grant minter reached this run, so ` +
        `interrupt ${interruptId} cannot be parked with a grant. Refusing to park. ` +
        `The minter is injected through LangGraph's config.configurable by the B4.run runtime; ` +
        `an invoker that calls streamResolvedRoute/streamAgent directly must inject it too, ` +
        `or set approvals.grants to "optional" or "off" in b4.config.ts.`,
    )
    this.name = "MissingApprovalGrantMinterError"
  }
}

/**
 * Mint the grant for a park, if this run can.
 *
 * Returns the plaintext grant to place in the interrupt envelope, or
 * `undefined` when grants are off or unavailable under a mode that tolerates
 * their absence. Throws {@link MissingApprovalGrantMinterError} under
 * `"required"` with no minter — the fail-closed rule.
 */
export async function mintGrantForPark(interruptId: string): Promise<string | undefined> {
  if (mode === "off") return undefined
  const minter = readMinter()
  if (!minter) {
    if (mode === "required") throw new MissingApprovalGrantMinterError(interruptId)
    // "optional": this run cannot mint, so this interrupt gets no grant row,
    // and the resume endpoint's per-interrupt-age rule lets it resume as
    // before. That is the migration window, and it is why "optional" is a
    // window rather than a permanent state.
    return undefined
  }
  return await minter.mint({ interruptId, checkpointNs: readCheckpointNs() })
}

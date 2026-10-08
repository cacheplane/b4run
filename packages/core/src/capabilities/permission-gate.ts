import type { PermissionsStore } from "@b4run/permissions"
import {
  subagentPermissionPattern,
  suggestedCommandPattern,
  suggestedMemoryPattern,
  suggestedPathPattern,
} from "@b4run/permissions"
import {
  type B4ErrorCode,
  type ConstraintContext,
  type ConstraintPredicate,
  type GateDecision,
  type ToolDisplayIcon,
  toolDenial,
} from "@b4run/sdk"
import { POSIX_SEP } from "@b4run/sdk/pure"
import { interrupt } from "@langchain/langgraph"
import { mintGrantForPark } from "./approval-grants.js"

export type PathOperation = "readFile" | "writeFile" | "listDir"

/**
 * A gate's answer. `decision` is present only when a human answered an
 * interactive prompt (`once` / `always` / `deny`); a static allow or deny
 * rule, bypass mode, and the fail-closed paths carry none.
 */
export type GateResult =
  | { allowed: true; decision?: GateDecision }
  | { allowed: false; reason: string; code?: B4ErrorCode; decision?: GateDecision }

/**
 * How the gated call reads while it runs: the tool's `display.icon` and
 * `display.running` label, exactly as the runtime streamed them as the call's
 * `running` step. A parked prompt carries it as `step` on the interrupt, so a
 * thread restored from the checkpoint shows the same label as the live run.
 */
export interface GateStepDisplay {
  readonly icon?: ToolDisplayIcon
  readonly label?: string
}

/** Which call a gate is deciding; absent outside a model tool call. */
export interface GateCallOptions {
  /** The model's id for the call. */
  readonly toolCallId?: string | undefined
  /** The call's running display, when its tool has one. */
  readonly step?: GateStepDisplay | undefined
}

/** The call identity a tool's run context carries (`toolCallId`, `step`), as gate options. */
export function gateCallOptions(context: unknown): GateCallOptions {
  const { toolCallId, step } = (context ?? {}) as {
    readonly toolCallId?: unknown
    readonly step?: unknown
  }
  const display = readGateStep(step)
  return {
    ...(typeof toolCallId === "string" && toolCallId !== "" ? { toolCallId } : {}),
    ...(display !== undefined ? { step: display } : {}),
  }
}

/** A running display with at least an icon or a non-empty label, else undefined. */
function readGateStep(value: unknown): GateStepDisplay | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { icon, label } = value as { readonly icon?: unknown; readonly label?: unknown }
  const out = {
    ...(typeof icon === "string" && icon !== "" ? { icon: icon as ToolDisplayIcon } : {}),
    ...(typeof label === "string" && label !== "" ? { label } : {}),
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The interrupt fields that name the gated call: its id and its running display. */
function callFields(opts: GateCallOptions | undefined): {
  toolCallId?: string
  step?: GateStepDisplay
} {
  const step = readGateStep(opts?.step)
  return {
    ...(opts?.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    ...(step !== undefined ? { step } : {}),
  }
}

/** Prefix a denial reason with its error code when the tool result is returned to the model. */
export function codedReason(gate: { reason: string; code?: B4ErrorCode }): string {
  return gate.code ? `[${gate.code}] ${gate.reason}` : gate.reason
}

export async function gatePathOp(
  permissions: PermissionsStore | undefined,
  operation: PathOperation,
  absPath: string,
  workspaceRoot: string,
  opts?: { readonly interruptCapable?: boolean } & GateCallOptions,
): Promise<GateResult> {
  // If permissions store is absent, allow (legacy behavior — capability used without permissions context).
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  // Both operands are POSIX-normalized absolute paths (the node lane converts
  // at its boundary), so containment compares against an explicit "/" rather
  // than a host-derived separator. The separator in the prefix test is what
  // keeps a sibling like `<root>-evil` outside.
  const insideWorkspace = absPath === workspaceRoot || absPath.startsWith(workspaceRoot + POSIX_SEP)

  // Inside workspace: always allow silently.
  if (insideWorkspace) return { allowed: true }

  // Outside workspace: consult the store.
  const rule = permissions.match(operation, absPath)
  if (rule === "allow") return { allowed: true }
  if (rule === "deny") {
    return { allowed: false, reason: `Permission denied by user: ${absPath}` }
  }
  // rule === "unknown"
  if (permissions.mode === "non-interactive") {
    return { allowed: false, reason: `Permission denied (fail-closed): ${absPath}` }
  }
  if (opts?.interruptCapable === false) {
    return {
      allowed: false,
      reason:
        `Permission denied: ${absPath} is outside the workspace and interactive ` +
        `permission prompts are not available in this execution context. ` +
        `Add an allow rule for "${operation}" to the permissions config in b4.config.ts.`,
    }
  }
  // Interactive: emit LangGraph interrupt and await user decision.
  const decision = await emitPermissionInterrupt({
    kind: "path",
    operation,
    path: absPath,
    ...callFields(opts),
    permissions,
  })
  if (decision === "deny") {
    return { allowed: false, reason: `Permission denied by user: ${absPath}`, decision }
  }
  return { allowed: true, decision }
}

export async function gateBashOp(
  permissions: PermissionsStore | undefined,
  command: string,
  opts?: GateCallOptions,
): Promise<GateResult> {
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const rule = permissions.match("bash", command)
  if (rule === "allow") return { allowed: true }
  if (rule === "deny") {
    return { allowed: false, reason: `Permission denied by user: ${command}` }
  }
  if (permissions.mode === "non-interactive") {
    return { allowed: false, reason: `Permission denied (fail-closed): ${command}` }
  }
  const decision = await emitPermissionInterrupt({
    kind: "command",
    command,
    ...callFields(opts),
    permissions,
  })
  if (decision === "deny") {
    return { allowed: false, reason: `Permission denied by user: ${command}`, decision }
  }
  return { allowed: true, decision }
}

/** Options for the per-tool approval gate. */
export interface ToolGateOptions extends GateCallOptions {
  readonly interruptCapable?: boolean
  /**
   * `false` makes every call prompt (`tools.approve` entry
   * `{ tool, allowAlways: false }`): an allow rule for the tool is ignored,
   * the envelope says `allowAlways: false` so clients offer only "once" and
   * "deny", and an "always" answer is treated as "once" and persists nothing.
   * Bypass mode, deny rules and the fail-closed paths are unchanged.
   */
  readonly allowAlways?: boolean
}

/**
 * Generic per-tool approval gate (tools.approve). Name-level: the decision
 * covers the tool name; argsPreview is display-only. Persisted decisions live
 * under the reserved "tool" key in .b4/permissions.json (exact-name match —
 * see @b4run/permissions pattern-matching).
 */
export async function gateToolOp(
  permissions: PermissionsStore | undefined,
  toolName: string,
  argsPreview: string,
  opts?: ToolGateOptions,
): Promise<GateResult> {
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const everyCall = opts?.allowAlways === false
  const rule = permissions.match("tool", toolName)
  // A standing approval must not exist for an every-call tool: an allow rule
  // (configured, or persisted by an "always" answer before the route opted
  // in) falls through to the prompt like an unknown one.
  if (rule === "allow" && !everyCall) return { allowed: true }
  if (rule === "deny") {
    return {
      allowed: false,
      reason: `Permission denied by user: tool ${toolName}`,
      code: "B4_E3001",
    }
  }
  if (permissions.mode === "non-interactive") {
    return {
      allowed: false,
      reason: `Permission denied (fail-closed): tool ${toolName}`,
      code: "B4_E3001",
    }
  }
  if (opts?.interruptCapable === false) {
    return {
      allowed: false,
      reason:
        `Permission denied: tool "${toolName}" requires approval and interactive ` +
        `permission prompts are not available in this execution context. ` +
        `Add an allow rule for "tool" to the permissions config in b4.config.ts.`,
      code: "B4_E3001",
    }
  }
  const decision = await emitPermissionInterrupt({
    kind: "tool",
    toolName,
    argsPreview,
    ...(everyCall ? { allowAlways: false as const } : {}),
    ...callFields(opts),
    permissions,
  })
  if (decision === "deny") {
    return {
      allowed: false,
      reason: `Permission denied by user: tool ${toolName}`,
      code: "B4_E3001",
      decision,
    }
  }
  return { allowed: true, decision }
}

export interface SubagentGateRequest {
  readonly callId: string
  readonly input: string
  readonly parentRouteId: string
  readonly reason?: string
  readonly subagentName: string
  readonly subagentRouteId: string
  readonly threadId?: string
}

/** Approval gate for one exact parent-route/subagent-name delegation edge. */
export async function gateSubagentOp(
  permissions: PermissionsStore | undefined,
  request: SubagentGateRequest,
  opts: { readonly interruptCapable: boolean },
): Promise<GateResult> {
  if (permissions?.mode === "bypass") return { allowed: true }

  const suggestedPattern = subagentPermissionPattern(request.parentRouteId, request.subagentName)
  if (permissions) {
    const rule = permissions.match("subagent", suggestedPattern)
    if (rule === "allow") return { allowed: true }
    if (rule === "deny") {
      return {
        allowed: false,
        reason: `Permission denied by user: subagent ${request.subagentName}`,
        code: "B4_E3002",
      }
    }
    if (permissions.mode === "non-interactive") {
      return {
        allowed: false,
        reason: `Permission denied (fail-closed): subagent ${request.subagentName}`,
        code: "B4_E3002",
      }
    }
  }

  if (
    !permissions ||
    opts.interruptCapable !== true ||
    request.threadId === undefined ||
    request.threadId.trim().length === 0
  ) {
    return {
      allowed: false,
      reason:
        `Permission denied: subagent "${request.subagentName}" requires approval. ` +
        `Provide a non-empty resumable thread ID and enable interrupt support, or add an allow ` +
        `rule for "subagent" to the permissions config in b4.config.ts.`,
      code: "B4_E3002",
    }
  }

  const decision = await emitPermissionInterrupt({
    kind: "subagent",
    callId: request.callId,
    parentRouteId: request.parentRouteId,
    subagentName: request.subagentName,
    subagentRouteId: request.subagentRouteId,
    inputPreview: truncateDisplay(request.input),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
    suggestedPattern,
    threadId: request.threadId,
    permissions,
  })
  if (decision === "deny") {
    return {
      allowed: false,
      reason: `Permission denied by user: subagent ${request.subagentName}`,
      code: "B4_E3002",
      decision,
    }
  }
  return { allowed: true, decision }
}

export interface MemorySupersedeDetail {
  readonly namespace: string
  readonly identity: string
  readonly oldId: string
  readonly oldContent: string
  readonly newContent: string
}

/**
 * Memory supersede gate (memory.writes: "ask"). Prompts ONLY when the agent
 * contradicts an existing active memory — ADDs and idempotent UPDATEs never
 * reach this gate. Persisted decisions live under the reserved "memory" key
 * as workspace+route namespace prefixes; candidates are matched with a "|"
 * terminator so sibling routes cannot prefix-collide.
 *
 * DELIBERATE DIVERGENCE from gateToolOp: on "unknown" with no interactive
 * human (non-interactive mode), this gate ALLOWS the supersede — ask is a
 * supervision affordance, not a security boundary; headless it behaves
 * exactly as writes:"auto". Explicit deny rules are still honored headless.
 * Only called from inside the memory capability's remember tool, which only
 * exists on agent routes (in-graph), so interrupt() is safe here.
 */
export async function gateMemorySupersede(
  permissions: PermissionsStore | undefined,
  detail: MemorySupersedeDetail,
  opts?: GateCallOptions,
): Promise<GateResult> {
  if (!permissions) return { allowed: true }
  if (permissions.mode === "bypass") return { allowed: true }

  const rule = permissions.match("memory", `${detail.namespace}|`)
  if (rule === "allow") return { allowed: true }
  if (rule === "deny") {
    return { allowed: false, reason: `approval denied for this route's memory overwrites` }
  }
  // unknown + headless → allow through (ask ≡ auto without a human).
  if (permissions.mode === "non-interactive") return { allowed: true }

  const decision = await emitPermissionInterrupt({
    kind: "memory",
    ...detail,
    ...callFields(opts),
    permissions,
  })
  if (decision === "deny") {
    return { allowed: false, reason: `approval denied`, decision }
  }
  return { allowed: true, decision }
}

/** Best-effort display preview of a tool call's args. Never matched or persisted. */
function buildArgsPreview(input: unknown): string {
  try {
    const s = JSON.stringify(input)
    return s === undefined ? String(input) : truncateDisplay(s)
  } catch {
    return String(input)
  }
}

function truncateDisplay(value: string): string {
  return value.length > 500 ? `${value.slice(0, 500)}…` : value
}

/**
 * Wrap a tool so each call passes gateToolOp first (tools.approve). A blocked
 * call returns the denial reason AS THE TOOL RESULT, branded with `TOOL_DENIAL`
 * (`toolDenial(reason)`): the model reads the reason as a regular result, and
 * the runtime can tell the denial from a successful string so a `display.done`
 * label never describes it as work done — deliberately a different
 * contract from the workspace gates (which throw from inside their own run):
 * a returned denial flows through the normal on_tool_end path, so stream
 * consumers and streamTransformers see a regular tool result and the model can
 * adapt, without touching error-retry handling. Generic over the tool shape so
 * DiscoveredToolDefinition (cli) and B4ToolDefinition (core) both survive
 * wrapping with their extra fields (filePath, schema, scope, …) intact.
 * The generic constraint means run's return type must accept a string (both
 * planned call sites declare `Promise<unknown> | unknown`).
 *
 * On an "unknown" decision in interactive mode the gate calls LangGraph's
 * `interrupt()`, which throws a raw error outside a running graph. B4.run's own
 * call sites wrap agent-route tools (always in-graph); out-of-graph callers
 * should pass `interruptCapable: false` to fail closed with actionable
 * guidance instead (mirrors gatePathOp's option).
 */
export function wrapToolWithApproval<
  C,
  T extends {
    readonly name: string
    readonly run: (input: unknown, context: C) => Promise<unknown> | unknown
  },
>(
  tool: T,
  permissions: PermissionsStore,
  opts?: { readonly interruptCapable?: boolean; readonly allowAlways?: boolean },
): T {
  return {
    ...tool,
    run: async (input: unknown, context: C) => {
      const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input), {
        ...opts,
        ...gateCallOptions(context),
      })
      reportGateDecision(context, gate)
      if (!gate.allowed) return toolDenial(codedReason(gate))
      return tool.run(input, context)
    },
  }
}

/**
 * Hand a human's answer to the run context so the runtime can persist it on
 * the call's step. Static rules carry no decision and report nothing.
 */
function reportGateDecision(context: unknown, gate: GateResult): void {
  if (gate.decision === undefined) return
  ;(context as { readonly onGateDecision?: (decision: GateDecision) => void }).onGateDecision?.(
    gate.decision,
  )
}

const CONSTRAINT_FAILED_REASON =
  "Blocked: the tool's argument constraint check failed (the policy predicate threw or returned an invalid verdict). Not run."

/**
 * Wrap a tool so each call is first evaluated by an argument-constraint predicate
 * (tools.constrain). The predicate returns `true` (allow), a string (deny — the
 * string is returned as the tool result, matching wrapToolWithApproval's
 * return-not-throw contract), or `{ approve: true }` (escalate to the HITL gate
 * via gateToolOp). A predicate that throws OR returns any off-contract value
 * (false, undefined, `{ approve: false }`, …) fails closed (deny) — a broken
 * policy never silently allows. Per-call identity (signal/threadId/params) is read from
 * the LIVE run context, never closed over, so the wrapper is safe inside the
 * per-descriptor-cached agent. `routeId` and `predicate` are stable per descriptor
 * and closed over.
 */
export function wrapToolWithConstraint<
  C extends {
    readonly signal: AbortSignal
    readonly threadId?: string
    readonly params?: Readonly<Record<string, string>>
  },
  T extends {
    readonly name: string
    readonly run: (input: unknown, context: C) => Promise<unknown> | unknown
  },
>(
  tool: T,
  predicate: ConstraintPredicate,
  permissions: PermissionsStore | undefined,
  routeId: string,
): T {
  return {
    ...tool,
    run: async (input: unknown, context: C) => {
      const ctx: ConstraintContext = {
        toolName: tool.name,
        routeId,
        signal: context.signal,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        ...(context.params ? { params: context.params } : {}),
      }
      let verdict: Awaited<ReturnType<ConstraintPredicate>>
      try {
        verdict = await predicate(input, ctx)
      } catch {
        return toolDenial(CONSTRAINT_FAILED_REASON)
      }
      if (verdict === true) return tool.run(input, context)
      if (typeof verdict === "string") return toolDenial(verdict)
      // Escalate to HITL ONLY on a genuine { approve: true } verdict.
      if (
        typeof verdict === "object" &&
        verdict !== null &&
        (verdict as { approve?: unknown }).approve === true
      ) {
        const gate = await gateToolOp(
          permissions,
          tool.name,
          buildArgsPreview(input),
          gateCallOptions(context),
        )
        reportGateDecision(context, gate)
        if (!gate.allowed) return toolDenial(codedReason(gate))
        return tool.run(input, context)
      }
      // Any other value (false, undefined, { approve: false }, a number, …) is
      // off-contract — fail closed rather than silently escalate or allow.
      return toolDenial(CONSTRAINT_FAILED_REASON)
    },
  }
}

// Discriminated union: each kind's required fields are enforced at the call
// site, so a `kind: "tool"` call without toolName is a compile error rather
// than a silently blank interrupt payload.
type InterruptArgs =
  | {
      kind: "command"
      command: string
      toolCallId?: string | undefined
      step?: GateStepDisplay | undefined
      permissions: PermissionsStore
    }
  | {
      kind: "path"
      operation: PathOperation
      path: string
      toolCallId?: string | undefined
      step?: GateStepDisplay | undefined
      permissions: PermissionsStore
    }
  | {
      kind: "tool"
      toolName: string
      argsPreview: string
      /** `false`: every call prompts; "always" is answered as "once". */
      allowAlways?: false
      toolCallId?: string | undefined
      step?: GateStepDisplay | undefined
      permissions: PermissionsStore
    }
  | {
      kind: "subagent"
      callId: string
      parentRouteId: string
      subagentName: string
      subagentRouteId: string
      inputPreview: string
      reason?: string
      suggestedPattern: string
      threadId: string
      permissions: PermissionsStore
    }
  | {
      kind: "memory"
      namespace: string
      identity: string
      oldId: string
      oldContent: string
      newContent: string
      toolCallId?: string | undefined
      step?: GateStepDisplay | undefined
      permissions: PermissionsStore
    }

async function emitPermissionInterrupt(args: InterruptArgs): Promise<GateDecision> {
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const suggestedPattern =
    args.kind === "command"
      ? suggestedCommandPattern(args.command)
      : args.kind === "tool"
        ? args.toolName
        : args.kind === "subagent"
          ? args.suggestedPattern
          : args.kind === "memory"
            ? suggestedMemoryPattern(args.namespace)
            : suggestedPathPattern(args.path)
  const payload = {
    interruptId,
    type: "permission-request" as const,
    kind: args.kind,
    ...(args.kind === "subagent" ? { callId: args.callId, threadId: args.threadId } : {}),
    // Tells clients this prompt has no "always" answer (only "once"/"deny").
    ...(args.kind === "tool" && args.allowAlways === false ? { allowAlways: false } : {}),
    // The model's id for the gated call, so a client can show the prompt on
    // the call it belongs to. A subagent dispatch gate names its call as
    // `callId` instead (the two coexist on a child's own gate: `callId` is the
    // task call, `toolCallId` the child's call).
    ...("toolCallId" in args && args.toolCallId ? { toolCallId: args.toolCallId } : {}),
    // How the gated call reads while it runs (its tool's `display.running`
    // label and icon). The runtime streamed it as the call's `running` step;
    // it rides on the checkpointed interrupt because a parked call has no
    // ToolMessage to stamp yet, so a restored thread shows the same label.
    ...("step" in args && args.step !== undefined ? { step: args.step } : {}),
    detail:
      args.kind === "command"
        ? { command: args.command, suggestedPattern }
        : args.kind === "tool"
          ? { toolName: args.toolName, argsPreview: args.argsPreview, suggestedPattern }
          : args.kind === "subagent"
            ? {
                parentRouteId: args.parentRouteId,
                subagentName: args.subagentName,
                subagentRouteId: args.subagentRouteId,
                inputPreview: args.inputPreview,
                ...(args.reason !== undefined ? { reason: args.reason } : {}),
                suggestedPattern,
              }
            : args.kind === "memory"
              ? {
                  namespace: args.namespace,
                  identity: args.identity,
                  oldId: args.oldId,
                  oldContent: args.oldContent,
                  newContent: args.newContent,
                  suggestedPattern,
                }
              : { operation: args.operation, path: args.path, suggestedPattern },
  }
  // Mint the single-use approval grant for this park, BEFORE the interrupt
  // throw, so that under `approvals.grants: "required"` a run with no minter
  // aborts the turn instead of parking a prompt nobody can answer safely.
  // Ordering is the whole mechanism: `interrupt()` throws, so anything after
  // it never runs on the parking pass.
  //
  // The grant travels IN the envelope. The design (§1) argued for attaching it
  // at projection time instead, to keep the plaintext out of the persisted
  // `writes` blob — but the park site cannot do that: it has no storage handle
  // and no way to reach the three disclosure paths, and attaching downstream
  // is exactly the CLI-minting shape the decision on #738 rejected for not
  // being able to fail closed. The consequence is stated plainly in the docs:
  // the plaintext grant is at rest in the checkpointer's `writes`, so the
  // hash-only grant store protects the consumption ledger, not the checkpoint.
  // The grant stays in the envelope, which `toAguiInterrupt` carries verbatim
  // as `metadata` — the schema-defined field a 1.0 client leaves intact.
  // There is no top-level copy.
  //
  // KNOWN COST, accepted rather than hidden: on the RESUME pass LangGraph
  // re-executes this node from the top, `interruptId` is regenerated (it
  // always has been), and this mints one more grant row that is never
  // disclosed and never presented. It is swept by `voidOutstanding` when the
  // turn settles, because its id is not in the post-turn pending set. The
  // alternative — asking LangGraph's private scratchpad whether this is a
  // replay — trades a bounded, self-cleaning write for a dependency on an
  // unexported internal, which is the worse bargain at the one site that must
  // stay obviously correct.
  const grant = await mintGrantForPark(interruptId)
  const answered = interrupt(grant === undefined ? payload : { ...payload, grant }) as GateDecision
  // Fail safe: a client that answers "always" to a prompt that offered no
  // such answer gets "once" — the call runs, nothing is persisted, and the
  // step records "once".
  const decision: GateDecision =
    answered === "always" && args.kind === "tool" && args.allowAlways === false ? "once" : answered
  if (decision === "always") {
    const tool =
      args.kind === "command"
        ? "bash"
        : args.kind === "tool"
          ? "tool"
          : args.kind === "subagent"
            ? "subagent"
            : args.kind === "memory"
              ? "memory"
              : args.operation
    await args.permissions.addAllow(tool, suggestedPattern)
  }
  return decision
}

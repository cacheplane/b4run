import type { PermissionsStore } from "@b4run/permissions"
import {
  subagentPermissionPattern,
  suggestedCommandPattern,
  suggestedMemoryPattern,
  suggestedPathPattern,
} from "@b4run/permissions"
import { permissionRuleForRequest } from "@b4run/permissions/internal/rule-coordinator"
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
import {
  assertPermissionContinuationContext,
  confirmRememberedPermission,
  mintGrantForPark,
} from "./approval-grants.js"
import { protectedToolProposal, withProtectedToolProposal } from "./permission-continuation.js"

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
  assertPermissionContinuationContext()
  const approval: InterruptArgs = {
    kind: "path",
    operation,
    path: absPath,
    ...callFields(opts),
    ...(permissions ? { permissions } : {}),
  }
  const coordinated = await continuationApplies(approval)
  if (coordinated && permissions) await permissions.load()
  // If permissions store is absent, allow (legacy behavior — capability used without permissions context).
  if (!permissions && !coordinated) return { allowed: true }
  if (permissions?.mode === "bypass" && !coordinated) return { allowed: true }

  // Both operands are POSIX-normalized absolute paths (the node lane converts
  // at its boundary), so containment compares against an explicit "/" rather
  // than a host-derived separator. The separator in the prefix test is what
  // keeps a sibling like `<root>-evil` outside.
  const insideWorkspace = absPath === workspaceRoot || absPath.startsWith(workspaceRoot + POSIX_SEP)

  // Inside workspace: always allow silently.
  if (insideWorkspace && !coordinated) return { allowed: true }

  // Outside workspace: consult the store.
  const rule = insideWorkspace
    ? "allow"
    : permissions?.mode === "bypass"
      ? "unknown"
      : (permissions?.match(operation, absPath) ?? "unknown")
  if (rule === "allow" && !coordinated) return { allowed: true }
  if (rule === "deny") {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return { allowed: false, reason: `Permission denied by user: ${absPath}` }
  }
  // rule === "unknown"
  if (permissions?.mode === "non-interactive" && !insideWorkspace) {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return { allowed: false, reason: `Permission denied (fail-closed): ${absPath}` }
  }
  if (
    opts?.interruptCapable === false &&
    !insideWorkspace &&
    permissions?.mode !== "bypass" &&
    permissions !== undefined
  ) {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return {
      allowed: false,
      reason:
        `Permission denied: ${absPath} is outside the workspace and interactive ` +
        `permission prompts are not available in this execution context. ` +
        `Add an allow rule for "${operation}" to the permissions config in b4.config.ts.`,
    }
  }
  // Interactive: emit LangGraph interrupt and await user decision.
  const decision = await emitPermissionInterrupt(
    approval,
    coordinated,
    undefined,
    !permissions || permissions.mode === "bypass" || insideWorkspace,
  )
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
  assertPermissionContinuationContext()
  const approval: InterruptArgs = {
    kind: "command",
    command,
    ...callFields(opts),
    ...(permissions ? { permissions } : {}),
  }
  const coordinated = await continuationApplies(approval)
  if (coordinated && permissions) await permissions.load()
  if (!permissions && !coordinated) return { allowed: true }
  if (permissions?.mode === "bypass" && !coordinated) return { allowed: true }

  const rule =
    permissions?.mode === "bypass" ? "unknown" : (permissions?.match("bash", command) ?? "unknown")
  if (rule === "allow" && !coordinated) return { allowed: true }
  if (rule === "deny") {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return { allowed: false, reason: `Permission denied by user: ${command}` }
  }
  if (permissions?.mode === "non-interactive") {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return { allowed: false, reason: `Permission denied (fail-closed): ${command}` }
  }
  const decision = await emitPermissionInterrupt(
    approval,
    coordinated,
    undefined,
    !permissions || permissions.mode === "bypass",
  )
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
function toolPermissionArgs(
  permissions: PermissionsStore | undefined,
  toolName: string,
  argsPreview: string,
  opts: ToolGateOptions | undefined,
): InterruptArgs {
  return {
    kind: "tool",
    toolName,
    argsPreview,
    protectedProposal: protectedToolProposal(opts),
    ...(opts?.allowAlways === false ? { allowAlways: false as const } : {}),
    ...callFields(opts),
    ...(permissions ? { permissions } : {}),
  }
}
export async function gateToolOp(
  permissions: PermissionsStore | undefined,
  toolName: string,
  argsPreview: string,
  opts?: ToolGateOptions,
): Promise<GateResult> {
  assertPermissionContinuationContext()
  const approval = toolPermissionArgs(permissions, toolName, argsPreview, opts)
  return gatePreparedToolOp(
    permissions,
    toolName,
    opts,
    approval,
    await continuationApplies(approval),
  )
}
async function gatePreparedToolOp(
  permissions: PermissionsStore | undefined,
  toolName: string,
  opts: ToolGateOptions | undefined,
  approval: InterruptArgs,
  coordinated: boolean,
): Promise<GateResult> {
  const everyCall = opts?.allowAlways === false
  if (coordinated && permissions) await permissions.load()
  if (!permissions && !coordinated) return { allowed: true }
  if (permissions?.mode === "bypass" && !coordinated) return { allowed: true }

  const rule =
    permissions?.mode === "bypass" ? "unknown" : (permissions?.match("tool", toolName) ?? "unknown")
  // A standing approval must not exist for an every-call tool: an allow rule
  // (configured, or persisted by an "always" answer before the route opted
  // in) falls through to the prompt like an unknown one.
  if (rule === "allow" && !everyCall && !coordinated) return { allowed: true }
  if (rule === "deny") {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return {
      allowed: false,
      reason: `Permission denied by user: tool ${toolName}`,
      code: "B4_E3001",
    }
  }
  if (permissions?.mode === "non-interactive") {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return {
      allowed: false,
      reason: `Permission denied (fail-closed): tool ${toolName}`,
      code: "B4_E3001",
    }
  }
  if (
    opts?.interruptCapable === false &&
    permissions?.mode !== "bypass" &&
    permissions !== undefined
  ) {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return {
      allowed: false,
      reason:
        `Permission denied: tool "${toolName}" requires approval and interactive ` +
        `permission prompts are not available in this execution context. ` +
        `Add an allow rule for "tool" to the permissions config in b4.config.ts.`,
      code: "B4_E3001",
    }
  }
  const decision = await emitPermissionInterrupt(
    approval,
    coordinated,
    undefined,
    !permissions || permissions.mode === "bypass",
  )
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
  assertPermissionContinuationContext()
  const suggestedPattern = subagentPermissionPattern(request.parentRouteId, request.subagentName)
  const approval: InterruptArgs = {
    kind: "subagent",
    callId: request.callId,
    parentRouteId: request.parentRouteId,
    subagentName: request.subagentName,
    subagentRouteId: request.subagentRouteId,
    inputPreview: truncateDisplay(request.input),
    ...(request.reason !== undefined ? { reason: request.reason } : {}),
    suggestedPattern,
    threadId: request.threadId ?? "",
    ...(permissions ? { permissions } : {}),
    protectedProposal: request,
  }
  const coordinated = await continuationApplies(approval)
  if (coordinated && permissions) await permissions.load()
  if (permissions?.mode === "bypass" && !coordinated) return { allowed: true }

  if (permissions) {
    const rule =
      permissions?.mode === "bypass"
        ? "unknown"
        : (permissions?.match("subagent", suggestedPattern) ?? "unknown")
    if (rule === "allow" && !coordinated) return { allowed: true }
    if (rule === "deny") {
      if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
      return {
        allowed: false,
        reason: `Permission denied by user: subagent ${request.subagentName}`,
        code: "B4_E3002",
      }
    }
    if (permissions?.mode === "non-interactive") {
      if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
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
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return {
      allowed: false,
      reason:
        `Permission denied: subagent "${request.subagentName}" requires approval. ` +
        `Provide a non-empty resumable thread ID and enable interrupt support, or add an allow ` +
        `rule for "subagent" to the permissions config in b4.config.ts.`,
      code: "B4_E3002",
    }
  }

  const decision = await emitPermissionInterrupt(
    approval,
    coordinated,
    undefined,
    !permissions || permissions.mode === "bypass",
  )
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
  assertPermissionContinuationContext()
  const approval: InterruptArgs = {
    kind: "memory",
    ...detail,
    ...callFields(opts),
    ...(permissions ? { permissions } : {}),
  }
  const coordinated = await continuationApplies(approval)
  if (coordinated && permissions) await permissions.load()
  if (!permissions && !coordinated) return { allowed: true }
  if (permissions?.mode === "bypass" && !coordinated) return { allowed: true }

  const rule =
    permissions?.mode === "bypass"
      ? "unknown"
      : (permissions?.match("memory", `${detail.namespace}|`) ?? "unknown")
  if (rule === "allow" && !coordinated) return { allowed: true }
  if (rule === "deny") {
    if (coordinated) await emitPermissionInterrupt(approval, true, "deny")
    return { allowed: false, reason: `approval denied for this route's memory overwrites` }
  }
  // unknown + headless → allow through (ask ≡ auto without a human).
  if (permissions?.mode === "non-interactive" && !coordinated) return { allowed: true }

  const decision = await emitPermissionInterrupt(
    approval,
    coordinated,
    undefined,
    !permissions || permissions.mode === "bypass",
  )
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
    b4ExecutionGated: true,
    run: async (input: unknown, context: C) => {
      const gate = await gateToolOp(
        permissions,
        tool.name,
        buildArgsPreview(input),
        withProtectedToolProposal(
          {
            ...opts,
            ...gateCallOptions(context),
          },
          input,
        ),
      )
      reportGateDecision(context, gate)
      if (!gate.allowed) return toolDenial(codedReason(gate))
      await reportExecutionStart(tool, context)
      return tool.run(input, context)
    },
  }
}

/** Report actual execution only after the innermost policy wrapper allows the call. */
async function reportExecutionStart(tool: unknown, context: unknown): Promise<void> {
  if ((tool as { readonly b4ExecutionGated?: true }).b4ExecutionGated === true) return
  await (context as { readonly onExecutionStart?: () => Promise<void> }).onExecutionStart?.()
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
    b4ExecutionGated: true,
    run: async (input: unknown, context: C) => {
      const ctx: ConstraintContext = {
        toolName: tool.name,
        routeId,
        signal: context.signal,
        ...(context.threadId ? { threadId: context.threadId } : {}),
        ...(context.params ? { params: context.params } : {}),
      }
      let verdict: Awaited<ReturnType<ConstraintPredicate>> | undefined
      let failed = false
      try {
        verdict = await predicate(input, ctx)
      } catch {
        failed = true
      }
      const escalated =
        typeof verdict === "object" &&
        verdict !== null &&
        (verdict as { approve?: unknown }).approve === true
      const opts = withProtectedToolProposal(gateCallOptions(context), input)
      if (escalated) {
        const gate = await gateToolOp(permissions, tool.name, buildArgsPreview(input), opts)
        reportGateDecision(context, gate)
        if (!gate.allowed) return toolDenial(codedReason(gate))
        await reportExecutionStart(tool, context)
        return tool.run(input, context)
      }
      const approval = toolPermissionArgs(permissions, tool.name, buildArgsPreview(input), opts)
      const coordinated = await continuationApplies(approval)
      if (coordinated) {
        if (failed || verdict !== true) {
          await emitPermissionInterrupt(approval, true, "deny")
        } else {
          const gate = await gatePreparedToolOp(permissions, tool.name, opts, approval, true)
          reportGateDecision(context, gate)
          if (!gate.allowed) return toolDenial(codedReason(gate))
        }
      }
      if (verdict === true) {
        await reportExecutionStart(tool, context)
        return tool.run(input, context)
      }
      if (typeof verdict === "string") return toolDenial(verdict)
      return toolDenial(CONSTRAINT_FAILED_REASON)
    },
  }
}

// Discriminated union: each kind's required fields are enforced at the call
// site, so a `kind: "tool"` call without toolName is a compile error rather
// than a silently blank interrupt payload.
type InterruptArgs = (
  | {
      kind: "command"
      command: string
      toolCallId?: string | undefined
      step?: GateStepDisplay | undefined
    }
  | {
      kind: "path"
      operation: PathOperation
      path: string
      toolCallId?: string | undefined
      step?: GateStepDisplay | undefined
    }
  | {
      kind: "tool"
      toolName: string
      argsPreview: string
      /** `false`: every call prompts; "always" is answered as "once". */
      allowAlways?: false
      toolCallId?: string | undefined
      step?: GateStepDisplay | undefined
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
    }
) & { readonly protectedProposal?: unknown; readonly permissions?: PermissionsStore }

function preparePermissionPayload(args: InterruptArgs, interruptId: string) {
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
    // label and icon), prepared before the gate without signaling execution;
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
  return payload
}
function actualPermissionProposal(args: InterruptArgs): unknown {
  return args.kind === "tool" || args.kind === "subagent"
    ? args.protectedProposal
    : args.kind === "command"
      ? { command: args.command }
      : args.kind === "path"
        ? { operation: args.operation, path: args.path }
        : {
            namespace: args.namespace,
            identity: args.identity,
            oldId: args.oldId,
            oldContent: args.oldContent,
            newContent: args.newContent,
          }
}
async function continuationApplies(args: InterruptArgs): Promise<boolean> {
  const { interruptId: _id, ...request } = preparePermissionPayload(args, "")
  return confirmRememberedPermission(
    request,
    actualPermissionProposal(args),
    permissionRuleForRequest(request),
  )
}
async function emitPermissionInterrupt(
  args: InterruptArgs,
  coordinated: boolean,
  forcedDecision?: "deny",
  currentPolicyAllows = false,
): Promise<GateDecision> {
  assertPermissionContinuationContext()
  const interruptId = `perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const payload = preparePermissionPayload(args, interruptId)
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
  // A proven coordinated binding already consumed its grant in the shared
  // acceptance transaction, so it never mints into the independent legacy
  // ledger. A new/unmatched gate still requires the configured park minter.
  // KNOWN legacy cost: on the RESUME pass LangGraph
  // re-executes this node from the top, `interruptId` is regenerated (it
  // always has been), and this mints one more grant row that is never
  // disclosed and never presented. It is swept by `voidOutstanding` when the
  // turn settles, because its id is not in the post-turn pending set. The
  // alternative — asking LangGraph's private scratchpad whether this is a
  // replay — trades a bounded, self-cleaning write for a dependency on an
  // unexported internal, which is the worse bargain at the one site that must
  // stay obviously correct.
  const grant = coordinated ? undefined : await mintGrantForPark(interruptId)
  const answered = interrupt(grant === undefined ? payload : { ...payload, grant }) as GateDecision
  // Fail safe: a client that answers "always" to a prompt that offered no
  // such answer gets "once" — the call runs, nothing is persisted, and the
  // step records "once".
  const decision: GateDecision =
    forcedDecision ??
    (answered === "always" && args.kind === "tool" && args.allowAlways === false
      ? "once"
      : answered)
  if (decision === "always") {
    const rule = permissionRuleForRequest(payload)
    if (coordinated) {
      // A prior apply receipt is not current policy authority. Re-read the
      // configured scope; never re-add a rule removed after intent application.
      if (currentPolicyAllows) return decision
      if (!args.permissions) return "deny"
      await args.permissions.load()
      const candidate =
        args.kind === "command"
          ? args.command
          : args.kind === "path"
            ? args.path
            : args.kind === "tool"
              ? args.toolName
              : args.kind === "subagent"
                ? args.suggestedPattern
                : `${args.namespace}|`
      if (args.permissions.match(rule.tool, candidate) !== "allow") return "deny"
    } else if (args.permissions) await args.permissions.addAllow(rule.tool, rule.pattern)
    else return "deny"
  }
  return decision
}

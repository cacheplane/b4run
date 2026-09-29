import type { KnownModelId } from "./known-model-ids.js"
import type { ModelProviderId } from "./model-provider.js"

const B4_AGENT: unique symbol = Symbol.for("b4.agent") as unknown as typeof B4_AGENT

declare const brand: unique symbol

/**
 * How an agent route retries a failed model call. Each model call in the
 * tool loop retries on its own; B4.run never restarts the run, so tools don't
 * run twice and streamed tokens are never sent again. See docs/retry.
 */
export interface RetryConfig {
  /**
   * Attempts per model call, counting the first. Default `3`; `1` sends each
   * call once. Becomes the chat model's `maxRetries` (`maxAttempts - 1`),
   * which covers server errors, network errors and rate limits with a short
   * `Retry-After`, and also caps B4.run's retries of a capacity rate limit.
   * The route's summarization model gets the same `maxRetries`.
   */
  readonly maxAttempts?: number
  /**
   * Milliseconds before the first retry of a capacity rate limit (a 429 with
   * no `Retry-After`); doubles each retry, plus up to 500ms of jitter, capped
   * at 10 seconds. Default `1000`. A 429 whose `Retry-After` is over 10
   * seconds isn't retried. LangChain's own backoff for other errors is fixed
   * and doesn't read it.
   */
  readonly baseDelay?: number
}

export interface ConstraintContext {
  readonly toolName: string
  readonly routeId: string
  readonly threadId?: string
  readonly signal: AbortSignal
  /** Route params in scope (e.g. tenant) when the route is parameterized. */
  readonly params?: Readonly<Record<string, string>>
}

export type ConstraintVerdict = true | string | { readonly approve: true; readonly reason?: string }

export type ConstraintPredicate = (
  args: unknown,
  ctx: ConstraintContext,
) => ConstraintVerdict | Promise<ConstraintVerdict>

export interface ToolScope {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  /**
   * Tools that require human approval per call (HITL interrupt) unless
   * pre-approved via permissions allow.tool or a persisted "always" decision.
   * Name-level: the prompt shows the call's args, but the decision covers the
   * tool name. See docs/permissions.
   */
  readonly approve?: readonly string[]
  /**
   * Per-call argument constraints: a predicate per tool name, run at call time
   * against the model's arguments. Return `true` to allow, a string to deny
   * (returned as the tool result), or `{ approve: true }` to escalate to a HITL
   * approval prompt. Predicate bodies are not statically validated — only the
   * tool names are. See docs/permissions.
   */
  readonly constrain?: Readonly<Record<string, ConstraintPredicate>>
}

export type SubagentMap = Readonly<Record<string, B4Agent>>

export interface DelegationRequest {
  readonly input: string
}

export interface DelegationContext {
  readonly parentRouteId: string
  readonly subagentName: string
  readonly subagentRouteId: string
  readonly threadId?: string
  readonly params?: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

export type DelegationVerdict = true | string | { readonly approve: true; readonly reason?: string }

export type DelegationConstraintPredicate = (
  request: DelegationRequest,
  context: DelegationContext,
) => DelegationVerdict | Promise<DelegationVerdict>

export type DelegationRule =
  | { readonly action: "allow" }
  | { readonly action: "deny"; readonly reason?: string }
  | { readonly action: "approve"; readonly reason?: string }
  | { readonly action: "constrain"; readonly predicate: DelegationConstraintPredicate }

export type DelegationRules<Name extends string> = [Name] extends [never]
  ? Readonly<Record<string, never>>
  : Partial<Record<Name, DelegationRule>>

export interface DelegationConfig<Name extends string> {
  readonly default?: "allow" | "deny" | "approve"
  readonly rules?: DelegationRules<Name>
}

/**
 * Reasoning model tuning. Currently maps to OpenAI's `reasoningEffort`
 * parameter; non-reasoning models silently ignore it.
 *
 * Supported effort values (per OpenAI docs):
 *   - "none"    — disable reasoning entirely (gpt-5.1+ only)
 *   - "minimal" — fastest, smallest reasoning budget
 *   - "low"     — light reasoning
 *   - "medium"  — default for models before gpt-5.1
 *   - "high"    — deeper reasoning; recommended for tool-use-heavy agents
 *   - "xhigh"   — gpt-5.1-codex-max and later only
 */
export interface ReasoningConfig {
  readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
}

export interface B4Agent<Subagents extends SubagentMap = SubagentMap> {
  readonly [brand]: "B4Agent"
  readonly delegation?: DelegationConfig<Extract<keyof Subagents, string>>
  readonly description?: string
  readonly model: string
  readonly provider?: ModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly retry?: RetryConfig
  readonly recursionLimit?: number
  readonly subagents?: Subagents
  readonly tools?: ToolScope
  readonly systemPrompt: string
}

// biome-ignore lint/complexity/noBannedTypes: {} preserves the no-registry key set as never.
export interface AgentConfig<Subagents extends SubagentMap = {}> {
  readonly delegation?: DelegationConfig<NoInfer<Extract<keyof Subagents, string>>>
  readonly description?: string
  readonly model: KnownModelId
  readonly provider?: ModelProviderId
  readonly reasoning?: ReasoningConfig
  readonly retry?: RetryConfig
  /**
   * Maximum number of LangGraph super-steps for one run before it aborts with a
   * recursion error. Defaults to LangGraph's own limit (25). Raise it for deep
   * agents — e.g. a coordinator that dispatches subagents and makes many tool
   * calls — that legitimately need more steps to reach a stop condition.
   */
  readonly recursionLimit?: number
  readonly subagents?: Subagents
  readonly tools?: ToolScope
  readonly systemPrompt: string
}

// biome-ignore lint/complexity/noBannedTypes: {} preserves the no-registry key set as never.
export function agent<const Subagents extends SubagentMap = {}>(
  config: AgentConfig<Subagents>,
): B4Agent<Subagents> {
  return {
    [B4_AGENT]: true,
    model: config.model,
    ...(config.delegation !== undefined ? { delegation: config.delegation } : {}),
    ...(config.provider !== undefined ? { provider: config.provider } : {}),
    ...(config.reasoning ? { reasoning: config.reasoning } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
    ...(config.recursionLimit !== undefined ? { recursionLimit: config.recursionLimit } : {}),
    ...(config.description !== undefined ? { description: config.description } : {}),
    ...(config.subagents !== undefined ? { subagents: config.subagents } : {}),
    ...(config.tools !== undefined ? { tools: config.tools } : {}),
    systemPrompt: config.systemPrompt,
  } as unknown as B4Agent<Subagents>
}

export function isB4Agent(value: unknown): value is B4Agent {
  return (
    typeof value === "object" &&
    value !== null &&
    B4_AGENT in value &&
    (value as Record<symbol, unknown>)[B4_AGENT] === true
  )
}

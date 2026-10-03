# AG-UI outbound reasoning (`REASONING_*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** An `agent()` route can ask its provider to stream visible reasoning (OpenAI Responses `summary`, Anthropic extended-thinking `budgetTokens`), the langchain adapter carries it as `reasoning` chunks, `toAguiEvents` frames it as 1.0 `REASONING_START/REASONING_MESSAGE_*/REASONING_END` with every span and message closed before the run ends, and `GET /agui/:routeId` advertises `reasoning.supported` from the exact fields the chat-model factory forwards.

**Architecture:** `ReasoningConfig` becomes provider-shaped (`{ openai?, anthropic? }`, breaking). One pure function in `@b4run/langchain`, `resolveReasoningConfig(provider, reasoning)`, validates the config against the route's resolved provider and returns both the provider constructor options and a `streams` boolean; the factory applies the options and the CLI's capabilities handler reads `streams` through a new `checkRouteReasoningSupport` preflight — so the claim and the behaviour come from the same code. The adapter's `chunkReasoning` extracts `thinking`/`reasoning` content blocks into `reasoning` chunks keyed by the invocation's `run_id` (the same `messageId` its tokens carry), and the translator opens a span + message per invocation, closing both at that invocation's `message_end` or at any flush boundary.

**Tech Stack:** TypeScript (NodeNext ESM; `src/` imports `.js`, `test/` imports `.ts`), vitest, `@ag-ui/core` 1.0.1, `@langchain/openai` 1.5.13 (`reasoning`, `useResponsesApi`), `@langchain/anthropic` 1.5.11 (`thinking`).

Spec: `docs/superpowers/specs/2026-10-02-ag-ui-1-0-outbound-richness-design.md` §4 (and §4.6 for the capability). This is PR 2 of the sub-project; it is independent of PR 1 (#908) at the code level. It subsumes cacheplane/b4run#897 (which passes `reasoning: { effort }` to `ChatOpenAI` instead of the silently-ignored `reasoningEffort`); #897 can be closed once this lands.

Conventions (from `AGENTS.md`): run from the repo root on Node 24; format changed files from **the package directory** with `pnpm exec biome check --write --config-path ../config-biome/biome.json <files>` (never bare `biome check --write`, never from the root without `--config-path` — it rewraps to tabs/80 cols and the wrap sticks); `exactOptionalPropertyTypes` is on (conditional spreads, never `{ x: undefined }`); changesets are `patch`. Commit the docs content **before** regenerating `lastmod`.

---

## File structure

| File | Responsibility |
|---|---|
| `packages/sdk/src/agent.ts` | **Modify.** `ReasoningConfig` → `{ openai?: OpenAIReasoningConfig; anthropic?: AnthropicReasoningConfig }`; the two sub-interfaces exported. |
| `packages/sdk/src/index.ts` | **Modify.** Export the two new types. |
| `packages/sdk/test/agent-config.contract.ts` | **Modify.** Type-level pins for the new shape. |
| `packages/langchain/src/reasoning-config.ts` | **Create.** `resolveReasoningConfig(provider, reasoning)`: validation + provider constructor options + `streams`. |
| `packages/langchain/src/chat-model-factory.ts` | **Modify.** Apply the resolved options (`reasoning`/`useResponsesApi` for OpenAI, `thinking` for Anthropic). |
| `packages/langchain/src/index.ts` | **Modify.** Export `resolveReasoningConfig` and `ResolvedReasoningConfig`. |
| `packages/langchain/test/reasoning-config.test.ts` | **Create.** Validation and mapping unit tests. |
| `packages/langchain/test/chat-model-factory.test.ts` | **Modify.** The two reasoning tests follow the new mapping. |
| `packages/langchain/test/chat-model-factory-reasoning.test.ts` | **Create.** Installed `ChatOpenAI`/`ChatAnthropic` constructed offline: the request params carry effort/summary/thinking. |
| `packages/langchain/src/agent-adapter.ts` | **Modify.** `chunkReasoning`; `on_chat_model_stream` emits `reasoning` chunks (root only — a child's reasoning is PR 3's attributed stream) and registers the run so `message_end` follows. |
| `packages/langchain/test/model-message-framing.test.ts` | **Modify.** The "thinking carries no token" pin becomes "thinking carries a reasoning chunk, no token". |
| `packages/ag-ui/src/ids.ts` + `test/ids.test.ts` | **Modify.** Kinds `reasoning` (`rsn-`) and `reasoningSpan` (`rspan-`). |
| `packages/ag-ui/src/types.ts` | **Modify.** `reasoning` chunk member. |
| `packages/ag-ui/src/outbound.ts` | **Modify.** Reasoning framing; `AguiOutboundEvent` gains the five reasoning event types. |
| `packages/ag-ui/test/outbound.test.ts` | **Modify.** Flip the "no REASONING_*" pin into a `describe("reasoning")` suite. |
| `packages/ag-ui/test/conformance.test.ts` | **Modify.** Reasoning in the canned turn + a reasoning-cut-by-interrupt run. |
| `packages/cli/src/lib/runtime/execute-route-core.ts` | **Modify.** `checkRouteReasoningSupport` preflight (pattern: `checkRouteResponseFormatSupport`). |
| `packages/cli/src/lib/dev/agui-capabilities.ts` | **Modify.** `reasoning` derived per descriptor route. |
| `packages/cli/test/agui-capabilities.test.ts` | **Modify.** A streaming-reasoning fixture route; expectations. |
| `examples/chat/server/src/app/{chat,coordinator}/index.ts`, `examples/chat/README.md` | **Modify.** New shape, `summary: "auto"`. |
| `apps/web/content/docs/reasoning-effort.mdx`, `apps/web/app/components/docs/nav.ts`, `apps/web/content/docs/agents.mdx` | **Modify.** Page rewritten as "Reasoning"; nav label; cross-links. |
| `apps/web/content/docs/api/sdk.mdx`, `apps/web/content/docs/api/ag-ui.mdx`, `apps/web/content/docs/ag-ui.mdx`, `apps/web/content/docs/upgrading.mdx` | **Modify.** Contracts, outbound table, upgrading entry. |
| `apps/web/app/components/docs/api-reference.ts`, `apps/web/app/components/docs/api-reference.test.ts`, `scripts/check-docs.mjs` | **Modify.** Contract pins (+2), nav label pin. |
| `docs/superpowers/specs/2026-10-02-ag-ui-1-0-outbound-richness-design.md` | **Modify.** §9: PR 4 folds into PRs 2 and 3. |
| `.changeset/agui-reasoning.md` | **Create.** `patch` for `@b4run/sdk`, `@b4run/langchain`, `@b4run/ag-ui`, `@b4run/cli`. |

---

### Task 1: SDK — provider-shaped `ReasoningConfig`

**Files:**
- Modify: `packages/sdk/src/agent.ts` (~lines 106-118)
- Modify: `packages/sdk/src/index.ts`
- Modify: `packages/sdk/test/agent-config.contract.ts` (~lines 66-72)

- [x] **Step 1: Update the type-level contract test first**

In `packages/sdk/test/agent-config.contract.ts`, replace

```ts
type _ReasoningEffort = Expect<
  Equal<
    ReasoningConfig["effort"],
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined
  >
>
```

with

```ts
type _ReasoningOpenAI = Expect<
  Equal<
    NonNullable<ReasoningConfig["openai"]>["effort"],
    "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | undefined
  >
>
type _ReasoningSummary = Expect<
  Equal<NonNullable<ReasoningConfig["openai"]>["summary"], "auto" | "concise" | "detailed" | undefined>
>
type _ReasoningAnthropic = Expect<
  Equal<NonNullable<ReasoningConfig["anthropic"]>["budgetTokens"], number>
>
// The flat 0.13 shape is gone: `effort` is not a key of ReasoningConfig.
type _NoFlatEffort = Expect<Equal<"effort" extends keyof ReasoningConfig ? true : false, false>>
```

- [x] **Step 2: Run the sdk typecheck to see it fail**

Run: `pnpm --filter @b4run/sdk typecheck`
Expected: errors in `agent-config.contract.ts` (`Property 'openai' does not exist`).

- [x] **Step 3: Change the SDK type**

In `packages/sdk/src/agent.ts`, replace the `ReasoningConfig` block (the doc comment starting `Reasoning model tuning.` through the closing `}`) with:

```ts
/**
 * OpenAI reasoning controls, applied when the route resolves to the `openai`
 * provider. `effort` is the request's reasoning effort. `summary` asks the
 * Responses API to stream a summary of the model's reasoning; setting it
 * switches the route to the Responses API and is what makes reasoning text
 * reach clients (AG-UI `REASONING_*`).
 *
 * Supported effort values (per OpenAI docs):
 *   - "none"    — disable reasoning entirely (gpt-5.1+ only)
 *   - "minimal" — fastest, smallest reasoning budget
 *   - "low"     — light reasoning
 *   - "medium"  — default for models before gpt-5.1
 *   - "high"    — deeper reasoning; recommended for tool-use-heavy agents
 *   - "xhigh"   — gpt-5.1-codex-max and later only
 */
export interface OpenAIReasoningConfig {
  readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  readonly summary?: "auto" | "concise" | "detailed"
}

/**
 * Anthropic extended thinking, applied when the route resolves to the
 * `anthropic` provider. `budgetTokens` (a whole number of at least 1024)
 * enables thinking with that budget; the thinking text streams to clients.
 */
export interface AnthropicReasoningConfig {
  readonly budgetTokens: number
}

/**
 * Reasoning controls, keyed by provider. Only the sub-object for the route's
 * resolved provider is read; a sub-object for another provider fails the route
 * when its model is built, so a misplaced setting is never silently ignored.
 */
export interface ReasoningConfig {
  readonly openai?: OpenAIReasoningConfig
  readonly anthropic?: AnthropicReasoningConfig
}
```

In `packages/sdk/src/index.ts`, find the export line that names `ReasoningConfig` and add `AnthropicReasoningConfig` and `OpenAIReasoningConfig` to it (alphabetical within the braces, matching the file's style).

- [x] **Step 4: Typecheck and run sdk tests**

Run: `pnpm --filter @b4run/sdk typecheck && pnpm --filter @b4run/sdk test`
Expected: PASS. (`packages/sdk/test/public-api*.test.ts` may pin the export list — if it fails, add the two names to its expectation.)

- [x] **Step 5: Format and commit**

```bash
(cd packages/sdk && pnpm exec biome check --write --config-path ../config-biome/biome.json src/agent.ts src/index.ts test/agent-config.contract.ts)
git add packages/sdk
git commit -m "feat(sdk)!: provider-shaped ReasoningConfig — openai { effort, summary }, anthropic { budgetTokens }

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `resolveReasoningConfig` and the factory mapping

**Files:**
- Create: `packages/langchain/src/reasoning-config.ts`
- Test: `packages/langchain/test/reasoning-config.test.ts`
- Modify: `packages/langchain/src/chat-model-factory.ts` (~lines 268-272)
- Modify: `packages/langchain/src/index.ts`
- Modify: `packages/langchain/test/chat-model-factory.test.ts` (~lines 14-42)

- [x] **Step 1: Write the unit tests**

Create `packages/langchain/test/reasoning-config.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { resolveReasoningConfig } from "../src/reasoning-config.ts"

describe("resolveReasoningConfig", () => {
  test("no config: nothing forwarded, nothing streams", () => {
    expect(resolveReasoningConfig("openai", undefined)).toEqual({
      constructorOptions: {},
      streams: false,
    })
  })

  test("openai effort alone reasons but does not stream", () => {
    expect(resolveReasoningConfig("openai", { openai: { effort: "high" } })).toEqual({
      constructorOptions: { reasoning: { effort: "high" } },
      streams: false,
    })
  })

  test("openai summary streams and selects the Responses API", () => {
    expect(
      resolveReasoningConfig("openai", { openai: { effort: "low", summary: "auto" } }),
    ).toEqual({
      constructorOptions: { reasoning: { effort: "low", summary: "auto" }, useResponsesApi: true },
      streams: true,
    })
  })

  test("anthropic budgetTokens enables thinking and streams", () => {
    expect(resolveReasoningConfig("anthropic", { anthropic: { budgetTokens: 2048 } })).toEqual({
      constructorOptions: { thinking: { type: "enabled", budget_tokens: 2048 } },
      streams: true,
    })
  })

  test("a sub-object for a provider the route does not resolve to is an error", () => {
    expect(() =>
      resolveReasoningConfig("anthropic", { openai: { effort: "high" } }),
    ).toThrowError(
      'agent() reasoning.openai is set, but the route resolves to the "anthropic" provider; set reasoning.anthropic instead.',
    )
    expect(() =>
      resolveReasoningConfig("openai", { anthropic: { budgetTokens: 2048 } }),
    ).toThrowError(
      'agent() reasoning.anthropic is set, but the route resolves to the "openai" provider; set reasoning.openai instead.',
    )
  })

  test("a provider with no reasoning controls rejects any sub-object", () => {
    expect(() => resolveReasoningConfig("ollama", { openai: { effort: "low" } })).toThrowError(
      'agent() reasoning.openai is set, but the route resolves to the "ollama" provider, which has no reasoning controls in B4.run.',
    )
  })

  test("unknown keys are rejected, naming the valid ones", () => {
    expect(() =>
      resolveReasoningConfig("openai", { effort: "high" } as never),
    ).toThrowError('agent() reasoning has an unknown key "effort"; valid keys are openai, anthropic.')
    expect(() =>
      resolveReasoningConfig("openai", { openai: { efort: "high" } } as never),
    ).toThrowError(
      'agent() reasoning.openai has an unknown key "efort"; valid keys are effort, summary.',
    )
  })

  test("budgetTokens must be a whole number of at least 1024", () => {
    for (const bad of [1023, 1.5, Number.NaN, -1]) {
      expect(() =>
        resolveReasoningConfig("anthropic", { anthropic: { budgetTokens: bad } }),
      ).toThrowError(
        `agent() reasoning.anthropic.budgetTokens must be a whole number of at least 1024, got ${String(bad)}.`,
      )
    }
  })

  test("non-object shapes are rejected", () => {
    expect(() => resolveReasoningConfig("openai", null as never)).toThrowError(
      "agent() reasoning must be an object with openai and/or anthropic, got null.",
    )
    expect(() => resolveReasoningConfig("openai", { openai: "high" } as never)).toThrowError(
      "agent() reasoning.openai must be an object, got string high.",
    )
  })
})
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain exec vitest run test/reasoning-config.test.ts`
Expected: FAIL — module not found.

- [x] **Step 3: Create the resolver**

Create `packages/langchain/src/reasoning-config.ts`:

```ts
import type { ReasoningConfig } from "@b4run/sdk"
import type { BuiltInModelProviderId } from "./model-provider-resolver.js"

/** What the route's resolved provider is told, and whether reasoning text will stream. */
export interface ResolvedReasoningConfig {
  /** Constructor options for the provider's chat model, possibly empty. */
  readonly constructorOptions: Readonly<Record<string, unknown>>
  /**
   * Whether reasoning text reaches the stream: OpenAI only when a `summary` is
   * requested (the Responses API streams nothing otherwise), Anthropic whenever
   * thinking is enabled. `GET /agui/:routeId` advertises exactly this.
   */
  readonly streams: boolean
}

const REASONING_KEYS = ["openai", "anthropic"] satisfies readonly (keyof ReasoningConfig)[]
const OPENAI_KEYS = ["effort", "summary"] as const
const ANTHROPIC_KEYS = ["budgetTokens"] as const
const MIN_BUDGET_TOKENS = 1024

/**
 * The route's reasoning controls, checked against its RESOLVED provider.
 * Throws on a value that cannot mean anything — a sub-object for another
 * provider, an unknown key such as the 0.13 flat `effort`, a budget the API
 * would reject — so a misplaced or misspelled setting fails the route when its
 * model is built instead of silently running at the provider's default (the
 * same posture as `resolveModelRetryPolicy`).
 */
export function resolveReasoningConfig(
  provider: BuiltInModelProviderId,
  reasoning: ReasoningConfig | undefined,
): ResolvedReasoningConfig {
  if (reasoning === undefined) return { constructorOptions: {}, streams: false }
  if (!isRecord(reasoning)) {
    throw new Error(
      `agent() reasoning must be an object with openai and/or anthropic, got ${describeValue(reasoning)}.`,
    )
  }
  for (const key of Object.keys(reasoning)) {
    if (!(REASONING_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `agent() reasoning has an unknown key "${key}"; valid keys are ${REASONING_KEYS.join(", ")}.`,
      )
    }
  }
  for (const key of REASONING_KEYS) {
    if (reasoning[key] !== undefined && key !== provider) {
      const hint =
        provider === "openai" || provider === "anthropic"
          ? `set reasoning.${provider} instead.`
          : "which has no reasoning controls in B4.run."
      throw new Error(
        `agent() reasoning.${key} is set, but the route resolves to the "${provider}" provider${hint.startsWith("set") ? "; " : ", "}${hint}`,
      )
    }
  }

  if (provider === "openai" && reasoning.openai !== undefined) {
    const openai = reasoning.openai
    if (!isRecord(openai)) {
      throw new Error(`agent() reasoning.openai must be an object, got ${describeValue(openai)}.`)
    }
    for (const key of Object.keys(openai)) {
      if (!(OPENAI_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `agent() reasoning.openai has an unknown key "${key}"; valid keys are ${OPENAI_KEYS.join(", ")}.`,
        )
      }
    }
    const options: Record<string, unknown> = {
      ...(openai.effort !== undefined ? { effort: openai.effort } : {}),
      ...(openai.summary !== undefined ? { summary: openai.summary } : {}),
    }
    if (Object.keys(options).length === 0) return { constructorOptions: {}, streams: false }
    return {
      constructorOptions: {
        reasoning: options,
        // Summaries exist only on the Responses API.
        ...(openai.summary !== undefined ? { useResponsesApi: true } : {}),
      },
      streams: openai.summary !== undefined,
    }
  }

  if (provider === "anthropic" && reasoning.anthropic !== undefined) {
    const anthropic = reasoning.anthropic
    if (!isRecord(anthropic)) {
      throw new Error(
        `agent() reasoning.anthropic must be an object, got ${describeValue(anthropic)}.`,
      )
    }
    for (const key of Object.keys(anthropic)) {
      if (!(ANTHROPIC_KEYS as readonly string[]).includes(key)) {
        throw new Error(
          `agent() reasoning.anthropic has an unknown key "${key}"; valid keys are ${ANTHROPIC_KEYS.join(", ")}.`,
        )
      }
    }
    const budget = anthropic.budgetTokens
    if (!Number.isInteger(budget) || budget < MIN_BUDGET_TOKENS) {
      throw new Error(
        `agent() reasoning.anthropic.budgetTokens must be a whole number of at least ${MIN_BUDGET_TOKENS}, got ${String(budget)}.`,
      )
    }
    return {
      constructorOptions: { thinking: { type: "enabled", budget_tokens: budget } },
      streams: true,
    }
  }

  return { constructorOptions: {}, streams: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function describeValue(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return `${typeof value} ${String(value)}`
}
```

Check `BuiltInModelProviderId` is the exported name in `packages/langchain/src/model-provider-resolver.ts` (`grep -n "export type" packages/langchain/src/model-provider-resolver.ts`); if the type lives elsewhere (e.g. `chat-model-factory.ts` imports it from `./model-provider-resolver.js` already — mirror that import).

- [x] **Step 4: Run the resolver tests**

Run: `pnpm --filter @b4run/langchain exec vitest run test/reasoning-config.test.ts`
Expected: PASS (10 tests). The wrong-provider message test expects exactly `…provider; set reasoning.anthropic instead.` and `…"ollama" provider, which has no reasoning controls in B4.run.` — if the punctuation differs, fix the template, not the test.

- [x] **Step 5: Apply it in the factory and update the factory tests**

In `packages/langchain/src/chat-model-factory.ts`, add the import `import { resolveReasoningConfig } from "./reasoning-config.js"` and replace

```ts
  if (options.provider === "openai" && options.reasoning?.effort) {
    constructorOptions.reasoningEffort = options.reasoning.effort
  }
```

with

```ts
  // Checked against the resolved provider: a sub-object for another provider
  // throws here rather than being ignored. ChatOpenAI's constructor reads
  // `reasoning` (`reasoningEffort` is only a per-call option) and streams a
  // summary only on the Responses API; ChatAnthropic reads `thinking`.
  Object.assign(
    constructorOptions,
    resolveReasoningConfig(options.provider, options.reasoning).constructorOptions,
  )
```

In `packages/langchain/src/index.ts`, add:

```ts
export { type ResolvedReasoningConfig, resolveReasoningConfig } from "./reasoning-config.js"
```

In `packages/langchain/test/chat-model-factory.test.ts`, replace the two reasoning tests:

```ts
  test("creates OpenAI with the reasoning controls, on the Responses API when a summary is asked for", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatOpenAI: FakeModel })

    const model = await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      reasoning: { openai: { effort: "high", summary: "auto" } },
      importer,
    })

    expect(importer).toHaveBeenCalledWith("@langchain/openai")
    expect((model as FakeModel).options).toEqual({
      model: "gpt-5-mini",
      reasoning: { effort: "high", summary: "auto" },
      useResponsesApi: true,
    })
  })

  test("creates Anthropic with extended thinking", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatAnthropic: FakeModel })

    const model = await createChatModel({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      reasoning: { anthropic: { budgetTokens: 4096 } },
      importer,
    })

    expect(importer).toHaveBeenCalledWith("@langchain/anthropic")
    expect((model as FakeModel).options).toEqual({
      model: "claude-sonnet-4-5",
      thinking: { type: "enabled", budget_tokens: 4096 },
    })
  })

  test("refuses OpenAI reasoning controls on an Anthropic route before importing the provider", async () => {
    const importer = vi.fn().mockResolvedValue({ ChatAnthropic: FakeModel })

    await expect(
      createChatModel({
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        reasoning: { openai: { effort: "high" } },
        importer,
      }),
    ).rejects.toThrow(/reasoning\.openai is set, but the route resolves to the "anthropic" provider/)
  })
```

Note the third test asserts the error is thrown; `resolveReasoningConfig` runs after the importer in the current factory order — if you want it before the import (cheaper failure, consistent with the `responseFormat` check at the top of `createChatModel`), move the `Object.assign` line's resolution into a `const reasoning = resolveReasoningConfig(...)` right after the `responseFormat` guard and assign `reasoning.constructorOptions` where the old `if` was; then the test can also `expect(importer).not.toHaveBeenCalled()`. Do that.

- [x] **Step 6: Run the factory tests, typecheck**

Run: `pnpm --filter @b4run/langchain exec vitest run test/chat-model-factory.test.ts test/reasoning-config.test.ts && pnpm --filter @b4run/langchain typecheck`
Expected: PASS; 0 type errors. (`agent-adapter.ts` line ~174 passes `descriptor.reasoning` straight through — it still typechecks because the type changed in the SDK, not the plumbing.)

- [x] **Step 7: Format and commit**

```bash
(cd packages/langchain && pnpm exec biome check --write --config-path ../config-biome/biome.json src/reasoning-config.ts src/chat-model-factory.ts src/index.ts test/reasoning-config.test.ts test/chat-model-factory.test.ts)
git add packages/langchain
git commit -m "feat(langchain)!: resolve ReasoningConfig per provider — OpenAI summary on the Responses API, Anthropic thinking

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The installed providers carry the controls (offline)

**Files:**
- Create: `packages/langchain/test/chat-model-factory-reasoning.test.ts`

- [x] **Step 1: Write the test** (adapted from #897, which proved the old constructor field was dropped)

```ts
import { afterEach, describe, expect, test, vi } from "vitest"
import { createChatModel } from "../src/chat-model-factory.ts"
import { defaultModelImporter } from "../src/default-model-importer.ts"

afterEach(() => {
  vi.unstubAllEnvs()
})

type OpenAIRequestParams = {
  readonly reasoning_effort?: string
  readonly reasoning?: { readonly effort?: string; readonly summary?: string }
}
type Requester = { invocationParams(options: Record<string, unknown>): OpenAIRequestParams }

describe("createChatModel reasoning, through the installed providers", () => {
  // The installed ChatOpenAI, constructed offline: the agent's controls must
  // reach the request it sends. The constructor reads `reasoning`;
  // `reasoningEffort` is only a per-call option and was silently ignored.
  test.each(["minimal", "low", "high"] as const)(
    "@langchain/openai sends effort %s on both inner models",
    async (effort) => {
      vi.stubEnv("OPENAI_API_KEY", "test-key-not-used")
      const model = (await createChatModel({
        model: "gpt-5-mini",
        provider: "openai",
        reasoning: { openai: { effort } },
        importer: defaultModelImporter,
      })) as Requester & { completions: Requester; responses: Requester }
      const effortOf = (p: OpenAIRequestParams) => p.reasoning_effort ?? p.reasoning?.effort
      expect(effortOf(model.invocationParams({}))).toBe(effort)
      expect(effortOf(model.completions.invocationParams({}))).toBe(effort)
      expect(effortOf(model.responses.invocationParams({}))).toBe(effort)
    },
  )

  test("@langchain/openai sends the summary request on the Responses API", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-used")
    const model = (await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      reasoning: { openai: { effort: "low", summary: "auto" } },
      importer: defaultModelImporter,
    })) as Requester & { useResponsesApi?: boolean }
    expect(model.useResponsesApi).toBe(true)
    expect(model.invocationParams({}).reasoning).toEqual({ effort: "low", summary: "auto" })
  })

  test("without a reasoning config, the request carries no effort", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-used")
    const model = (await createChatModel({
      model: "gpt-5-mini",
      provider: "openai",
      importer: defaultModelImporter,
    })) as Requester
    const params = model.invocationParams({})
    expect(params.reasoning_effort ?? params.reasoning?.effort).toBeUndefined()
  })

  test("@langchain/anthropic sends extended thinking with the budget", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-used")
    const model = (await createChatModel({
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      reasoning: { anthropic: { budgetTokens: 2048 } },
      importer: defaultModelImporter,
    })) as { invocationParams(options: Record<string, unknown>): { thinking?: unknown } }
    expect(model.invocationParams({}).thinking).toEqual({ type: "enabled", budget_tokens: 2048 })
  })
})
```

- [x] **Step 2: Run it**

Run: `pnpm --filter @b4run/langchain exec vitest run test/chat-model-factory-reasoning.test.ts`
Expected: PASS. If `ChatAnthropic.invocationParams` nests `thinking` differently (read `node_modules/@langchain/anthropic/dist/chat_models.js` `invocationParams`), adjust the assertion path — the point is that the budget reaches the request shape, not the exact nesting.

- [x] **Step 3: Format and commit**

```bash
(cd packages/langchain && pnpm exec biome check --write --config-path ../config-biome/biome.json test/chat-model-factory-reasoning.test.ts)
git add packages/langchain/test/chat-model-factory-reasoning.test.ts
git commit -m "test(langchain): the installed providers carry effort, summary and thinking from ReasoningConfig

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Adapter — `reasoning` chunks from thinking/reasoning blocks

**Files:**
- Modify: `packages/langchain/src/agent-adapter.ts` (`chunkText` ~line 700; `on_chat_model_stream` ~line 755)
- Modify: `packages/langchain/test/model-message-framing.test.ts` (~line 88)

- [x] **Step 1: Flip the framing pin and add the new cases**

In `packages/langchain/test/model-message-framing.test.ts`, read the test at ~line 88 (`"non-text blocks such as thinking and tool-use input carry no token"`): it streams a chunk whose content is `[{ type: "thinking", thinking: "let me see", index: 0 }]` and asserts no `token`. Change its name to `"thinking and tool-use input carry no token; thinking becomes a reasoning chunk"` and extend its assertions so that the collected chunks contain

```ts
      { type: "reasoning", data: "let me see", messageId: "<the run_id the fixture uses>" }
```

and still no `token` for that chunk. Then add, in the same describe, using the same `collect`/stream helpers the file already has:

```ts
  test("a reasoning-only model turn still closes with message_end", async () => {
    // Anthropic thinking → tool call, no prose: the invocation opens with
    // reasoning and must still be ended so the AG-UI mapper can close its span.
    const chunks = await collect([
      {
        event: "on_chat_model_stream",
        run_id: "model-1",
        name: "model",
        data: { chunk: { content: [{ type: "thinking", thinking: "plan", index: 0 }] } },
      },
      {
        event: "on_chat_model_end",
        run_id: "model-1",
        name: "model",
        data: { output: { content: [], tool_calls: [] } },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])
    expect(chunks).toEqual([
      { type: "reasoning", data: "plan", messageId: "model-1" },
      { type: "message_end", data: { messageId: "model-1" } },
    ])
  })

  test("OpenAI Responses reasoning blocks and LangChain standard blocks are reasoning too", async () => {
    const chunks = await collect([
      {
        event: "on_chat_model_stream",
        run_id: "model-2",
        name: "model",
        data: { chunk: { content: [{ type: "reasoning", reasoning: "step one", index: 0 }] } },
      },
      {
        event: "on_chat_model_stream",
        run_id: "model-2",
        name: "model",
        data: { chunk: { content: [{ type: "text", text: "Answer", index: 1 }] } },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])
    expect(chunks.slice(0, 2)).toEqual([
      { type: "reasoning", data: "step one", messageId: "model-2" },
      { type: "token", data: "Answer", messageId: "model-2" },
    ])
  })

  test("redacted thinking and signatures carry nothing", async () => {
    const chunks = await collect([
      {
        event: "on_chat_model_stream",
        run_id: "model-3",
        name: "model",
        data: {
          chunk: {
            content: [
              { type: "redacted_thinking", data: "opaque", index: 0 },
              { type: "thinking", signature: "sig", index: 0 },
            ],
          },
        },
      },
      { event: "on_chain_end", run_id: "root", name: "LangGraph", data: { output: {} } },
    ])
    expect(chunks.filter((c) => c.type === "reasoning" || c.type === "token")).toEqual([])
  })
```

(Use whatever `collect` helper the file defines; if it's named differently, follow the file. If the file's existing fixtures end without `on_chain_end`, match that.)

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/langchain exec vitest run test/model-message-framing.test.ts`
Expected: FAIL — no `reasoning` chunks produced.

- [x] **Step 3: Implement `chunkReasoning` and emit**

In `packages/langchain/src/agent-adapter.ts`, after `chunkText`, add:

```ts
/**
 * The reasoning text a model chunk carries: Anthropic streams `thinking`
 * blocks (field `thinking`; `signature_delta`s arrive as thinking blocks with
 * no text), the OpenAI Responses converter and LangChain's standard content
 * emit `reasoning` blocks (field `reasoning`). `redacted_thinking` and
 * encrypted material are not text and contribute nothing.
 */
function chunkReasoning(content: unknown): string {
  if (!Array.isArray(content)) return ""
  let text = ""
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === "thinking" && typeof block.thinking === "string") text += block.thinking
    else if (block.type === "reasoning" && typeof block.reasoning === "string")
      text += block.reasoning
  }
  return text
}
```

Change the `case "on_chat_model_stream":` body from

```ts
      const content = chunkText((event.data.chunk as { content?: unknown })?.content)
      const chunks: AgentStreamChunk[] = []
      if (content.length > 0) {
```

to

```ts
      const streamed = (event.data.chunk as { content?: unknown })?.content
      const content = chunkText(streamed)
      const chunks: AgentStreamChunk[] = []
      // Root only until the attributed child stream lands (AG-UI sub-project
      // 2, PR 3): a child's reasoning stays inside the subagent boundary.
      const reasoning = child ? "" : chunkReasoning(streamed)
      if (reasoning.length > 0) {
        // Registered like text so this invocation's `on_chat_model_end` emits
        // `message_end`, which is what closes the AG-UI reasoning span.
        rootTools.textModelRunIds.add(event.run_id)
        chunks.push({ type: "reasoning", data: reasoning, messageId: event.run_id })
      }
      if (content.length > 0) {
```

Update the `textModelRunIds` doc comment in `RootToolProjectionState` (~line 300) from `/** Model invocations with open text output. */` to `/** Model invocations with open text or reasoning output, closed by \`message_end\`. */`.

- [x] **Step 4: Run the adapter suites**

Run: `pnpm --filter @b4run/langchain exec vitest run test/model-message-framing.test.ts test/agent-adapter.test.ts`
Expected: PASS.

- [x] **Step 5: Format and commit**

```bash
(cd packages/langchain && pnpm exec biome check --write --config-path ../config-biome/biome.json src/agent-adapter.ts test/model-message-framing.test.ts)
git add packages/langchain
git commit -m "feat(langchain): stream thinking and reasoning blocks as reasoning chunks

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Translator — `REASONING_*` framing

**Files:**
- Modify: `packages/ag-ui/src/ids.ts`, `packages/ag-ui/test/ids.test.ts`
- Modify: `packages/ag-ui/src/types.ts`
- Modify: `packages/ag-ui/src/outbound.ts`
- Modify: `packages/ag-ui/test/outbound.test.ts` (~line 1427, the pin)

- [x] **Step 1: Ids**

In `packages/ag-ui/src/ids.ts`, widen the kind union and prefixes:

```ts
export type IdFactory = (
  kind: "message" | "toolCall" | "toolResult" | "reasoning" | "reasoningSpan",
) => string

const PREFIX: Record<Parameters<IdFactory>[0], string> = {
  message: "msg",
  toolCall: "tc",
  toolResult: "tr",
  reasoning: "rsn",
  reasoningSpan: "rspan",
}
```

and in `createCounterIdFactory` the counters object gains `reasoning: 0, reasoningSpan: 0`. In `packages/ag-ui/test/ids.test.ts` add to the first test `expect(id("reasoning")).toBe("rsn-1")` and `expect(id("reasoningSpan")).toBe("rspan-1")`, and to the second `expect(id("reasoning").startsWith("rsn-")).toBe(true)`.

- [x] **Step 2: Chunk type**

In `packages/ag-ui/src/types.ts`, add after the `token` member:

```ts
  | {
      readonly type: "reasoning"
      readonly data: string
      /** Source model invocation identity; shared with that invocation's tokens. */
      readonly messageId?: string
    }
```

- [x] **Step 3: Replace the pin with the reasoning suite**

In `packages/ag-ui/test/outbound.test.ts`, delete the test `"no chunk becomes a REASONING_* event (capabilities advertise reasoning.supported: false)"` and append:

```ts
describe("reasoning", () => {
  test("an identified invocation: span and message open on the first delta, close at message_end, interleaving with text", async () => {
    const out = await collect([
      { type: "reasoning", data: "think ", messageId: "m1" },
      { type: "token", data: "Hi", messageId: "m1" },
      { type: "reasoning", data: "more", messageId: "m1" },
      { type: "message_end", data: { messageId: "m1" } },
      { type: "done" },
    ])
    expect(out.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_CONTENT,
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED,
    ])
    expect(out[1]).toEqual({ type: EventType.REASONING_START, messageId: "rspan-1" })
    expect(out[2]).toEqual({
      type: EventType.REASONING_MESSAGE_START,
      messageId: "rsn-1",
      role: "reasoning",
    })
    expect(out[3]).toEqual({
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "rsn-1",
      delta: "think ",
    })
    expect(out[7]).toEqual({ type: EventType.REASONING_MESSAGE_END, messageId: "rsn-1" })
    expect(out[8]).toEqual({ type: EventType.REASONING_END, messageId: "rspan-1" })
    // Three distinct ids for one invocation: span, reasoning message, text message.
    expect(new Set(["rspan-1", "rsn-1", "msg-1"]).size).toBe(3)
  })

  test("two invocations get two spans and two reasoning messages", async () => {
    const out = await collect([
      { type: "reasoning", data: "a", messageId: "m1" },
      { type: "message_end", data: { messageId: "m1" } },
      { type: "reasoning", data: "b", messageId: "m2" },
      { type: "message_end", data: { messageId: "m2" } },
      { type: "done" },
    ])
    const starts = out.filter((e) => e.type === EventType.REASONING_MESSAGE_START)
    expect(starts.map((e) => e.messageId)).toEqual(["rsn-1", "rsn-2"])
    expect(
      out.filter((e) => e.type === EventType.REASONING_START).map((e) => e.messageId),
    ).toEqual(["rspan-1", "rspan-2"])
  })

  test("an anonymous reasoning delta closes at the next tool boundary", async () => {
    const out = await collect([
      { type: "reasoning", data: "plan" },
      { type: "tool_call", data: { id: "tc-9", name: "search", input: {} } },
      { type: "done" },
    ])
    const kinds = out.map((e) => e.type)
    expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(kinds.indexOf(EventType.TOOL_CALL_START))
    expect(kinds.filter((k) => k === EventType.REASONING_START)).toHaveLength(1)
  })

  test("reasoning still open at done, interrupt, stream end, cancel and error is closed before the terminal", async () => {
    for (const tail of [
      [{ type: "done" }],
      [{ type: "interrupt", data: { interruptId: "i-1", kind: "tool", callId: "tc-1" } }, { type: "done" }],
      [],
    ] as B4AgentStreamChunk[][]) {
      const out = await collect([{ type: "reasoning", data: "x", messageId: "m1" }, ...tail])
      const kinds = out.map((e) => e.type)
      expect(kinds.indexOf(EventType.REASONING_MESSAGE_END)).toBeGreaterThan(-1)
      expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(kinds.length - 1)
      expect(kinds.at(-1)).toBe(EventType.RUN_FINISHED)
    }
    for (const cancelled of [true, false]) {
      async function* stream(): AsyncIterable<B4AgentStreamChunk> {
        yield { type: "reasoning", data: "x", messageId: "m1" }
        throw new Error("stop")
      }
      const out = []
      for await (const ev of toAguiEvents(stream(), CTX, {
        idFactory: createCounterIdFactory(),
        cancelled: () => cancelled,
      })) {
        out.push(ev)
      }
      const kinds = out.map((e) => e.type)
      expect(kinds.slice(-3)).toEqual([
        EventType.REASONING_MESSAGE_END,
        EventType.REASONING_END,
        cancelled ? EventType.RUN_FINISHED : EventType.RUN_ERROR,
      ])
    }
  })

  test("an empty reasoning delta emits nothing", async () => {
    const out = await collect([{ type: "reasoning", data: "", messageId: "m1" }, { type: "done" }])
    expect(out.map((e) => e.type)).toEqual([EventType.RUN_STARTED, EventType.RUN_FINISHED])
  })
})
```

- [x] **Step 4: Run to verify failure**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/outbound.test.ts -t "reasoning" test/ids.test.ts`
Expected: ids tests fail on unknown kinds; reasoning tests fail (no REASONING events).

- [x] **Step 5: Implement the framing**

In `packages/ag-ui/src/outbound.ts`:

Imports — add to the `@ag-ui/core` type import: `ReasoningEndEvent, ReasoningMessageContentEvent, ReasoningMessageEndEvent, ReasoningMessageStartEvent, ReasoningStartEvent`. Extend `AguiOutboundEvent`:

```ts
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
```

State — after `const identifiedMessages = new Map<string, string>()`:

```ts
  /**
   * Reasoning is framed per model invocation like text: one span and one
   * message, opened on the first delta. The span and message ids are distinct
   * from each other and from the invocation's text message id — the 1.0
   * reducer warns when one id is shared across text, reasoning and activity
   * messages.
   */
  interface OpenReasoning {
    readonly spanId: string
    readonly messageId: string
  }
  let openReasoning: OpenReasoning | null = null
  const identifiedReasoning = new Map<string, OpenReasoning>()
```

Helpers — add after `flushText`'s definition (and make `flushText` close anonymous reasoning first):

```ts
  function* closeReasoning(open: OpenReasoning): Generator<AguiOutboundEvent> {
    yield* ledger.onPassthrough({
      type: EventType.REASONING_MESSAGE_END,
      messageId: open.messageId,
    })
    yield* ledger.onPassthrough({ type: EventType.REASONING_END, messageId: open.spanId })
  }

  function* flushReasoning(): Generator<AguiOutboundEvent> {
    if (openReasoning !== null) {
      const open = openReasoning
      openReasoning = null
      yield* closeReasoning(open)
    }
  }

  function* openReasoningFrame(): Generator<AguiOutboundEvent, OpenReasoning> {
    const open: OpenReasoning = { spanId: nextId("reasoningSpan"), messageId: nextId("reasoning") }
    yield* ledger.onPassthrough({ type: EventType.REASONING_START, messageId: open.spanId })
    yield* ledger.onPassthrough({
      type: EventType.REASONING_MESSAGE_START,
      messageId: open.messageId,
      role: "reasoning",
    })
    return open
  }
```

Change `flushText` to begin with `yield* flushReasoning()` (anonymous reasoning closes at every boundary anonymous text does). Change `closeIdentified(sourceId)` to also close reasoning for that source — at its top:

```ts
    const reasoning = identifiedReasoning.get(sourceId)
    if (reasoning !== undefined) {
      identifiedReasoning.delete(sourceId)
      yield* closeReasoning(reasoning)
    }
```

(before the existing `const messageId = identifiedMessages.get(sourceId); if (messageId === undefined) return`). Change `flushAllText` to also iterate `identifiedReasoning.keys()` through `closeIdentified` — since `closeIdentified` now handles both, iterate the union: `for (const sourceId of new Set([...identifiedReasoning.keys(), ...identifiedMessages.keys()])) yield* closeIdentified(sourceId)`.

Chunk case — add before `case "message_end":`:

```ts
        case "reasoning": {
          const delta = typeof chunk.data === "string" ? chunk.data : ""
          if (delta.length === 0) break
          const sourceId =
            "messageId" in chunk &&
            typeof chunk.messageId === "string" &&
            chunk.messageId.length > 0
              ? chunk.messageId
              : undefined
          if (sourceId !== undefined) {
            yield* flushReasoning()
            let open = identifiedReasoning.get(sourceId)
            if (open === undefined) {
              open = yield* openReasoningFrame()
              identifiedReasoning.set(sourceId, open)
            }
            yield* ledger.onPassthrough({
              type: EventType.REASONING_MESSAGE_CONTENT,
              messageId: open.messageId,
              delta,
            })
            break
          }
          if (openReasoning === null) openReasoning = yield* openReasoningFrame()
          yield* ledger.onPassthrough({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: openReasoning.messageId,
            delta,
          })
          break
        }
```

Note on the identified `token` case: it calls `yield* flushText()` which now also flushes *anonymous* reasoning — correct (an identified token means the producer identifies invocations, so anonymous reasoning belongs to nothing current). It must NOT close identified reasoning for the same source: text and reasoning of one invocation interleave until `message_end`. Verify by reading the first test's expected order.

- [x] **Step 6: Run the ag-ui suite and typecheck**

Run: `pnpm --filter @b4run/ag-ui exec vitest run && pnpm --filter @b4run/ag-ui typecheck`
Expected: PASS. If `openReasoningFrame`'s `Generator<AguiOutboundEvent, OpenReasoning>` return typing trips `yield*` inside a `Generator<AguiOutboundEvent>` function, annotate the callers as `Generator<AguiOutboundEvent, void>` — `yield*` of a generator with a return value is legal and gives the value.

- [x] **Step 7: Format and commit**

```bash
(cd packages/ag-ui && pnpm exec biome check --write --config-path ../config-biome/biome.json src/ids.ts src/types.ts src/outbound.ts test/ids.test.ts test/outbound.test.ts)
git add packages/ag-ui
git commit -m "feat(ag-ui): REASONING_* framing — one span and message per model invocation, closed before the run ends

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Conformance

**Files:**
- Modify: `packages/ag-ui/test/conformance.test.ts`

- [x] **Step 1: Reasoning in the canned turn**

In `CANNED`, insert before `{ type: "token", data: "Researching" }`:

```ts
  { type: "reasoning", data: "The user wants sources; search first." },
```

(anonymous, like the surrounding tokens — it closes at the first `tool_call_args`). In `"a full turn passes 1.0 enforcement with nothing stripped"`, after the `TEXT_MESSAGE_CONTENT` join assertion, add:

```ts
  // Reasoning survives enforcement as a span + a `role: "reasoning"` message,
  // both closed before the first tool frame.
  expect(kinds).toContain(EventType.REASONING_START)
  expect(kinds).toContain(EventType.REASONING_MESSAGE_START)
  expect(kinds.indexOf(EventType.REASONING_END)).toBeLessThan(kinds.indexOf(EventType.TOOL_CALL_START))
  expect(
    events
      .filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)
      .map((event) => event.delta)
      .join(""),
  ).toBe("The user wants sources; search first.")
```

Also check what the client's message list holds: after `runThroughClient`, `agent.messages` should contain one message with `role: "reasoning"` and `content: "The user wants sources; search first."` — add:

```ts
  expect(agent.messages.filter((m) => m.role === "reasoning")).toEqual([
    expect.objectContaining({ content: "The user wants sources; search first." }),
  ])
```

(`runThroughClient` returns `{ agent, events, result }`; destructure `agent` too.)

- [x] **Step 2: Reasoning cut by an interrupt, then resumed**

Add a new test:

```ts
it("reasoning open at an interrupt is closed before RUN_FINISHED, and the resume starts fresh", async () => {
  const { url } = await startCannedServer([
    {
      stream: () =>
        toAsync([
          { type: "reasoning", data: "need approval", messageId: "m1" },
          {
            type: "interrupt",
            data: { interruptId: "perm-1", kind: "tool", callId: "c1", grant: "b4ag_xyz" },
          },
        ]),
    },
    {
      stream: () =>
        toAsync([
          { type: "reasoning", data: "approved, continuing", messageId: "m2" },
          { type: "token", data: "done", messageId: "m2" },
          { type: "message_end", data: { messageId: "m2" } },
          { type: "done", data: {} },
        ]),
    },
  ])
  const first = await runThroughClient(url, { runId: "r1" })
  const firstKinds = first.events.map((e) => e.type)
  expect(firstKinds.slice(-3)).toEqual([
    EventType.REASONING_MESSAGE_END,
    EventType.REASONING_END,
    EventType.RUN_FINISHED,
  ])
  expect(first.events.at(-1)).toMatchObject({ outcome: { type: "interrupt" } })

  const second = await runThroughClient(url, {
    runId: "r2",
    resume: [{ interruptId: "perm-1", status: "resolved", payload: "once", metadata: { grant: "b4ag_xyz" } }],
  })
  const secondKinds = second.events.map((e) => e.type)
  expect(secondKinds.filter((k) => k === EventType.REASONING_START)).toHaveLength(1)
  expect(secondKinds.at(-1)).toBe(EventType.RUN_FINISHED)
})
```

Match the `resume` entry shape to what the existing approval-interrupt test in this file sends (read it; copy its `resume` literal and metadata).

- [x] **Step 3: Run the conformance suite**

Run: `pnpm --filter @b4run/ag-ui exec vitest run test/conformance.test.ts`
Expected: PASS with zero warnings. A "stripped or translated" failure names the key the client removed — the likely culprit is a `role` on a non-`REASONING_MESSAGE_START` event or a missing `role: "reasoning"`.

- [x] **Step 4: Format and commit**

```bash
(cd packages/ag-ui && pnpm exec biome check --write --config-path ../config-biome/biome.json test/conformance.test.ts)
git add packages/ag-ui/test/conformance.test.ts
git commit -m "test(ag-ui): conformance covers reasoning spans through the real 1.0 client

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Capability — `reasoning` derived from the route

**Files:**
- Modify: `packages/cli/src/lib/runtime/execute-route-core.ts` (next to `checkRouteResponseFormatSupport`, ~line 896)
- Modify: `packages/cli/src/lib/dev/agui-capabilities.ts`
- Modify: `packages/cli/test/agui-capabilities.test.ts`

- [x] **Step 1: Extend the capabilities test**

In `packages/cli/test/agui-capabilities.test.ts`:

Add a fixture route after `GEMINI_ROUTE`:

```ts
/** An agent route that asks OpenAI to stream a reasoning summary. */
const REASONING_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gpt-5-mini", reasoning: { openai: { effort: "low", summary: "auto" } }, systemPrompt: "t" })',
  "",
].join("\n")
/** Effort alone reasons but streams nothing. */
const EFFORT_ONLY_ROUTE = [
  'import { agent } from "@b4run/sdk"',
  'export default agent({ model: "gpt-5-mini", reasoning: { openai: { effort: "low" } }, systemPrompt: "t" })',
  "",
].join("\n")
```

Register them in `fixtureApp`'s `files`: `"src/app/thinking/index.ts": REASONING_ROUTE, "src/app/effort/index.ts": EFFORT_ONLY_ROUTE`.

Rename the constant `REASONING` to `NO_REASONING` (keep `{ supported: false }`) and update every use. Add a test:

```ts
  it("advertises reasoning only when the route's config makes it stream", async () => {
    const handler = await createHandler(await fixtureApp())

    expect((await capabilities(handler, "/thinking#agent")).reasoning).toEqual({
      encrypted: false,
      streaming: true,
      supported: true,
    })
    expect((await capabilities(handler, "/effort#agent")).reasoning).toEqual(NO_REASONING)
    expect((await capabilities(handler, "/open#agent")).reasoning).toEqual(NO_REASONING)
    expect((await capabilities(handler, "/echo#graph")).reasoning).toEqual(NO_REASONING)
    expect((await capabilities(handler, "/raw#agent")).reasoning).toEqual(NO_REASONING)
  })
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm --filter @b4run/cli exec vitest run test/agui-capabilities.test.ts -t "advertises reasoning"`
Expected: FAIL — `/thinking#agent` reports `{ supported: false }`.

- [x] **Step 3: Add the preflight**

In `packages/cli/src/lib/runtime/execute-route-core.ts`, add `resolveReasoningConfig` to the `@b4run/langchain` import list, and after `checkRouteResponseFormatSupport`:

```ts
/**
 * Whether the route's model will stream reasoning text: an `agent()`
 * descriptor whose `reasoning` asks for it (OpenAI `summary`, Anthropic
 * `budgetTokens`), resolved by the same function the chat-model factory
 * applies — so `GET /agui/:routeId` claims exactly what the model is told.
 * A config the factory would reject reports `streams: false` with the
 * message; the run itself surfaces the error.
 */
export async function checkRouteReasoningSupport(options: {
  readonly appRoot: string
  readonly bootFallbacks: RuntimeBootFallbacks | undefined
  readonly routeFile: string
  readonly routeId: string
}): Promise<{ readonly ok: true; readonly streams: boolean } | PreparedRouteError> {
  const prepared = await getPreparedRouteModules(
    { appRoot: options.appRoot, routeFile: options.routeFile, routeId: options.routeId },
    options.bootFallbacks,
  )
  const normalized = prepared.module
  if (normalized.kind !== "agent" || !isB4Agent(normalized.entry)) {
    return { ok: false, message: nonAgentReasoningMessage(options.routeId, normalized.kind) }
  }
  const descriptor = normalized.entry
  try {
    const provider = resolveProvider({
      model: descriptor.model,
      ...(descriptor.provider !== undefined ? { provider: descriptor.provider } : {}),
    })
    return { ok: true, streams: resolveReasoningConfig(provider, descriptor.reasoning).streams }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Why a chain/graph/workflow route has no reasoning controls. */
export function nonAgentReasoningMessage(routeId: string, kind: string): string {
  return `Route "${routeId}" is a ${kind} route; reasoning controls apply only to an agent() route's root model.`
}
```

Read `checkRouteResponseFormatSupport` (~line 904-915) to confirm `prepared.module` is the normalized module shape it passes to `responseFormatSupport` and mirror it exactly (the name may be `prepared.normalized`).

- [x] **Step 4: Use it in the capabilities handler**

In `packages/cli/src/lib/dev/agui-capabilities.ts`:

- Import `checkRouteReasoningSupport` alongside the two existing preflights.
- Rename the constant: `const NO_REASONING: NonNullable<AgentCapabilities["reasoning"]> = { supported: false }` with the comment `/** Nothing reasoning-shaped reaches the wire from this route. */`, and use `NO_REASONING` at the three existing sites.
- In `agentCapabilities`, inside the `try` after `structuredOutput = …`:

```ts
    const reasoningSupport = await checkRouteReasoningSupport(routeModule)
    streamsReasoning = reasoningSupport.ok && reasoningSupport.streams
```

with `let streamsReasoning: boolean` declared beside `isDescriptor`. In the returned object replace `reasoning: REASONING,` with:

```ts
    // The factory forwards a summary (OpenAI) or a thinking budget
    // (Anthropic) exactly when `streams` is true, and the adapter turns the
    // resulting blocks into `reasoning` chunks → `REASONING_*`. Nothing is
    // encrypted: redacted/encrypted material is dropped, never carried.
    reasoning: streamsReasoning
      ? { encrypted: false, streaming: true, supported: true }
      : NO_REASONING,
```

- Rewrite the module doc-comment bullet on `reasoning.supported` to describe the new derivation and name the pins: `packages/langchain/test/reasoning-config.test.ts` (what streams), `packages/langchain/test/model-message-framing.test.ts` (blocks → `reasoning` chunks), `packages/ag-ui/test/outbound.test.ts` `describe("reasoning")` (chunks → `REASONING_*`).

- [x] **Step 5: Run the cli capabilities tests and typecheck**

Run: `pnpm --filter @b4run/cli exec vitest run test/agui-capabilities.test.ts && pnpm --filter @b4run/cli typecheck`
Expected: PASS; 0 errors. (`agui-capabilities.ts` must stay free of `node:` imports — `execute-route-core` already is the source of its other two preflights, so this adds nothing new.)

- [x] **Step 6: Format and commit**

```bash
(cd packages/cli && pnpm exec biome check --write --config-path ../config-biome/biome.json src/lib/runtime/execute-route-core.ts src/lib/dev/agui-capabilities.ts test/agui-capabilities.test.ts)
git add packages/cli
git commit -m "feat(cli): advertise reasoning from the config the chat-model factory forwards

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Examples, docs, pins, changeset

**Files:**
- Modify: `examples/chat/server/src/app/chat/index.ts`, `examples/chat/server/src/app/coordinator/index.ts`, `examples/chat/README.md` (line 44)
- Modify: `apps/web/content/docs/reasoning-effort.mdx` (rewrite), `apps/web/app/components/docs/nav.ts`, `apps/web/content/docs/agents.mdx` (lines 106, 123), `scripts/check-docs.mjs` (~line 4041 nav pin; contract pins ~line 1206)
- Modify: `apps/web/content/docs/api/sdk.mdx` (exports table ~line 47; contract ~line 229), `apps/web/content/docs/api/ag-ui.mdx` (exports table), `apps/web/content/docs/ag-ui.mdx` (outbound table + section), `apps/web/content/docs/upgrading.mdx` (new entry under "Changes by version", first)
- Modify: `apps/web/app/components/docs/api-reference.ts`, `apps/web/app/components/docs/api-reference.test.ts` (count 122 → 124)
- Modify: `docs/superpowers/specs/2026-10-02-ag-ui-1-0-outbound-richness-design.md` §9
- Create: `.changeset/agui-reasoning.md`

- [x] **Step 1: Examples**

In both chat example routes replace `reasoning: { effort: "high" },` with `reasoning: { openai: { effort: "high", summary: "auto" } },`. In `examples/chat/README.md` line 44 replace `` `reasoning: { effort: "high" }` `` with `` `reasoning: { openai: { effort: "high", summary: "auto" } }` `` and append the sentence: `The summary is what lets the web client show the model's reasoning as it streams.` Run `pnpm --filter @b4-example/chat-server typecheck` and `pnpm --filter @b4-example/chat-server test` (aimock serves `/v1/responses`, so the scripted fixtures still answer).

- [x] **Step 2: The reasoning page**

Rewrite `apps/web/content/docs/reasoning-effort.mdx` (slug kept) with H1 `# Reasoning` and these sections, keeping the existing `RelatedCards` block at the end:

```md
# Reasoning

`reasoning` tunes how hard an `agent()` route's model thinks, and whether the thinking is shown. It is keyed by provider, and only the block for the route's resolved provider is read.

## Quick start

```ts title="src/app/support/[tenant]/index.ts"
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  reasoning: { openai: { effort: "high", summary: "auto" } },
  systemPrompt: "You are a careful support assistant.",
})
```

`ReasoningConfig`, `OpenAIReasoningConfig` and `AnthropicReasoningConfig` are exported from `@b4run/sdk`.

## OpenAI

```ts
reasoning: {
  openai: {
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
    summary?: "auto" | "concise" | "detailed"
  }
}
```

`effort` is the request's reasoning effort; the provider decides which values mean something for each model, and models without reasoning ignore it. `summary` asks the Responses API to stream a summary of the model's reasoning. Setting it moves the route to the Responses API (B4.run sets `ChatOpenAI`'s `useResponsesApi`), and the summary streams to clients as reasoning: AG-UI `REASONING_*` events, which CopilotKit renders as a reasoning message. Without `summary`, the model still reasons at the requested effort but nothing is shown.

## Anthropic

```ts
reasoning: {
  anthropic: {
    budgetTokens: number // a whole number of at least 1024
  }
}
```

`budgetTokens` enables extended thinking with that budget (`ChatAnthropic`'s `thinking: { type: "enabled", budget_tokens }`). The thinking text streams to clients the same way an OpenAI summary does.

## What B4.run checks

The block must match the route's provider. `reasoning.openai` on a route that resolves to Anthropic, or either block on a provider with no reasoning controls, fails the route when its model is built, naming the misplaced key — a setting is never silently ignored. An unknown key (including the pre-0.14 flat `effort`) and a `budgetTokens` under 1024 fail the same way. B4.run does not check whether a particular model accepts the setting; that is the provider's error, surfaced as a model-call failure.

Leave out `reasoning` and B4.run sends nothing, so the provider's default applies.

## Where it applies

Reasoning applies to `agent()` routes, where `@b4run/langchain` builds the model. In `workflow`, raw `graph` and `chain` routes, and for any model you create yourself, set reasoning on that model instance.

`GET /agui/{routeId}` advertises `reasoning: { supported: true, streaming: true, encrypted: false }` exactly when the route's config makes reasoning stream, and `{ supported: false }` otherwise. See [AG-UI](/docs/ag-ui#outbound-events).

## Choosing a value

Leave it unset until a route needs it. Lower effort suits routes where speed and cost matter more than careful thinking; higher effort suits routes that call many tools, plan a lot, or combine several pieces of evidence. More reasoning will not make up for missing tools or context.

Show reasoning (`summary`, `budgetTokens`) when users benefit from seeing the plan — a research assistant, a long tool loop — and leave it hidden for short answers, where it is noise.

## Subagents

Each `agent()` sets its own reasoning, so a parent and child can differ:

```ts
// parent
export default agent({
  model: "gpt-5-mini",
  reasoning: { openai: { effort: "low" } },
  systemPrompt: "Coordinate the work.",
})

// child
export default agent({
  model: "gpt-5-mini",
  reasoning: { openai: { effort: "high", summary: "auto" } },
  systemPrompt: "Analyze the evidence carefully.",
})
```

A child keeps its own setting, whatever the parent uses.
```

(Keep the `## Related` + `RelatedCards` block from the current file, with the SDK card subtitle changed to `AgentConfig, ReasoningConfig and the provider blocks`.)

Nav: in `apps/web/app/components/docs/nav.ts` change the entry label `"Reasoning Effort"` to `"Reasoning"`; in `scripts/check-docs.mjs` ~line 4041 change `{ label: "Reasoning Effort", href: "/docs/reasoning-effort" }` to `{ label: "Reasoning", href: "/docs/reasoning-effort" }`. In `apps/web/content/docs/agents.mdx` line 106 → `` - [Reasoning](/docs/reasoning-effort) tunes effort and streams reasoning on `agent()` routes, per provider. `` and line 123's card `title: "Reasoning"`.

- [x] **Step 3: SDK API reference**

In `apps/web/content/docs/api/sdk.mdx`: in the exports table change the `ReasoningConfig` row to `| \`ReasoningConfig\` | Configure model reasoning per provider. |` and add rows `| \`OpenAIReasoningConfig\` | Configure OpenAI reasoning effort and streamed summary. |` and `| \`AnthropicReasoningConfig\` | Configure Anthropic extended thinking. |` after it. Replace the `ReasoningConfig` contract block + field table with:

````md
```ts api-contract="@b4run/sdk#.:ReasoningConfig"
export interface ReasoningConfig {
  readonly openai?: OpenAIReasoningConfig
  readonly anthropic?: AnthropicReasoningConfig
}
```

**Fields: `@b4run/sdk#.:ReasoningConfig`**
| Field | Type | Required | Description |
|---|---|---|---|
| `readonly openai` | `OpenAIReasoningConfig` | no | Apply when the route resolves to OpenAI. |
| `readonly anthropic` | `AnthropicReasoningConfig` | no | Apply when the route resolves to Anthropic. |

```ts api-contract="@b4run/sdk#.:OpenAIReasoningConfig"
export interface OpenAIReasoningConfig {
  readonly effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh"
  readonly summary?: "auto" | "concise" | "detailed"
}
```

**Fields: `@b4run/sdk#.:OpenAIReasoningConfig`**
| Field | Type | Required | Description |
|---|---|---|---|
| `readonly effort` | `"none" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"` | no | Set the request's reasoning effort. |
| `readonly summary` | `"auto" \| "concise" \| "detailed"` | no | Stream a reasoning summary on the Responses API. |

```ts api-contract="@b4run/sdk#.:AnthropicReasoningConfig"
export interface AnthropicReasoningConfig {
  readonly budgetTokens: number
}
```

**Fields: `@b4run/sdk#.:AnthropicReasoningConfig`**
| Field | Type | Required | Description |
|---|---|---|---|
| `readonly budgetTokens` | `number` | yes | Enable extended thinking with this token budget (at least 1024). |
````

Add `"@b4run/sdk#.:OpenAIReasoningConfig"` and `"@b4run/sdk#.:AnthropicReasoningConfig"` next to `"@b4run/sdk#.:ReasoningConfig"` in all three lists: `apps/web/app/components/docs/api-reference.ts`, `apps/web/app/components/docs/api-reference.test.ts` (and bump its `toHaveLength(122)` to `124`), `scripts/check-docs.mjs`. If `check-docs` reports the heading-id list (the `"reasoningconfig"` entry near line 4846) needs `"openaireasoningconfig"` / `"anthropicreasoningconfig"`, add them in the same order the page has them.

- [x] **Step 4: AG-UI docs**

`apps/web/content/docs/ag-ui.mdx` outbound table — add before the `usage` row:

```md
| `reasoning` (per model invocation, alongside its `token`s) | `REASONING_START` and `REASONING_MESSAGE_START { role: "reasoning" }` once, then `REASONING_MESSAGE_CONTENT` per delta; both closed at the invocation's `message_end` or the next tool/terminal boundary |
```

and a section after "Token usage":

```md
### Reasoning

When a route's [`reasoning`](/docs/reasoning-effort) asks the provider to show its thinking (OpenAI `summary`, Anthropic `budgetTokens`), each model invocation's reasoning is framed as one span and one `role: "reasoning"` message with their own ids, distinct from the invocation's assistant text. Reasoning and text of one invocation may interleave; both close when the invocation ends, and anything still open at a tool call, an interrupt, cancellation or an error is closed before the terminal event, as 1.0 requires. Redacted or encrypted reasoning is dropped, never carried, so `reasoning.encrypted` is `false`. `GET /agui/{routeId}` advertises `reasoning.supported` from the same config the model is built with; a route with only `effort` set reasons but streams nothing and advertises `{ supported: false }`.
```

`apps/web/content/docs/api/ag-ui.mdx` — in the `@b4run/ag-ui` exports table, update `IdFactory`'s row if it names the kinds; otherwise nothing (the `IdFactory` contract block, if present as an `api-contract`, must match the new union — grep `IdFactory` in the file and update the type literal).

- [x] **Step 5: Upgrading entry**

In `apps/web/content/docs/upgrading.mdx`, insert as the first entry under `## Changes by version`:

```md
### `reasoning` is keyed by provider

`agent({ reasoning: { effort } })` is now `agent({ reasoning: { openai: { effort } } })`, and Anthropic routes gain `reasoning: { anthropic: { budgetTokens } }`. The flat `effort` is an unknown key and fails the route when its model is built, as does a block for a provider the route does not resolve to — before, a misplaced setting was silently ignored. Setting `openai.summary` moves the route to the OpenAI Responses API and streams the summary as AG-UI `REASONING_*` events; `GET /agui/{routeId}` advertises `reasoning.supported` accordingly. See [Reasoning](/docs/reasoning-effort).
```

- [x] **Step 6: Spec §9**

In the spec, replace the four-PR list's items 2–4 with: `2. Reasoning — … plus the reasoning capability section (#883 merged before this PR, so the claim ships with the behaviour, as the pin in outbound.test.ts requires). 3. Subagents — … plus the multiAgent capability section.` and delete item 4. Update §4.6's opening to say the claim ships in PR 2.

- [x] **Step 7: Changeset**

Create `.changeset/agui-reasoning.md`:

```md
---
"@b4run/sdk": patch
"@b4run/langchain": patch
"@b4run/ag-ui": patch
"@b4run/cli": patch
---

**Breaking:** `agent()`'s `reasoning` is keyed by provider. `reasoning: { effort }` becomes `reasoning: { openai: { effort } }`; a flat `effort`, an unknown key, or a block for a provider the route does not resolve to now fails the route when its model is built (before, a misplaced setting was silently ignored — and the OpenAI effort itself never reached the request, see #897). New controls make reasoning visible: `openai.summary: "auto" | "concise" | "detailed"` streams a reasoning summary (and moves the route to the Responses API), `anthropic.budgetTokens` enables extended thinking. The langchain adapter carries thinking and reasoning blocks as `reasoning` stream chunks; `@b4run/ag-ui` frames them as AG-UI 1.0 `REASONING_START` / `REASONING_MESSAGE_*` / `REASONING_END`, one span and one `role: "reasoning"` message per model invocation, every one closed before the run ends. `GET /agui/:routeId` advertises `reasoning: { supported: true, streaming: true, encrypted: false }` exactly when the route's config makes reasoning stream. `IdFactory` gains the `reasoning` and `reasoningSpan` kinds.
```

- [x] **Step 8: Commit content, regenerate lastmod, run the docs gates**

```bash
(cd apps/web && pnpm exec biome check --write --config-path ../../packages/config-biome/biome.json app/components/docs/nav.ts app/components/docs/api-reference.ts app/components/docs/api-reference.test.ts)
pnpm exec biome check --write --config-path packages/config-biome/biome.json scripts/check-docs.mjs
git add examples/chat apps/web/content apps/web/app/components scripts/check-docs.mjs docs/superpowers/specs .changeset/agui-reasoning.md
git commit -m "docs: reasoning per provider — page, SDK and AG-UI references, upgrading entry; chat example streams its summary

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm --dir apps/web seo:lastmod
git add apps/web/app/seo/lastmod.generated.json
git commit -m "chore(web): regenerate SEO lastmod manifest

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
pnpm build
node scripts/check-docs.mjs
node scripts/check-changesets.mjs
pnpm --filter @b4run/web test
```

Expected: all exit 0. `check-docs` failures name the exact pin (field table mismatch, undocumented export, nav label); fix the doc, not the pin, unless the pin is the thing that changed (nav label, contract list).

---

### Task 9: Full validation and PR

- [ ] **Step 1: Package gates for everything touched**

```bash
pnpm build
pnpm --filter @b4run/sdk --filter @b4run/langchain --filter @b4run/ag-ui --filter @b4run/cli --filter @b4run/web typecheck
pnpm --filter @b4run/sdk --filter @b4run/langchain --filter @b4run/ag-ui --filter @b4run/cli --filter @b4run/testing --filter @b4-example/chat-server test
pnpm lint
```

- [ ] **Step 2: `pnpm ci:validate`** in the background (`> scratch/ci-validate-2.log 2>&1; echo "exit=$?"`), then read the exit line and grep the log for `FAIL`. A `@b4run/sandbox` `bounded-filesystem` 5s timeout under load is a known contention flake — re-run that file alone to confirm before dismissing it.

- [ ] **Step 3: Branch from the rebased base, push, PR**

Before pushing: `git fetch origin main` and rebase; re-run Step 1's tests if anything under `packages/{sdk,langchain,ag-ui,cli}` moved. Check `gh run list --repo cacheplane/b4run --status in_progress` — keep at most two maintainer PRs with full CI active.

```bash
git push -u origin blove/agui-outbound-reasoning
gh pr create --repo cacheplane/b4run --title "feat!: reasoning per provider, streamed as AG-UI REASONING_* (AG-UI 1.0 sub-project 2, PR 2)" --body "$(cat <<'EOF'
Part of #885 (AG-UI 1.0 sub-project 2). Spec: `docs/superpowers/specs/2026-10-02-ag-ui-1-0-outbound-richness-design.md` §4; plan: `docs/superpowers/plans/2026-10-02-ag-ui-outbound-reasoning.md`. Supersedes #897 (the OpenAI effort fix is included).

**Breaking (`@b4run/sdk`).** `ReasoningConfig` is provider-shaped: `{ openai?: { effort?, summary? }, anthropic?: { budgetTokens } }`. One function, `resolveReasoningConfig(provider, reasoning)`, validates it against the route's resolved provider (a misplaced block, the old flat `effort`, an unknown key or a budget under 1024 fails the route when its model is built) and returns the provider constructor options plus `streams`.

**Factory.** OpenAI gets `reasoning: { effort, summary }` (not the silently-ignored `reasoningEffort`) and `useResponsesApi: true` when a summary is asked for; Anthropic gets `thinking: { type: "enabled", budget_tokens }`. Proven against the installed providers offline.

**Adapter.** `thinking` / `reasoning` content blocks become `reasoning` chunks keyed by the invocation's `run_id`; the invocation still ends with `message_end`. Redacted/encrypted material is dropped.

**Translator.** One `REASONING_START` span and one `REASONING_MESSAGE_START { role: "reasoning" }` message per invocation, ids distinct from the text message; closed at `message_end` or any flush/terminal boundary. Conformance through the real 1.0 client: interleaved with text, cut by a tool call, cut by an interrupt and resumed.

**Capability.** `GET /agui/:routeId` derives `reasoning` through `checkRouteReasoningSupport` → the same `resolveReasoningConfig.streams` the factory applies: `{ supported: true, streaming: true, encrypted: false }` when it streams, `{ supported: false }` otherwise (incl. effort-only, graph and raw routes). The #906 pin that demanded the flip travel with the translator change is replaced by the `describe("reasoning")` suite.

**Docs/examples.** `/docs/reasoning-effort` rewritten as "Reasoning" (slug kept); SDK/AG-UI references; upgrading entry; the chat example streams its summary.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Bind the PR in the app (`get_status`), enable auto-merge (squash) if the user asked for merge-on-green, and do not poll CI.**

---

## Self-review

- **Spec §4 coverage:** 4.1 SDK → Task 1; 4.2 factory → Task 2 (+3 proves it against installed providers); 4.3 validation → Task 2 (at model build, same posture as `retry` — the spec's "surfaced by `b4 check`" is narrowed to "when the model is built", which is where `resolveModelRetryPolicy` also runs; the reasoning page says so); 4.4 extraction → Task 4 (the OpenAI `summary[].text` branch in the spec is unnecessary: `@langchain/openai`'s Responses converter already flattens summaries into `reasoning` blocks — recorded in `chunkReasoning`'s comment); 4.5 framing → Task 5 + 6; 4.6 capability → Task 7; docs → Task 8. §9 restructure → Task 8 Step 6.
- **Placeholders:** none. Every code step has the code; the two "read the file and mirror" notes (prepared-module field name, ChatAnthropic `invocationParams` nesting) tell the engineer exactly what to confirm.
- **Type consistency:** `resolveReasoningConfig(provider, reasoning): { constructorOptions, streams }` is used identically in Task 2 (factory), Task 7 (CLI). `OpenReasoning { spanId, messageId }`, `openReasoningFrame()`, `closeReasoning()`, `flushReasoning()` are consistent through Task 5. Id kinds `reasoning`/`reasoningSpan` → prefixes `rsn`/`rspan` match the outbound test expectations. `NO_REASONING` is used consistently in Task 7's handler and test.

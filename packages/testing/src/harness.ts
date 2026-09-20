import { randomUUID } from "node:crypto"
import {
  __resetMaterializedAgentsForTests,
  __resetRouteLoadCachesForTests,
  type B4ResumeEntry,
  createRuntimeRegistry,
  readPendingInterrupts,
  resolveCheckpointer,
  resolvePendingResume,
  resolveSandboxManager,
  runTypegen,
  type SandboxManager,
  streamResolvedRoute,
} from "@b4run/cli/runtime"
import { __clearB4ConfigCacheForTests } from "@b4run/core"
import { discoverRoutes } from "@b4run/core/node"
import type { B4ToolContext } from "@b4run/sdk"
import { type Aimock, createAimock } from "./aimock-runner.js"
import type { FixtureSet, ScriptBuilder } from "./fixture-builder.js"
import { recordingsToFixtures } from "./record-fixtures.js"
import { type AgentRunResult, collectRunResult } from "./run-result.js"

/** Normalise a ScriptBuilder or bare FixtureSet to a FixtureSet. */
function toFixtureSet(f: FixtureSet | ScriptBuilder): FixtureSet {
  if (Array.isArray(f)) return f
  return f.build()
}

/** Extract the system prompt from a slice of aimock journal requests. */
function systemPromptFromRequests(
  reqs: ReadonlyArray<{ body: { messages?: Array<{ role: string; content: unknown }> } | null }>,
): string {
  for (const req of reqs) {
    const messages = req.body?.messages ?? []
    for (const m of messages) {
      // OpenAI chat models use role "system"; gpt-5 / reasoning models send the
      // system prompt under role "developer". Accept either so the captured
      // systemPrompt is populated regardless of which model the route uses.
      if ((m.role === "system" || m.role === "developer") && typeof m.content === "string") {
        return m.content
      }
    }
  }
  return ""
}

/** The turn a harness is about to drive; passed to a `middlewareContext` factory. */
export interface AgentHarnessRunInfo {
  readonly threadId: string
  /** The user message for `run()`; absent for `resume()`. */
  readonly input?: string
  /** The interrupt resolutions for `resume()`; absent for `run()`. */
  readonly resume?: readonly B4ResumeEntry[]
}

/**
 * The context a route's `middleware.ts` would have produced via `allow(context)`,
 * either as a fixed value or as a factory evaluated once per `run()`/`resume()`.
 * Tools read it as `ctx.middleware`.
 */
export type AgentHarnessMiddlewareContext =
  | NonNullable<B4ToolContext["middleware"]>
  | ((
      run: AgentHarnessRunInfo,
    ) =>
      | NonNullable<B4ToolContext["middleware"]>
      | undefined
      | Promise<NonNullable<B4ToolContext["middleware"]> | undefined>)

export interface AgentHarnessOptions {
  readonly appRoot: string
  readonly route: string
  readonly fixtures?: FixtureSet
  /**
   * The harness invokes the route's agent directly, so `middleware.ts` never
   * runs. Supply the context it would have returned so tools that read
   * `ctx.middleware` (a session, a database handle, a per-request snapshot)
   * behave as they do behind the server. A function is evaluated per turn.
   */
  readonly middlewareContext?: AgentHarnessMiddlewareContext
  /**
   * When true, proxy all LLM requests through a real upstream (OPENAI_API_KEY
   * must be set). Requires OPENAI_API_KEY to be present in the environment.
   */
  readonly live?: boolean
  /** Capture real-model traffic for getRecordedFixtures(). Proxies to recordUpstream. */
  readonly record?: boolean
  /** Upstream base URL for record mode (no /v1 suffix). Default https://api.openai.com. */
  readonly recordUpstream?: string
}

/** Evaluate a `middlewareContext` option (value or per-turn factory) for one turn. */
async function resolveMiddlewareContext(
  option: AgentHarnessMiddlewareContext | undefined,
  run: AgentHarnessRunInfo,
): Promise<NonNullable<B4ToolContext["middleware"]> | undefined> {
  if (option === undefined) return undefined
  if (typeof option === "function") return await option(run)
  return option
}

export interface AgentHarness {
  readonly baseUrl: string
  run(opts: { input: string; fixtures?: FixtureSet | ScriptBuilder }): Promise<AgentRunResult>
  resume(opts: {
    resume: readonly B4ResumeEntry[]
    fixtures?: FixtureSet | ScriptBuilder
  }): Promise<AgentRunResult>
  reset(): void
  close(options?: { readonly destroyWorkspaces?: boolean }): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
  /** Fixtures captured from the most recent run() (record mode only); re-keyed for replay. */
  getRecordedFixtures(): FixtureSet
}

export async function createAgentHarness(options: AgentHarnessOptions): Promise<AgentHarness> {
  const live = options.live ?? false
  const record = options.record ?? false

  // Guard: live mode requires a real API key before doing anything else.
  if (live && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "createAgentHarness({ live: true }) requires OPENAI_API_KEY to be set in the environment",
    )
  }

  const prevBaseUrl = process.env.OPENAI_BASE_URL
  const prevKey = process.env.OPENAI_API_KEY

  // Start aimock once — port (and thus the cached agent's baseURL) stays stable for the harness lifetime.
  // In live mode: proxy all requests through to the real OpenAI upstream.
  // In record mode: proxy to recordUpstream and capture responses for getRecordedFixtures().
  const aimock: Aimock = live
    ? await createAimock({ fixtures: [], proxy: { openai: "https://api.openai.com" } })
    : record
      ? await createAimock({
          fixtures: [],
          proxy: { openai: options.recordUpstream ?? "https://api.openai.com" },
          record: true,
        })
      : await createAimock({ fixtures: options.fixtures ?? [] })
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  // Only inject a dummy key in mock mode; live and record modes use real or no key.
  if (!live && !record) {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "test-not-used"
  }

  // All construction steps after aimock starts are wrapped so we can clean up on failure.
  let resolved: Awaited<ReturnType<Awaited<ReturnType<typeof createRuntimeRegistry>>["lookup"]>>
  let sandboxManager: SandboxManager | undefined
  try {
    // typegen once → generated tool schemas exist (dev-boot fidelity)
    const manifest = await discoverRoutes({ appRoot: options.appRoot })
    await runTypegen({ appRoot: options.appRoot, manifest })

    const registry = await createRuntimeRegistry(options.appRoot)
    resolved = registry.lookup(options.route)
    if (!resolved) {
      throw new Error(`createAgentHarness: unknown route "${options.route}"`)
    }
    sandboxManager = await resolveSandboxManager(options.appRoot)
  } catch (err) {
    // Unified cleanup: stop aimock and restore env vars before re-throwing.
    if (sandboxManager) await sandboxManager.releaseAll()
    await aimock.close()
    if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
    else process.env.OPENAI_BASE_URL = prevBaseUrl
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = prevKey
    throw err
  }

  const baseUrl = aimock.baseUrl
  let threadId = randomUUID()
  const ownedThreads = new Set([threadId])
  let closed = false
  let lastRunJournalStart = 0
  let lastRunFixtureStart = 0

  /** Core drive helper — runs a single turn and merges systemPrompt. */
  async function drive(driveOpts: {
    fixtures?: FixtureSet | ScriptBuilder
    input?: string
    resume?: readonly B4ResumeEntry[]
  }): Promise<AgentRunResult> {
    // In live and record modes, fixtures are proxied to the upstream — skip registration.
    if (!live && !record && driveOpts.fixtures) {
      const newFixtures = toFixtureSet(driveOpts.fixtures)
      if (newFixtures.length > 0) {
        aimock.addFixtures(newFixtures)
      }
    }
    const snapshotLen = aimock.getRequests().length
    lastRunJournalStart = snapshotLen
    lastRunFixtureStart = aimock.getFixtureCount()
    const r = resolved
    if (!r) {
      throw new Error(`createAgentHarness: unknown route "${options.route}"`)
    }
    let resolvedResume: Readonly<Record<string, "once" | "always" | "deny">> | undefined
    if (driveOpts.resume) {
      const checkpointer = await resolveCheckpointer(options.appRoot)
      const pending = await readPendingInterrupts(checkpointer, threadId)
      if (!pending) {
        throw new Error(`createAgentHarness: no checkpoint found for thread "${threadId}"`)
      }
      const resolution = resolvePendingResume(driveOpts.resume, pending)
      if (!resolution.ok) {
        throw new Error(`createAgentHarness: ${resolution.message} (${resolution.code})`)
      }
      if (resolution.mode !== "resume") {
        throw new Error("createAgentHarness: no pending interrupts to resume")
      }
      resolvedResume = resolution.resume
    }
    const middlewareContext = await resolveMiddlewareContext(options.middlewareContext, {
      threadId,
      ...(driveOpts.input !== undefined ? { input: driveOpts.input } : {}),
      ...(driveOpts.resume !== undefined ? { resume: driveOpts.resume } : {}),
    })
    const streamArgs: Parameters<typeof streamResolvedRoute>[0] = {
      appRoot: options.appRoot,
      input:
        driveOpts.input !== undefined
          ? { messages: [{ role: "user", content: driveOpts.input }] }
          : { messages: [] },
      routeFile: r.routeFile,
      routeId: r.routeId,
      routePath: r.routePath,
      threadId,
      ...(sandboxManager ? { sandboxManager } : {}),
      ...(resolvedResume ? { resume: resolvedResume } : {}),
      ...(middlewareContext !== undefined ? { middlewareContext } : {}),
    }
    const stream = streamResolvedRoute(streamArgs)
    const result = await collectRunResult(stream, threadId)
    const turnReqs = aimock.getRequests().slice(snapshotLen)
    return { ...result, systemPrompt: systemPromptFromRequests(turnReqs) }
  }

  const harness: AgentHarness = {
    get baseUrl() {
      return baseUrl
    },
    async run(runOpts) {
      return drive({
        input: runOpts.input,
        ...(runOpts.fixtures !== undefined ? { fixtures: runOpts.fixtures } : {}),
      })
    },
    async resume(resumeOpts) {
      return drive({
        resume: resumeOpts.resume,
        ...(resumeOpts.fixtures !== undefined ? { fixtures: resumeOpts.fixtures } : {}),
      })
    },
    reset() {
      threadId = randomUUID()
      ownedThreads.add(threadId)
      // Start each scenario from a clean fixture set. Fixtures are registered
      // additively per run() and findFixture is first-match-in-array-order, so
      // without this a loosely-matched fixture from a prior scenario (e.g. a raw
      // FixtureSet with no `userMessage`) would shadow the next run's turn-0
      // call. Live mode proxies to the real upstream and registers no fixtures.
      if (!live) {
        aimock.clearFixtures()
        if (options.fixtures && options.fixtures.length > 0) {
          aimock.addFixtures(options.fixtures)
        }
      }
    },
    getRecordedFixtures() {
      return recordingsToFixtures(
        aimock.getRecordingsSince(lastRunJournalStart, lastRunFixtureStart),
      )
    },
    async close(closeOptions) {
      if (closed) return
      if (closeOptions?.destroyWorkspaces && sandboxManager) {
        for (const id of ownedThreads) {
          await sandboxManager.destroyThread(id)
          await (await resolveCheckpointer(options.appRoot)).deleteThread(id)
          sandboxManager.completeDelete(id)
        }
      }
      if (sandboxManager) await sandboxManager.releaseAll()
      closed = true
      await aimock.close()
      // restore env to avoid cross-test bleed
      if (prevBaseUrl === undefined) delete process.env.OPENAI_BASE_URL
      else process.env.OPENAI_BASE_URL = prevBaseUrl
      if (prevKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prevKey
      // Reset the per-descriptor LLM cache so the next harness constructs a
      // fresh ChatOpenAI instance pointing to its own aimock URL. Without this,
      // successive harnesses that share the same B4Agent descriptor object
      // (ESM module cache returns the same export) would reuse an LLM already
      // bound to the previous (stopped) aimock server.
      __resetMaterializedAgentsForTests()
      // loadB4Config is now memoized per appRoot for the process lifetime
      // (perf(core): memoize loadB4Config per appRoot). Test suites that
      // rewrite a fixture app's b4.config.ts and drive it again through a
      // fresh harness in the same process (e.g. switching a memory backend
      // via env + config) need that mutation to actually take effect — clear
      // the memo here so the next createAgentHarness call reloads from disk.
      __clearB4ConfigCacheForTests()
      // Same reasoning for the per-route module cache and per-appRoot route
      // manifest memo (perf(cli): load route modules/tools/state once per
      // process): a fixture app mutated between harnesses (new tool file,
      // added route) must be re-discovered by the next harness.
      __resetRouteLoadCachesForTests()
    },
    [Symbol.asyncDispose](): Promise<void> {
      return this.close()
    },
  }
  return harness
}

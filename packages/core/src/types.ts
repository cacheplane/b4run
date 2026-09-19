import type { PermissionMode, PermissionsStore } from "@b4run/permissions"
import type { ApprovalGrantMode, InterruptGrantStore, ModelProviderId, RouteKind } from "@b4run/sdk"
import type { ThreadsStore } from "@b4run/sqlite-storage"
import type { ExecBackend, FilesystemBackend, SandboxConfig } from "@b4run/workspace"
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint"
import type { BuildTargetName } from "./build-targets.js"

export type { RouteKind }

/** One route of a Vercel Build Output `config.json`; `src` is required. */
export type VercelBuildRoute = Readonly<Record<string, unknown>> & { readonly src: string }

/** `build.vercel` — see {@link B4Config.build}. Paths resolve from the app root. */
export interface VercelBuildConfig {
  /**
   * Name of the runtime function (`functions/<name>.func`). Defaults to
   * `"b4"`, never `"index"`: a function named `index` is also served at `/`,
   * where it would shadow `static/index.html`. Combining `"index"` with
   * {@link static} fails the build.
   */
  readonly functionName?: string
  /**
   * `maxDuration` for the runtime function, in positive integer seconds.
   * Omitted leaves the property off `.vc-config.json` and Vercel applies the
   * project default. The runtime function runs the agent, so it is the one a
   * long tool-using run outgrows; composed {@link functions} set their own.
   */
  readonly maxDuration?: number
  /** A directory copied verbatim into `static/`, with an optional SPA document. */
  readonly static?: {
    readonly dir: string
    /**
     * Path inside `dir` served for every path the filesystem and the runtime
     * do not claim (`{ src: "/(.*)", dest: "/<spaFallback>" }`, last). When
     * set, the runtime route is scoped to the surfaces the runtime owns
     * (`/healthz`, `/readyz`, `/agui`, `/threads`, `/memory`) instead of
     * catching all.
     */
    readonly spaFallback?: string
  }
  /**
   * Additional Node functions, each bundled from `entry` with esbuild into
   * `functions/<name>.func/index.mjs`. Route to one with
   * `{ src: "/api/(.*)", dest: "/api" }` in {@link routes}.
   */
  readonly functions?: Readonly<
    Record<
      string,
      {
        readonly entry: string
        /** Vercel Node runtime id. Default `"nodejs24.x"`. */
        readonly runtime?: string
        /** Positive integer seconds. */
        readonly maxDuration?: number
        readonly supportsResponseStreaming?: boolean
      }
    >
  >
  /**
   * Routes placed before the filesystem phase. `b4 build` appends
   * `{ handle: "filesystem" }`, the runtime route, and the SPA fallback itself;
   * a `handle` entry here is rejected.
   */
  readonly routes?: readonly VercelBuildRoute[]
  /**
   * Where the `"vercel"` target publishes its Build Output API tree.
   * Resolved relative to the app root; defaults to `.vercel/output`, the
   * directory Vercel deploys from. `b4 build --out-dir <dir>` overrides it
   * per run. The directory must not contain the app root itself.
   */
  readonly outDir?: string
  /**
   * Whether `b4 build` reconciles the app-root `vercel.json` with the
   * target's lifecycle contract (a `buildCommand` that runs `b4 build`
   * and `fluid: true`): it writes the recommended file when none
   * exists, warns when an authored file does not establish the
   * contract, and fails on `fluid: false`.
   *
   * Set to `false` for a prebuilt flow (`vercel deploy --prebuilt` from
   * CI, no Vercel Git integration): Vercel never runs `buildCommand`
   * there, so the target neither requires nor touches a committed
   * `vercel.json`. Fluid compute still matters for the deployed
   * project — keep it enabled in the project settings.
   *
   * Defaults to `true`.
   */
  readonly reconcileVercelJson?: boolean
}

export interface B4Config {
  readonly appDir?: string
  readonly backends?: {
    readonly filesystem?: FilesystemBackend
    readonly exec?: ExecBackend
  }
  readonly permissions?: {
    readonly mode?: PermissionMode
    readonly allow?: Readonly<Record<string, readonly string[]>>
    readonly deny?: Readonly<Record<string, readonly string[]>>
    /**
     * Custom permissions store. Defaults to the file-backed store at
     * `<appRoot>/.b4/permissions.json`. A custom store receives `mode` and
     * the `allow`/`deny` lists above through its own options — the runtime
     * only calls `load()` on it, then reads it.
     */
    readonly store?: PermissionsStore
  }
  /**
   * Human-in-the-loop approvals. See the approval-grants docs.
   */
  readonly approvals?: {
    /**
     * Whether a parked approval carries a single-use **grant** that must be
     * echoed on resume — the fix for replay and staleness in #736.
     *
     * - `"off"` (default) — no grant is minted and none is required. Exactly
     *   the pre-grant behavior.
     * - `"optional"` — grants are minted and disclosed, and an interrupt that
     *   HAS a grant requires it. An interrupt parked without one (before the
     *   migration, or while the mode was `"off"`) resumes as before. The
     *   softness is per-interrupt-age, not per-request: a per-request softness
     *   would be a bypass.
     * - `"required"` — a resume with no grant is refused, and a park that
     *   cannot mint one is refused too, loudly. See the fail-closed rule on
     *   `mintGrantForPark`.
     *
     * The setting is process-wide and ratchets up only: two app roots in one
     * process share the strictest mode either asks for.
     */
    readonly grants?: ApprovalGrantMode
    /**
     * Lifetime of a minted grant, in milliseconds. Omitted means no TTL, and
     * that is the default on purpose — a human approval may legitimately sit
     * overnight, and an expiry that fires while someone is asleep turns a
     * safety feature into an outage.
     */
    readonly grantTtlMs?: number
    /**
     * Where consumption is recorded. Defaults to the SQLite store beside the
     * checkpointer on node, and to an in-process store elsewhere — which is
     * NOT durable and NOT replica-safe, so a multi-replica deployment must
     * configure a real one (`@b4run/postgres-storage`).
     */
    readonly grantStore?: InterruptGrantStore
  }
  readonly checkpointer?: BaseCheckpointSaver
  readonly threadsStore?: ThreadsStore
  /**
   * Path to the env file loaded for local `b4 dev` / `b4 verify`,
   * relative to the app root. Defaults to "./.env". Does NOT affect the
   * deploy artifact (langgraph.json env is detected separately).
   */
  readonly env?: string
  readonly toolOutput?: {
    /** Offload tool outputs whose serialized length exceeds this many characters. Default 40000. */
    readonly offloadThresholdChars?: number
    /** Number of leading lines kept in the in-context preview. Default 10. */
    readonly previewLines?: number
    /** Max total bytes retained under workspace/tool-outputs/. Default 268435456 (256MB). */
    readonly maxBytes?: number
    /** Delete offloaded files older than this many ms. Default 10800000 (3h). */
    readonly ttlMs?: number
    /** Minimum ms between GC scans. Default 10000 (10s). */
    readonly gcThrottleMs?: number
    /**
     * Tool names whose output is never offloaded. Merged with the built-in
     * defaults (`readFile`, `listDir`), which are always exempt — exempting
     * the retrieval tools is required so the agent can read back offloaded
     * content without it being re-offloaded.
     */
    readonly noOffloadTools?: readonly string[]
  }
  readonly summarization?: {
    /** Enable conversation summarization. Default false. */
    readonly enabled?: boolean
    /** Token threshold over which older history is summarized. Default 12000. */
    readonly maxTokens?: number
    /** Most-recent turns kept verbatim (a turn starts at a HumanMessage). Default 6. */
    readonly keepRecentTurns?: number
    /** Model id for the summary LLM call. Defaults to the route's model. */
    readonly model?: string
    /** Token counter. Default: a lazy gpt-tokenizer (o200k_base) counter. */
    readonly tokenCounter?: (text: string) => number | Promise<number>
    /** Summary generator. Default: a built-in single-LLM-call summarizer. */
    readonly summarize?: (args: {
      readonly messages: readonly unknown[]
      readonly model: string
      readonly previousSummary?: string
      readonly signal: AbortSignal
    }) => Promise<string>
  }
  /**
   * Deployment build configuration for `b4 build`.
   */
  readonly build?: {
    /**
     * Which deployment artifacts `b4 build` emits. Known targets:
     * - `"node"` — a runnable Node server entry (`.b4/build/server.mjs`,
     *   which boots {@link serveRuntime}) plus a hardened `Dockerfile`.
     * - `"langsmith"` — the LangSmith deploy config (`.b4/build/langgraph.json`
     *   and the per-route materialized graph entry files).
     * - `"hono"` — an edge entry point: `.b4/build/app.mjs` (a Hono app over
     *   the web-standard fetch handler), the node-builtin-free static manifest
     *   `modules.edge.mjs`, a per-request `stores.mjs` factory, and a
     *   `wrangler.toml` scaffold. Opt-in only, and never emitted by default:
     *   the edge serves a subset of B4.run (no sandbox, no workspace tooling) and
     *   requires durable stores to be configured.
     * - `"vercel"` — Vercel Build Output API artifacts under `.vercel/output/`.
     *   Opt-in only, and never emitted by default: it serves the same edge
     *   subset of B4.run as `"hono"` (no sandbox, no workspace tooling) and
     *   requires durable stores to be configured.
     *
     * Defaults to `["node", "langsmith"]` when omitted. Only the names in
     * {@link BUILD_TARGET_NAMES} are accepted, so a misspelling fails to
     * type-check instead of failing at `b4 build`.
     */
    readonly targets?: readonly BuildTargetName[]
    /**
     * Shape and options of the `"vercel"` target's Build Output tree. Ignored
     * unless `"vercel"` is in {@link targets}. With nothing set the output is
     * the runtime function alone (`functions/b4.func`) behind a catch-all
     * route, published to `.vercel/output`, and the app-root `vercel.json` is
     * reconciled.
     */
    readonly vercel?: VercelBuildConfig
  }
  readonly sandbox?: SandboxConfig
  /**
   * How the B4.run HTTP runtime itself behaves — as opposed to what the agent
   * does. Everything here is off unless configured.
   */
  readonly server?: {
    /**
     * Cross-origin access to the B4.run endpoints (`/agui/*`, `/threads/*`,
     * `/memory/*`). Omit and the runtime sends no `Access-Control-*` header at
     * all, which means a browser on another origin cannot call it — the
     * default, because opening a server to other origins is a deployment
     * decision.
     *
     * Set it when a browser client talks to B4.run directly rather than through
     * a same-origin proxy:
     *
     * ```ts
     * server: { cors: { origins: ["http://localhost:3010"] } }
     * ```
     */
    readonly cors?: CorsConfig
  }
  readonly memory?: {
    readonly enabled?: boolean
    /** Custom memory store. Defaults to an SQLite-backed store at <appRoot>/.b4/memory.sqlite. */
    readonly store?: import("./capabilities/types.js").MemoryStoreLike
    /** Write-governance mode. "off" — never write; "candidate" — write as candidate (default); "auto" — write and auto-promote; "ask" — auto, but supersedes require HITL approval when interactive. */
    readonly writes?: "off" | "candidate" | "auto" | "ask"
    /** Maximum number of entries returned by the index. */
    readonly indexMaxEntries?: number
    /** Recall ranking tuning for the default SQLite store. All fields
     *  defaulted; omit for standard behavior. Ignored when a custom `store`
     *  is supplied (custom stores own their own ranking). */
    readonly recall?: {
      readonly weights?: {
        readonly relevance?: number
        readonly recency?: number
        readonly confidence?: number
      }
      readonly recencyHalfLifeMs?: number
      readonly candidatePool?: number
    }
    /** Opt-in vector/semantic recall. Presence of `embedder` enables it; absent
     *  → keyword-only (unchanged). Ignored when a custom `store` is supplied. */
    readonly vector?: {
      readonly embedder: import("./capabilities/types.js").Embedder
      readonly weights?: { readonly keyword?: number; readonly vector?: number }
      readonly rrfK?: number
      readonly vectorK?: number
      readonly recencyWeight?: number
      readonly confidenceWeight?: number
    }
    /** Opt-in runtime episode recorder: when enabled, the runtime writes one
     *  episodic memory per agent run (input, outcome, tools used, duration).
     *  Defaults: enabled false, ttlMs 30 days, cap 500 episodes per namespace,
     *  includeFailedRuns true, embed false (embed: true is not yet supported —
     *  episodes are recalled by keyword + time window). */
    readonly episodes?: {
      readonly enabled?: boolean
      readonly ttlMs?: number
      readonly cap?: number
      readonly includeFailedRuns?: boolean
      readonly embed?: boolean
    }
    /** Knobs for the explicitly-invoked distillation commands
     *  (`b4 memory consolidate` / `b4 memory reflect`). Nothing here runs
     *  automatically — distillation only happens when a command is invoked.
     *  Defaults: model "gpt-5-mini"; provider inferred from `model`, falling
     *  back to "openai"; maxBatches 5 per invocation; consolidate.olderThanMs
     *  7 days, consolidate.minBatchSize 5, consolidate.maxBatchSize 50,
     *  consolidate.ttlMs unset (summaries never expire),
     *  consolidate.sourceTtlMs 7 days; reflect.minNewRecords
     *  10, reflect.maxRecords 100, reflect.writes "candidate". */
    readonly distill?: {
      /** Model id for the distillation pass. Default "gpt-5-mini". */
      readonly model?: string
      /** Model provider. Default: inferred from `model`, else "openai". */
      readonly provider?: ModelProviderId
      /** Maximum batches processed per invocation. Default 5. */
      readonly maxBatches?: number
      readonly consolidate?: {
        /** Only consolidate records older than this many ms. Default 604800000 (7d). */
        readonly olderThanMs?: number
        /** Batches smaller than this are skipped. Default 5. */
        readonly minBatchSize?: number
        /** Batches are truncated to this many records. Default 50. */
        readonly maxBatchSize?: number
        /** Expiry for written summaries. Default: unset (summaries don't expire). */
        readonly ttlMs?: number
        /**
         * How long a superseded SOURCE record stays inspectable before the
         * normal prune pass reaps it. Default 604800000 (7d).
         *
         * Consolidation replaces its sources with one dense summary, but a
         * superseded row still occupies the per-namespace episodic cap while
         * being invisible to recall — so the cap would keep evicting live rows
         * to make room for records that have already been compacted. Stamping
         * an expiry hands that budget back on the next prune. Sources remain
         * visible in the Inspector (and their `supersedes` audit trail intact)
         * for this window.
         */
        readonly sourceTtlMs?: number
      }
      readonly reflect?: {
        /** Minimum new records since the watermark before reflecting. Default 10. */
        readonly minNewRecords?: number
        /** Maximum records fed to one reflection pass. Default 100. */
        readonly maxRecords?: number
        /** Write governance for derived insights. Default "candidate". */
        readonly writes?: "candidate" | "auto"
      }
    }
    /** Derive the memory namespace scope for a given route. */
    readonly resolveScope?: (ctx: {
      readonly routePath: string
      readonly appRoot: string
    }) => Record<string, string>
  }
}

/**
 * Cross-origin policy for the B4.run runtime (`server.cors`).
 *
 * Presence of this object is what turns CORS on; there is no `enabled` flag.
 */
export interface CorsConfig {
  /**
   * Origins allowed to read responses — an explicit list (compared exactly,
   * after normalizing case and a trailing slash) or `"*"` for any origin.
   *
   * `"*"` with `credentials: true` is rejected at boot: browsers refuse a
   * wildcard allow-origin on a credentialed request, so accepting it would
   * produce a server that looks configured and fails only in the console.
   */
  readonly origins: readonly string[] | "*"
  /** Allow cookies and `Authorization` cross-origin. Default false. */
  readonly credentials?: boolean
  /** Methods advertised in a preflight. Default: GET, POST, DELETE, OPTIONS. */
  readonly methods?: readonly string[]
  /**
   * Request headers advertised in a preflight. Default: echo whatever the
   * browser asked for, so an app can add an auth header without touching
   * server config.
   */
  readonly headers?: readonly string[]
  /** Response headers a browser script may read. Default none. */
  readonly exposeHeaders?: readonly string[]
  /** How long a browser may cache a preflight, in seconds. Default 600. */
  readonly maxAgeSeconds?: number
}

export type RouteSegment =
  | {
      readonly kind: "static"
      readonly raw: string
    }
  | {
      readonly kind: "dynamic" | "catchall" | "optional-catchall"
      readonly name: string
      readonly raw: string
    }

export interface RouteDefinition {
  readonly id: string
  readonly pathname: string
  readonly kind: RouteKind
  readonly entryFile: string
  readonly routeDir: string
  readonly segments: RouteSegment[]
}

export interface RouteManifest {
  readonly appRoot: string
  readonly routes: RouteDefinition[]
}

export interface NormalizedRouteModule {
  readonly kind: RouteKind
  readonly entry: unknown
  readonly config: Record<string, unknown>
}

export interface LoadB4ConfigOptions {
  readonly appRoot: string
}

export interface LoadedB4Config {
  readonly appRoot: string
  readonly config: B4Config
  /**
   * Absolute path of the loaded `b4.config.ts` — or the `"<seeded>"`
   * sentinel when the memo was primed via `seedB4Config` (no disk read).
   */
  readonly configPath: string
}

export interface FindB4AppOptions {
  readonly appRoot?: string
  readonly cwd?: string
}

export interface DiscoveredB4App {
  readonly appRoot: string
  readonly configPath: string
  readonly b4Dir: string
  readonly routesDir: string
}

export interface DiscoverRoutesOptions {
  readonly appRoot?: string
  readonly cwd?: string
}

export interface ExtractedToolType {
  readonly description: string
  readonly name: string
  readonly inputType: string
  readonly outputType: string
}

export interface RouteToolTypes {
  readonly pathname: string
  readonly tools: readonly ExtractedToolType[]
}

export interface JsonSchemaProperty {
  readonly type?: string
  readonly description?: string
  readonly items?: JsonSchemaProperty
  readonly properties?: Record<string, JsonSchemaProperty>
  readonly required?: readonly string[]
  readonly additionalProperties?: boolean | JsonSchemaProperty
  readonly anyOf?: readonly JsonSchemaProperty[]
  readonly enum?: readonly string[]
}

export interface ExtractedToolSchema {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: "object"
    readonly properties: Record<string, JsonSchemaProperty>
    readonly required: readonly string[]
    readonly additionalProperties: false
  }
}

export interface RouteToolSchemas {
  readonly pathname: string
  readonly tools: readonly ExtractedToolSchema[]
}

export type StateFieldReducer = "append" | "replace"

export interface ResolvedStateField {
  readonly name: string
  readonly reducer: StateFieldReducer | ((current: unknown, incoming: unknown) => unknown)
  readonly default: unknown
}

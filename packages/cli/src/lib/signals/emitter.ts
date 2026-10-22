import type { CommandIo } from "../output.js"
import { readCliVersion } from "./cli-version.js"
import { isReportingCommand, type ReportingCommand, signalsDisabledReason } from "./env.js"
import {
  type CommandOutcome,
  commandCompletedEvent,
  devFirstRunCompletedEvent,
  type RouteKind,
  type SignalEvent,
} from "./events.js"
import {
  type FetchLike,
  resolveSignalsUrl,
  SIGNALS_SCHEMA_VERSION,
  sendSignals,
} from "./transport.js"
import { readOrCreateUsageId, resolveUsageDir } from "./usage-id.js"

export const FIRST_RUN_NOTICE =
  "B4.run collects anonymous usage signals (command, version, OS, outcome) to\n" +
  "improve the CLI. No code, paths, or identity are collected.\n" +
  "Disable: B4_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Details: https://b4.run/privacy\n"

export interface SignalsEmitterOptions {
  readonly io: CommandIo
  /** The startup environment; copied at creation, so later changes never move the endpoint. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /**
   * The live environment, re-checked for the opt-out before every send so a
   * project `.env` loaded after startup can still turn reporting off.
   */
  readonly currentEnv?: () => Readonly<Record<string, string | undefined>>
  readonly homeDir?: string
  readonly fetch?: FetchLike
  readonly cliVersion?: string
  readonly nodeMajor?: number
  readonly os?: string
  readonly now?: () => Date
}

export interface SignalsEmitter {
  commandStarted(command: string): void
  commandCompleted(input: {
    readonly outcome: CommandOutcome
    readonly durationMs: number
    readonly error?: unknown
  }): void
  devFirstRunCompleted(routeKind: RouteKind): void
  flush(): Promise<void>
}

export function createInertSignalsEmitter(): SignalsEmitter {
  return {
    commandStarted: () => undefined,
    commandCompleted: () => undefined,
    devFirstRunCompleted: () => undefined,
    flush: () => Promise.resolve(),
  }
}

interface Armed {
  readonly command: ReportingCommand
  readonly identity: Promise<{ readonly id: string } | null>
}

export function createSignalsEmitter(options: SignalsEmitterOptions): SignalsEmitter {
  const env: Readonly<Record<string, string | undefined>> = { ...(options.env ?? process.env) }
  const injectedEnv = options.env
  const currentEnv =
    options.currentEnv ?? (injectedEnv !== undefined ? () => injectedEnv : () => process.env)
  // Read once: a project .env loaded later (b4 dev, b4 inspect) cannot redirect reports.
  const signalsUrl = resolveSignalsUrl(env)
  const cliVersion = options.cliVersion ?? readCliVersion()
  const nodeMajor = options.nodeMajor ?? Number(process.versions.node.split(".")[0])
  const os = options.os ?? process.platform
  const now = options.now ?? (() => new Date())

  let armed: Armed | null = null
  let devFirstRunSent = false
  // Whole emit jobs that are still pending; flush() awaits each of them.
  const pending = new Set<Promise<void>>()

  async function resolveIdentity(dir: string): Promise<{ readonly id: string } | null> {
    try {
      const identity = await readOrCreateUsageId(dir)
      if (identity === null) return null
      if (identity.created) options.io.stderr(FIRST_RUN_NOTICE)
      return { id: identity.id }
    } catch {
      return null
    }
  }

  function emit(build: (armedState: Armed) => SignalEvent): void {
    const state = armed
    if (state === null) return
    // The job joins the set synchronously, before its first await.
    const job = (async () => {
      try {
        if (signalsDisabledReason(currentEnv()) !== null) return
        const identity = await state.identity
        if (signalsDisabledReason(currentEnv()) !== null) return
        if (identity === null) return
        await sendSignals(
          {
            schema: SIGNALS_SCHEMA_VERSION,
            usage_id: identity.id,
            sent_at: now().toISOString(),
            events: [build(state)],
          },
          {
            url: signalsUrl,
            ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
          },
        )
      } catch {
        // Usage reporting never surfaces errors.
      }
    })()
    pending.add(job)
    void job.finally(() => pending.delete(job))
  }

  return {
    commandStarted(command) {
      try {
        if (armed !== null || !isReportingCommand(command)) return
        if (signalsDisabledReason(env) !== null) return
        const dir = resolveUsageDir(options.homeDir)
        if (dir === null) return
        armed = { command, identity: resolveIdentity(dir) }
      } catch {
        armed = null
      }
    },
    commandCompleted(input) {
      try {
        emit((state) =>
          commandCompletedEvent({
            command: state.command,
            cliVersion,
            nodeMajor,
            os,
            outcome: input.outcome,
            durationMs: input.durationMs,
            ...(input.error !== undefined ? { error: input.error } : {}),
          }),
        )
      } catch {
        // Never throw into the caller.
      }
    },
    devFirstRunCompleted(routeKind) {
      try {
        if (devFirstRunSent || armed === null) return
        devFirstRunSent = true
        emit(() => devFirstRunCompletedEvent({ cliVersion, routeKind }))
      } catch {
        // Never throw into the caller.
      }
    },
    async flush() {
      try {
        while (pending.size > 0) await Promise.all([...pending])
      } catch {
        // Jobs never reject; stay silent regardless.
      }
    },
  }
}

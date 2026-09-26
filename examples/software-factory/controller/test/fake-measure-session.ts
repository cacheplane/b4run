import type { VitestRun } from "../src/lib/targets/measure/classify.ts"
import type {
  MeasureSession,
  OpenSession,
  SessionLimits,
} from "../src/lib/targets/measure/session.ts"

export interface FakeFile {
  readonly exitCode?: number
  readonly timedOut?: boolean
  /** Paths the run writes into the workspace. */
  readonly writes?: readonly string[]
  readonly ms?: number
  /** The files the run's report names; the file itself when absent. */
  readonly reports?: readonly string[]
  /** Fails its first run only (exit 1), then passes. */
  readonly flakyOnce?: boolean
}

export interface FakeScript {
  readonly files: Readonly<Record<string, FakeFile>>
  /** What `listFiles` returns, as vitest printed it; the script's files, sorted, when absent. */
  readonly listed?: readonly string[]
  readonly build?: { readonly ok: boolean; readonly output?: string }
  readonly suite?: {
    readonly exitCode?: number
    readonly writes?: readonly string[]
    readonly ms?: number
    /** Killed (exit 137) in a session with less memory than this. */
    readonly minMemoryMb?: number
  }
  readonly peakBytes?: number
}

const COUNTS = { passed: 1, failed: 0, skipped: 0 }

/**
 * Sessions over a scripted suite. A vitest argv naming exactly one of the script's files as a
 * positional (and no --exclude) is that file's run; anything else is the whole suite. Tests
 * with a scope therefore scope at least two files. `sessionOf` records, per vitest run, the
 * number of the session it ran in (1-based).
 */
export function fakeSessions(script: FakeScript) {
  const opened: SessionLimits[] = []
  const commands: string[][] = []
  const sessionOf: { readonly argv: readonly string[]; readonly session: number }[] = []
  const calls = new Map<string, number>()
  const names = Object.keys(script.files).sort()
  const open: OpenSession = async (limits, use) => {
    opened.push(limits)
    const session = opened.length
    let workspace: Record<string, string> = { "packages/app/src/index.ts": "v0" }
    let version = 0
    const write = (paths: readonly string[] = []) => {
      for (const path of paths) workspace = { ...workspace, [path]: `v${++version}` }
    }
    const measure: MeasureSession = {
      build: async () => ({
        ok: script.build?.ok ?? true,
        output: script.build?.output ?? "built",
        ms: 1_000,
      }),
      listFiles: async (argv) => {
        commands.push([...argv])
        return [...(script.listed ?? names)]
      },
      vitest: async (argv): Promise<VitestRun> => {
        commands.push([...argv])
        sessionOf.push({ argv: [...argv], session })
        const positional = argv.filter(
          (arg, i) => names.includes(arg) && argv[i - 1] !== "--exclude",
        )
        const file =
          positional.length === 1 && !argv.includes("--exclude") ? positional[0] : undefined
        if (file === undefined) {
          write(script.suite?.writes)
          const killed =
            script.suite?.minMemoryMb !== undefined && limits.memoryMb < script.suite.minMemoryMb
          return {
            exitCode: killed ? 137 : (script.suite?.exitCode ?? 0),
            output: "suite output",
            timedOut: false,
            files: [],
            ms: script.suite?.ms ?? 9_000,
          }
        }
        const scripted = script.files[file] as FakeFile
        const call = (calls.get(file) ?? 0) + 1
        calls.set(file, call)
        write(scripted.writes)
        if (scripted.timedOut)
          return {
            exitCode: 124,
            output: `${file} hung\nCommand timed out after 180s`,
            timedOut: true,
            files: null,
            ms: scripted.ms ?? 180_000,
          }
        const exitCode = scripted.flakyOnce ? (call === 1 ? 1 : 0) : (scripted.exitCode ?? 0)
        return {
          exitCode,
          output: `${file} output\nError: scripted`,
          timedOut: false,
          files: (scripted.reports ?? [file]).map((name) => ({
            file: name,
            passed: exitCode === 0,
            tests: COUNTS,
          })),
          ms: scripted.ms ?? 2_000,
        }
      },
      snapshot: async () => ({ ...workspace }),
      memoryPeakBytes: async () => script.peakBytes ?? 400 * 1024 * 1024,
    }
    return await use(measure)
  }
  return { open, opened, commands, sessionOf }
}

import { WorkspaceInspectionError } from "@b4run/workspace"
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
  /** Killed by the kernel (exit 137), with no report. */
  readonly killed?: boolean
  /** What the run prints; `<file> output` and a scripted error when absent. */
  readonly output?: string
  /**
   * After the run, the verifier's workspace inspection refuses the session's workspace with
   * this message (a `refused` WorkspaceInspectionError), as it does an executable file.
   */
  readonly refuses?: string
  /** After the run, a snapshot fails with this message: an I/O error, not a refusal. */
  readonly snapshotFails?: string
}

export interface FakeScript {
  readonly files: Readonly<Record<string, FakeFile>>
  /** What `listFiles` returns, as vitest printed it; the script's files, sorted, when absent. */
  readonly listed?: readonly string[]
  readonly build?: {
    readonly ok?: boolean
    readonly output?: string
    /** Killed (exit 137) in a session with less memory than this. */
    readonly minMemoryMb?: number
    /** The workspace the build leaves is refused by the inspection, with this message. */
    readonly refuses?: string
  }
  readonly suite?: {
    readonly exitCode?: number
    readonly writes?: readonly string[]
    readonly ms?: number
    /** Killed (exit 137) in a session with less memory than this. */
    readonly minMemoryMb?: number
    /** Times out (exit 124) in a session whose per-command timeout is below this. */
    readonly minTimeoutMs?: number
    /** The suite's raw JSON report; one passing test when absent. */
    readonly report?: string
    /** After the suite, the inspection refuses the workspace with this message. */
    readonly refuses?: string
  }
  readonly peakBytes?: number
}

const COUNTS = { passed: 1, failed: 0, skipped: 0 }

/** A vitest JSON report of one test with `status`, as the verifier grades it. */
export function vitestReport(status: "passed" | "failed" | "skipped" = "passed"): string {
  return JSON.stringify({
    numTotalTests: 1,
    numFailedTests: status === "failed" ? 1 : 0,
    testResults: [{ assertionResults: [{ fullName: "scripted", status }] }],
  })
}

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
  /** The session each listing ran in (1-based). */
  const listedIn: number[] = []
  const calls = new Map<string, number>()
  const names = Object.keys(script.files).sort()
  const open: OpenSession = async (limits, use) => {
    opened.push(limits)
    const session = opened.length
    let workspace: Record<string, string> = { "packages/app/src/index.ts": "v0" }
    let version = 0
    let broken: Error | undefined
    const refuse = (message: string | undefined) => {
      if (message !== undefined) broken = new WorkspaceInspectionError("refused", message)
    }
    const write = (paths: readonly string[] = []) => {
      for (const path of paths) workspace = { ...workspace, [path]: `v${++version}` }
    }
    const measure: MeasureSession = {
      build: async () => {
        const minimum = script.build?.minMemoryMb
        const exitCode =
          minimum !== undefined && limits.memoryMb < minimum
            ? 137
            : (script.build?.ok ?? true)
              ? 0
              : 1
        refuse(script.build?.refuses)
        return {
          ok: exitCode === 0,
          exitCode,
          output: script.build?.output ?? "built",
          ms: 1_000,
        }
      },
      listFiles: async (argv) => {
        commands.push([...argv])
        listedIn.push(session)
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
          refuse(script.suite?.refuses)
          const killed =
            script.suite?.minMemoryMb !== undefined && limits.memoryMb < script.suite.minMemoryMb
          const timedOut =
            script.suite?.minTimeoutMs !== undefined &&
            limits.commandTimeoutMs < script.suite.minTimeoutMs
          const exitCode = timedOut ? 124 : killed ? 137 : (script.suite?.exitCode ?? 0)
          return {
            exitCode,
            output: "suite output",
            timedOut,
            files: [],
            report:
              exitCode === 124 || exitCode === 137
                ? ""
                : (script.suite?.report ?? vitestReport(exitCode === 0 ? "passed" : "failed")),
            ms: script.suite?.ms ?? 9_000,
          }
        }
        const scripted = script.files[file] as FakeFile
        const call = (calls.get(file) ?? 0) + 1
        calls.set(file, call)
        write(scripted.writes)
        refuse(scripted.refuses)
        if (scripted.snapshotFails !== undefined) broken = new Error(scripted.snapshotFails)
        if (scripted.timedOut)
          return {
            exitCode: 124,
            output: `${file} hung\nCommand timed out after 180s`,
            timedOut: true,
            files: null,
            report: "",
            ms: scripted.ms ?? 180_000,
          }
        if (scripted.killed)
          return {
            exitCode: 137,
            output: `${file} killed`,
            timedOut: false,
            files: null,
            report: "",
            ms: scripted.ms ?? 5_000,
          }
        const exitCode = scripted.flakyOnce ? (call === 1 ? 1 : 0) : (scripted.exitCode ?? 0)
        return {
          exitCode,
          output: scripted.output ?? `${file} output\nError: scripted`,
          timedOut: false,
          files: (scripted.reports ?? [file]).map((name) => ({
            file: name,
            passed: exitCode === 0,
            tests: COUNTS,
          })),
          report: vitestReport(exitCode === 0 ? "passed" : "failed"),
          ms: scripted.ms ?? 2_000,
        }
      },
      snapshot: async () => {
        if (broken !== undefined) throw broken
        return { ...workspace }
      },
      memoryPeakBytes: async () => script.peakBytes ?? 400 * 1024 * 1024,
    }
    return await use(measure)
  }
  return { open, opened, commands, sessionOf, listedIn }
}

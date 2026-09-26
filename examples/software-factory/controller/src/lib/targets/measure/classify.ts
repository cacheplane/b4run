import type { TargetManifest, TargetRecipe } from "../catalog.js"

export type Resources = TargetManifest["resources"]

/** One file's per-test counts from vitest's JSON report (`assertionResults`). */
export interface TestCounts {
  readonly passed: number
  readonly failed: number
  readonly skipped: number
}

/** One vitest run in a measurement session, as `MeasureSession.vitest` reports it. */
export interface VitestRun {
  readonly exitCode: number
  /** stdout then stderr, the JSON report cut off. */
  readonly output: string
  /** The sandbox's per-command timeout fired (exit 124). */
  readonly timedOut: boolean
  /** The files the JSON report names, relative to the command directory; null with no report. */
  readonly files:
    | readonly { readonly file: string; readonly passed: boolean; readonly tests: TestCounts }[]
    | null
  readonly ms: number
}

/**
 * `fail`, `hang`, `killed` and `writes` are proposed for exclusion; `flaky` (a non-pass whose
 * second run, in a fresh container, disagreed) is listed and never proposed (plan D11).
 */
export type FileVerdict = "pass" | "fail" | "hang" | "killed" | "writes" | "flaky"
export const EXCLUDED: ReadonlySet<FileVerdict> = new Set(["fail", "hang", "killed", "writes"])

export interface FileMeasurement {
  readonly file: string
  readonly verdict: FileVerdict
  readonly reason: string
  /** The run's output tail: empty for a pass, the evidence a reviewer reads otherwise. */
  readonly output: string
  readonly ms: number
  /** What the run changed in the workspace, whatever its verdict. */
  readonly changed: readonly string[]
  /** Per-test counts, when vitest reported them. */
  readonly tests?: TestCounts
  /** Paths the run could not find that exist at the pin: what the capture left out. */
  readonly omissions: readonly string[]
}

export interface SuiteSample {
  readonly buildMs: number
  readonly suiteMs: number
  /** From opening the session to closing it: capture, start, build, two snapshots, the suite. */
  readonly sessionMs: number
  readonly memoryPeakBytes: number
}

export interface Measurement {
  readonly files: readonly FileMeasurement[]
  readonly excludes: readonly string[]
  /** The proposed `commands.test`. */
  readonly test: readonly string[]
  readonly samples: readonly SuiteSample[]
  /** From the samples alone (`proposeResources`). */
  readonly measured: Resources
  /** The target's resources before this measurement; undefined for placeholders. */
  readonly prior: Resources | undefined
  /** What is proposed: `settleResources(measured, prior, allowDecrease)`, confirmed by a run at these values. */
  readonly resources: Resources
  readonly confirmation: SuiteSample
}

export interface MeasureLimits {
  readonly fileTimeoutMs: number
  readonly memoryMb: number
}

/** Something about the harness or the target, not a verdict on a test file: `measure` stops. */
export class MeasureError extends Error {
  /** The files measured before the stop, when the per-file phase got that far. */
  files: readonly FileMeasurement[] | undefined
  /** A partial report of those files, which `measureTarget` renders for the script to write. */
  report: string | undefined
  constructor(
    message: string,
    readonly output = "",
  ) {
    super(message)
    this.name = "MeasureError"
  }
}

export const OUTPUT_LIMIT = 4_000
const MiB = 1024 * 1024
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal escapes is the point
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g
/** The workspace root inside a target's container (every generated Dockerfile's WORKDIR). */
const WORKSPACE = "/workspace/"

/** The last `limit` characters of `text` without terminal escapes: where a failure explains itself. */
export function outputTail(text: string, limit = OUTPUT_LIMIT): string {
  const plain = text.replace(ANSI, "").trimEnd()
  return plain.length <= limit ? plain : `…${plain.slice(-limit)}`
}

/** Paths added, removed or changed between two snapshots, sorted. */
export function changedPaths(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((path) => before[path] !== after[path])
    .sort()
}

/**
 * Workspace paths an `ENOENT` in `output` names that exist at the pin (`existsAtPin`, over
 * repository paths): not a defect of the test but of the capture, said so to the reviewer.
 */
export function captureOmissions(output: string, existsAtPin: (path: string) => boolean): string[] {
  const found = new Set<string>()
  for (const match of output.replace(ANSI, "").matchAll(/ENOENT[^\n]*?'(\/[^'\n]+)'/g)) {
    const absolute = match[1] as string
    if (!absolute.startsWith(WORKSPACE)) continue
    const path = absolute.slice(WORKSPACE.length)
    if (existsAtPin(path)) found.add(path)
  }
  return [...found].sort()
}

const list = (paths: readonly string[]) =>
  `${paths.slice(0, 10).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}`

/**
 * What one file run alone says about it. `changed` is reported whatever the verdict, so a file
 * that fails AND writes shows both. A run that did not select exactly `file` (vitest's
 * positional argument is a filter), or wrote no report without being killed or timed out, is
 * the harness's failure, not the file's: it throws.
 */
export function classifyFile(
  file: string,
  run: VitestRun,
  changed: readonly string[],
  limits: MeasureLimits,
  existsAtPin: (path: string) => boolean = () => false,
): FileMeasurement {
  const omissions = captureOmissions(run.output, existsAtPin)
  const also = [
    ...(changed.length > 0 ? [`it also changed the workspace: ${list(changed)}`] : []),
    ...(omissions.length > 0
      ? [`capture omission: ${list(omissions)} exist(s) at the pin but not in the capture`]
      : []),
  ]
  const because = (reason: string) => [reason, ...also].join("; ")
  const base = {
    file,
    ms: run.ms,
    output: outputTail(run.output),
    changed: [...changed],
    omissions,
  }
  if (run.timedOut)
    return {
      ...base,
      verdict: "hang",
      reason: because(`did not finish within ${limits.fileTimeoutMs} ms run alone`),
    }
  if (run.files === null && run.exitCode === 137)
    return {
      ...base,
      verdict: "killed",
      reason: because(
        `was killed (exit 137; the session's memory limit was ${limits.memoryMb} MB)`,
      ),
    }
  if (run.files === null)
    throw new MeasureError(
      `vitest wrote no report for ${file} (exit ${run.exitCode}): a harness failure, not a verdict on the file`,
      run.output,
    )
  const named = run.files.map((f) => f.file)
  if (named.length !== 1 || named[0] !== file)
    throw new MeasureError(
      `The run of ${file} alone reported ${JSON.stringify(named)}: vitest's positional argument is a filter, and it must select exactly this file`,
      run.output,
    )
  const tests = run.files[0]?.tests
  const counted = { ...base, ...(tests !== undefined ? { tests } : {}) }
  if (run.exitCode !== 0 || run.files[0]?.passed !== true)
    return {
      ...counted,
      verdict: "fail",
      reason: because(`fails run alone (exit ${run.exitCode})`),
    }
  if (changed.length > 0)
    return {
      ...counted,
      verdict: "writes",
      reason: [
        `passes, but changes the workspace, which the verifier refuses as tampering: ${list(changed)}`,
        ...also.slice(1),
      ].join("; "),
    }
  return { ...counted, verdict: "pass", reason: "passes run alone", output: "" }
}

/**
 * A file's two runs, the second in a fresh container, as one verdict: a non-pass the second
 * run contradicts is `flaky` (listed, never excluded); two non-passes keep the first verdict.
 * Whatever either run changed in the workspace, or could not find, is kept on the settled
 * result: a write the second run made is reported even though the verdict is the first's.
 */
export function settleFile(first: FileMeasurement, second: FileMeasurement): FileMeasurement {
  if (first.verdict === "pass") return first
  const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])].sort()
  const changed = union(first.changed, second.changed)
  const omissions = union(first.omissions, second.omissions)
  if (second.verdict === "pass")
    return {
      ...first,
      changed,
      omissions,
      verdict: "flaky",
      reason: `${first.reason} on its first run, but passed a second run in a fresh container: listed, not excluded`,
    }
  const secondOnly = second.changed.filter((path) => !first.changed.includes(path))
  return {
    ...first,
    changed,
    omissions,
    reason: `${first.reason} (a second run in a fresh container: ${second.verdict}${
      secondOnly.length > 0 ? `; it changed the workspace: ${list(secondOnly)}` : ""
    })`,
  }
}

const roundUp = (value: number, step: number) => Math.ceil(value / step) * step

/** Resources from the worst of every whole-suite sample (plan D12). */
export function proposeResources(samples: readonly SuiteSample[], cpus: number): Resources {
  if (samples.length === 0) throw new Error("There is no suite sample to propose resources from")
  const peakMiB = Math.max(...samples.map((s) => s.memoryPeakBytes)) / MiB
  const slowest = Math.max(...samples.flatMap((s) => [s.buildMs, s.suiteMs]))
  const session = Math.max(...samples.map((s) => s.sessionMs))
  return {
    memoryMb: Math.max(512, roundUp(2 * peakMiB, 256)),
    cpus,
    commandTimeoutMs: Math.max(60_000, roundUp(8 * slowest, 10_000)),
    verifierDeadlineMs: Math.max(120_000, roundUp(2 * 2.5 * session, 60_000)),
  }
}

/**
 * What is proposed (plan D12): never below the target's own resources unless the person asks
 * (`allowDecrease`), because one host's measurement is not every host's (rung 2 measured 369
 * MiB on devkit where the prototype measured 181). Placeholders are no prior (`prior` undefined).
 */
export function settleResources(
  measured: Resources,
  prior: Resources | undefined,
  allowDecrease: boolean,
): Resources {
  if (prior === undefined || allowDecrease) return measured
  return {
    memoryMb: Math.max(measured.memoryMb, prior.memoryMb),
    cpus: Math.max(measured.cpus, prior.cpus),
    commandTimeoutMs: Math.max(measured.commandTimeoutMs, prior.commandTimeoutMs),
    verifierDeadlineMs: Math.max(measured.verifierDeadlineMs, prior.verifierDeadlineMs),
  }
}

/** The first lines of `output` that say what went wrong, without durations: for measurement.md. */
export function errorLines(output: string, count = 3): string[] {
  const lines = output
    .replace(ANSI, "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+\d+(?:\.\d+)?m?s$/, ""))
    .filter((line) => /\b(?:\w*Error|ENOENT|EACCES|ECONNREFUSED|Command timed out)\b/.test(line))
  return [...new Set(lines)].slice(0, count)
}

const fenceFor = (text: string) =>
  "`".repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((r) => r[0].length + 1)))

/** The per-file part of a report: also what a stopped measurement writes (a partial report). */
export function renderFiles(files: readonly FileMeasurement[]): string[] {
  const passed = files.filter((f) => f.verdict === "pass").length
  const excluded = files.filter((f) => EXCLUDED.has(f.verdict)).length
  const lines = [
    `## Files: ${files.length}, ${passed} pass, ${excluded} proposed for exclusion, ${files.filter((f) => f.verdict === "flaky").length} flaky`,
    "",
    ...files.map(
      (f) =>
        `- \`${f.file}\`: ${f.verdict} (${f.ms} ms${f.tests ? `; tests ${f.tests.passed} passed, ${f.tests.failed} failed, ${f.tests.skipped} skipped` : ""})`,
    ),
    "",
  ]
  for (const f of files.filter((f) => f.verdict !== "pass")) {
    const fence = fenceFor(f.output)
    lines.push(`### \`${f.file}\`: ${f.verdict}`, "", f.reason, "", fence, f.output, fence, "")
  }
  return lines
}

/** The evidence a person reads before accepting the proposal: `report.md`. */
export function renderReport(input: {
  readonly target: Pick<TargetRecipe, "id" | "pin">
  readonly image: { readonly localId: string; readonly tag: string }
  readonly measurement: Measurement
  readonly limits: MeasureLimits
  readonly notes?: readonly string[]
}): string {
  const { target, image, measurement: m, limits } = input
  const row = (name: keyof Resources) =>
    `| ${name} | ${m.prior?.[name] ?? "(placeholder)"} | ${m.measured[name]} | ${m.resources[name]} |`
  const lines = [
    `# target:measure ${target.id} at ${target.pin}`,
    "",
    `Image ${image.localId} (${image.tag}), the network denied. Each test file ran alone (${limits.fileTimeoutMs} ms, ${limits.memoryMb} MB), and each non-pass once more in a fresh container; the suite with the proposed excludes then ran ${m.samples.length} time(s), each in a fresh container, and once more at the proposed resources.`,
    "",
    ...(input.notes ?? []).flatMap((note) => [`> ${note}`, ""]),
    ...renderFiles(m.files),
    "## The suite with the proposed excludes",
    "",
    "| run | build ms | suite ms | session ms | memory.peak MiB |",
    "|---|---|---|---|---|",
    ...[...m.samples, m.confirmation].map(
      (s, i) =>
        `| ${i < m.samples.length ? i + 1 : "at the proposed resources"} | ${s.buildMs} | ${s.suiteMs} | ${s.sessionMs} | ${Math.ceil(s.memoryPeakBytes / MiB)} |`,
    ),
    "",
    "## Resources",
    "",
    "| field | before | measured | proposed |",
    "|---|---|---|---|",
    row("memoryMb"),
    row("cpus"),
    row("commandTimeoutMs"),
    row("verifierDeadlineMs"),
    "",
    "Measured: memoryMb is twice the highest memory.peak, rounded up to 256 MiB, at least 512 (memory.peak includes page cache, so it errs high); cpus is what the sessions ran with; commandTimeoutMs is eight times the slower of the build and the suite, rounded up to 10 s, at least 60 s; verifierDeadlineMs is two sessions (visible and independent) at 2.5 times the slowest, rounded up to a minute, at least 2 minutes. Proposed: never below before unless --allow-decrease, and confirmed by a whole-suite run at exactly these values.",
    "",
  ]
  return lines.join("\n")
}

/**
 * `targets/<id>/measurement.md`: why each file is excluded, committed and reviewed with
 * `target.json` (plan D2). Deterministic across hosts and runs: no timings, no image ids.
 */
export function renderMeasurementRecord(id: string, files: readonly FileMeasurement[]): string {
  const excluded = files.filter((f) => EXCLUDED.has(f.verdict))
  const flaky = files.filter((f) => f.verdict === "flaky")
  const entry = (f: FileMeasurement) => [
    `- \`${f.file}\`: ${f.verdict}. ${f.reason.replace(/ \(\d+ ms\)/g, "")}`,
    ...errorLines(f.output).map((line) => `  > ${line}`),
  ]
  return `${[
    `# Measured excludes: ${id}`,
    "",
    "Written by `target:measure --write` and reviewed with `target.json`. Each file below is excluded from the target's suite, and so from every verification of a task on this target. The measurement's `report.md` holds the full output.",
    "",
    ...(excluded.length === 0
      ? ["No file is excluded: every file passed run alone."]
      : excluded.flatMap(entry)),
    ...(flaky.length === 0
      ? []
      : ["", "## Flaky: listed, not excluded", "", ...flaky.flatMap(entry)]),
  ].join("\n")}\n`
}

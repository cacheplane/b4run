import { posix } from "node:path"
import { isPlaceholderResources, type TargetManifest, type TargetRecipe } from "../catalog.js"

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
  /** The JSON report as vitest wrote it; empty when it wrote none. */
  readonly report: string
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
  /**
   * Why, in words that do not change from run to run or host to host: `measurement.md` commits
   * it (plan D2). Paths in it are JSON-quoted.
   */
  readonly reason: string
  /** What a second run in a fresh container said, when it ran and did not pass: report.md only. */
  readonly secondRun?: string
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
/**
 * Terminal escape sequences: CSI (7-bit or C1, any parameter and intermediate bytes), OSC
 * ending in BEL or ST, DCS/SOS/PM/APC strings, and every other escape (`ESC M`, `ESC 7`…).
 */
const ESCAPES = new RegExp(
  [
    "(?:\u001b\\[|\u009b)[\\u0030-\\u003f]*[\\u0020-\\u002f]*[\\u0040-\\u007e]",
    "(?:\u001b\\]|\u009d)[\\s\\S]*?(?:\u0007|\u001b\\\\|\u009c)",
    "(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\\s\\S]*?(?:\u001b\\\\|\u009c)",
    "\u001b[\\u0020-\\u002f]*[\\u0030-\\u007e]?",
  ].join("|"),
  "g",
)
/** C0 and C1 controls but newline and tab: what a terminal, git (NUL: "binary") or a renderer acts on. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
/** The workspace root inside a target's container (every generated Dockerfile's WORKDIR). */
const WORKSPACE = "/workspace"

/** `text` without escape sequences or controls (but `\n` and `\t`): for parsing. */
const plain = (text: string) => text.replace(ESCAPES, "").replace(CONTROLS, "")

/**
 * Test output made safe to print and to write into Markdown: no escape sequence or control
 * (a NUL makes git call measurement.md binary; `\r`, `ESC M` and OSC links rewrite what a
 * terminal shows), and `<` escaped (`<!--` hides the rest of a page GitHub renders).
 */
export function sanitize(text: string): string {
  return plain(text).replaceAll("<", "&lt;")
}

/** Does `text` hold a C0 or C1 control (newline and tab included)? */
export function hasControl(text: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is the point
  return /[\u0000-\u001f\u007f-\u009f]/.test(text)
}

/** The last `limit` characters of `text`, sanitised: where a failure explains itself. */
export function outputTail(text: string, limit = OUTPUT_LIMIT): string {
  const safe = sanitize(text).trimEnd()
  return safe.length <= limit ? safe : `…${safe.slice(-limit)}`
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
  for (const match of plain(output).matchAll(/ENOENT[^\n]*?'(\/[^'\n]+)'/g)) {
    const absolute = posix.normalize(match[1] as string).replace(/\/+$/, "")
    if (!absolute.startsWith(`${WORKSPACE}/`)) continue
    const path = absolute.slice(WORKSPACE.length + 1)
    if (path !== "" && existsAtPin(path)) found.add(path)
  }
  return [...found].sort()
}

/** A path JSON-quoted, `<` escaped: no control, newline or comment opener reaches Markdown. */
const quote = (path: string) => JSON.stringify(path).replaceAll("<", "\\u003c")
const list = (paths: readonly string[]) =>
  `${paths.slice(0, 10).map(quote).join(", ")}${paths.length > 10 ? ` and ${paths.length - 10} more` : ""}`

/**
 * What one file run alone says about it. `changed` is reported whatever the verdict, so a file
 * that fails AND writes shows both. A run that did not select exactly `file` (vitest's
 * positional argument is a filter), or wrote no report without being killed or timed out, is
 * the harness's failure, not the file's: it throws. So does a report that contradicts the exit
 * code. Reasons carry no limit or timing, so the committed record does not change with them.
 */
export function classifyFile(
  file: string,
  run: VitestRun,
  changed: readonly string[],
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
      reason: because("did not finish within the per-file timeout (--file-timeout-ms) run alone"),
    }
  if (run.files === null && run.exitCode === 137)
    return {
      ...base,
      verdict: "killed",
      reason: because(
        "was killed (exit 137, with no report: the session's memory limit, --memory-mb, or a SIGKILL)",
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
  if (run.exitCode === 0 && run.files[0]?.passed !== true)
    throw new MeasureError(
      `vitest exited 0 but its report says ${file} did not pass: a contradiction is the harness's failure, not a verdict on the file`,
      run.output,
    )
  if (run.exitCode !== 0)
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
    secondRun: `a second run in a fresh container: ${second.verdict}${
      secondOnly.length > 0 ? `; it changed the workspace: ${list(secondOnly)}` : ""
    }`,
  }
}

const roundUp = (value: number, step: number) => Math.ceil(value / step) * step

const slowestSession = (samples: readonly SuiteSample[]) =>
  Math.max(...samples.map((s) => s.sessionMs))

/**
 * `resources` with a `verifierDeadlineMs` that absorbs the verifier's worst honest case: in
 * `full` mode it runs two sessions (visible, then independent) under one deadline
 * (`docker-verifier.ts`), and a candidate that hangs its suite runs one command to its timeout
 * in each (a hung build ends the session and skips the independent one). The deadline is
 * therefore at least twice the command timeout plus the slowest session, rounded up to a
 * minute, so a hung candidate is rejected by its command timeout instead of reaching the whole
 * verification's deadline, which is `inconclusive`. Never lowered: a wider deadline is kept.
 */
export function coveringDeadline(resources: Resources, samples: readonly SuiteSample[]): Resources {
  const floor = roundUp(2 * (resources.commandTimeoutMs + slowestSession(samples)), 60_000)
  return resources.verifierDeadlineMs >= floor
    ? resources
    : { ...resources, verifierDeadlineMs: floor }
}

/** Resources from the worst of every whole-suite sample (plan D12). */
export function proposeResources(samples: readonly SuiteSample[], cpus: number): Resources {
  if (samples.length === 0) throw new Error("There is no suite sample to propose resources from")
  const measurement = (value: number) => Number.isFinite(value) && value > 0
  if (!measurement(cpus))
    throw new MeasureError(`cpus ${cpus} is not a positive number to propose resources with`)
  for (const sample of samples)
    if (!Object.values(sample).every(measurement))
      throw new MeasureError(
        `A suite sample is not a measurement (every field must be a positive number): ${JSON.stringify(sample, (_, v) => (typeof v === "number" && !Number.isFinite(v) ? String(v) : v))}`,
      )
  const peakMiB = Math.max(...samples.map((s) => s.memoryPeakBytes)) / MiB
  const slowest = Math.max(...samples.flatMap((s) => [s.buildMs, s.suiteMs]))
  return coveringDeadline(
    {
      memoryMb: Math.max(512, roundUp(2 * peakMiB, 256)),
      cpus,
      commandTimeoutMs: Math.max(60_000, roundUp(8 * slowest, 10_000)),
      verifierDeadlineMs: Math.max(120_000, roundUp(5 * slowestSession(samples), 60_000)),
    },
    samples,
  )
}

/**
 * What is proposed (plan D12): never below the target's own resources unless the person asks
 * (`allowDecrease`), because one host's measurement is not every host's (rung 2 measured 369
 * MiB on devkit where the prototype measured 181). Placeholders are no prior, however passed.
 */
export function settleResources(
  measured: Resources,
  prior: Resources | undefined,
  allowDecrease: boolean,
): Resources {
  if (prior === undefined || isPlaceholderResources(prior) || allowDecrease) return measured
  return {
    memoryMb: Math.max(measured.memoryMb, prior.memoryMb),
    cpus: Math.max(measured.cpus, prior.cpus),
    commandTimeoutMs: Math.max(measured.commandTimeoutMs, prior.commandTimeoutMs),
    verifierDeadlineMs: Math.max(measured.verifierDeadlineMs, prior.verifierDeadlineMs),
  }
}

/** An error line longer than this is cut: measurement.md is read, not searched. */
export const ERROR_LINE_LIMIT = 240
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
/** Absolute or relative paths: a run of non-space, non-quote characters holding a `/`. */
const PATH = /[^\s'"`]*\/[^\s'"`]*/g
/**
 * An `mkdtemp` suffix: exactly six letters and digits after a `-` or `.`, ending a path segment,
 * mixing at least two of lower case, upper case and digits (`FlOOPf`, `35z1ce`), so an ordinary
 * word (`bundle`, `runner`) or a number stays. An all-lower-case draw is left as it is.
 */
const TEMP_SUFFIX = /([-.])([A-Za-z0-9]{6})(?=[/:]|$)/g
const mixed = (text: string) =>
  [/[a-z]/, /[A-Z]/, /[0-9]/].filter((kind) => kind.test(text)).length >= 2

/** `line` without what differs from run to run: UUIDs and temporary names. */
function stable(line: string): string {
  return line
    .replace(UUID, "UUID")
    .replace(PATH, (path) =>
      path.replace(TEMP_SUFFIX, (whole, lead: string, suffix: string) =>
        mixed(suffix) ? `${lead}XXXXXX` : whole,
      ),
    )
}

/**
 * The first lines of `output` that say what went wrong, sanitised, without durations, code-frame
 * lines, temporary names or UUIDs, each cut to {@link ERROR_LINE_LIMIT}: for measurement.md,
 * which a re-measurement that agrees rewrites byte for byte (plan D2).
 */
export function errorLines(output: string, count = 3): string[] {
  const lines = sanitize(output)
    .split("\n")
    .filter((line) => !/^\s*\d+\|/.test(line))
    .map((line) => line.trim().replace(/\s+\d+(?:\.\d+)?m?s$/, ""))
    .filter((line) => /\b(?:\w*Error|ENOENT|EACCES|ECONNREFUSED|Command timed out)\b/.test(line))
    .map(stable)
    .map((line) =>
      line.length > ERROR_LINE_LIMIT ? `${line.slice(0, ERROR_LINE_LIMIT - 1)}…` : line,
    )
  return [...new Set(lines)].slice(0, count)
}

const longestTicks = (text: string) =>
  Math.max(0, ...[...text.matchAll(/`+/g)].map((r) => r[0].length))
const fenceFor = (text: string) => "`".repeat(Math.max(3, longestTicks(text) + 1))
/** `text` as one CommonMark code span, whatever backticks it holds. */
export function codeSpan(text: string): string {
  const ticks = "`".repeat(longestTicks(text) + 1)
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : ""
  return `${ticks}${pad}${text}${pad}${ticks}`
}

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
    lines.push(
      `### \`${f.file}\`: ${f.verdict}`,
      "",
      f.reason,
      "",
      ...(f.secondRun !== undefined ? [f.secondRun, ""] : []),
      fence,
      f.output,
      fence,
      "",
    )
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
    "Measured: memoryMb is twice the highest memory.peak, rounded up to 256 MiB, at least 512 (memory.peak includes page cache, so it errs high); cpus is what the sessions ran with; commandTimeoutMs is eight times the slower of the build and the suite, rounded up to 10 s, at least 60 s; verifierDeadlineMs is the larger of five times the slowest session and twice (commandTimeoutMs plus the slowest session), each rounded up to a minute, at least 2 minutes: the verifier runs two sessions (visible and independent) under one deadline, and a hung candidate must reach a command's timeout (a rejection) in each before the deadline (inconclusive). Proposed: never below before unless --allow-decrease, the deadline raised again to twice (commandTimeoutMs plus the slowest session) when a prior raised the timeout, and confirmed by a whole-suite run at exactly these values.",
    "",
  ]
  return lines.join("\n")
}

/**
 * A record entry's test counts (plan D15: what an exclude hides), from the run the verdict is
 * the first's: none when vitest wrote no report (a hang or a kill).
 */
function counts(f: FileMeasurement): string {
  if (f.tests === undefined) return ""
  const total = f.tests.passed + f.tests.failed + f.tests.skipped
  if (total === 0) return f.verdict === "fail" ? " (failed to load)" : " (no tests)"
  return ` (${f.tests.failed} of ${total} tests failed)`
}

/**
 * `targets/<id>/measurement.md`: why each file is excluded, committed and reviewed with
 * `target.json` (plan D2). Deterministic across hosts and runs: no timings, no limits, no
 * image ids, no second run's evidence (report.md has it), files in path order.
 */
export function renderMeasurementRecord(id: string, files: readonly FileMeasurement[]): string {
  const sorted = [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
  const excluded = sorted.filter((f) => EXCLUDED.has(f.verdict))
  const flaky = sorted.filter((f) => f.verdict === "flaky")
  const entry = (f: FileMeasurement) => [
    `- \`${f.file}\`: ${f.verdict}${counts(f)}. ${f.reason}`,
    ...errorLines(f.output).map((line) => `  > ${codeSpan(line)}`),
  ]
  return `${[
    `# Measured excludes: ${id}`,
    "",
    "Written by `target:measure --write` and reviewed with `target.json`. Each file below is excluded from the target's suite, and so from every verification of a task on this target. The measurement's `report.md` holds the full output.",
    "",
    `${files.length} files measured, ${files.filter((f) => f.verdict === "pass").length} pass, ${excluded.length} proposed for exclusion, ${flaky.length} flaky.`,
    "",
    ...(excluded.length === 0
      ? [
          flaky.length === 0
            ? "No file is excluded: every file passed run alone."
            : "No file is excluded: each file passed at least one of its runs alone; the flaky ones below also failed one.",
        ]
      : excluded.flatMap(entry)),
    ...(flaky.length === 0
      ? []
      : ["", "## Flaky: listed, not excluded", "", ...flaky.flatMap(entry)]),
  ].join("\n")}\n`
}

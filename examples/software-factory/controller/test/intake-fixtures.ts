import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tasksDir } from "../src/lib/targets/catalog.ts"

/**
 * A drafter's draft for the `devkit` target, modelled on the shipped `devkit-spawn-deadline`
 * task: read from those files at module load rather than embedded, so the fixture cannot
 * drift from the task it imitates. The drafter writes no `id` (the work order's) and no
 * `visible` suite (the controller's).
 */
const shipped = join(tasksDir, "devkit-spawn-deadline")
const read = (name: string) => readFileSync(join(shipped, name), "utf8")

const { id: _id, ...taskWithoutId } = JSON.parse(read("task.json")) as Record<string, unknown>
const shippedChecks = JSON.parse(read("checks.json")) as { independent: unknown }
// The shipped spec carries A1 and A2 but its independent check names only `A1: ...`. A draft
// must name every acceptance id it states, so the fixture's spec copy turns A2 into a plain
// paragraph and the check file stays byte-identical to the shipped one.
const shippedSpec = read("spec.md")
if (!shippedSpec.includes("\nA2:")) throw new Error("fixture expects the shipped spec to carry A2:")
const specWithA1Only = shippedSpec.replace("\nA2:", "\nAlso:")

export const GOOD_DRAFT: Readonly<Record<string, string>> = Object.freeze({
  "draft/task.json": `${JSON.stringify(taskWithoutId, null, 2)}\n`,
  "draft/spec.md": specWithA1Only,
  "draft/checks.json": `${JSON.stringify({ independent: shippedChecks.independent }, null, 2)}\n`,
  "draft/checks/spawn-deadline.test.ts": read("checks/spawn-deadline.test.ts"),
})

const withTask = (patch: Record<string, unknown>): Readonly<Record<string, string>> => ({
  ...GOOD_DRAFT,
  "draft/task.json": `${JSON.stringify({ ...taskWithoutId, ...patch }, null, 2)}\n`,
})
const withChecks = (checks: unknown): Readonly<Record<string, string>> => ({
  ...GOOD_DRAFT,
  "draft/checks.json": `${JSON.stringify(checks, null, 2)}\n`,
})
const independent = shippedChecks.independent as { file: string; assertions: string[] }
const { "draft/task.json": _task, ...missingTask } = GOOD_DRAFT

/** Drafts `parseDraft` must refuse, each derived from GOOD_DRAFT by one defect. */
export const BAD_DRAFTS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze(
  {
    missingTask,
    suppliedId: withTask({ id: "drafter-chosen" }),
    badTarget: withTask({ target: "no-such-target" }),
    // `packages/devkit/test` is immutable in the shipped manifest, so this trips TaskSchema's
    // "allowed and immutable paths must be disjoint" refine.
    editsTests: withTask({
      allowedSourcePaths: [
        ...(taskWithoutId.allowedSourcePaths as string[]),
        "packages/devkit/test/x.ts",
      ],
    }),
    // The shipped spec states A1 and A2; the check still names only A1.
    acceptanceMismatch: { ...GOOD_DRAFT, "draft/spec.md": shippedSpec },
    noAcceptance: { ...GOOD_DRAFT, "draft/spec.md": specWithA1Only.replace(/^A\d+:/gm, "Note:") },
    visibleSupplied: withChecks({
      visible: { runner: "vitest", assertions: [] },
      independent,
    }),
    missingCheckFile: withChecks({ independent: { ...independent, file: "checks/other.test.ts" } }),
    emptySpec: { ...GOOD_DRAFT, "draft/spec.md": "\n\n" },
  },
)

/**
 * A draft that IS an oracle at the shipped pin: the `cli-flags` task, whose pinned bytes are
 * the defect (the Docker lanes prove its independent check fails on the unpatched baseline),
 * turned into the four files a drafter writes. The shipped spec has no acceptance lines and
 * the check names carry no ids, so both are derived here: one `A<n>:` line per independent
 * assertion, and the assertion and test names prefixed to match. `GOOD_DRAFT` above cannot
 * serve this purpose: `devkit-spawn-deadline`'s defect is injected by its `defect.patch`, and
 * at the pin its check passes.
 */
const cliFlags = join(tasksDir, "cli-flags")
const readCliFlags = (name: string) => readFileSync(join(cliFlags, name), "utf8")
const { id: _cliId, ...cliTaskWithoutId } = JSON.parse(readCliFlags("task.json")) as Record<
  string,
  unknown
>
const cliChecks = JSON.parse(readCliFlags("checks.json")) as {
  independent: { runner: string; file: string; assertions: string[] }
}
const cliAssertions = cliChecks.independent.assertions.map((name, i) => [
  name,
  `A${i + 1}: ${name}`,
])
let cliCheckFile = readCliFlags(cliChecks.independent.file)
for (const [name, prefixed] of cliAssertions) {
  const literal = JSON.stringify(name)
  if (!cliCheckFile.includes(`test(${literal}`))
    throw new Error(`fixture expects the shipped check to name ${literal}`)
  cliCheckFile = cliCheckFile.replace(`test(${literal}`, `test(${JSON.stringify(prefixed)}`)
}
export const ORACLE_DRAFT: Readonly<Record<string, string>> = Object.freeze({
  "draft/task.json": `${JSON.stringify(cliTaskWithoutId, null, 2)}\n`,
  "draft/spec.md": `${readCliFlags("spec.md").replace(/\n*$/, "")}\n\n${cliAssertions
    .map(([, prefixed]) => prefixed)
    .join("\n")}\n`,
  "draft/checks.json": `${JSON.stringify(
    {
      independent: {
        ...cliChecks.independent,
        assertions: cliAssertions.map(([, prefixed]) => prefixed),
      },
    },
    null,
    2,
  )}\n`,
  [`draft/${cliChecks.independent.file}`]: cliCheckFile,
})

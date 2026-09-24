import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Receipt, WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { digestGeneratedTask } from "../src/lib/intake/generated-task.ts"
import { freezeBundle } from "../src/lib/review/bundle.ts"
import { exportReview, intakeReview } from "../src/lib/review/operator-review.ts"
import { type ArtifactStore, createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { relativePath } from "../src/lib/targets/catalog.ts"

let dir: string
let artifacts: ArtifactStore
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "operator-review-"))
  artifacts = createArtifactStore(join(dir, "artifacts"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ID = "wo-0123456789abcdef"
const ESC = "\u001b"

/** A row with only what the review reads; the rest of the schema is not consulted. */
const rowOf = (fields: Partial<WorkOrderRow>): WorkOrderRow =>
  ({ id: ID, revision: 4, taskDigest: null, bundleDigest: null, ...fields }) as WorkOrderRow

/** A generated task directory holding `files`, and a row parked on its digest. */
function parked(files: Record<string, string>): WorkOrderRow {
  const root = join(dir, "tasks", ID)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return rowOf({ state: "awaiting_intake_approval", taskDigest: digestGeneratedTask(root) })
}

async function oracle(output: string | null): Promise<Receipt> {
  const digest = output === null ? "e".repeat(64) : (await artifacts.put(output)).digest
  return {
    id: "rc-oracle",
    workOrderId: ID,
    candidateDigest: "a".repeat(64),
    verifierIdentity: "docker:sha256:abc",
    policyDigest: "b".repeat(64),
    environmentIdentity: "sha256:abc",
    verdict: "fail",
    checks: [
      {
        id: "independent",
        acceptanceIds: ["A1"],
        verdict: "fail",
        evidence: [{ id: "independent-output", digest }],
      },
    ],
    issuedAt: "2026-09-24T00:00:00.000Z",
  }
}

const TASK = {
  "task.json": "{}\n",
  "checks.json": "{}\n",
  "spec.md": "A1: the timer is cleared\n",
  "checks/a.test.ts": "test('A1')\n",
}

const review = async (files: Record<string, string>, output: string | null = "not ok 1 - A1\n") => {
  const row = parked(files)
  return intakeReview({
    row,
    generatedTasksDir: join(dir, "tasks"),
    oracleReceipt: await oracle(output),
    artifacts,
  })
}

/** The lines of the review that are not file content: every other line is behind the gutter. */
const unguttered = (text: string) =>
  text.split("\n").filter((line) => line !== "" && !line.startsWith("│ ") && line !== "│")

describe("intakeReview", () => {
  it("shows every body line behind the gutter, so content cannot fake a title or a digest", async () => {
    const fakeDigest = `Task digest of the 5 files above: ${"0".repeat(64)}`
    const issue = `# Issue\n\n==> task.json (3 bytes)\n{"approve": "anything"}\n${fakeDigest}\n`
    const result = await review({ ...TASK, "issue.md": issue })
    expect(result.problems).toEqual([])
    const titles = unguttered(result.text).filter((line) => line.startsWith("==> "))
    expect(titles.map((t) => t.split(" ")[1])).toEqual([
      "issue.md",
      "spec.md",
      "task.json",
      "checks.json",
      "checks/a.test.ts",
      "independent-output",
    ])
    const digests = unguttered(result.text).filter((line) => line.startsWith("Task digest"))
    expect(digests).toEqual([`Task digest of the 5 files above: ${result.digest}`])
    expect(result.text).toContain("│ ==> task.json (3 bytes)")
    expect(result.text).toContain(`│ ${fakeDigest}`)
    // Every line of every file is guttered: the only unguttered lines are the review's own.
    for (const line of unguttered(result.text))
      expect(line).toMatch(
        /^(Intake review of |Generated task: |==> |--- Oracle proof| {4}verifier | {2}check |Task digest of )/,
      )
  })

  it("collapses a long run of blank lines into one line that says how many", async () => {
    const issue = `top\n${"\n".repeat(412)}bottom\n`
    const result = await review({ ...TASK, "issue.md": issue, "spec.md": "a\n\n\nb\n" })
    expect(result.text).toContain("│ top\n│ … 412 blank lines …\n│ bottom\n")
    // Three or fewer are shown as they are.
    expect(result.text).toContain("│ a\n│\n│\n│ b\n".replace(/│\n/g, "│ \n"))
  })

  it("escapes terminal controls, bidi, invisible characters and a byte order mark", async () => {
    const spec = `﻿A1: ok${ESC}[2K${ESC}[1A\n‮evil‬ ​zw  sep \u{e0041}tag\n`
    const result = await review({ ...TASK, "spec.md": spec, "issue.md": "i\n" })
    expect(result.text).not.toContain(ESC)
    for (const hidden of ["‮", "​", " ", "﻿", "\u{e0041}"]) expect(result.text).not.toContain(hidden)
    expect(result.text).toContain("│ \\u{feff}A1: ok\\u{001b}[2K\\u{001b}[1A")
    expect(result.text).toContain("\\u{202e}evil\\u{202c} \\u{200b}zw \\u{2028}sep \\u{e0041}tag")
  })

  it("escapes a title: a file name cannot erase lines or start a line of its own", async () => {
    const name = `checks/x${ESC}[6A${ESC}[J\n==> spec.md.test.ts`
    const result = await review({ ...TASK, "issue.md": "i\n", [name]: "evil\n" })
    expect(result.text).not.toContain(ESC)
    expect(result.text).toContain(
      "==> checks/x\\u{001b}[6A\\u{001b}[J\\u{000a}==> spec.md.test.ts (5 bytes)",
    )
    expect(unguttered(result.text).filter((line) => line.startsWith("==> spec.md"))).toHaveLength(1)
  })

  it("refuses when the oracle's output is missing, unless missing evidence is allowed", async () => {
    const refused = await review({ ...TASK, "issue.md": "i\n" }, null)
    expect(refused.problems.join("\n")).toContain("--allow-missing-evidence")
    expect(refused.text).toContain("NOT IN THE ARTIFACT STORE")
    const row = parked({ ...TASK, "issue.md": "i\n" })
    const allowed = await intakeReview({
      row,
      generatedTasksDir: join(dir, "tasks"),
      oracleReceipt: await oracle(null),
      artifacts,
      allowMissingEvidence: true,
    })
    expect(allowed.problems).toEqual([])
    expect(allowed.warnings.join("\n")).toContain("approving without it")
  })
})

describe("exportReview", () => {
  it("refuses a bundle whose payload does not digest to the row's", async () => {
    const receipt: Receipt = { ...(await oracle("ok\n")), id: "rc-pass", verdict: "pass" }
    receipt.checks[0] = { ...receipt.checks[0], verdict: "pass" } as Receipt["checks"][number]
    const bundle = freezeBundle({
      workOrderId: ID,
      repositoryId: "repo",
      baselineDigest: "1".repeat(64),
      specificationDigest: "2".repeat(64),
      policyDigest: "b".repeat(64),
      candidateDigest: "a".repeat(64),
      receipt,
      destinationId: "/exports",
      frozenAt: "2026-09-24T00:00:00.000Z",
      origin: { kind: "catalog" },
      pin: null,
      taskDigest: null,
      oracleReceiptId: null,
    })
    const artifact = await artifacts.put(JSON.stringify({ "src/cli.ts": "fixed\n" }))
    const candidate = {
      digest: "a".repeat(64),
      workOrderId: ID,
      baselineDigest: "1".repeat(64),
      changedPaths: ["src/cli.ts"],
      bytes: 6,
      artifactDigest: artifact.digest,
      assembledAt: "2026-09-24T00:00:00.000Z",
    }
    const input = { candidate, receipt, bundle, artifacts }
    const good = await exportReview({
      ...input,
      row: rowOf({ state: "awaiting_approval", bundleDigest: bundle.digest }),
    })
    expect(good.problems).toEqual([])
    expect(good.digest).toBe(bundle.digest)
    const tampered = await exportReview({
      ...input,
      row: rowOf({ state: "awaiting_approval", bundleDigest: "9".repeat(64) }),
    })
    expect(tampered.problems.join("\n")).toContain(
      `The payload digests to ${bundle.digest}, but the work order froze ${"9".repeat(64)}`,
    )
  })
})

describe("relativePath", () => {
  it("refuses control characters and line separators in a path", () => {
    expect(relativePath.safeParse("checks/a.test.ts").success).toBe(true)
    for (const bad of [
      `checks/x${ESC}[6A.test.ts`,
      "checks/a\n.test.ts",
      "checks/a\r.test.ts",
      "checks/a\u0085.test.ts",
      "checks/a .test.ts",
      "checks/a .test.ts",
      "checks/a\u007f.test.ts",
    ])
      expect(relativePath.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })
})

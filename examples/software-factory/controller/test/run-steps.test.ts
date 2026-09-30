import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STATES, type WorkOrderState } from "../src/lib/domain/states.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { chooseWorkOrder, nextStep, type RunStep } from "../src/lib/operator/run-steps.ts"

const issueRow = (patch: Partial<WorkOrderRow> = {}): WorkOrderRow => ({
  id: "wo-0000000000000001",
  revision: 1,
  state: "received",
  taskId: "wo-0000000000000001",
  workerRoute: "/build#agent",
  workerThreadId: null,
  interruptId: null,
  candidateDigest: null,
  bundleDigest: null,
  blockedReason: null,
  failureReason: null,
  candidateAttempts: 0,
  maxCandidateAttempts: 2,
  maxActiveMs: 1_200_000,
  activeMs: 0,
  activeStartedAt: null,
  awaitingSince: null,
  origin: {
    kind: "issue",
    repository: "cacheplane/b4run",
    number: 714,
    bodyDigest: "0".repeat(64),
  },
  pin: "7".repeat(40),
  targetId: null,
  taskDigest: null,
  intakeAttempts: 0,
  maxIntakeAttempts: 2,
  createdAt: "2026-09-28T00:00:00.000Z",
  updatedAt: "2026-09-28T00:00:00.000Z",
  ...patch,
})
const at = (state: WorkOrderState, patch: Partial<WorkOrderRow> = {}) =>
  nextStep(issueRow({ state, ...patch }), [])

describe("nextStep", () => {
  it("gives every state a step, and none of them approves", () => {
    const kinds = new Set<RunStep["kind"]>()
    for (const state of STATES) kinds.add(at(state).kind)
    // The type has no approval member; this pins that no step kind was added that could be one.
    for (const kind of kinds)
      expect(["intake", "dispatch", "follow", "gate", "done", "stop"]).toContain(kind)
  })

  it("stops at each person's gate", () => {
    expect(at("awaiting_intake_approval")).toEqual({ kind: "gate", gate: "intake" })
    expect(at("awaiting_approval")).toEqual({ kind: "gate", gate: "export" })
  })

  it("intakes an issue with no task, and dispatches an approved one or a catalog task", () => {
    expect(at("received")).toEqual({ kind: "intake" })
    expect(at("received", { taskDigest: "a".repeat(64) })).toEqual({ kind: "dispatch" })
    expect(at("received", { origin: { kind: "catalog" }, pin: null, taskId: "cli-flags" })).toEqual(
      {
        kind: "dispatch",
      },
    )
  })

  it("follows a dispatch that is still building its image, instead of sending another", () => {
    const row = issueRow({ taskDigest: "a".repeat(64) })
    const started = { type: "image_prepare_started", payload: { deadlineMs: 60_000 } }
    expect(nextStep(row, [started]).kind).toBe("follow")
    expect(nextStep(row, [started, { type: "dispatch_refused", payload: {} }])).toEqual({
      kind: "dispatch",
    })
  })

  it("follows every state the controller is working in", () => {
    for (const state of [
      "intake_running",
      "dispatched",
      "running",
      "verifying",
      "exporting",
      "cancel_requested",
    ] as const)
      expect(at(state).kind).toBe("follow")
  })

  it("never prompts for an expired bundle (D24)", () => {
    const parked = issueRow({
      state: "awaiting_approval",
      awaitingSince: "2026-09-28T00:00:00.000Z",
    })
    const t0 = Date.parse("2026-09-28T00:00:00.000Z")
    expect(nextStep(parked, [], { now: t0 + 1_000, approvalTtlMs: 900_000 })).toEqual({
      kind: "gate",
      gate: "export",
    })
    const late = nextStep(parked, [], { now: t0 + 900_001, approvalTtlMs: 900_000 })
    expect(late).toMatchObject({ kind: "stop", message: expect.stringContaining("has expired") })
    expect(JSON.stringify(late)).toContain("--reject")
    expect(JSON.stringify(late)).toContain("pnpm factory cancel")
    // A window run did not know: the controller's refusal says so, and run stops asking.
    const refused = [
      { type: "transition", payload: { event: "receipt_passed", to: "awaiting_approval" } },
      {
        type: "approve_refused",
        payload: { message: "Review bundle has expired; deny or cancel it" },
      },
    ]
    expect(nextStep(parked, refused, { now: t0 }).kind).toBe("stop")
    // A refusal from an earlier parking does not count once the row parked again.
    expect(
      nextStep(parked, [...refused, refused[0] as (typeof refused)[number]], { now: t0 }).kind,
    ).toBe("gate")
  })

  it("is done only when exported", () => {
    expect(at("exported")).toEqual({ kind: "done" })
  })

  it("stops at a block, naming retry only when the block is a candidate's with attempts left", () => {
    const retryable = at("blocked", { blockedReason: "verification_failed", candidateAttempts: 1 })
    expect(retryable).toMatchObject({
      kind: "stop",
      next: ["pnpm factory retry wo-0000000000000001", "pnpm factory run wo-0000000000000001"],
    })
    const spent = at("blocked", { blockedReason: "verification_failed", candidateAttempts: 2 })
    expect(spent).toMatchObject({ kind: "stop" })
    expect(JSON.stringify(spent)).not.toContain("retry")
    const intake = at("blocked", { blockedReason: "intake_attempts_exhausted" })
    expect(JSON.stringify(intake)).not.toContain("retry")
  })

  it("stops at a terminal state with the command that starts again", () => {
    for (const state of ["denied", "cancelled", "failed"] as const)
      expect(at(state)).toMatchObject({
        kind: "stop",
        next: expect.arrayContaining([
          `pnpm factory run --issue 714 --repo cacheplane/b4run --pin ${"7".repeat(40)} --new`,
        ]),
      })
  })
})

describe("chooseWorkOrder", () => {
  const row = (id: string, state: WorkOrderState, createdAt: string) =>
    issueRow({ id, state, createdAt })

  it("resumes the one live work order, whatever else there is", () => {
    const live = row("wo-b", "verifying", "2026-09-28T02:00:00Z")
    expect(chooseWorkOrder([row("wo-a", "denied", "2026-09-28T01:00:00Z"), live], false)).toEqual({
      kind: "resume",
      row: live,
    })
  })

  it("refuses to guess between two live work orders", () => {
    const rows = [row("wo-a", "blocked", "1"), row("wo-b", "awaiting_approval", "2")]
    expect(chooseWorkOrder(rows, false)).toEqual({ kind: "ambiguous", rows })
  })

  it("answers done when the newest is exported and none is live, unless asked for a new one", () => {
    const exported = row("wo-b", "exported", "2026-09-28T02:00:00Z")
    const rows = [row("wo-a", "denied", "2026-09-28T01:00:00Z"), exported]
    expect(chooseWorkOrder(rows, false)).toEqual({ kind: "done", row: exported })
    expect(chooseWorkOrder(rows, true)).toEqual({ kind: "create" })
  })

  it("creates when there is nothing, or only ended work orders", () => {
    expect(chooseWorkOrder([], false)).toEqual({ kind: "create" })
    expect(chooseWorkOrder([row("wo-a", "cancelled", "1")], false)).toEqual({ kind: "create" })
  })
})

describe("run's only way to an approval", () => {
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8")
  /** The source of the top-level function `name`, up to the next top-level declaration. */
  const body = (name: string) => {
    const found = [`\nasync function ${name}(`, `\nfunction ${name}(`]
      .map((head) => cli.indexOf(head))
      .find((at) => at !== -1)
    const start = found ?? -1
    expect(start, name).toBeGreaterThan(0)
    const next = cli
      .slice(start + 1)
      .search(/\n(async function|function|const|interface|type|main)\b/)
    return cli.slice(start, next === -1 ? undefined : start + 1 + next)
  }

  it("is reviewOutcome with no digest, no approval flag, no key and no note", () => {
    const run = body("runCommand")
    // The one call to the review, with every approving input spelt out as absent.
    expect(run.match(/reviewOutcome\(/g)).toHaveLength(1)
    expect(run).toMatch(
      /reviewOutcome\(workOrder, \{\s*approve: false,\s*reject: false,\s*digest: undefined,\s*note: undefined,\s*key: undefined,\s*allowMissingEvidence: values\["allow-missing-evidence"\],\s*\}\)/,
    )
    // Never the commands that approve or reject underneath review, and never the flags or the
    // test seam that would make a pipe answer the prompt.
    for (const forbidden of [
      /\bapprove(Intake|Export)\b/,
      /\.(approve|deny|rejectIntake)\b/,
      /\brejectDraft\b/,
      /--approve|--digest/,
      /\bvalues\.(approve|reject|digest|key|note|revision|bundle)\b/,
      /\bapprove: true\b/,
      /FACTORY_CLI_INTERACTIVE/,
    ])
      expect(run, String(forbidden)).not.toMatch(forbidden)
  })

  it("refuses every approving option by name, and main hands run nothing else to approve with", () => {
    expect(cli).toMatch(
      /const RUN_REFUSES = \["approve", "reject", "digest", "note", "revision", "bundle"\] as const/,
    )
    expect(cli).toMatch(/case "run":\s*return await runCommand\(id, values\)/)
    // Neither the standalone approve commands nor review's own dispatch are reachable from run.
    for (const helper of ["runWorkOrder", "followJournal", "requireController", "listRows"])
      expect(body(helper), helper).not.toMatch(
        /\bapprove(Intake|Export)\b|\.(approve|deny|rejectIntake)\b|\brejectDraft\b|\breviewOutcome\b/,
      )
  })
})

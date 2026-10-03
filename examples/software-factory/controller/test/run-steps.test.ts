import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STATES, type WorkOrderState } from "../src/lib/domain/states.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import {
  approvalStartedSinceParked,
  chooseWorkOrder,
  nextStep,
  type RunStep,
} from "../src/lib/operator/run-steps.ts"

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
  delivery: { kind: "local" },
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

  it("starts a draft-PR work order again as a draft PR at today's tip, not at the old pin", () => {
    const draftPr = {
      delivery: {
        kind: "draft-pr",
        repository: "cacheplane/b4run",
        baseBranch: "main",
        branch: "factory/wo-0000000000000001",
        pathPrefix: null,
        issueStateAtCreate: "open",
      },
    } as const
    const again = "pnpm factory run --issue 714 --repo cacheplane/b4run --deliver draft-pr --new"
    for (const state of ["denied", "cancelled", "failed"] as const) {
      const step = at(state, draftPr)
      expect(step).toMatchObject({ kind: "stop", next: expect.arrayContaining([again]) })
      expect(JSON.stringify(step)).not.toContain("--pin")
    }
    const t0 = Date.parse("2026-09-28T00:00:00.000Z")
    const expired = nextStep(
      issueRow({
        ...draftPr,
        state: "awaiting_approval",
        awaitingSince: "2026-09-28T00:00:00.000Z",
      }),
      [],
      { now: t0 + 900_001, approvalTtlMs: 900_000 },
    )
    expect(expired).toMatchObject({ kind: "stop", next: expect.arrayContaining([again]) })
    expect(JSON.stringify(expired)).not.toContain("--pin")
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

describe("approvalStartedSinceParked", () => {
  const parked = { type: "transition", payload: { to: "awaiting_approval" } }
  const started = { type: "approve_started", payload: {} }
  const refused = { type: "approve_refused", payload: { message: "Stale revision" } }
  it("is an approval started since the bundle parked with no refusal after it", () => {
    expect(approvalStartedSinceParked([parked])).toBe(false)
    expect(approvalStartedSinceParked([parked, started])).toBe(true)
    expect(approvalStartedSinceParked([parked, started, refused])).toBe(false)
    expect(approvalStartedSinceParked([parked, started, refused, started])).toBe(true)
    // One from before the row last parked is another bundle's.
    expect(approvalStartedSinceParked([parked, started, parked])).toBe(false)
  })
})

/** Calls and inputs that approve or reject, or make a pipe answer the prompt. */
const FORBIDDEN = [
  /\bapprove(Intake|Export)\b/,
  // Rung 4: run never redelivers either; a person does, with the digest's prefix (D10). Not the
  // controller's or the client's method, not the CLI's own command, not its route.
  /\.(approve|deny|rejectIntake|cancel|interrupt|redeliver)\b/,
  /\bredeliver\s*\(/,
  /work-orders\/redeliver/,
  // The same methods named by a computed member access (`client()["redeliver"](…)`).
  /\[\s*["'`](approve\w*|deny|rejectIntake|cancel|interrupt|redeliver)["'`]\s*\]/,
  /\brejectDraft\b/,
  /--approve|--digest/,
  /\bvalues\.(approve|reject|digest|key|note|revision|bundle)\b/,
  /\bapprove: true\b/,
  /FACTORY_CLI_INTERACTIVE/,
] as const

/**
 * Source with comments removed, and string text too unless `keepStrings` (template expressions
 * are always kept).
 */
function code(src: string, keepStrings = false): string {
  let out = ""
  const stack: ("template" | "expression")[] = []
  const depth: number[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    const top = stack.at(-1)
    if (top === "template") {
      if (c === "\\") {
        if (keepStrings) out += src.slice(i, i + 2)
        i += 2
      } else if (c === "`") {
        stack.pop()
        out += keepStrings ? "`" : " "
        i += 1
      } else if (c === "$" && src[i + 1] === "{") {
        stack.push("expression")
        depth.push(0)
        out += keepStrings ? "${" : " "
        i += 2
      } else {
        if (keepStrings) out += c
        i += 1
      }
      continue
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i += 1
      continue
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2)
      i = end === -1 ? src.length : end + 2
      continue
    }
    if (c === '"' || c === "'") {
      const from = i
      i += 1
      while (i < src.length && src[i] !== c) i += src[i] === "\\" ? 2 : 1
      i += 1
      out += keepStrings ? src.slice(from, i) : " "
      continue
    }
    if (c === "`") {
      stack.push("template")
      if (keepStrings) out += c
      i += 1
      continue
    }
    if (top === "expression" && (c === "{" || c === "}")) {
      const at = depth.length - 1
      if (c === "}" && depth[at] === 0) {
        stack.pop()
        depth.pop()
        out += keepStrings ? "}" : " "
        i += 1
        continue
      }
      depth[at] = (depth[at] ?? 0) + (c === "{" ? 1 : -1)
    }
    out += c
    i += 1
  }
  return out
}

describe("run's only way to an approval", () => {
  const cli = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8")
  /**
   * A top-level declaration's head, any of the forms that could hide a reachable helper from the
   * walk: `export`ed or not, a function (async or generator), a binding, or a class.
   */
  const DECLARATION =
    "(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class)\\s+"
  /** The source of the top-level declaration `name`, up to the next top-level declaration. */
  const body = (name: string) => {
    const start = cli.search(
      new RegExp(`\\n${DECLARATION}${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`),
    )
    expect(start, name).toBeGreaterThan(0)
    const next = cli
      .slice(start + 1)
      .search(
        /\n(?:export\s+)?(?:default\s+)?(async\s+function|function|const|let|var|class|interface|type|enum|main)\b/,
      )
    return cli.slice(start, next === -1 ? undefined : start + 1 + next)
  }

  it("run-steps.ts, the whole module run decides with, approves nothing", () => {
    const steps = code(
      readFileSync(join(import.meta.dirname, "../src/lib/operator/run-steps.ts"), "utf8"),
      true,
    )
    for (const forbidden of FORBIDDEN) expect(steps, String(forbidden)).not.toMatch(forbidden)
  })

  it("is reviewOutcome with no digest, no approval flag, no key and no note", () => {
    const run = body("runCommand")
    // The one call to the review, with every approving input spelt out as absent.
    expect(run.match(/reviewOutcome\(/g)).toHaveLength(1)
    expect(run).toMatch(
      /reviewOutcome\(workOrder, \{\s*approve: false,\s*reject: false,\s*digest: undefined,\s*note: undefined,\s*key: undefined,\s*allowMissingEvidence: values\["allow-missing-evidence"\],\s*\}\)/,
    )
    // Never the commands that approve or reject underneath review, and never the flags or the
    // test seam that would make a pipe answer the prompt.
    for (const forbidden of FORBIDDEN) expect(run, String(forbidden)).not.toMatch(forbidden)
  })

  it("refuses every approving option by name, and main hands run nothing else to approve with", () => {
    expect(cli).toMatch(
      /const RUN_REFUSES = \["approve", "reject", "digest", "note", "revision", "bundle"\] as const/,
    )
    expect(cli).toMatch(
      /case "run":\s*return await runCommand\(id, values, positionals\.slice\(2\)\)/,
    )
  })

  /**
   * Every top-level name `runCommand` reaches, transitively, through the code (comments and
   * string text removed). `reviewOutcome` is the one door to an approval, pinned above by its
   * exact arguments, so the walk stops there.
   */
  const reached = () => {
    const names = new Set(
      [...cli.matchAll(new RegExp(`\\n${DECLARATION}([A-Za-z_$][\\w$]*)`, "g"))].map(
        (m) => m[1] as string,
      ),
    )
    const seen = new Set<string>()
    const todo = ["runCommand"]
    while (todo.length > 0) {
      const name = todo.pop() as string
      if (seen.has(name)) continue
      seen.add(name)
      if (name === "reviewOutcome") continue
      for (const m of code(body(name)).matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)/g)) {
        const used = m[1] as string
        if (names.has(used) && !seen.has(used)) todo.push(used)
      }
    }
    return seen
  }

  /** The local helpers run may reach: adding one is a reviewed change to this list. */
  const RUN_REACHES: readonly string[] = [
    "CREATE_RACE_MS",
    "DISPATCH_ACTIVE",
    "DISPATCH_FOLLOW",
    "DISPATCH_SUCCESS",
    "INTAKE_ACTIVE",
    "INTAKE_SUCCESS",
    "NEVER_SENT",
    "POLL_GRACE_MS",
    "RUN_IGNORES",
    "RUN_REFUSES",
    "arrivalWindowMs",
    "awaiting",
    "client",
    "createRacing",
    "deliverOption",
    "finish",
    "followBusyThread",
    "followJournal",
    "followRow",
    "howToApprove",
    "interrupted",
    "issueCreateInput",
    "listRows",
    "markRow",
    "pollRow",
    "print",
    "read",
    "recordedApprovalTtlMs",
    "registryPath",
    "replayPinOf",
    "repositoryFromOrigin",
    "requestFetch",
    "requireController",
    "reviewOutcome",
    "runCommand",
    "runWorkOrder",
    "tailEvents",
    "threadBusy",
    "transportFailure",
  ]

  it("reaches only the helpers it names, and none of them approves (transitively)", () => {
    const seen = reached()
    expect([...seen].sort()).toEqual([...RUN_REACHES].sort())
    for (const name of seen) {
      if (name === "reviewOutcome") continue
      const text = code(body(name), true)
      for (const forbidden of FORBIDDEN) {
        // The one string that names the scripting flags, never filled in: a person reads the
        // digest off the display (D13). Pinned below.
        if (name === "howToApprove" && String(forbidden) === String(/--approve|--digest/)) continue
        expect(text, `${name}: ${String(forbidden)}`).not.toMatch(forbidden)
      }
      if (name !== "runCommand") expect(text, name).not.toMatch(/\breviewOutcome\b/)
    }
    expect(body("howToApprove")).toContain("--approve --digest <the digest shown above>")
    // It interpolates the work order's id and nothing else: never a digest.
    const interpolated = [...body("howToApprove").matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1])
    expect(new Set(interpolated)).toEqual(new Set(["id"]))
  })
})

describe("run and a draft-PR delivery (rung 4)", () => {
  it("follows a delivery, is done when delivered, and never redelivers by itself", () => {
    expect(at("delivering")).toEqual({ kind: "follow", why: "it is delivering" })
    expect(at("delivered")).toEqual({ kind: "done" })
    const healable = at("blocked", { blockedReason: "delivery_rate_limited" })
    expect(healable).toMatchObject({
      kind: "stop",
      next: [
        "pnpm factory events wo-0000000000000001",
        "pnpm factory redeliver wo-0000000000000001",
        "pnpm factory cancel wo-0000000000000001",
      ],
    })
    const conflict = at("blocked", { blockedReason: "delivery_base_conflict" })
    expect(JSON.stringify(conflict)).not.toContain("redeliver")
  })

  it("answers a delivered newest work order as done", () => {
    const delivered = issueRow({ state: "delivered" })
    expect(chooseWorkOrder([delivered], false)).toEqual({ kind: "done", row: delivered })
  })
})

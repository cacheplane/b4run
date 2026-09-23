import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { GOOD_DRAFT } from "./intake-fixtures.ts"
import { FIRST_DRAFTER_THREAD, type ServedController, serveController } from "./serve-controller.ts"

let dir: string
let served: ServedController

/** Poll the registry the way an operator would: a separate, read-only connection. */
async function pollRow(
  stateDir: string,
  id: string,
  done: (state: string | undefined) => boolean,
  timeoutMs = 5_000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  let state: string | undefined
  while (Date.now() < deadline) {
    const reader = openRegistryReader(join(stateDir, "registry.sqlite"))
    try {
      state = reader.show(id)?.state
    } finally {
      reader.close()
    }
    if (done(state)) return state
    await new Promise((r) => setTimeout(r, 25))
  }
  return state
}
afterEach(async () => {
  await served?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("controller routes", () => {
  it("creates, dispatches (awaiting the run), and refuses a stale approval, all as outcomes", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-routes-"))
    served = await serveController(dir)
    const created = await served.run("create-1", "/work-orders/create#workflow", {
      taskId: "cli-flags",
    })
    expect(created.status).toBe(200)
    const { row } = created.body as { row: { id: string; state: string } }
    expect(row.state).toBe("received")
    const id = row.id

    const dispatched = await served.run(id, "/work-orders/dispatch#workflow", { id })
    expect(dispatched.status).toBe(200)
    expect(dispatched.body).toMatchObject({ ok: true })
    // The route awaited the run: the row it returns has left the active states.
    expect((dispatched.body as { row: { state: string } }).row.state).toBe("awaiting_approval")

    const stale = await served.run(id, "/work-orders/approve#workflow", {
      id,
      revision: 0,
      bundleDigest: "0".repeat(64),
    })
    expect(stale.status).toBe(200)
    expect(stale.body).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Stale revision|does not match/),
    })
  })

  it("returns refusals for an unknown work order, an unknown task and bad input, never a 500", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-routes-"))
    served = await serveController(dir)
    const unknown = await served.run("nope", "/work-orders/dispatch#workflow", { id: "nope" })
    expect(unknown.status).toBe(200)
    expect(unknown.body).toMatchObject({ ok: false, refusal: "unknown_work_order" })
    const badTask = await served.run("create-2", "/work-orders/create#workflow", {
      taskId: "no-such-task",
    })
    expect(badTask.body).toMatchObject({ ok: false, refusal: "unknown_task" })
    const badInput = await served.run("create-3", "/work-orders/create#workflow", { nope: 1 })
    expect(badInput.body).toMatchObject({ ok: false, refusal: "invalid_input" })
  })

  it("creates from an issue, and refuses a mixed or a pinless issue input as invalid_input", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-routes-"))
    served = await serveController(dir)
    const origin = {
      kind: "issue",
      repository: "cacheplane/b4run",
      number: 778,
      bodyDigest: "0".repeat(64),
    }
    const created = await served.run("create-5", "/work-orders/create#workflow", {
      origin,
      pin: "a".repeat(40),
      issue: { title: "T", body: "B" },
    })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({
      ok: true,
      state: "received",
      row: { origin, pin: "a".repeat(40) },
    })
    const { row } = created.body as { row: { id: string; taskId: string } }
    expect(row.taskId).toBe(row.id)
    expect(existsSync(join(served.stateDir, "tasks", row.id, "issue.md"))).toBe(true)

    const mixed = await served.run("create-6", "/work-orders/create#workflow", {
      taskId: "cli-flags",
      origin,
      pin: "a".repeat(40),
      issue: { title: "T", body: "B" },
    })
    expect(mixed.body).toMatchObject({ ok: false, refusal: "invalid_input" })
    const pinless = await served.run("create-7", "/work-orders/create#workflow", {
      origin,
      issue: { title: "T", body: "B" },
    })
    expect(pinless.body).toMatchObject({ ok: false, refusal: "invalid_input" })
    // Flat and addressed: the issue names `pin` at the top level, not inside a union branch.
    expect((pinless.body as { issues: { path: unknown[] }[] }).issues).toEqual([
      expect.objectContaining({ path: ["pin"] }),
    ])
  })

  it("serialises commands per work order through the runtime's one-run-per-thread rule", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-routes-"))
    served = await serveController(dir, { run: "hang" })
    const { row } = (
      await served.run("create-4", "/work-orders/create#workflow", { taskId: "cli-flags" })
    ).body as { row: { id: string } }
    const id = row.id
    const inflight = served.run(id, "/work-orders/dispatch#workflow", { id })
    // The dispatch holds the thread from the moment the runtime admits its run, but the row
    // says when the command is genuinely under way; a sleep would be a guess about both.
    expect(
      await pollRow(served.stateDir, id, (state) => state === "dispatched" || state === "running"),
    ).toMatch(/^(dispatched|running)$/)

    const second = await served.run(id, "/work-orders/cancel#workflow", { id })
    expect(second.status).toBe(409) // run_in_flight from the runtime
    expect(second.body).toMatchObject({ error: { details: { code: "run_in_flight" } } })

    expect(await served.cancel(id)).toBe(200)
    const result = await inflight
    expect(result.status).toBe(409) // run_cancelled: the caller re-reads the row
    expect(result.body).toMatchObject({ error: { details: { code: "run_cancelled" } } })

    // The 409 is sent while the route runs on, so the cancel it triggered is still finishing:
    // the terminal row is what the operator waits for, not whatever the registry says now.
    expect(await pollRow(served.stateDir, id, (state) => state === "cancelled")).toBe("cancelled")
  })

  it("runs the intake arc: intake parks the draft, reject-intake redrafts, approve-intake binds the digest", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-routes-"))
    // The intake fakes: a verifier whose independent check FAILS on the baseline (the oracle
    // proof), a reader that hands the drafter's `draft/` back twice (the second is the redraft
    // after the rejection). The served controller always has a drafter app root, so `intake`
    // is configured; the reader is the fake, so the root is never opened.
    served = await serveController(
      dir,
      {},
      { verifier: createFakeVerifier({ independent: "fail" }) },
    )
    served.workspace.queue(FIRST_DRAFTER_THREAD, [GOOD_DRAFT, GOOD_DRAFT])
    const created = await served.run("create-8", "/work-orders/create#workflow", {
      origin: {
        kind: "issue",
        repository: "cacheplane/b4run",
        number: 778,
        bodyDigest: "0".repeat(64),
      },
      pin: "a".repeat(40),
      issue: { title: "spawnProcess leaks its deadline timer", body: "B" },
    })
    const { id } = (created.body as { row: { id: string } }).row

    const parked = await served.run(id, "/work-orders/intake#workflow", { id })
    expect(parked.status).toBe(200)
    expect(parked.body).toMatchObject({
      ok: true,
      state: "awaiting_intake_approval",
      row: { state: "awaiting_intake_approval", targetId: "devkit", intakeAttempts: 1 },
    })
    const first = (parked.body as { row: { revision: number; taskDigest: string } }).row
    expect(first.taskDigest).toMatch(/^[a-f0-9]{64}$/)

    // The gate's refusals are values with no `refusal` code: they are the factory's own
    // outcome, not the route layer's, and the row rides along.
    const wrong = await served.run(id, "/work-orders/approve-intake#workflow", {
      id,
      revision: first.revision,
      taskDigest: "b".repeat(64),
    })
    expect(wrong.status).toBe(200)
    expect(wrong.body).toEqual({
      ok: false,
      state: "awaiting_intake_approval",
      message: "Task digest does not match the work order's",
      row: expect.objectContaining({ state: "awaiting_intake_approval" }),
    })
    const notHex = await served.run(id, "/work-orders/approve-intake#workflow", {
      id,
      revision: first.revision,
      taskDigest: "not-a-digest",
    })
    expect(notHex.body).toMatchObject({ ok: false, refusal: "invalid_input" })
    const noNote = await served.run(id, "/work-orders/reject-intake#workflow", { id, note: "" })
    expect(noNote.body).toMatchObject({ ok: false, refusal: "invalid_input" })

    // A rejection with attempts left redrafts on the same thread, and the route awaits that
    // redraft the way `intake` does, so the caller sees where it settled.
    const rejected = await served.run(id, "/work-orders/reject-intake#workflow", {
      id,
      note: "name the timer",
    })
    expect(rejected.status).toBe(200)
    expect(rejected.body).toMatchObject({
      ok: true,
      state: "awaiting_intake_approval",
      row: { state: "awaiting_intake_approval", intakeAttempts: 2 },
    })
    const second = (rejected.body as { row: { revision: number; taskDigest: string } }).row
    expect(second.revision).toBeGreaterThan(first.revision)

    const approved = await served.run(id, "/work-orders/approve-intake#workflow", {
      id,
      revision: second.revision,
      taskDigest: second.taskDigest,
    })
    expect(approved.status).toBe(200)
    expect(approved.body).toMatchObject({
      ok: true,
      state: "received",
      row: { state: "received", taskDigest: second.taskDigest, targetId: "devkit" },
    })
  }, 60_000)
})

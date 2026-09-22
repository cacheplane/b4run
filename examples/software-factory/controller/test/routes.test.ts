import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openRegistryReader } from "../src/lib/registry/reader.ts"
import { type ServedController, serveController } from "./serve-controller.ts"

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
    expect(JSON.stringify((pinless.body as { issues: unknown }).issues)).toContain("pin")
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
})

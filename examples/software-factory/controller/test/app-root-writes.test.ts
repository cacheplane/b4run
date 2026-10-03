import { type FSWatcher, mkdirSync, mkdtempSync, rmSync, watch } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { appRoot } from "../src/lib/targets/catalog.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { GOOD_DRAFT } from "./intake-fixtures.ts"
import { FIRST_DRAFTER_THREAD, type ServedController, serveController } from "./serve-controller.ts"

/**
 * What `b4 dev`'s watcher ignores under an app root (`classifyChange` in
 * `packages/cli/src/lib/dev/classify-change.ts`): a write anywhere else restarts the server.
 */
const DEV_IGNORED = [".b4", "workspace", "node_modules", ".pnpm-store"]

function ignoredByDev(relative: string): boolean {
  const first = relative.split(/[\\/]/)[0] ?? ""
  return relative === "" || DEV_IGNORED.includes(first) || relative.endsWith("-lock.yaml")
}

/** Every path written under `root` while it runs, the way a recursive dev watcher sees it. */
function record(root: string): { readonly paths: string[]; readonly watcher: FSWatcher } {
  const paths: string[] = []
  const watcher = watch(root, { recursive: true }, (_event, fileName) => {
    if (fileName !== null) paths.push(fileName.toString().split(sep).join("/"))
  })
  return { paths, watcher }
}

let dir: string
let served: ServedController | undefined

afterEach(async () => {
  await served?.close()
  served = undefined
  rmSync(dir, { recursive: true, force: true })
})

describe("the controller's run-time files", () => {
  // The live-run defect: under `b4 dev`, `intake` staged the drafter's wide capture under the
  // controller's own app root, the dev watcher restarted the server, and the CLI got "Request
  // canceled during server shutdown". `serveRuntime` does not watch, so the routes tests never
  // saw it; this test watches the app root itself, with the real capture collaborators, and
  // requires every staged byte to land under FACTORY_STATE_DIR instead.
  it("stages every capture of intake and dispatch under the state directory, never under the app root", async () => {
    dir = mkdtempSync(join(tmpdir(), "factory-app-root-"))
    served = await serveController(
      dir,
      {},
      { realCaptures: true, verifier: createFakeVerifier({ independent: "fail" }) },
    )
    served.workspace.queue(FIRST_DRAFTER_THREAD, [GOOD_DRAFT])
    const app = record(appRoot)
    // The positive control: the same watcher over the state directory sees the captures, so
    // an empty app-root record is the captures having moved, not the watcher being deaf.
    // The registry is opened on the first request; the directory may not exist before it.
    mkdirSync(served.stateDir, { recursive: true })
    const state = record(served.stateDir)
    try {
      const issue = await served.run("create-issue", "/work-orders/create#workflow", {
        origin: {
          kind: "issue",
          repository: "cacheplane/b4run",
          number: 778,
          bodyDigest: "0".repeat(64),
        },
        pin: served.pin,
        issue: { title: "spawnProcess leaks its deadline timer", body: "B" },
      })
      const issueId = (issue.body as { row: { id: string } }).row.id
      const parked = await served.run(issueId, "/work-orders/intake#workflow", { id: issueId })
      expect(parked.body).toMatchObject({ ok: true, state: "awaiting_intake_approval" })

      const task = await served.run("create-task", "/work-orders/create#workflow", {
        taskId: "cli-flags",
      })
      const taskId = (task.body as { row: { id: string } }).row.id
      const dispatched = await served.run(taskId, "/work-orders/dispatch#workflow", {
        id: taskId,
      })
      // The request completed: under `b4 dev` with the defect, it was cancelled mid-flight.
      expect(dispatched.status).toBe(200)
      expect(dispatched.body).toMatchObject({ ok: true })
      // fs.watch delivers asynchronously: let the last events arrive before reading.
      await new Promise((resolve) => setTimeout(resolve, 250))
    } finally {
      app.watcher.close()
      state.watcher.close()
    }
    expect(app.paths.filter((path) => !ignoredByDev(path))).toEqual([])
    for (const role of ["drafter", "builder", "controller"])
      expect(state.paths.some((path) => path.startsWith(`captures/${role}/`))).toBe(true)
  }, 120_000)
})

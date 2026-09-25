import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { type ServeRuntimeHandle, serveRuntime } from "@b4run/cli"
import type { ControllerRuntimeOverrides } from "../src/lib/runtime.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeDrafterHandoff } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { shippedPin } from "./temp-repo.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/** What the target is deemed to hold before the builder runs. */
const BASELINE = new Map([
  ["src/cli.ts", "broken\n"],
  ["test/cli.test.ts", "spec\n"],
  ["TASK.md", "task\n"],
])
/** What the builder is deemed to have left behind on its thread: one repaired file. */
const REPAIRED: Readonly<Record<string, string>> = {
  "src/cli.ts": "export const fixed = true\n",
  "test/cli.test.ts": "spec\n",
  "TASK.md": "task\n",
}
/**
 * The thread the fake worker is TOLD to create, so the pre-scripted reader id is a pin. It is
 * the FIRST thread the worker makes, whichever stage asks: a test that runs intake first
 * scripts the drafter's `draft/` under this id.
 */
export const FIRST_THREAD = "factory-routes-thread"
/** The drafter's first thread: its own id, as two real workers would never share one. */
export const FIRST_DRAFTER_THREAD = "factory-routes-drafter-thread"

/** The environment `controllerRuntime()` reads, restored when the helper closes. */
const FACTORY_ENV = [
  "FACTORY_WORKER_URL",
  "FACTORY_STATE_DIR",
  "FACTORY_BUILDER_MANIFEST_DIR",
  "FACTORY_DRAFTER_URL",
  "FACTORY_DRAFTER_MANIFEST_DIR",
  "FACTORY_WORKER_TOKEN",
] as const

const appRoot = fileURLToPath(new URL("../", import.meta.url))

export interface ServedController {
  readonly url: string
  /** The builder: every dispatched thread lands here. */
  readonly fake: FakeWorker
  /** The drafter: every intake thread lands here. */
  readonly drafter: FakeWorker
  readonly workspace: FakeWorkspaceReader
  readonly stateDir: string
  /** A commit the served controller's repository holds: the pin an issue work order may name. */
  readonly pin: string
  /** POST /threads/<threadId>/runs/wait with a route and input; returns status and parsed body. */
  run(threadId: string, route: string, input: unknown): Promise<{ status: number; body: unknown }>
  /** POST /threads/<threadId>/cancel; returns the status. */
  cancel(threadId: string): Promise<number>
  close(): Promise<void>
}

/**
 * Boots the controller app in-process against two fake workers, a builder and a drafter,
 * as deployed. The environment has to be set BEFORE the runtime is reset:
 * `controllerRuntime()` reads `process.env` once, when the app's middleware `setup` first
 * asks for the Factory.
 *
 * The routes, the runtime, the middleware and the Agent Protocol endpoints are the real
 * ones, and so is the worker map (the builder pair for the one builder, the drafter pair for
 * the drafter). The collaborators that need a container, a worker installation on disk, a
 * target checkout or the repository at a pin are the same scripted stand-ins the HTTP layer
 * uses: without them every dispatch here ends `blocked` on an unreadable workspace, which
 * would test nothing about the routes.
 */
export async function serveController(
  dir: string,
  /** The BUILDER's behaviour; the drafter takes `drafter`. */
  worker: Omit<FakeWorkerOptions, "outboxDir"> = {},
  /** Replaces any of the injected collaborators, e.g. a verifier that fails. */
  overrides: ControllerRuntimeOverrides & {
    readonly drafter?: Omit<FakeWorkerOptions, "outboxDir">
    /**
     * Keep the runtime's REAL capture collaborators (the drafter's wide capture, the
     * builder's handoff capture and the controller's baseline) instead of the stand-ins
     * below: for a test about where the controller stages what it captures.
     */
    readonly realCaptures?: boolean
  } = {},
  /** Extra controller environment, e.g. a tiny FACTORY_MAX_ACTIVE_MS. Restored on close. */
  env: Readonly<Record<string, string>> = {},
): Promise<ServedController> {
  const stateDir = join(dir, "state")
  mkdirSync(join(dir, "builder"), { recursive: true })
  // A real directory, because the runtime checks that at boot; never opened, because the
  // drafter reader below is the fake.
  mkdirSync(join(dir, "drafter"), { recursive: true })
  const touchedEnv = [...FACTORY_ENV, ...Object.keys(env)]
  const previousEnv = Object.fromEntries(touchedEnv.map((key) => [key, process.env[key]]))
  const { drafter: drafterOptions, realCaptures = false, ...runtimeOverrides } = overrides
  const fake = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
    threadId: FIRST_THREAD,
    ...worker,
  })
  const drafter = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
    threadId: FIRST_DRAFTER_THREAD,
    ...drafterOptions,
  })
  process.env.FACTORY_WORKER_URL = fake.baseUrl
  process.env.FACTORY_STATE_DIR = stateDir
  // Retired: the controller refuses to boot while either is set, and restores them on close.
  delete process.env.FACTORY_BUILDER_MANIFEST_DIR
  delete process.env.FACTORY_DRAFTER_MANIFEST_DIR
  process.env.FACTORY_DRAFTER_URL = drafter.baseUrl
  process.env.FACTORY_WORKER_TOKEN = TEST_WORKER_TOKEN
  // A commit the served controller's repository (this one) holds, so `intake`'s pin check
  // passes without a fetch, and the one the shipped targets hold images at, so a draft
  // naming one of them is looked up at a pin it was prepared for.
  const pin = shippedPin("devkit")
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  // One scripted reader, keyed by thread id, serves both stages: the builder's repair under
  // its thread, and whatever `draft/` a test scripts under the drafter's.
  const workspace = createFakeWorkspaceReader({ [FIRST_THREAD]: REPAIRED })
  // This helper imports `../src/lib/runtime.ts` while the route modules the served app loads
  // import `../../../lib/runtime.js`. vite-node resolves both specifiers to the one module
  // instance, so the runtime the overrides below bind is the runtime the routes reach. That
  // is why the helper serves the SOURCE app root rather than a built app: a built lane would
  // load its own copy of the module and the overrides would bind nothing.
  const { resetControllerRuntimeForTests } = await import("../src/lib/runtime.ts")
  // Disposes any previous runtime, then clears it; the overrides bind the next open.
  await resetControllerRuntimeForTests({
    verifier: createFakeVerifier({ verdict: "pass" }),
    // The same fake for the drafter's thread: its `draft/` is scripted under FIRST_DRAFTER_THREAD.
    readers: { builder: workspace, drafter: workspace },
    ...(realCaptures ? {} : captureStandIns()),
    ...runtimeOverrides,
  })
  const handle: ServeRuntimeHandle = await serveRuntime({ appRoot, host: "127.0.0.1", port: 0 })
  const run = async (threadId: string, route: string, input: unknown) => {
    const response = await fetch(
      `${handle.url}/threads/${encodeURIComponent(threadId)}/runs/wait`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route, input }),
      },
    )
    return { status: response.status, body: await response.json() }
  }
  return {
    url: handle.url,
    fake,
    drafter,
    workspace,
    stateDir,
    pin,
    run,
    cancel: async (threadId) =>
      (
        await fetch(`${handle.url}/threads/${encodeURIComponent(threadId)}/cancel`, {
          method: "POST",
        })
      ).status,
    close: async () => {
      await handle.close()
      // Disposes the runtime AND clears the overrides: leaving them set would hand the next
      // test in this process a verifier or a workspace reader it never asked for.
      await resetControllerRuntimeForTests()
      await fake.close()
      await drafter.close()
      // The helper wrote process-wide environment; leave the process as it was found, so a
      // later test in this file's process reads its own configuration and not this one's.
      for (const key of touchedEnv) {
        const previous = previousEnv[key]
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }
    },
  }
}

/**
 * The capture collaborators a served controller uses unless a test asks for the real ones:
 * each stands in for a capture of the repository at a pin, leaving the file the real writer
 * would leave.
 */
function captureStandIns(): ControllerRuntimeOverrides {
  return {
    captureBaseline: async () => ({ digest: "a".repeat(64), files: BASELINE }),
    // The pin of a served issue is no commit of any repository: the capture is stood in for,
    // and uploaded to the fake drafter as the real one would be.
    captureDrafterHandoff: fakeDrafterHandoff,
    // The builder is a fake too, whose threads resolve nothing: a small source stands in for
    // the capture the real one would take (and a drafted task's target's is not this lane's).
    captureBuilderHandoff: fakeBuilderHandoff,
  }
}

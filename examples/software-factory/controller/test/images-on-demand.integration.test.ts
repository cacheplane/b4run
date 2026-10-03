import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createFactory, type Factory } from "../src/lib/controller/factory.ts"
import { boundImageOf } from "../src/lib/controller/images.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import {
  configureCatalog,
  environmentIdentity,
  loadTargetRecipe,
  resetCatalogForTests,
} from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.ts"
import { type ImageRegistry, openImageRegistry } from "../src/lib/targets/images.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { prepareDevkitSecondPin, SECOND_PIN } from "./devkit-second-pin.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeDrafterHandoff, fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { GOOD_DRAFT } from "./intake-fixtures.ts"
import { useImages } from "./static-images.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/**
 * An image built when a work order first needs it, against the real daemon: an intake at a
 * devkit pin this controller's registry has never built builds it at the fit step and binds
 * it, and the identity it records is the one `target:prepare` records for the same recipe in
 * a registry of its own (Docker's build cache makes an identical rebuild the same image).
 * The drafter, the builder and the verifier are fakes: the build is what is under test.
 *
 * Requires Docker. Runs only under `test:sandbox`.
 */
let dir: string
let drafter: FakeWorker
let builderWorker: FakeWorker
let factory: Factory
let images: ImageRegistry
let restore: () => void
let reader: FakeWorkspaceReader

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "factory-images-on-demand-"))
  mkdirSync(join(dir, "out"), { recursive: true })
  configureCatalog({ generatedTasksDir: join(dir, "state", "tasks") })
  // A registry of this controller's own, empty: nothing is built at SECOND_PIN in it.
  images = openImageRegistry({
    path: join(dir, "state", "images.sqlite"),
    builder: dockerImageBuilder(),
    buildTimeoutMs: 1_140_000,
  })
  restore = useImages(images)
  drafter = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  builderWorker = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
    threadId: "b-1",
  })
  reader = createFakeWorkspaceReader({})
  factory = await createFactory({
    registryPath: join(dir, "registry.sqlite"),
    generatedTasksDir: join(dir, "state", "tasks"),
    captureRoot: dir,
    workers: fakeWorkerMap({
      builder: {
        client: createHttpWorkerClient(builderWorker.baseUrl, { token: TEST_WORKER_TOKEN }),
        reader,
      },
      drafter: {
        client: createHttpWorkerClient(drafter.baseUrl, { token: TEST_WORKER_TOKEN }),
        reader,
      },
    }),
    captureBuilderHandoff: fakeBuilderHandoff,
    captureDrafterHandoff: fakeDrafterHandoff,
    exportDir: join(dir, "out"),
    artifactsDir: join(dir, "artifacts"),
    verifier: createFakeVerifier({ independent: "fail" }),
    captureBaseline: async () => ({ digest: "a".repeat(64), files: new Map() }),
  })
}, 120_000)

afterAll(async () => {
  await factory?.close()
  await drafter?.close()
  await builderWorker?.close()
  restore?.()
  images?.close()
  resetCatalogForTests()
  rmSync(dir, { recursive: true, force: true })
})

describe("an image built when a work order first needs it", () => {
  it("intake at an unprepared devkit pin builds it at the fit step, and the identity equals the script's", async () => {
    const recipe = loadTargetRecipe("devkit", { pin: SECOND_PIN })
    expect(images.recorded(recipe)).toBeUndefined()
    const { id } = await factory.createFromIssue({
      origin: {
        kind: "issue",
        repository: "cacheplane/b4run",
        number: 9001,
        bodyDigest: "0".repeat(64),
      },
      pin: SECOND_PIN,
      issue: { title: "t", body: "b" },
    })
    expect(await factory.intake(id)).toMatchObject({ ok: true, state: "intake_running" })
    reader.set((factory.show(id) as WorkOrderRow).workerThreadId as string, GOOD_DRAFT)
    const row = await factory.settleIntake(id, 1_200_000)
    expect(row.state).toBe("awaiting_intake_approval")
    const types = factory.events(id).map((e) => e.type)
    expect(types).toContain("image_prepare_started")
    expect(types).toContain("image_prepared")
    const bound = boundImageOf(factory.events(id))
    if (bound === undefined) throw new Error("intake bound no image")
    expect(bound).toMatchObject({ targetId: "devkit", pin: SECOND_PIN })
    // The daemon holds exactly the bound image, under the recipe's tag.
    const onDaemon = execFileSync(
      "docker",
      ["image", "inspect", "--format", "{{.Id}}", bound.tag],
      {
        encoding: "utf8",
      },
    ).trim()
    expect(onDaemon).toBe(bound.image.localId)

    // The script, on a registry of its own, records the same image for the same recipe.
    const script = prepareDevkitSecondPin()
    try {
      expect(script.printed.key).toBe(bound.key)
      expect(script.printed.localId).toBe(bound.image.localId)
      expect(script.printed.identity).toBe(
        environmentIdentity({ image: bound.image, pin: SECOND_PIN }),
      )
    } finally {
      script.cleanup()
    }
  }, 2_400_000)

  it("re-points a moved recipe tag without rebuilding", async () => {
    const recipe = loadTargetRecipe("devkit", { pin: SECOND_PIN })
    const recorded = images.recorded(recipe)
    if (recorded === undefined) throw new Error("the first test recorded no image")
    // A moved tag: pointed back, no build. The daemon is shared: however this ends, the tag
    // goes back to the recorded image (a concurrent run of this lane on the same host can see
    // the moved tag in between, which is accepted).
    const base = loadTargetRecipe("devkit").baseImage
    execFileSync("docker", ["tag", base, recorded.tag])
    try {
      const again = await images.ensure(recipe, { signal: AbortSignal.timeout(60_000) })
      expect(again.build).toBeUndefined()
      expect(
        execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", recorded.tag], {
          encoding: "utf8",
        }).trim(),
      ).toBe(recorded.image.localId)
    } finally {
      execFileSync("docker", ["tag", recorded.image.localId, recorded.tag])
    }
  }, 120_000)
})

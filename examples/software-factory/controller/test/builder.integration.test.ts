import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { script } from "@b4run/testing"
import { createSourceBundle } from "@b4run/workspace/node"
import { afterAll, beforeAll, expect, it } from "vitest"
import {
  BuilderHandoffSchema,
  type CapturedBuilderHandoff,
  captureBuilderHandoff,
  stagedReferenceOf,
} from "../src/lib/builder-handoff.ts"
import { taskPrompt } from "../src/lib/prompts.ts"
import { captureTarget } from "../src/lib/targets/archive.ts"
import { imageTag, loadTarget, loadTask } from "../src/lib/targets/catalog.ts"
import { prepareDevkitSecondPin, SECOND_PIN } from "./devkit-second-pin.ts"
import { type ServedBuilder, serveBuilder, toolCallsSeen, toolResults } from "./served-builder.ts"
import { expectOnlyTheTokenAdmitted } from "./worker-token-probe.ts"

/**
 * Layer 2: the real builder app, real typegen, real tool wiring, scripted model output, and
 * the builder's per-work-order resolver: ONE builder process for every target and pin, and
 * each thread serves its own work order's workspace, in its own target's image.
 *
 * Only the model is scripted. The route, the permission config, the tool loop, the resolver
 * and the container are all the real ones, which is why this lives in the Docker project:
 * the app configures a sandbox, so the run acquires one. Without Docker it fails rather than
 * skipping.
 *
 * The builder is handed each work order over its Agent Protocol port, as `dispatch` does it
 * (`captureBuilderHandoff`, then `handOff`): the captured source uploaded, and the thread
 * created naming it, with the image, policy and permissions in `factoryBuilder`. Nothing is
 * shared on disk. The builder resolves no pin and captures nothing of its own.
 */

const task = loadTask("cli-flags")
const source = task.manifest.allowedSourcePaths[0] as string
const input = taskPrompt(task)
const LIST = "List the workspace."

let builder: ServedBuilder
const threads: string[] = []
/** Each work order's captured handoff, and its source digest, as `dispatch` would stage them. */
const handoffs: Record<string, CapturedBuilderHandoff> = {}
const digests: Record<string, string> = {}
let repaired: string

beforeAll(async () => {
  builder = await serveBuilder()
  // The controller's half, twice: `wo-alpha` is the task's capture as `dispatch` takes it;
  // `wo-beta` is the same capture with one file more, so the two workspaces differ by a path
  // a listing can see and a digest the association records.
  const alphaRoot = await mkdtemp(join(tmpdir(), "factory-builder-capture-"))
  const alpha = await captureBuilderHandoff(task, {
    workOrderId: "wo-alpha",
    captureRoot: alphaRoot,
  }).finally(() => rm(alphaRoot, { recursive: true, force: true }))
  handoffs["wo-alpha"] = alpha
  digests["wo-alpha"] = alpha.handoff.workspace.sourceDigest
  const extra = createSourceBundle([
    ...alpha.workspace.source.files.map((file) => ({
      path: file.path,
      bytes: new Uint8Array(Buffer.from(file.base64, "base64")),
      executable: file.executable,
    })),
    { path: "EXTRA.md", bytes: new Uint8Array(Buffer.from("one file more\n")), executable: false },
  ])
  const betaWorkspace = { ...alpha.workspace, source: extra }
  handoffs["wo-beta"] = {
    workspace: betaWorkspace,
    handoff: BuilderHandoffSchema.parse({
      ...alpha.handoff,
      workOrderId: "wo-beta",
      workspace: stagedReferenceOf(betaWorkspace),
    }),
  }
  digests["wo-beta"] = extra.digest
  // A handoff naming an image the factory did not prepare: refused before any provider call.
  // Not parsed here: the controller's schema would refuse it, and the builder's must too.
  handoffs["wo-foreign-image"] = {
    workspace: alpha.workspace,
    handoff: {
      ...alpha.handoff,
      workOrderId: "wo-foreign-image",
      target: { ...alpha.handoff.target, image: "alpine:latest" },
    },
  }
  // The baseline bytes, from a throwaway capture of the pin under a temporary root: the
  // same archive the handoff's workspace is built from, captured where it disturbs neither
  // the builder's nor the controller's capture directory.
  const captureRoot = await mkdtemp(join(tmpdir(), "factory-builder-baseline-"))
  try {
    repaired = await readFile(
      join(captureTarget(task, "test", { captureRoot }).absolute, source),
      "utf8",
    )
  } finally {
    await rm(captureRoot, { recursive: true, force: true })
  }
}, 300_000)

afterAll(async () => {
  await builder?.close(threads)
})

it("answers no thread endpoint without the worker token, and 403 with a wrong one", async () => {
  // A thread the controller made (with the token), probed by everyone else. No turn runs, so
  // no sandbox is acquired for it.
  const threadId = await builder.handOff(handoffs["wo-alpha"] as CapturedBuilderHandoff)
  threads.push(threadId)
  await expectOnlyTheTokenAdmitted(builder.url, threadId, "/build#agent")
})

it("admits a create naming a workspace only when the controller uploaded that source", async () => {
  // A digest never uploaded: the policy refuses it before the framework looks for it, and no
  // thread row is written.
  await expect(
    builder.client.createThread(
      { factoryWorkOrderId: "wo-alpha", factoryBuilder: handoffs["wo-alpha"]?.handoff },
      { sourceDigest: "f".repeat(64), environmentLinks: [] },
    ),
  ).rejects.toMatchObject({ status: 403, code: "workspace_not_uploaded_by_controller" })
  // The controller's upload is stamped as its own and named: admitted.
  const alpha = handoffs["wo-alpha"] as CapturedBuilderHandoff
  expect(await builder.client.uploadSource(alpha.workspace.source)).toBe("held")
}, 300_000)

it("drives the real builder to write the repaired source and nothing else", async () => {
  builder.aimock.addFixtures(
    script()
      .user(input)
      .callsTool("readFile", { path: "TASK.md" })
      .callsTool("runBash", { command: "npm test" })
      .callsTool("writeFile", { path: source, content: `${repaired}// repaired\n` })
      .callsTool("runBash", { command: "npm test" })
      .replies("Repair complete.")
      .build(),
  )
  const threadId = await builder.handOff(handoffs["wo-alpha"] as CapturedBuilderHandoff)
  threads.push(threadId)
  const turn = await builder.runTurn(threadId, input)
  expect(turn.status).toBe(200)
  // The builder produced no interrupt, because it has no gate to park on, and every call
  // was admitted: a command off its list would have parked the thread instead.
  expect(await builder.threadStatus(threadId)).toBe("idle")
  const called = toolCallsSeen(builder.aimock)
  expect(called).toEqual(["readFile", "runBash", "writeFile", "runBash"])
  // It has no verdict channel at all.
  expect(called).not.toContain("prepareReview")
  expect(called).not.toContain("exportForReview")

  // Every tool actually ran. The bash results came out of a container that really ran the
  // fixture's own test command, and the first reproduced the documented failure, so the
  // workspace the controller staged really is the faulty baseline. Only the first is pinned
  // to the failure: the scripted write is deliberately not a repair.
  const results = toolResults(builder.aimock)
  expect(results).toHaveLength(4)
  expect(results[0]).toContain(task.specText.split("\n")[0] as string)
  expect(results[2]).toContain(`bytes to ${source}`)
  for (const result of [results[1], results[3]]) expect(result).toContain("b4-fixture-cli-flags")
  expect(results[1]).toContain("unknown option")

  // The workspace the builder SERVED is the one the controller captured for THIS work order,
  // byte for byte: the association records the staged source's digest.
  const installation = openWorkspaceInstallationReader(builder.appRoot)
  try {
    const record = installation.associations.get(threadId)
    // Asserted on its own: a thread with no record at all would otherwise fail as an
    // undefined digest, which reads like a capture mismatch and is not one.
    expect(record).toBeDefined()
    expect(record?.intent.sourceDigest).toBe(digests["wo-alpha"])
  } finally {
    installation.close()
  }
}, 300_000)

// ORDER-COUPLED: this test reuses the first test's `wo-alpha` thread (`threads[0]`) and the
// one aimock journal the whole file shares, so it must run after it, in this file, in
// sequence (vitest's default within a file; the sandbox config also disables file
// parallelism). Run alone (`-t`), it fails on the missing thread rather than proving less.
it("serves a second work order's own workspace from the same builder process", async () => {
  // Fresh thread, fresh script: list the workspace root, then stop.
  builder.aimock.addFixtures(
    script().user(LIST).callsTool("listDir", { path: "." }).replies("Listed.").build(),
  )
  const beta = await builder.handOff(handoffs["wo-beta"] as CapturedBuilderHandoff)
  threads.push(beta)
  expect((await builder.runTurn(beta, LIST)).status).toBe(200)
  const listing = toolResults(builder.aimock)[0]
  expect(listing).toContain("EXTRA.md")
  expect(listing).toContain("TASK.md")

  // And alpha's thread, admitted first through the same resolver, keeps its own: a second
  // turn on it lists no EXTRA.md.
  const alpha = threads[0]
  if (alpha === undefined) throw new Error("run the whole file: this test needs the first's thread")
  expect((await builder.runTurn(alpha, LIST)).status).toBe(200)
  expect(toolResults(builder.aimock).at(-1)).not.toContain("EXTRA.md")

  const installation = openWorkspaceInstallationReader(builder.appRoot)
  try {
    expect(digests["wo-alpha"]).not.toBe(digests["wo-beta"])
    expect(installation.associations.get(alpha)?.intent.sourceDigest).toBe(digests["wo-alpha"])
    expect(installation.associations.get(beta)?.intent.sourceDigest).toBe(digests["wo-beta"])
  } finally {
    installation.close()
  }
}, 300_000)

it("refuses, at admission and by name, a thread with no staged workspace, another one, or a foreign image", async () => {
  const alpha = handoffs["wo-alpha"] as CapturedBuilderHandoff
  const beta = handoffs["wo-beta"] as CapturedBuilderHandoff
  const refused: [string, () => Promise<string>, string][] = [
    [
      // Created with the handoff and no workspace, as a controller that staged nothing would.
      "wo-none",
      () =>
        builder.client.createThread({
          factoryWorkOrderId: "wo-none",
          factoryBuilder: { ...alpha.handoff, workOrderId: "wo-none" },
        }),
      "work order wo-none's thread was created without a staged workspace",
    ],
    [
      // Created with a staged workspace the controller uploaded, but not the one the handoff
      // names: the links and baseline match, the files do not.
      "wo-mismatch",
      () =>
        builder.client.createThread(
          {
            factoryWorkOrderId: "wo-mismatch",
            factoryBuilder: { ...alpha.handoff, workOrderId: "wo-mismatch" },
          },
          stagedReferenceOf(beta.workspace),
        ),
      "is not the one work order wo-mismatch names",
    ],
    [
      "wo-foreign-image",
      () => builder.handOff(handoffs["wo-foreign-image"] as CapturedBuilderHandoff),
      "thread metadata factoryBuilder is invalid",
    ],
  ]
  for (const [workOrderId, create, reason] of refused) {
    const threadId = await create()
    threads.push(threadId)
    const turn = await builder.runTurn(threadId, LIST)
    expect([workOrderId, turn.status >= 400]).toEqual([workOrderId, true])
    expect(turn.text).toContain(reason)
    const installation = openWorkspaceInstallationReader(builder.appRoot)
    try {
      expect(installation.associations.get(threadId)).toBeUndefined()
    } finally {
      installation.close()
    }
  }
}, 300_000)

/** The one live session container of the managed workspace a thread's intent names. */
function sessionOf(operationId: string): { Image: string; HostConfig: { Memory: number } } {
  const ids = execFileSync(
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      `label=b4.workspace.operation=${operationId}`,
      "--filter",
      "label=b4.workspace.role=session",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  // Each admission replaces the session it reconnects, so there is exactly one.
  expect(ids).toHaveLength(1)
  return JSON.parse(
    execFileSync("docker", ["inspect", "--format", "{{json .}}", ids[0] as string], {
      encoding: "utf8",
    }),
  ) as { Image: string; HostConfig: { Memory: number } }
}

// ORDER-COUPLED like the tests above: reuses the file's served builder, the first test's
// `wo-alpha` thread (`threads[0]`) and the one aimock journal.
it("serves a cli-flags thread and devkit threads at two pins from one process", async () => {
  const second = prepareDevkitSecondPin()
  const root = await mkdtemp(join(tmpdir(), "factory-builder-capture-"))
  try {
    const devkitTask = loadTask("devkit-spawn-deadline")
    const devkit = await captureBuilderHandoff(devkitTask, {
      workOrderId: "wo-devkit",
      captureRoot: root,
    })
    // The same capture at the second pin: only the target block changes, which is all the
    // image and the policy are drawn from. Captured as dispatch would, then re-pinned.
    const atSecond = loadTarget("devkit", { targetsDir: second.targetsDir, pin: SECOND_PIN })
    const byWorkOrder: Record<string, CapturedBuilderHandoff> = {
      "wo-devkit": devkit,
      "wo-devkit-2": {
        workspace: devkit.workspace,
        handoff: BuilderHandoffSchema.parse({
          ...devkit.handoff,
          workOrderId: "wo-devkit-2",
          target: { ...devkit.handoff.target, image: imageTag(atSecond), pin: SECOND_PIN },
        }),
      },
    }
    const expected: Record<string, { localId: string; memoryMb: number }> = {
      "wo-alpha": {
        localId: task.target.image.localId,
        memoryMb: task.target.resources.memoryMb,
      },
      "wo-devkit": {
        localId: devkitTask.target.image.localId,
        memoryMb: devkitTask.target.resources.memoryMb,
      },
      "wo-devkit-2": {
        localId: atSecond.image.localId,
        memoryMb: atSecond.resources.memoryMb,
      },
    }
    const alpha = threads[0]
    if (alpha === undefined)
      throw new Error("run the whole file: this test needs the first's thread")
    const threadOf: Record<string, string> = { "wo-alpha": alpha }
    for (const workOrderId of ["wo-devkit", "wo-devkit-2"]) {
      builder.aimock.addFixtures(
        script().user(LIST).callsTool("listDir", { path: "." }).replies("Listed.").build(),
      )
      const threadId = await builder.handOff(byWorkOrder[workOrderId] as CapturedBuilderHandoff)
      threads.push(threadId)
      threadOf[workOrderId] = threadId
      expect((await builder.runTurn(threadId, LIST)).status).toBe(200)
    }
    // Each thread's intent records its own target's image, at its own pin: the image the
    // verifier runs for that task, so no dispatch needs a pin guard.
    const installation = openWorkspaceInstallationReader(builder.appRoot)
    const operations: Record<string, string> = {}
    try {
      for (const [workOrderId, want] of Object.entries(expected)) {
        const record = installation.associations.get(threadOf[workOrderId] as string)
        expect([workOrderId, record?.intent.environment.identity]).toEqual([
          workOrderId,
          want.localId,
        ])
        operations[workOrderId] = record?.intent.operationId as string
      }
    } finally {
      installation.close()
    }
    expect(new Set(Object.values(expected).map((want) => want.localId)).size).toBe(3)
    // And each thread's live session runs that image under its own target's memory limit.
    for (const [workOrderId, want] of Object.entries(expected)) {
      builder.aimock.addFixtures(
        script().user(LIST).callsTool("listDir", { path: "." }).replies("Listed.").build(),
      )
      expect((await builder.runTurn(threadOf[workOrderId] as string, LIST)).status).toBe(200)
      const session = sessionOf(operations[workOrderId] as string)
      expect([workOrderId, session.Image]).toEqual([workOrderId, want.localId])
      expect([workOrderId, session.HostConfig.Memory]).toEqual([
        workOrderId,
        want.memoryMb * 1024 * 1024,
      ])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
    second.cleanup()
  }
}, 1_500_000)

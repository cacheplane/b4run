import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ServeRuntimeHandle, serveRuntime } from "@b4run/cli"
import { openWorkspaceInstallationReader } from "@b4run/sqlite-storage"
import { type Aimock, createAimock, script } from "@b4run/testing"
import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import type { Factory } from "../src/lib/controller/factory.ts"
import { type ControllerRuntime, createControllerRuntime } from "../src/lib/runtime.ts"
import { drafterInspectionOptions } from "../src/lib/targets/workspace.ts"
import {
  createHttpThreadWorkspaceReader,
  type WorkspaceReader,
} from "../src/lib/worker/workspace-reader.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { ORACLE_DRAFT } from "./intake-fixtures.ts"
import { isolatedDrafter } from "./isolated-drafter.ts"
import { shippedPin } from "./temp-repo.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/**
 * The intake half of the factory, for real: one drafter turn in the DRAFTER'S OWN PROCESS
 * against the wide read-only capture of this repository, read back by the controller
 * re-rooted at `draft/`, materialised and proved as an oracle in the target's own image.
 *
 * What is real here: the drafter app (`examples/software-factory/drafter`, served by
 * `serveRuntime` from a private copy, on its pinned `node:24-slim` image with the network
 * denied and permissions non-interactive), its resolver (which serves the capture the
 * controller staged over its port for the work order, and no other), its tools, the
 * controller's runtime with the real worker map (the drafter entry pointing at that server),
 * the real capture (the wide capture at the work order's pin, staged out of the object store)
 * and its upload, the real re-rooted read over the drafter's own port with the worker token
 * and the handed digest, the real baseline capture and the real Docker
 * verifier. What is not: the model is scripted (aimock), and the builder worker the map
 * also needs is the fake HTTP one, which nothing here dispatches to.
 *
 * The draft is the `cli-flags` task's (`ORACLE_DRAFT`), because its pinned bytes are the
 * defect and its check really does fail on the baseline; that target's root is a fixture
 * project under `examples/`, which the wide capture does not hold, so the scripted reads
 * are of a root manifest and a package source that are. What the reads prove is that the
 * tools run over the capture the controller staged, not that a model could draft this
 * particular target from it.
 *
 * Requires Docker, the `cli-flags` target prepared (`target:prepare cli-flags`: the oracle
 * proof runs in its image) and the drafter's base image pulled by digest
 * (`docker pull node:24-slim@sha256:…`, the literal in `drafter/src/drafter-image.ts`).
 * Runs only under `test:sandbox`.
 */

const ISSUE = {
  title: "Documented dry-run flag fails before the handler runs",
  body: [
    "`node --import tsx src/cli.ts memory consolidate --dry-run` fails before the handler",
    "runs. Memory-level `--cwd`, value-taking `prune --cap` and the rejection of invalid",
    "arguments must be preserved; only `src/cli.ts` should change.",
  ].join("\n"),
}
const ORIGIN = {
  kind: "issue" as const,
  repository: "cacheplane/b4run",
  number: 778,
  bodyDigest: createHash("sha256").update(ISSUE.body).digest("hex"),
}

/** One of the oracle draft's files, by its `draft/`-prefixed path. */
function draftFile(path: string): string {
  const content = ORACLE_DRAFT[path]
  if (content === undefined) throw new Error(`no fixture file ${path}`)
  return content
}

/** What the served drafter and the controller read from the process: restored afterwards. */
const ENV = [
  "FACTORY_DRAFTER_MANIFEST_DIR",
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "B4_PERMISSIONS_MODE",
  "FACTORY_WORKER_TOKEN",
] as const

let aimock: Aimock
let drafterRoot: string
let drafter: ServeRuntimeHandle
let pin: string
const previousEnv: Partial<Record<(typeof ENV)[number], string | undefined>> = {}

let runtime: ControllerRuntime | undefined
let builder: FakeWorker | undefined
const cleanups: Array<() => Promise<void>> = []

beforeAll(async () => {
  for (const key of ENV) previousEnv[key] = process.env[key]
  // The work order's pin is the one the shipped targets are prepared at: the draft's target
  // is looked up at the work order's pin (3b), and `cli-flags` has an image at that commit
  // alone (its paths moved since, so it cannot be prepared at HEAD). `target:prepare` has
  // made it present in a shallow checkout, and `intake` ensures it again before the capture.
  pin = shippedPin("cli-flags")
  // `non-interactive` is the drafter's own setting; an operator's process-wide override
  // would make a denied command a parked prompt nobody answers.
  delete process.env.B4_PERMISSIONS_MODE

  aimock = await createAimock({ fixtures: [] })
  drafterRoot = await isolatedDrafter()
  // The model layer reads `OPENAI_BASE_URL` when the route first builds its model, and the
  // policy reads the token at boot, so both are set BEFORE the app boots in this process.
  // The retired manifest directory is unset: the drafter refuses to boot while it is set.
  delete process.env.FACTORY_DRAFTER_MANIFEST_DIR
  process.env.OPENAI_BASE_URL = aimock.baseUrl
  process.env.OPENAI_API_KEY = "test"
  // The drafter admits only the controller: the runtime below sends the same token.
  process.env.FACTORY_WORKER_TOKEN = TEST_WORKER_TOKEN
  drafter = await serveRuntime({ appRoot: drafterRoot, host: "127.0.0.1", port: 0 })
}, 300_000)

afterAll(async () => {
  await drafter?.close()
  await aimock?.close()
  if (drafterRoot) await rm(drafterRoot, { recursive: true, force: true })
  for (const key of ENV) {
    const previous = previousEnv[key]
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  }
})

afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  await builder?.close()
  builder = undefined
  // Optional: a `beforeAll` that failed before aimock existed must not fail again here and
  // mask what broke.
  aimock?.clearFixtures()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/**
 * The controller as deployed: the builder pair for the one builder (the fake, which nothing here
 * dispatches to) and the drafter pair pointing at the served drafter. Everything the runtime builds is real except the builder's reader (no builder
 * thread exists to read) and, when a test gives one, the drafter's.
 */
async function bootController(
  dir: string,
  overrides: { readonly drafterReader?: WorkspaceReader } = {},
): Promise<Factory> {
  await mkdir(join(dir, "builder"), { recursive: true })
  builder = await createFakeWorker({ outboxDir: join(dir, "unused"), run: "edits_only" })
  runtime = createControllerRuntime(
    {
      FACTORY_WORKER_URL: builder.baseUrl,
      FACTORY_STATE_DIR: join(dir, "state"),
      FACTORY_DRAFTER_URL: drafter.url,
      FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
    },
    {
      readers: {
        builder: createFakeWorkspaceReader({}),
        ...(overrides.drafterReader !== undefined ? { drafter: overrides.drafterReader } : {}),
      },
    },
  )
  return runtime.factory()
}

/** The real drafter reader, as the runtime builds it: the drafter's URL and the token, re-rooted at `draft/`. */
function realDrafterReader(): WorkspaceReader {
  return createHttpThreadWorkspaceReader({ url: drafter.url, token: TEST_WORKER_TOKEN }, () => ({
    ...drafterInspectionOptions(),
    root: "draft",
  }))
}

const eventTypes = (factory: Factory, id: string) => factory.events(id).map((e) => e.type)
const payload = (factory: Factory, id: string, type: string) =>
  factory.events(id).find((e) => e.type === type)?.payload

/**
 * A tool result as the model saw it. The runtime hands a tool's return value to the model
 * JSON-encoded (a string result arrives quoted), so the text is decoded once when it is
 * JSON and taken as is otherwise.
 */
function toolResultText(message: { content: unknown }): string {
  const raw = String(message.content)
  try {
    const decoded: unknown = JSON.parse(raw)
    return typeof decoded === "string" ? decoded : raw
  } catch {
    return raw
  }
}

/** The tool calls the model was asked for, in order, as aimock's journal of the last request shows them. */
function toolCallsSeen(): string[] {
  const requests = aimock.getRequests()
  const last = requests[requests.length - 1]?.body?.messages ?? []
  return last.flatMap((message) => {
    if (message.role !== "assistant") return []
    const calls = (message as { tool_calls?: Array<{ function?: { name?: string } }> }).tool_calls
    return (calls ?? []).map((call) => call.function?.name ?? "?")
  })
}

it("runs a real drafter turn against the wide capture, reads only draft/, and proves the oracle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-drafter-e2e-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  // The drafter's turn: look around the repository under `repo/`, read the file the issue
  // names, write the four files. The model is scripted; the tools, the container and the
  // capture they run over are real, so every call below either finds the wide capture where
  // the prompt says it is or errors (and the assertion on the journal would then show it).
  aimock.addFixtures(
    script()
      .user(ISSUE.title)
      .callsTool("listDir", { path: "repo/" })
      .callsTool("readFile", { path: "repo/package.json" })
      .callsTool("readFile", { path: "repo/packages/cli/src/index.ts" })
      .callsTool("writeFile", { path: "draft/task.json", content: draftFile("draft/task.json") })
      .callsTool("writeFile", { path: "draft/spec.md", content: draftFile("draft/spec.md") })
      .callsTool("writeFile", {
        path: "draft/checks.json",
        content: draftFile("draft/checks.json"),
      })
      .callsTool("writeFile", {
        path: "draft/checks/independent.test.ts",
        content: draftFile("draft/checks/independent.test.ts"),
      })
      .replies("The four files are written under draft/.")
      .build(),
  )
  const factory = await bootController(dir)
  // aimock's journal spans the file: this test's requests are the ones after this mark.
  const journalStart = aimock.getRequests().length

  const { id } = await factory.createFromIssue({ origin: ORIGIN, pin, issue: ISSUE })
  const started = await factory.intake(id)
  expect(started).toMatchObject({ ok: true, state: "intake_running" })
  const parked = await factory.settleIntake(id, 800_000)
  expect({
    state: parked.state,
    blocked: parked.blockedReason,
    targetId: parked.targetId,
    attempts: parked.intakeAttempts,
  }).toEqual({
    state: "awaiting_intake_approval",
    blocked: null,
    targetId: "cli-flags",
    attempts: 1,
  })
  expect(parked.taskDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(eventTypes(factory, id)).toEqual([
    "created",
    "drafter_source_staged",
    "intake_thread_created",
    "transition",
    "intake_run_started",
    "intake_turn_ended",
    "draft_read",
    "task_generated",
    "oracle_receipt",
    "transition",
  ])

  // The model was asked for exactly the seven tool calls and nothing was refused: a tool that
  // errored would have left the scripted reply unmatched and the turn would not have ended
  // where it did.
  expect(toolCallsSeen()).toEqual([
    "listDir",
    "readFile",
    "readFile",
    "writeFile",
    "writeFile",
    "writeFile",
    "writeFile",
  ])
  expect(aimock.getRequests().slice(journalStart)).toHaveLength(8)
  // The repository really was under `repo/` for the drafter: the listing the model was
  // handed back names the workspace layout, and the files it read are the pinned root
  // manifest and a package source (the `packages/*/src/**` capture rule).
  const messages = aimock.getRequests().at(-1)?.body?.messages ?? []
  const toolResults = messages.filter((m) => m.role === "tool").map(toolResultText)
  expect(toolResults[0]).toContain("packages")
  expect(toolResults[1]).toContain('"name": "b4-run"')
  expect(toolResults[2]).toContain('config } from "@b4run/core"')
  expect(toolResults.slice(3)).toEqual([
    `wrote ${Buffer.byteLength(draftFile("draft/task.json"))} bytes to draft/task.json`,
    `wrote ${Buffer.byteLength(draftFile("draft/spec.md"))} bytes to draft/spec.md`,
    `wrote ${Buffer.byteLength(draftFile("draft/checks.json"))} bytes to draft/checks.json`,
    `wrote ${Buffer.byteLength(draftFile("draft/checks/independent.test.ts"))} bytes to draft/checks/independent.test.ts`,
  ])

  // Handed over the protocol: the drafter's own installation store associates the thread
  // with a workspace whose source digest is the one the controller staged at the pin, and
  // nothing was written for the drafter to read.
  const threadId = payload(factory, id, "intake_thread_created")?.threadId as string
  const staged = payload(factory, id, "drafter_source_staged") as {
    sourceDigest: string
    status: string
  }
  expect(staged.sourceDigest).toMatch(/^[a-f0-9]{64}$/)
  const store = openWorkspaceInstallationReader(drafterRoot)
  try {
    expect(store.associations.get(threadId)?.intent.sourceDigest).toBe(staged.sourceDigest)
  } finally {
    store.close()
  }
  expect(existsSync(join(drafterRoot, ".factory"))).toBe(false)
  expect(process.env.FACTORY_DRAFTER_MANIFEST_DIR).toBeUndefined()

  // The controller read only `draft/`: four paths. The wide capture under `repo/` holds
  // over a thousand files and more bytes than the drafter's inspection bound admits, so a
  // read that walked it would have thrown rather than returned these; the file set is the
  // proof, and the duration is journalled for an operator, not bounded here.
  expect(payload(factory, id, "draft_read")).toMatchObject({
    files: Object.keys(ORACLE_DRAFT).sort(),
  })
  expect(typeof payload(factory, id, "draft_read")?.ms).toBe("number")
  // The controller read it over the drafter's port with the token; without it the port refuses.
  const bare = await fetch(
    `${drafter.url}/threads/${encodeURIComponent(threadId)}/workspace/inspect`,
    {
      method: "POST",
      body: JSON.stringify({ root: "draft" }),
    },
  )
  expect(bare.status).toBe(403)

  // The oracle was proved in the target's image over the drafted check alone.
  const evidence = factory.evidence(id)
  expect(evidence.oracleReceipt?.verdict).toBe("fail")
  expect(evidence.oracleReceipt?.checks.map((c) => [c.id, c.verdict])).toEqual([
    ["independent", "fail"],
  ])
  expect(evidence.oracleReceipt?.verifierIdentity).toMatch(/^docker:/)

  // Approval: nothing to remove behind it, on either side.
  const approved = await factory.approveIntake(id, {
    revision: parked.revision,
    taskDigest: parked.taskDigest as string,
  })
  expect(approved).toMatchObject({ ok: true, state: "received" })
  expect(eventTypes(factory, id).filter((type) => type.includes("manifest"))).toEqual([])
}, 900_000)

it("refuses a three-file draft by name, and the redraft's prompt carries the reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-drafter-e2e-"))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const negativeIssue = { ...ISSUE, title: "The dry-run flag is rejected by the CLI" }
  const origin = { ...ORIGIN, number: 779 }
  // Turn one: three of the four files. `checks.json` is the one left out.
  aimock.addFixtures(
    script()
      .user(negativeIssue.title)
      .callsTool("listDir", { path: "repo/" })
      .callsTool("writeFile", { path: "draft/task.json", content: draftFile("draft/task.json") })
      .callsTool("writeFile", { path: "draft/spec.md", content: draftFile("draft/spec.md") })
      .callsTool("writeFile", {
        path: "draft/checks/independent.test.ts",
        content: draftFile("draft/checks/independent.test.ts"),
      })
      .replies("Three files are written.")
      .build(),
  )
  // Turn two cannot be scripted up front beside turn one. The redraft's prompt contains
  // the issue, so every first-turn fixture content-matches it too, and aimock's turn
  // selection (`selectByTurnIndex` in its router) prefers the indexed fixture nearest
  // below the transcript's assistant count over an unindexed one wherever it sits in the
  // list: a `Previous attempt was refused` fixture placed first would still lose to the
  // first turn's reply. The controller's read of `draft/` is the one moment between the
  // two turns, and the reader seam is where the model is re-scripted: from then on, every
  // call is answered with a reply and no tool call, so the redraft writes nothing and the
  // second read finds the same three files.
  const real = realDrafterReaderLazily()
  let reads = 0
  const factory = await bootController(dir, {
    drafterReader: {
      async read(target, signal) {
        const draft = await real().read(target, signal)
        if (reads++ === 0) {
          aimock.clearFixtures()
          aimock.addFixtures([
            {
              match: { userMessage: "Previous attempt was refused" },
              response: { content: "I cannot add the missing file." },
            },
          ])
        }
        return draft
      },
    },
  })
  const journalStart = aimock.getRequests().length
  const { id } = await factory.createFromIssue({ origin, pin, issue: negativeIssue })
  expect(await factory.intake(id)).toMatchObject({ ok: true })
  const blocked = await factory.settleIntake(id, 800_000)
  expect({
    state: blocked.state,
    blocked: blocked.blockedReason,
    attempts: blocked.intakeAttempts,
  }).toEqual({
    state: "blocked",
    blocked: "intake_attempts_exhausted",
    attempts: 2,
  })
  expect(reads).toBe(2)

  // The first refusal names the missing file and spends the first attempt; the retry ran a
  // second turn on the same thread; the second refusal is the last attempt.
  const refusals = factory.events(id).filter((e) => e.type === "intake_refused")
  expect(refusals.map((e) => e.payload)).toMatchObject([
    { reason: "draft/checks.json is missing", blockedReason: "intake_invalid", attempt: 1 },
    { reason: "draft/checks.json is missing", blockedReason: "intake_invalid", attempt: 2 },
  ])
  // Each refused draft is kept for the operator, under the state directory, with its files.
  for (const [i, refusal] of refusals.entries()) {
    expect(refusal.payload.keptAt).toMatch(new RegExp(`\\.refused/${id}/attempt-${i + 1}$`))
    expect(refusal.payload.keptFiles).toEqual([
      "checks/independent.test.ts",
      "spec.md",
      "task.json",
    ])
  }
  expect(eventTypes(factory, id).filter((t) => t === "intake_thread_created")).toHaveLength(1)
  expect(eventTypes(factory, id).filter((t) => t === "intake_run_started")).toHaveLength(2)
  expect(payload(factory, id, "draft_read")).toMatchObject({
    files: ["draft/checks/independent.test.ts", "draft/spec.md", "draft/task.json"],
  })

  // The second turn's prompt quotes the reason: the model saw exactly what to mend.
  const requests = aimock.getRequests().slice(journalStart)
  expect(requests).toHaveLength(6)
  const secondTurn = requests[5]?.body?.messages ?? []
  const lastUser = [...secondTurn].reverse().find((m) => m.role === "user")
  expect(String(lastUser?.content)).toContain("Previous attempt was refused")
  expect(String(lastUser?.content)).toContain("draft/checks.json is missing")
  // The thread is the same one: the second request carries the first turn's tool calls.
  expect(secondTurn.filter((m) => m.role === "tool")).toHaveLength(4)

  // One capture, one upload, for both attempts: the redraft reused the admitted thread.
  expect(eventTypes(factory, id).filter((type) => type === "drafter_source_staged")).toHaveLength(1)
}, 900_000)

/** The real reader, built on first use. */
function realDrafterReaderLazily(): () => WorkspaceReader {
  let reader: WorkspaceReader | undefined
  return () => {
    reader ??= realDrafterReader()
    return reader
  }
}

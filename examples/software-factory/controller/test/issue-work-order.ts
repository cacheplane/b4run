import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSourceBundle } from "@b4run/workspace/node"
import { stagedReferenceOf } from "../src/lib/builder-handoff.ts"
import { createFactory, type Factory, type FactoryOptions } from "../src/lib/controller/factory.ts"
import type { IssueOrigin, WorkOrderRow } from "../src/lib/domain/work-order.ts"
import { DrafterHandoffSchema } from "../src/lib/drafter-handoff.ts"
import { configureCatalog, resetCatalogForTests } from "../src/lib/targets/catalog.ts"
import { createHttpWorkerClient } from "../src/lib/worker/client.ts"
import { createFakeVerifier, type FakeVerifier } from "./fake-verifier.ts"
import { createFakeWorker, type FakeWorker } from "./fake-worker.ts"
import { fakeBuilderHandoff, fakeWorkerMap } from "./fake-worker-map.ts"
import { createFakeWorkspaceReader, type FakeWorkspaceReader } from "./fake-workspace-reader.ts"
import { GOOD_DRAFT } from "./intake-fixtures.ts"
import { shippedPin } from "./temp-repo.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/**
 * An issue work order driven through the real factory to its frozen bundle, with every
 * collaborator faked as `factory-intake.test.ts` fakes them: a drafter and a builder on loopback,
 * one workspace reader, a scripted verifier, the devkit target at its shipped pin. For tests of
 * what happens at and after the export gate (rung 4's delivery) that do not care how intake works.
 */

export const ORIGIN: IssueOrigin = {
  kind: "issue",
  repository: "cacheplane/b4run",
  number: 912,
  bodyDigest: "0".repeat(64),
}
export const PIN = shippedPin("devkit")
export const ISSUE = {
  title: "spawnProcess leaks its deadline timer",
  body: "A spawn that fails asynchronously leaves the deadline running.",
}
export const SOURCE = "packages/devkit/src/testing/process.ts"
export const BASELINE_TEXT = "export const deadline = 'leaks'\n"
export const REPAIRED_TEXT = "export const deadline = 'cleared'\n"
const BASELINE = new Map([
  [SOURCE, BASELINE_TEXT],
  ["packages/devkit/test/process.test.ts", "spec\n"],
])
const DRAFT_SOURCE = createSourceBundle([
  { path: "repo/README.md", bytes: new TextEncoder().encode("# fixture\n"), executable: false },
])

export interface IssueHarness {
  readonly dir: string
  readonly generated: string
  readonly verifier: FakeVerifier
  readonly reader: FakeWorkspaceReader
  factory: Factory
  /** Open (or reopen, after `factory.close()`) the factory over the same registry. */
  boot(overrides?: Partial<FactoryOptions>): Promise<Factory>
  /** Create, intake, approve the draft, dispatch and verify: the row parked at the export gate. */
  toBundle(input?: {
    readonly deliver?: { readonly kind: "draft-pr"; readonly issueState: "open" | "closed" }
    readonly draft?: Readonly<Record<string, string>>
  }): Promise<WorkOrderRow & { bundleDigest: string }>
  close(): Promise<void>
}

export async function issueHarness(defaults: Partial<FactoryOptions> = {}): Promise<IssueHarness> {
  const dir = mkdtempSync(join(tmpdir(), "factory-issue-"))
  const generated = join(dir, "state", "tasks")
  mkdirSync(join(dir, "out"), { recursive: true })
  configureCatalog({ generatedTasksDir: generated })
  const drafter: FakeWorker = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
  })
  const builder: FakeWorker = await createFakeWorker({
    outboxDir: join(dir, "unused"),
    run: "edits_only",
    threadId: "builder-thread-1",
  })
  const reader = createFakeWorkspaceReader({})
  const verifier = createFakeVerifier({ independent: "fail" })
  const harness: IssueHarness = {
    dir,
    generated,
    verifier,
    reader,
    factory: undefined as unknown as Factory,
    async boot(overrides = {}) {
      harness.factory = await createFactory({
        registryPath: join(dir, "registry.sqlite"),
        generatedTasksDir: generated,
        captureRoot: dir,
        workers: fakeWorkerMap({
          builder: {
            client: createHttpWorkerClient(builder.baseUrl, { token: TEST_WORKER_TOKEN }),
            reader,
          },
          drafter: {
            client: createHttpWorkerClient(drafter.baseUrl, { token: TEST_WORKER_TOKEN }),
            reader,
          },
        }),
        captureBuilderHandoff: fakeBuilderHandoff,
        captureDrafterHandoff: async ({ workOrderId }) => {
          const workspace = { version: 1 as const, source: DRAFT_SOURCE, environmentLinks: [] }
          return {
            handoff: DrafterHandoffSchema.parse({
              version: 2,
              workOrderId,
              workspace: stagedReferenceOf(workspace),
            }),
            workspace,
          }
        },
        exportDir: join(dir, "out"),
        artifactsDir: join(dir, "artifacts"),
        verifier,
        captureBaseline: async () => ({ digest: "a".repeat(64), files: BASELINE }),
        ...defaults,
        ...overrides,
      })
      return harness.factory
    },
    async toBundle(input = {}) {
      const { factory } = harness
      const created = await factory.createFromIssue({
        origin: ORIGIN,
        pin: PIN,
        issue: ISSUE,
        ...(input.deliver !== undefined ? { deliver: input.deliver } : {}),
        operationKey: `issue:${ORIGIN.number}:${Math.random()}`,
      })
      const started = await factory.intake(created.id)
      if (!started.ok) throw new Error(`intake refused: ${started.message}`)
      const intakeThread = (factory.show(created.id) as WorkOrderRow).workerThreadId as string
      reader.set(intakeThread, input.draft ?? GOOD_DRAFT)
      const parked = await factory.settleIntake(created.id, 20_000)
      if (parked.state !== "awaiting_intake_approval")
        throw new Error(`intake parked nothing: ${parked.state} ${parked.blockedReason}`)
      const approved = await factory.approveIntake(created.id, {
        revision: parked.revision,
        taskDigest: parked.taskDigest as string,
      })
      if (!approved.ok) throw new Error(`approve-intake refused: ${approved.message}`)
      verifier.script = { verdict: "pass" }
      const dispatched = await factory.dispatch(created.id)
      if (!dispatched.ok) throw new Error(`dispatch refused: ${dispatched.message}`)
      const running = await factory.waitFor(created.id, (r) => r.state !== "received")
      reader.set(running.workerThreadId as string, {
        ...Object.fromEntries(BASELINE),
        [SOURCE]: REPAIRED_TEXT,
      })
      const row = await factory.settle(created.id, 20_000)
      if (row.state !== "awaiting_approval" || row.bundleDigest === null)
        throw new Error(`verification parked nothing: ${row.state} ${row.blockedReason}`)
      return row as WorkOrderRow & { bundleDigest: string }
    },
    async close() {
      resetCatalogForTests()
      await harness.factory?.close()
      await drafter.close()
      await builder.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
  await harness.boot()
  return harness
}

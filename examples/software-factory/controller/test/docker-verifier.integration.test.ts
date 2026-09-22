import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { freezeBundle } from "../src/lib/review/bundle.ts"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { createDockerVerifier } from "../src/lib/verification/docker-verifier.ts"
import { loadPolicy } from "../src/lib/verification/policy.ts"
import { applyReference } from "./reference-repair.ts"

const task = loadTask("cli-flags")
const policy = loadPolicy("cli-flags")
const allowed = task.manifest.allowedSourcePaths[0] as string

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const verifierFor = async (deadlineMs?: number) => {
  const dir = await mkdtemp(join(tmpdir(), "factory-verifier-"))
  directories.push(dir)
  return createDockerVerifier(
    createArtifactStore(join(dir, "artifacts")),
    deadlineMs === undefined ? {} : { deadlineMs },
  )
}

describe("the real verifier", () => {
  it("passes the reference repair", async () => {
    // The historical reference repair: a candidate known to be correct, so a
    // failure here is the harness's fault and not the candidate's.
    const receipt = await (await verifierFor()).verify(
      {
        workOrderId: "wo-1",
        taskId: "cli-flags",
        candidateDigest: "a".repeat(64),
        changes: { [allowed]: await applyReference() },
        policyDigest: policy.policyDigest,
      },
      AbortSignal.timeout(280_000),
    )
    expect(receipt.verdict).toBe("pass")
    expect(receipt.verifierIdentity).toMatch(/^docker:/)
    expect(receipt.candidateDigest).toBe("a".repeat(64))
    expect(receipt.checks.map((c) => c.id)).toEqual(["visible", "independent"])
    // Evidence is named per check, not per kind: two checks reporting one `output` id with
    // two digests is exactly what `freezeBundle` refuses, so a receipt the controller cannot
    // freeze is a receipt this lane must not call passing.
    expect(receipt.checks.flatMap((c) => c.evidence.map((e) => e.id))).toEqual([
      "visible/output",
      "independent/output",
    ])
    const bundle = freezeBundle({
      workOrderId: "wo-1",
      repositoryId: "cli-flags",
      baselineDigest: "f".repeat(64),
      specificationDigest: policy.specificationDigest,
      policyDigest: policy.policyDigest,
      candidateDigest: receipt.candidateDigest,
      receipt,
      destinationId: "/out",
      frozenAt: new Date().toISOString(),
      origin: { kind: "catalog" },
      pin: null,
      taskDigest: null,
      oracleReceiptId: null,
    })
    expect(bundle.payload.evidence).toHaveLength(2)
  }, 300_000)

  it("fails a candidate that satisfies the visible suite and not the independent checks", async () => {
    // Rung 1's headline invariant, earned rather than scripted.
    const receipt = await (await verifierFor()).verify(
      {
        workOrderId: "wo-2",
        taskId: "cli-flags",
        candidateDigest: "b".repeat(64),
        changes: { [allowed]: shallowRepair() },
        policyDigest: policy.policyDigest,
      },
      AbortSignal.timeout(280_000),
    )
    expect(receipt.verdict).toBe("fail")
    expect(receipt.checks.find((c) => c.id === "visible")?.verdict).toBe("pass")
    expect(receipt.checks.find((c) => c.id === "independent")?.verdict).toBe("fail")
  }, 300_000)

  it("refuses a candidate whose suite mutates the workspace", async () => {
    const receipt = await (await verifierFor()).verify(
      {
        workOrderId: "wo-3",
        taskId: "cli-flags",
        candidateDigest: "c".repeat(64),
        changes: { [allowed]: selfModifying() },
        policyDigest: policy.policyDigest,
      },
      AbortSignal.timeout(280_000),
    )
    expect(receipt.verdict).toBe("fail")
    expect(receipt.checks.map((c) => c.id)).toEqual(["visible"])
  }, 300_000)

  it("bounds itself and reports not knowing when its own deadline fires", async () => {
    // The controller cannot be relied on to bound this: reconciliation awaits
    // verification before the budget ticker exists. A receipt, not a rejection —
    // out of time is a fact about the harness, not a verdict on the candidate.
    const receipt = await (await verifierFor(1)).verify(
      {
        workOrderId: "wo-4",
        taskId: "cli-flags",
        candidateDigest: "d".repeat(64),
        changes: { [allowed]: await applyReference() },
        policyDigest: policy.policyDigest,
      },
      AbortSignal.timeout(280_000),
    )
    expect(receipt.verdict).toBe("inconclusive")
    expect(receipt.checks.map((c) => c.id)).toEqual(["deadline"])
  }, 300_000)

  it("re-throws a caller's cancellation instead of calling it a verdict", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      (await verifierFor()).verify(
        {
          workOrderId: "wo-5",
          taskId: "cli-flags",
          candidateDigest: "e".repeat(64),
          changes: { [allowed]: await applyReference() },
          policyDigest: policy.policyDigest,
        },
        controller.signal,
      ),
    ).rejects.toThrow()
  }, 300_000)
})

/**
 * Registers only the one flag the visible test names, and forwards it by hand.
 * `memory consolidate --dry-run` therefore works, while `prune --cap 17` still
 * dies on an unknown option — which is precisely what the independent checks
 * were written to catch.
 */
function shallowRepair(): string {
  return `import { Command } from "commander"
import { runMemoryCommand } from "./memory.js"

const program = new Command().name("fixture")
program
  .command("memory [subcommand] [args...]")
  .description("Manage memory")
  .option("--cwd <path>", "App directory")
  .option("--dry-run", "Preview only")
  .action(
    async (subcommand: string, args: string[], options: { cwd?: string; dryRun?: boolean }) => {
      await runMemoryCommand(subcommand, options.dryRun ? [...args, "--dry-run"] : args, options)
    },
  )

await program.parseAsync(process.argv)
`
}

/** A repair whose module top level rewrites the visible test it is graded by. */
function selfModifying(): string {
  return `import { writeFileSync } from "node:fs"
import { Command } from "commander"
import { runMemoryCommand } from "./memory.js"

writeFileSync(
  new URL("../test/cli.test.ts", import.meta.url),
  "import test from 'node:test'\\ntest('documented dry-run flag reaches the handler', () => {})\\n",
)

const program = new Command().name("fixture").enablePositionalOptions()
program
  .command("memory [subcommand] [args...]")
  .passThroughOptions()
  .description("Manage memory")
  .option("--cwd <path>", "App directory")
  .action(async (subcommand: string, args: string[], options: { cwd?: string }) => {
    await runMemoryCommand(subcommand, args, options)
  })

await program.parseAsync(process.argv)
`
}

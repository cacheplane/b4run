import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { attemptContext } from "../src/blueprint/attempt-context.ts"
import { fixturesRoot } from "../src/blueprint/fixture-catalog.ts"

it.each(["once", "deny"])(
  "requires actual approval before review export: %s",
  async (decision) => {
    const output = await mkdtemp(join(tmpdir(), "b4-code-fixer-approval-"))
    const previous = process.env.B4_CODE_FIXER_ATTEMPT_DIR
    process.env.B4_CODE_FIXER_ATTEMPT_DIR = output
    const appRoot = fileURLToPath(new URL("../", import.meta.url))
    const original = await readFile(join(fixturesRoot, "cli-flags/project/src/cli.ts"), "utf8")
    const repaired = original
      .replace(
        'new Command().name("fixture")',
        'new Command().name("fixture").enablePositionalOptions()',
      )
      .replace(
        '.command("memory [subcommand] [args...]")',
        '.command("memory [subcommand] [args...]").passThroughOptions()',
      )
    const h = await createAgentHarness({ appRoot, route: "/fix#agent" })
    try {
      const run = await h.run({
        input: "Fix the task",
        fixtures: script()
          .user("Fix the task")
          .callsTool("readFile", { path: "TASK.md" })
          .callsTool("runBash", { command: "npm test" })
          .callsTool("writeFile", { path: "src/cli.ts", content: repaired })
          .callsTool("runBash", { command: "npm test" })
          .callsTool("exportForReview", {})
          .replies("Exported the verified patch for review."),
      })
      expect(run.interrupts).toHaveLength(1)
      expect(run.interrupts[0]?.kind).toBe("tool")
      expect((await readdir(output)).filter((name) => name !== "owned-threads.jsonl")).toEqual([])
      expect(
        (await attemptContext().verify(AbortSignal.timeout(120_000))).verification.passed,
      ).toBe(true)
      await h.resume({
        resume: run.interrupts.map((entry) => ({
          interruptId: entry.interruptId,
          status: "resolved" as const,
          payload: decision,
        })),
      })
      if (decision === "once") {
        expect(
          JSON.parse(await readFile(join(output, "review-outbox/patch.json"), "utf8")).verification
            .passed,
        ).toBe(true)
      } else {
        expect((await readdir(output)).filter((name) => name !== "owned-threads.jsonl")).toEqual([])
      }
    } finally {
      await h.close()
      await attemptContext().provider.destroyAll()
      if (previous === undefined) delete process.env.B4_CODE_FIXER_ATTEMPT_DIR
      else process.env.B4_CODE_FIXER_ATTEMPT_DIR = previous
      await rm(output, { recursive: true, force: true })
    }
  },
  120_000,
)

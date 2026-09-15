import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { isolatedApp } from "../src/evaluation/isolated-app.ts"
import { replayFixture, taskInput } from "../src/evaluation/replay.ts"

it.each(["once", "deny"])(
  "requires actual approval before review export: %s",
  async (decision) => {
    const appRoot = await isolatedApp()
    const h = await createAgentHarness({ appRoot, route: "/fix#agent" })
    try {
      const first = await h.run({ input: taskInput, fixtures: await replayFixture("cli-flags") })
      const prepared = first.toolResults.find((tool) => tool.name === "prepareReview")
      expect(prepared).toBeDefined()
      const payload =
        typeof prepared?.content === "string" ? JSON.parse(prepared.content) : prepared?.content
      expect(payload.verification.passed).toBe(true)
      const input = "Export the verified candidate"
      const run = await h.run({
        input,
        fixtures: script()
          .user(input)
          .callsTool("exportForReview", { candidate: payload.candidate })
          .replies("Review request handled."),
      })
      expect(run.interrupts).toHaveLength(1)
      const outbox = join(appRoot, ".b4/code-fixer/review-outbox")
      expect(await readdir(outbox).catch(() => [])).toEqual([])
      await h.resume({
        resume: run.interrupts.map((entry) => ({
          interruptId: entry.interruptId,
          status: "resolved" as const,
          payload: decision,
        })),
      })
      const files = await readdir(outbox).catch(() => [])
      if (decision === "once") {
        expect(files).toHaveLength(1)
        expect(JSON.parse(await readFile(join(outbox, files[0]!), "utf8")).candidate).toEqual(
          payload.candidate,
        )
      } else expect(files).toEqual([])
    } finally {
      await h.close({ destroyWorkspaces: true })
      await rm(appRoot, { recursive: true, force: true })
    }
  },
  120_000,
)

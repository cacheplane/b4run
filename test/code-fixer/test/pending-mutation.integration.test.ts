import { execFileSync } from "node:child_process"
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { createAgentHarness, script } from "@b4run/testing"
import { expect, it } from "vitest"
import { validateCandidate } from "../../../examples/code-fixer/server/src/review/candidate.ts"
import { cleanupEvaluation } from "../evaluation/cleanup.ts"
import { isolatedApp } from "../evaluation/isolated-app.ts"
import { replayFixture, taskInput } from "../evaluation/replay.ts"

it("rejects export when source changes while the exact candidate awaits approval", async () => {
  const appRoot = await isolatedApp()
  let h: Awaited<ReturnType<typeof createAgentHarness>> | undefined
  try {
    h = await createAgentHarness({ appRoot, route: "/fix#agent" })
    const first = await h.run({ input: taskInput, fixtures: await replayFixture("cli-flags") })
    const preparation = first.toolResults.find(
      (result) => result.name === "prepareReview" && !result.isError,
    )
    expect(preparation).toBeDefined()
    const prepared =
      typeof preparation?.content === "string"
        ? JSON.parse(preparation.content)
        : preparation?.content
    const candidate = validateCandidate(prepared.candidate)
    const input = "Export this verified candidate"
    const pending = await h.run({
      input,
      fixtures: script()
        .user(input)
        .callsTool("exportForReview", { candidate })
        .replies("Review request handled."),
    })
    expect(pending.interrupts).toHaveLength(1)
    const interrupt = pending.interrupts[0]
    expect(interrupt?.kind).toBe("tool")
    if (interrupt?.kind !== "tool") throw new Error("Missing approval interrupt")
    expect(interrupt.detail.toolName).toBe("exportForReview")
    expect(pending.toolResults.some((result) => result.name === "exportForReview")).toBe(false)
    const outbox = join(appRoot, ".b4/code-fixer/review-outbox")
    expect(await readdir(outbox).catch(() => [])).toEqual([])

    // Provider-specific fault injection stays in the repository suite. The public
    // candidate identifies the owned operation; exact labels exclude every other app.
    const matches = execFileSync(
      "docker",
      [
        "ps",
        "--no-trunc",
        "--quiet",
        "--filter",
        `label=b4.workspace.operation=${candidate.workspaceId}`,
        "--filter",
        `label=b4.workspace.source=${candidate.sourceDigest}`,
        "--filter",
        "label=b4.workspace.role=session",
      ],
      { encoding: "utf8", timeout: 10_000 },
    )
      .trim()
      .split("\n")
      .filter(Boolean)
    expect(matches).toHaveLength(1)
    const container = matches[0]
    if (!container || !/^[a-f0-9]{64}$/.test(container))
      throw new Error("Missing owned workspace container")
    execFileSync(
      "docker",
      [
        "exec",
        container,
        "node",
        "-e",
        'require("node:fs").appendFileSync("/workspace/src/cli.ts", "\\n// changed while awaiting approval\\n")',
      ],
      { timeout: 10_000 },
    )

    const resumed = await h.resume({
      resume: pending.interrupts.map((entry) => ({
        interruptId: entry.interruptId,
        status: "resolved" as const,
        payload: "once",
      })),
    })
    const exported = resumed.toolResults.find((result) => result.name === "exportForReview")
    expect(exported?.isError).toBe(true)
    expect(JSON.stringify(exported?.content)).toContain("Workspace changed since review")
    expect(await readdir(outbox).catch(() => [])).toEqual([])
  } finally {
    try {
      await h?.close({ destroyWorkspaces: true })
    } finally {
      try {
        await cleanupEvaluation(appRoot)
      } finally {
        await rm(appRoot, { recursive: true, force: true })
      }
    }
  }
}, 120_000)

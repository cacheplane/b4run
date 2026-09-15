import { mkdtemp, readdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { runChild } from "../evaluation/run-attempt.ts"

it("returns nonzero while retaining every failed attempt in the batch summary", async () => {
  const output = await mkdtemp(join(tmpdir(), "b4-code-fixer-failed-batch-"))
  try {
    const command = await runChild(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("../scripts/eval.ts", import.meta.url)),
        "--replay",
        "--attempts",
        "1",
        "--output",
        output,
      ],
      { DOCKER_HOST: `unix://${output}/unavailable.sock` },
      30_000,
    )
    expect(command.exitCode).toBe(1)
    const batch = (await readdir(output)).find((name) => name.startsWith("batch-"))
    expect(batch).toBeDefined()
    const summary = JSON.parse(
      await readFile(join(output, batch as string, "summary.json"), "utf8"),
    )
    expect(summary).toHaveLength(2)
    expect(
      summary.every(
        (attempt: { status: string; passed: boolean }) =>
          attempt.status === "infrastructure-failed" && !attempt.passed,
      ),
    ).toBe(true)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}, 35_000)

import { watch } from "node:fs"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { runAttempt } from "../src/blueprint/run-attempt.ts"

it("returns an accounted failure if the final artifact cannot be written", async () => {
  const output = await mkdtemp(join(tmpdir(), "b4-artifact-failure-"))
  const previous = process.env.DOCKER_HOST
  process.env.DOCKER_HOST = `unix://${output}/unavailable.sock`
  const fallback = vi.spyOn(console, "error").mockImplementation(() => {})
  const pending: Promise<unknown>[] = []
  const watcher = watch(output, () => {
    pending.push(
      (async () => {
        for (const name of await readdir(output))
          await mkdir(join(output, name, "result.json"), { recursive: true })
      })(),
    )
  })
  try {
    const result = await runAttempt({ task: "cli-flags", mode: "replay", outputRoot: output })
    expect(result.receipt.status).toBe("artifact-failed")
    expect(result.receipt.passed).toBe(false)
    expect(fallback).toHaveBeenCalled()
  } finally {
    watcher.close()
    await Promise.all(pending)
    fallback.mockRestore()
    if (previous === undefined) delete process.env.DOCKER_HOST
    else process.env.DOCKER_HOST = previous
    await rm(output, { recursive: true, force: true })
  }
}, 30_000)

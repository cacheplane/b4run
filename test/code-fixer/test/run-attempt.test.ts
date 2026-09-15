import { expect, it } from "vitest"
import { runChild } from "../evaluation/run-attempt.ts"

it("accounts for child success, failure, and timeout", async () => {
  expect((await runChild(process.execPath, ["-e", "process.exit(0)"], {}, 5000)).status).toBe(
    "completed",
  )
  expect((await runChild(process.execPath, ["-e", "process.exit(2)"], {}, 5000)).status).toBe(
    "infrastructure-failed",
  )
  expect(
    (await runChild(process.execPath, ["-e", "setInterval(()=>{},1000)"], {}, 50)).status,
  ).toBe("timed-out")
})

it("records cancellation and terminates the owned child", async () => {
  const controller = new AbortController()
  const pending = runChild(
    process.execPath,
    ["-e", "setInterval(()=>{},1000)"],
    {},
    5000,
    controller.signal,
  )
  controller.abort()
  expect((await pending).status).toBe("cancelled")
})

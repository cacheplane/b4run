import { expect, it } from "vitest"
import { destroyRegisteredThreads, runChild } from "../src/blueprint/run-attempt.ts"

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
    false,
    controller.signal,
  )
  controller.abort()
  expect((await pending).status).toBe("cancelled")
})

it("attempts all owned cleanup even after invalid entries and destroy failures", async () => {
  const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]
  const visited: string[] = []
  await expect(
    destroyRegisteredThreads(
      {
        async destroy(id) {
          visited.push(id)
          if (id === ids[0]) throw new Error("unavailable")
        },
      },
      `not-json\n${ids.map((id) => JSON.stringify(id)).join("\n")}`,
    ),
  ).rejects.toThrow("Owned sandbox cleanup failed")
  expect(visited).toEqual(ids)
})

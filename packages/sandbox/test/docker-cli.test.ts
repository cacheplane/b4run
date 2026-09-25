import { describe, expect, test } from "vitest"
import { createDocker, spawnCollect } from "../src/docker/docker-cli.ts"

describe("createDocker", () => {
  test("runs docker with args, returns stdout/exit", async () => {
    const calls: string[][] = []
    const docker = createDocker({
      spawn: async (args, _opts) => {
        calls.push([...args])
        return { stdout: "ok", stderr: "", exitCode: 0 }
      },
    })
    const r = await docker.run(["ps", "-q"])
    expect(r.stdout).toBe("ok")
    expect(calls[0]).toEqual(["ps", "-q"])
  })

  test("execInto pipes stdin and targets a container", async () => {
    const seen: { args: string[]; stdin?: string }[] = []
    const docker = createDocker({
      spawn: async (args, opts) => {
        seen.push({ args: [...args], ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}) })
        return { stdout: "", stderr: "", exitCode: 0 }
      },
    })
    await docker.exec("c1", ["sh", "-c", "cat > /workspace/f"], { stdin: "data" })
    expect(seen[0]?.args.slice(0, 2)).toEqual(["exec", "-i"])
    expect(seen[0]?.args).toContain("c1")
    expect(seen[0]?.stdin).toBe("data")
  })
})

describe("spawnCollect", () => {
  test("a child that exits without reading its stdin reports its exit status, not an uncaught EPIPE", async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown) => uncaught.push(error)
    process.on("uncaughtException", onUncaught)
    try {
      // Far more than a pipe buffer holds, so the write is still pending when the child exits.
      const stdin = "x".repeat(8 * 1024 * 1024)
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const result = await spawnCollect("sh", ["-c", "exit 3"], { stdin })
        expect(result.exitCode).toBe(3)
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(uncaught).toEqual([])
    } finally {
      process.off("uncaughtException", onUncaught)
    }
  })
})

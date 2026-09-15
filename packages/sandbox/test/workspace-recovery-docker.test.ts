import { describe, expect, test } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { RecoveryDocker } from "./support/recovery/docker.ts"
import type { Attempt } from "./support/recovery/types.ts"

const attempt: Attempt = {
  installationId: "test-install",
  logicalId: "thread",
  generationId: "generation",
  imageId: "sha256:test",
  volumeName: "volume",
  preparerName: "preparer",
  sessionName: "session",
}
const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0 })

describe("recovery Docker ownership and uncertainty", () => {
  test("inspection failure is unavailable, never absence", async () => {
    const docker: Docker = {
      run: async () => ({ stdout: "", stderr: "daemon disconnected", exitCode: 1 }),
      exec: async () => ok(),
    }
    await expect(new RecoveryDocker(docker).inspect(attempt)).rejects.toThrow("daemon disconnected")
  })

  test("foreign volume is a conflict and is never removed", async () => {
    const calls: string[][] = []
    const docker: Docker = {
      async run(args) {
        calls.push([...args])
        if (args[0] === "volume" && args[1] === "ls") return ok("volume\n")
        if (args[0] === "volume" && args[1] === "inspect")
          return ok(
            JSON.stringify([{ Name: "volume", Labels: { "b4.recovery.installation": "foreign" } }]),
          )
        return ok()
      },
      exec: async () => ok(),
    }
    await expect(new RecoveryDocker(docker).destroy(attempt)).rejects.toThrow("ownership")
    expect(calls.some((args) => args.includes("rm"))).toBe(false)
  })

  test("confirmed empty daemon inventory means absent resources", async () => {
    const docker: Docker = { run: async () => ok(), exec: async () => ok() }
    expect(await new RecoveryDocker(docker).inspect(attempt)).toEqual({ volume: false })
  })

  test("a failed stop is retained as uncertainty and never followed by removal", async () => {
    const calls: string[][] = []
    let adapter: RecoveryDocker
    const docker: Docker = {
      async run(args) {
        calls.push([...args])
        if (args[0] === "ps") return ok("preparer")
        if (args[0] === "inspect")
          return ok(
            JSON.stringify([
              {
                Id: "physical-preparer",
                Name: "/preparer",
                Image: attempt.imageId,
                Config: { Labels: adapter.labels(attempt) },
                Mounts: [{ Name: "volume", Destination: "/workspace" }],
                State: { Running: true },
              },
            ]),
          )
        if (args[0] === "stop") return { stdout: "", stderr: "stop disconnected", exitCode: 1 }
        return ok()
      },
      exec: async () => ok(),
    }
    adapter = new RecoveryDocker(docker)
    await expect(adapter.destroy(attempt)).rejects.toThrow("stop disconnected")
    expect(calls.some((args) => args.includes("rm"))).toBe(false)
  })

  test("same container name with a different physical ID is refused", async () => {
    let adapter: RecoveryDocker
    const docker: Docker = {
      async run(args) {
        if (args[0] === "ps") return ok("session")
        if (args[0] === "inspect")
          return ok(
            JSON.stringify([
              {
                Id: "replacement",
                Name: "/session",
                Image: attempt.imageId,
                Config: { Labels: adapter.labels(attempt) },
                Mounts: [{ Name: "volume", Destination: "/workspace" }],
                State: { Running: false },
              },
            ]),
          )
        return ok()
      },
      exec: async () => ok(),
    }
    adapter = new RecoveryDocker(docker)
    await expect(adapter.inspect({ ...attempt, sessionId: "original" })).rejects.toThrow(
      "identity mismatch",
    )
  })

  test("logical discovery checks both compute and storage with ownership filters", async () => {
    const calls: string[][] = []
    const docker: Docker = {
      async run(args) {
        calls.push([...args])
        return ok(args[0] === "ps" ? "orphan" : "")
      },
      exec: async () => ok(),
    }
    expect(await new RecoveryDocker(docker).hasResources("installation", "logical")).toBe(true)
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call).toContain("label=b4.recovery.installation=installation")
      expect(call).toContain("label=b4.recovery.logical=logical")
    }
  })

  test("new session is inspected for ownership before start", async () => {
    let created = false
    let adapter: RecoveryDocker
    const calls: string[][] = []
    const docker: Docker = {
      async run(args) {
        calls.push([...args])
        if (args[0] === "volume" && args[1] === "ls") return ok("volume")
        if (args[0] === "volume" && args[1] === "inspect")
          return ok(JSON.stringify([{ Name: "volume", Labels: adapter.labels(attempt) }]))
        if (args[0] === "ps") return ok(created ? "session" : "")
        if (args[0] === "create") {
          created = true
          return ok("new-session")
        }
        if (args[0] === "inspect")
          return ok(
            JSON.stringify([
              {
                Id: "new-session",
                Name: "/session",
                Image: attempt.imageId,
                Config: { Labels: {} },
                Mounts: [{ Name: "volume", Destination: "/workspace" }],
                State: { Running: false },
              },
            ]),
          )
        return ok()
      },
      exec: async () => ok(),
    }
    adapter = new RecoveryDocker(docker)
    await expect(adapter.attach({ ...attempt }, attempt.imageId)).rejects.toThrow("ownership")
    expect(calls.some((args) => args[0] === "start")).toBe(false)
  })
})

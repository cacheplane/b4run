import { randomUUID } from "node:crypto"
import { dockerSandbox } from "@b4run/sandbox"
import type { SandboxPolicy } from "@b4run/workspace"
import { expect, it } from "vitest"
import { seedFixture } from "../src/blueprint/seed-fixture.ts"
import { seededProvider } from "../src/blueprint/seeded-provider.ts"

it("uses the same isolated workspace for files and commands, then destroys it", async () => {
  const provider = seededProvider(
    dockerSandbox({ image: "b4-code-fixer:fixture-v1" }),
    (h, signal) => seedFixture("cli-flags", h, signal),
  )
  const policy: SandboxPolicy = {
    network: { mode: "deny" },
    resources: { memoryMb: 1024, cpus: 1, timeoutMs: 120_000 },
  }
  const signal = AbortSignal.timeout(120_000)
  const firstId = randomUUID(),
    secondId = randomUUID()
  try {
    const first = await provider.acquire({ threadId: firstId, policy, signal })
    const ctx = { workspaceRoot: first.workspaceRoot, signal }
    await first.filesystem.writeFile(`${first.workspaceRoot}/probe.txt`, "sandbox-only", ctx)
    expect((await first.exec.runCommand({ command: "cat probe.txt" }, ctx)).stdout).toBe(
      "sandbox-only",
    )
    const baseline = await first.exec.runCommand({ command: "npm test" }, ctx)
    expect(baseline.exitCode).not.toBe(0)
    expect(baseline.stdout + baseline.stderr).toContain("unknown option")
    const env = await first.exec.runCommand(
      { command: "node -e 'console.log(Boolean(process.env.OPENAI_API_KEY))'" },
      ctx,
    )
    expect(env.stdout.trim()).toBe("false")
    await provider.release(firstId)
    const resumed = await provider.acquire({ threadId: firstId, policy, signal })
    expect(await resumed.filesystem.readFile(`${resumed.workspaceRoot}/probe.txt`, ctx)).toBe(
      "sandbox-only",
    )
    const second = await provider.acquire({ threadId: secondId, policy, signal })
    await expect(
      second.filesystem.readFile(`${second.workspaceRoot}/probe.txt`, {
        ...ctx,
        workspaceRoot: second.workspaceRoot,
      }),
    ).rejects.toThrow()
  } finally {
    await provider.destroyAll()
  }
  expect(provider.handles.size).toBe(0)
}, 120_000)

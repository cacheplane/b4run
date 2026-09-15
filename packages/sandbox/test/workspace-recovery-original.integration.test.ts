import { randomUUID } from "node:crypto"
import type { SandboxHandle, SandboxProvider } from "@b4run/workspace"
import { describe, expect, test } from "vitest"
import { dockerSandbox } from "../src/index.ts"
import { resourceScope } from "../src/resource-scope.ts"
import { withCleanup } from "./support/recovery/cleanup.ts"
import { RecoveryDocker } from "./support/recovery/docker.ts"

describe.skipIf(process.env.B4_TEST_DOCKER !== "1")(
  "original app restart diagnostic",
  { timeout: 120_000 },
  () => {
    test("actual seeded wrapper destroys retained workspace when repeated setup fails", async () => {
      // Dynamic URLs keep application implementation outside this package's TS rootDir.
      const seededUrl = new URL(
        "../../../examples/code-fixer/server/src/blueprint/seeded-provider.ts",
        import.meta.url,
      ).href
      const seedUrl = new URL(
        "../../../examples/code-fixer/server/src/blueprint/seed-fixture.ts",
        import.meta.url,
      ).href
      const { seededProvider } = (await import(seededUrl)) as {
        seededProvider(
          base: SandboxProvider,
          seed: (h: SandboxHandle, s: AbortSignal) => Promise<void>,
        ): SandboxProvider
      }
      const { seedFixture } = (await import(seedUrl)) as {
        seedFixture(id: string, h: SandboxHandle, s: AbortSignal): Promise<void>
      }
      const scope = `original-diagnostic-${randomUUID()}`
      const threadId = randomUUID()
      const image = process.env.B4_RECOVERY_IMAGE ?? "b4-code-fixer-recovery:local"
      const input = {
        threadId,
        policy: { network: { mode: "deny" as const } },
        signal: AbortSignal.timeout(90_000),
      }
      const base = dockerSandbox({ scope, image })
      const resources = new RecoveryDocker()
      const seed = (h: SandboxHandle, s: AbortSignal) => seedFixture("cli-flags", h, s)
      await withCleanup(
        async () => {
          const first = seededProvider(base, seed)
          const handle = await first.acquire(input)
          const context = { workspaceRoot: handle.workspaceRoot, signal: input.signal }
          await handle.filesystem.writeFile("/workspace/src/cli.ts", "retained user edit", context)
          await first.release(threadId)
          const fresh = seededProvider(dockerSandbox({ scope, image }), seed)
          await expect(fresh.acquire(input)).rejects.toThrow("Sandbox seeding failed")
          const volumeName = `b4-sbx-vol-${resourceScope(scope)(threadId)}`
          const names = await resources.checked(["volume", "ls", "--format", "{{.Name}}"])
          expect(names.split("\n")).not.toContain(volumeName)
        },
        async () => {
          await base.destroy(threadId)
          const volumeName = `b4-sbx-vol-${resourceScope(scope)(threadId)}`
          const names = await resources.checked(["volume", "ls", "--format", "{{.Name}}"])
          if (names.split("\n").includes(volumeName))
            throw new Error(`Cleanup incomplete: ${volumeName}`)
        },
      )
    })
  },
)

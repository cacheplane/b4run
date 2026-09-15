import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import { dockerSandbox } from "@b4run/sandbox"
import { expect, it } from "vitest"
import { appRoot, projectWorkspace, sandboxImage, sandboxPolicy } from "../src/project/workspace.ts"

it("runs fixture commands in a disposable managed workspace", async () => {
  await withWorkspace(
    {
      appRoot,
      stateRoot: join(appRoot, ".b4/test-verifiers", randomUUID()),
      workspace: projectWorkspace("cli-flags"),
      provider: dockerSandbox({ scope: "code-fixer-test", image: sandboxImage }),
      policy: sandboxPolicy,
      signal: AbortSignal.timeout(120_000),
    },
    async (handle) => {
      const ctx = { workspaceRoot: handle.workspaceRoot, signal: AbortSignal.timeout(120_000) }
      const result = await handle.exec.runCommand({ command: "npm test" }, ctx)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout + result.stderr).toContain("unknown option")
      const env = await handle.exec.runCommand(
        { command: "node -e 'console.log(Boolean(process.env.OPENAI_API_KEY))'" },
        ctx,
      )
      expect(env.stdout.trim()).toBe("false")
    },
  )
}, 120_000)

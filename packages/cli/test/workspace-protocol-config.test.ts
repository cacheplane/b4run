import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seedB4Config } from "@b4run/core"
import { afterEach, describe, expect, it } from "vitest"
import { runBuildCommand } from "../src/commands/build.ts"
import {
  createRuntimeFetchHandler,
  type RuntimeFetchHandler,
} from "../src/lib/dev/runtime-fetch-handler.ts"
import { collectSandboxErrors } from "../src/lib/runtime/collect-sandbox-errors.ts"
import { sandboxConfigShapeErrors } from "../src/lib/runtime/sandbox-config-shape.ts"
import { managedProviderFixture } from "./support/managed-provider.ts"

const roots: string[] = []
const handlers: RuntimeFetchHandler[] = []
afterEach(async () => {
  for (const handler of handlers.splice(0)) await handler.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const resolver = async () => ({ source: { directory: "source", include: ["main.txt"] } })
const allowAll = { fallback: () => ({ decision: "allow" as const }) }

async function app(options: { readonly policyFile?: boolean } = {}) {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-workspace-protocol-"))
  roots.push(appRoot)
  const files: Record<string, string> = {
    "package.json": '{"type":"module"}',
    "b4.config.ts": "export default {}",
    "workspace/.keep": "",
    "source/main.txt": "initial",
    "src/app/hello/index.ts": "export const workflow = async () => ({ ok: true })",
    ...(options.policyFile
      ? { "src/thread-access.ts": "export default { fallback: () => ({ decision: 'allow' }) }" }
      : {}),
  }
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(appRoot, path, ".."), { recursive: true })
    await writeFile(join(appRoot, path), text)
  }
  return appRoot
}

describe("sandbox.workspaceRead shape", () => {
  const provider = managedProviderFixture().provider
  it('accepts exactly "http" beside managed workspaces', () => {
    expect(
      sandboxConfigShapeErrors({ provider, workspace: resolver, workspaceRead: "http" }),
    ).toEqual([])
    expect(sandboxConfigShapeErrors({ provider, thread: resolver, workspaceRead: "http" })).toEqual(
      [],
    )
  })
  for (const value of ["HTTP", true, "https", 1, null])
    it(`refuses workspaceRead: ${JSON.stringify(value)}`, () => {
      expect(
        sandboxConfigShapeErrors({ provider, workspace: resolver, workspaceRead: value }).join(
          "\n",
        ),
      ).toMatch(/sandbox.workspaceRead must be "http"/)
    })
  it("refuses it without managed workspaces", () => {
    expect(sandboxConfigShapeErrors({ provider, workspaceRead: "http" }).join("\n")).toMatch(
      /workspaceRead needs managed workspaces/,
    )
  })
  it("refuses a misspelling as an unknown key", () => {
    expect(
      sandboxConfigShapeErrors({ provider, workspace: resolver, workspaceRaed: "http" }).join("\n"),
    ).toMatch(/sandbox.workspaceRaed is not a sandbox option/)
  })
})

describe("sandbox.workspaceRead needs a thread-access policy", () => {
  it("b4 check refuses it without src/thread-access.ts, and accepts it with one", async () => {
    const provider = managedProviderFixture().provider
    const sandbox = { provider, workspace: resolver, workspaceRead: "http" as const }
    const without = await collectSandboxErrors({ sandbox }, await app())
    expect(without.errors.join("\n")).toMatch(/sandbox.workspaceRead .* no thread-access policy/)
    const withPolicy = await collectSandboxErrors({ sandbox }, await app({ policyFile: true }))
    expect(withPolicy.errors).toEqual([])
  })

  it("b4 build refuses it without src/thread-access.ts", async () => {
    const appRoot = await app()
    seedB4Config(appRoot, {
      build: { targets: ["node"] },
      sandbox: {
        provider: managedProviderFixture().provider,
        workspace: resolver,
        workspaceRead: "http",
      },
    } as never)
    await expect(
      runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} }),
    ).rejects.toThrow(/no thread-access policy/)
  })

  it("boot refuses it without a policy, releases the installation, and boots with one", async () => {
    const appRoot = await app()
    const config = {
      sandbox: {
        provider: managedProviderFixture().provider,
        workspace: resolver,
        workspaceRead: "http" as const,
      },
    }
    await expect(createRuntimeFetchHandler({ appRoot, config })).rejects.toThrow(
      /sandbox.workspaceRead .* no thread-access policy/,
    )
    // The refused boot released the installation's owner lock: a second owner can open it.
    const handler = await createRuntimeFetchHandler({ appRoot, config, threadAccess: allowAll })
    handlers.push(handler)
  })

  it("boot refuses a provider whose managed workspaces cannot be read", async () => {
    const appRoot = await app()
    const config = {
      sandbox: {
        provider: managedProviderFixture({ reads: false }).provider,
        workspace: resolver,
        workspaceRead: "http" as const,
      },
    }
    await expect(
      createRuntimeFetchHandler({ appRoot, config, threadAccess: allowAll }),
    ).rejects.toThrow(/workspaceRead needs a provider whose managed workspaces can be read/)
  })
})

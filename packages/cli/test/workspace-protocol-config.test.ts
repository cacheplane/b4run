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
import { stagedWorkspaceSettings } from "../src/lib/runtime/workspace-protocol.ts"
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
  it("accepts a read deadline beside workspaceRead, within bounds", () => {
    expect(
      sandboxConfigShapeErrors({
        provider,
        workspace: resolver,
        workspaceRead: "http",
        workspaceReadTimeoutMs: 30_000,
      }),
    ).toEqual([])
  })
  for (const value of [0, 999, 30 * 60_000 + 1, 1.5, "60000", null])
    it(`refuses workspaceReadTimeoutMs: ${JSON.stringify(value)}`, () => {
      expect(
        sandboxConfigShapeErrors({
          provider,
          workspace: resolver,
          workspaceRead: "http",
          workspaceReadTimeoutMs: value,
        }).join("\n"),
      ).toMatch(/sandbox.workspaceReadTimeoutMs must be an integer/)
    })
  it("refuses a read deadline without workspaceRead", () => {
    expect(
      sandboxConfigShapeErrors({
        provider,
        workspace: resolver,
        workspaceReadTimeoutMs: 5_000,
      }).join("\n"),
    ).toMatch(/workspaceReadTimeoutMs applies only with sandbox.workspaceRead/)
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

describe("sandbox.stagedWorkspaces shape", () => {
  const provider = managedProviderFixture().provider
  const staticWorkspace = { source: { directory: "source", include: ["main.txt"] } }
  it("accepts true, false and bounded limits beside a resolver", () => {
    for (const value of [
      true,
      false,
      {},
      { maxUploadBytes: 1024 },
      { maxUploadBytes: 96 * 1024 * 1024 },
      { retentionMs: 60_000 },
      { retentionMs: 30 * 24 * 60 * 60 * 1000 },
      { maxStagedBytes: 16 * 1024 * 1024 * 1024 },
      { uploadTimeoutMs: 1_000 },
      { uploadTimeoutMs: 30 * 60_000 },
    ])
      expect(
        sandboxConfigShapeErrors({ provider, thread: resolver, stagedWorkspaces: value }),
      ).toEqual([])
    expect(
      sandboxConfigShapeErrors({ provider, workspace: resolver, stagedWorkspaces: true }),
    ).toEqual([])
    // Off is off: no resolver is needed to say so.
    expect(
      sandboxConfigShapeErrors({ provider, workspace: staticWorkspace, stagedWorkspaces: false }),
    ).toEqual([])
  })
  for (const [label, value, message] of [
    ["a string", "true", /stagedWorkspaces must be true, false or/],
    ["null", null, /stagedWorkspaces must be true, false or/],
    ["an array", [], /stagedWorkspaces must be true, false or/],
    ["an unknown limit", { maxUpload: 1 }, /stagedWorkspaces.maxUpload is not an option/],
    ["an upload over 96 MiB", { maxUploadBytes: 96 * 1024 * 1024 + 1 }, /maxUploadBytes must be/],
    ["a zero upload", { maxUploadBytes: 0 }, /maxUploadBytes must be/],
    ["a fractional upload", { maxUploadBytes: 1.5 }, /maxUploadBytes must be/],
    ["a retention under a minute", { retentionMs: 59_999 }, /retentionMs must be/],
    [
      "a retention over 30 days",
      { retentionMs: 30 * 24 * 60 * 60 * 1000 + 1 },
      /retentionMs must be/,
    ],
    ["a zero quota", { maxStagedBytes: 0 }, /maxStagedBytes must be/],
    [
      "a quota over 16 GiB",
      { maxStagedBytes: 16 * 1024 * 1024 * 1024 + 1 },
      /maxStagedBytes must be/,
    ],
    ["a string quota", { maxStagedBytes: "1" }, /maxStagedBytes must be/],
    ["an upload deadline under a second", { uploadTimeoutMs: 999 }, /uploadTimeoutMs must be/],
    [
      "an upload deadline over 30 minutes",
      { uploadTimeoutMs: 30 * 60_000 + 1 },
      /uploadTimeoutMs must be/,
    ],
  ] as const)
    it(`refuses ${label}`, () => {
      expect(
        sandboxConfigShapeErrors({ provider, thread: resolver, stagedWorkspaces: value }).join(
          "\n",
        ),
      ).toMatch(message)
    })
  it("refuses it without a resolver: a static workspace would ignore what was staged", () => {
    for (const block of [
      { provider, workspace: staticWorkspace, stagedWorkspaces: true },
      { provider, stagedWorkspaces: { retentionMs: 60_000 } },
    ])
      expect(sandboxConfigShapeErrors(block).join("\n")).toMatch(
        /stagedWorkspaces needs a resolver/,
      )
  })
  it("refuses a misspelling as an unknown key", () => {
    expect(
      sandboxConfigShapeErrors({ provider, thread: resolver, stagedWorkspace: true }).join("\n"),
    ).toMatch(/sandbox.stagedWorkspace is not a sandbox option/)
  })
})

describe("sandbox.stagedWorkspaces needs a thread-access policy", () => {
  it("b4 check refuses it without src/thread-access.ts, and accepts it with one", async () => {
    const provider = managedProviderFixture().provider
    const sandbox = { provider, thread: resolver, stagedWorkspaces: true }
    const without = await collectSandboxErrors({ sandbox } as never, await app())
    expect(without.errors.join("\n")).toMatch(/sandbox.stagedWorkspaces .* no thread-access policy/)
    const withPolicy = await collectSandboxErrors(
      { sandbox } as never,
      await app({ policyFile: true }),
    )
    expect(withPolicy.errors).toEqual([])
    // Off needs nothing.
    const off = await collectSandboxErrors(
      { sandbox: { provider, thread: resolver, stagedWorkspaces: false } } as never,
      await app(),
    )
    expect(off.errors).toEqual([])
  })

  it("b4 build refuses it without src/thread-access.ts", async () => {
    const appRoot = await app()
    seedB4Config(appRoot, {
      build: { targets: ["node"] },
      sandbox: {
        provider: managedProviderFixture().provider,
        thread: resolver,
        stagedWorkspaces: true,
      },
    } as never)
    await expect(
      runBuildCommand({ cwd: appRoot, clean: true }, { stdout: () => {}, stderr: () => {} }),
    ).rejects.toThrow(/sandbox.stagedWorkspaces .* no thread-access policy/)
  })

  it("boot refuses it without a policy, releases the installation, and boots with one", async () => {
    const appRoot = await app()
    const config = {
      sandbox: {
        provider: managedProviderFixture().provider,
        workspace: resolver,
        stagedWorkspaces: true,
      },
    }
    await expect(createRuntimeFetchHandler({ appRoot, config: config as never })).rejects.toThrow(
      /sandbox.stagedWorkspaces .* no thread-access policy/,
    )
    const handler = await createRuntimeFetchHandler({
      appRoot,
      config: config as never,
      threadAccess: allowAll,
    })
    handlers.push(handler)
  })

  it("names both options when both are on", async () => {
    const appRoot = await app()
    const config = {
      sandbox: {
        provider: managedProviderFixture().provider,
        thread: resolver,
        workspaceRead: "http",
        stagedWorkspaces: { retentionMs: 60_000 },
      },
    }
    await expect(createRuntimeFetchHandler({ appRoot, config: config as never })).rejects.toThrow(
      /sandbox.workspaceRead and sandbox.stagedWorkspaces serve .* no thread-access policy/,
    )
  })
})

describe("stagedWorkspaceSettings", () => {
  it("applies the defaults, the upload deadline included", () => {
    expect(stagedWorkspaceSettings(true)).toEqual({
      maxUploadBytes: 96 * 1024 * 1024,
      retentionMs: 24 * 60 * 60 * 1000,
      maxStagedBytes: 1024 * 1024 * 1024,
      uploadTimeoutMs: 120_000,
    })
    expect(stagedWorkspaceSettings({ uploadTimeoutMs: 5_000 })?.uploadTimeoutMs).toBe(5_000)
    expect(stagedWorkspaceSettings(false)).toBeUndefined()
  })
})

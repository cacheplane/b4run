import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fakeSandbox } from "@b4run/sandbox/testing"
import { describe, expect, it, test } from "vitest"
import { collectSandboxErrors } from "../src/lib/runtime/collect-sandbox-errors.js"

describe("collectSandboxErrors", () => {
  test("no sandbox config → no errors", async () => {
    const { errors } = await collectSandboxErrors({})
    expect(errors).toEqual([])
  })

  test("provider missing acquire → error", async () => {
    const { errors } = await collectSandboxErrors({
      sandbox: { provider: { name: "bad" } as never },
    })
    expect(errors.join("\n")).toMatch(/acquire/)
  })

  test("preflight failure → error with detail", async () => {
    const provider = {
      name: "p",
      acquire: async () => ({}) as never,
      release: async () => {},
      destroy: async () => {},
      preflight: async () => ({ ok: false, detail: "Docker daemon not reachable" }),
    }
    const { errors } = await collectSandboxErrors({ sandbox: { provider } })
    expect(errors.join("\n")).toMatch(/Docker daemon not reachable/)
  })

  test("preflight throw → error with message", async () => {
    const provider = {
      name: "p",
      acquire: async () => ({}) as never,
      release: async () => {},
      destroy: async () => {},
      preflight: async () => {
        throw new Error("boom")
      },
    }
    const { errors } = await collectSandboxErrors({ sandbox: { provider } })
    expect(errors.join("\n")).toMatch(/boom/)
  })

  test("healthy provider → no errors", async () => {
    const provider = {
      name: "p",
      acquire: async () => ({}) as never,
      release: async () => {},
      destroy: async () => {},
      preflight: async () => ({ ok: true }),
    }
    const { errors } = await collectSandboxErrors({ sandbox: { provider } })
    expect(errors).toEqual([])
  })

  test("folds preflight warnings without erroring", async () => {
    const provider = {
      name: "kubernetes",
      acquire: async () => ({}) as never,
      release: async () => {},
      destroy: async () => {},
      preflight: async () => ({ ok: true, warnings: ["cni unconfirmed"] }),
    }
    const { errors, warnings } = await collectSandboxErrors({ sandbox: { provider } })
    expect(errors).toHaveLength(0)
    expect(warnings.join(" ")).toContain("cni unconfirmed")
  })
})

describe("collectSandboxErrors: security shape", () => {
  const ok = {
    name: "p",
    acquire: async () => ({}) as never,
    release: async () => {},
    destroy: async () => {},
    preflight: async () => ({ ok: true }),
  }

  test("pidsLimit must be a positive integer", async () => {
    const { errors } = await collectSandboxErrors({
      sandbox: { provider: ok, security: { pidsLimit: 0 } },
    })
    expect(errors.join("\n")).toMatch(/pidsLimit/)
  })

  test("runAsNonRoot object needs numeric uid/gid", async () => {
    const { errors } = await collectSandboxErrors({
      sandbox: { provider: ok, security: { runAsNonRoot: { uid: -1, gid: 0 } as never } },
    })
    expect(errors.join("\n")).toMatch(/uid|gid/)
  })

  test("runAsNonRoot: null → error (must be boolean or object, not null)", async () => {
    const { errors } = await collectSandboxErrors({
      sandbox: { provider: ok, security: { runAsNonRoot: null as never } },
    })
    expect(errors.join("\n")).toMatch(/not null/)
  })

  test("valid security → no errors", async () => {
    const { errors } = await collectSandboxErrors({
      sandbox: {
        provider: ok,
        security: { pidsLimit: 256, runAsNonRoot: { uid: 1000, gid: 1000 } },
      },
    })
    expect(errors).toEqual([])
  })
})

describe("collectSandboxErrors: resolver workspace", () => {
  it("accepts a resolver without capturing anything at check time", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "b4-sbx-check-"))
    await mkdir(join(appRoot, "workspace"), { recursive: true })
    const provider = { ...fakeSandbox(), workspaces: {} as never }
    const result = await collectSandboxErrors(
      {
        sandbox: {
          provider,
          workspace: async () => ({ source: { directory: "missing", include: ["x"] } }),
        },
      },
      appRoot,
    )
    expect(result.errors).toEqual([])
  })

  it("still rejects a resolver on a provider without managed workspaces", async () => {
    const result = await collectSandboxErrors({
      sandbox: {
        provider: fakeSandbox(),
        workspace: async () => ({ source: { directory: ".", include: [] } }),
      },
    })
    expect(result.errors).toContain("Sandbox provider does not support managed workspaces")
  })
})

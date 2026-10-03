import { describe, expect, expectTypeOf, test } from "vitest"
import type {
  OpenWorkspaceReaderInput,
  ReadOnlyFilesystemBackend,
  SandboxConfig,
  SandboxHandle,
  SandboxPolicy,
  SandboxProvider,
  SandboxSecurityPolicy,
  SandboxWorkspaceReader,
  WorkspaceReadSource,
} from "../src/sandbox-types.ts"
import type { ExecBackend, FilesystemBackend } from "../src/types.ts"

test("resources carries an optional diskGb (PVC size)", () => {
  const p: SandboxPolicy = { network: { mode: "deny" }, resources: { diskGb: 2 } }
  expectTypeOf(p.resources?.diskGb).toEqualTypeOf<number | undefined>()
})

test("preflight may return warnings", async () => {
  const provider = {
    name: "x",
    acquire: async () => ({}) as never,
    release: async () => {},
    destroy: async () => {},
    preflight: async (): ReturnType<NonNullable<SandboxProvider["preflight"]>> => ({
      ok: true,
      warnings: ["cni not enforced"],
    }),
  } satisfies Partial<SandboxProvider> & Pick<SandboxProvider, "preflight">
  const r = await provider.preflight()
  expectTypeOf(r.warnings).toEqualTypeOf<readonly string[] | undefined>()
})

describe("sandbox contract types", () => {
  test("a handle exposes workspace backends + an in-sandbox root", () => {
    const fs = {} as FilesystemBackend
    const exec = {} as ExecBackend
    const handle: SandboxHandle = {
      threadId: "t1",
      filesystem: fs,
      exec,
      workspaceRoot: "/workspace",
    }
    expect(handle.workspaceRoot).toBe("/workspace")
  })

  test("policy network is a discriminated union (allow|deny)", () => {
    const allow: SandboxPolicy["network"] = { mode: "allow", denylist: ["1.2.3.4"] }
    const deny: SandboxPolicy["network"] = { mode: "deny", allowlist: ["registry.npmjs.org"] }
    expect(allow.mode).toBe("allow")
    expect(deny.mode).toBe("deny")
  })

  test("a provider implements acquire/release/destroy", async () => {
    const provider: SandboxProvider = {
      name: "noop",
      acquire: async ({ threadId }) => ({
        threadId,
        filesystem: {} as FilesystemBackend,
        exec: {} as ExecBackend,
        workspaceRoot: "/workspace",
      }),
      release: async () => {},
      destroy: async () => {},
    }
    const h = await provider.acquire({
      threadId: "t1",
      policy: { network: { mode: "allow" } },
      signal: new AbortController().signal,
    })
    expect(h.threadId).toBe("t1")
    const cfg: SandboxConfig = { provider }
    expect(cfg.provider.name).toBe("noop")
  })
})

describe("sandbox security intent", () => {
  test("security is optional on the policy and config, with all-optional fields", () => {
    const sec: SandboxSecurityPolicy = {
      dropAllCapabilities: true,
      noNewPrivileges: true,
      readOnlyRootFilesystem: false,
      runAsNonRoot: { uid: 1000, gid: 1000 },
      pidsLimit: 256,
    }
    const policy: SandboxPolicy = { network: { mode: "deny" }, security: sec }
    expect(policy.security?.pidsLimit).toBe(256)
    const off: SandboxPolicy = { network: { mode: "deny" }, security: { runAsNonRoot: false } }
    expect(off.security?.runAsNonRoot).toBe(false)
    const cfg: SandboxConfig = { provider: {} as never, security: sec }
    expect(cfg.security).toBe(sec)
  })
})

describe("workspace read capability", () => {
  test("openWorkspaceReader is optional, so an existing provider still satisfies the contract", () => {
    const withoutCapability = {
      name: "no-reads",
      acquire: async () => ({}) as never,
      release: async () => {},
      destroy: async () => {},
    } satisfies SandboxProvider
    expect(withoutCapability).not.toHaveProperty("openWorkspaceReader")
    expectTypeOf<SandboxProvider["openWorkspaceReader"]>().toEqualTypeOf<
      ((input: OpenWorkspaceReaderInput) => Promise<SandboxWorkspaceReader>) | undefined
    >()
  })

  test("a reader carries no exec backend and no write members", () => {
    expectTypeOf<SandboxWorkspaceReader>().not.toHaveProperty("exec")
    expectTypeOf<ReadOnlyFilesystemBackend>().not.toHaveProperty("writeFile")
    expectTypeOf<ReadOnlyFilesystemBackend>().not.toHaveProperty("mkdir")
    expectTypeOf<ReadOnlyFilesystemBackend>().not.toHaveProperty("removeFile")
    // Inspection metadata is REQUIRED here, unlike on FilesystemBackend.
    expectTypeOf<ReadOnlyFilesystemBackend["lstat"]>().not.toBeNullable()
    expectTypeOf<ReadOnlyFilesystemBackend["readBinaryFile"]>().not.toBeNullable()
    expectTypeOf<ReadOnlyFilesystemBackend["statFile"]>().not.toBeNullable()
  })

  test("both a full handle and an exec-less reader are workspace read sources", () => {
    const handle: SandboxHandle = {
      threadId: "t",
      filesystem: {} as FilesystemBackend,
      exec: {} as ExecBackend,
      workspaceRoot: "/workspace",
    }
    const fromHandle: WorkspaceReadSource = handle
    const reader = {
      threadId: "t",
      filesystem: {} as ReadOnlyFilesystemBackend,
      workspaceRoot: "/workspace",
      close: async () => {},
    } satisfies SandboxWorkspaceReader
    const fromReader: WorkspaceReadSource = reader
    expect(fromHandle.workspaceRoot).toBe("/workspace")
    expect(fromReader.workspaceRoot).toBe("/workspace")
  })
})

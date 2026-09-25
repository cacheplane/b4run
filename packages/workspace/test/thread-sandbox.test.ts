import { describe, expect, expectTypeOf, it } from "vitest"
import type {
  ManagedWorkspaceProvider,
  SandboxConfig,
  ThreadSandbox,
  ThreadSandboxPolicy,
  ThreadSandboxResolver,
  WorkspaceEnvironment,
  WorkspaceResolverInput,
} from "../src/index.ts"
import {
  MAX_THREAD_SANDBOX_RECORD_BYTES,
  threadSandboxRecordBytes,
  verifyImageReference,
  verifyThreadSandbox,
  verifyThreadSandboxPolicy,
  verifyThreadSandboxRecord,
} from "../src/node.ts"

describe("thread sandbox types", () => {
  it("SandboxConfig.thread is a resolver from the thread to its whole sandbox", () => {
    expectTypeOf<SandboxConfig["thread"]>().toEqualTypeOf<ThreadSandboxResolver | undefined>()
    expectTypeOf<Parameters<ThreadSandboxResolver>[0]>().toEqualTypeOf<WorkspaceResolverInput>()
    expectTypeOf<ReturnType<ThreadSandboxResolver>>().toEqualTypeOf<Promise<ThreadSandbox>>()
    expectTypeOf<ThreadSandbox["policy"]>().toEqualTypeOf<ThreadSandboxPolicy | undefined>()
    // `security` is the app's, never a thread's.
    expectTypeOf<keyof ThreadSandboxPolicy>().toEqualTypeOf<"network" | "env" | "resources">()
  })
  it("resolveImageEnvironment is an optional, presence-probed capability", () => {
    expectTypeOf<NonNullable<ManagedWorkspaceProvider["resolveImageEnvironment"]>>().toEqualTypeOf<
      (image: string, signal: AbortSignal) => Promise<WorkspaceEnvironment>
    >()
    const provider = {} as ManagedWorkspaceProvider
    expect(provider.resolveImageEnvironment).toBeUndefined()
  })
})

const workspace = { source: { directory: "src", include: ["a.ts"] } }

describe("verifyThreadSandbox", () => {
  it("accepts a workspace, an image and a policy, and freezes the result", () => {
    const verified = verifyThreadSandbox({
      workspace,
      environment: { image: "b4-factory-devkit:6a59e00aed46-0123456789ab" },
      policy: {
        network: { mode: "deny" },
        env: { B: "2", A: "1" },
        resources: { memoryMb: 2048, cpus: 1.5, timeoutMs: 60_000 },
      },
    })
    expect(verified.workspace).toBe(workspace)
    expect(verified.environment).toEqual({ image: "b4-factory-devkit:6a59e00aed46-0123456789ab" })
    expect(Object.keys(verified.policy?.env ?? {})).toEqual(["A", "B"])
    expect(Object.isFrozen(verified)).toBe(true)
    expect(Object.isFrozen(verified.policy)).toBe(true)
  })
  it("accepts a workspace alone", () => {
    expect(verifyThreadSandbox({ workspace })).toEqual({ workspace })
  })
  it.each([
    [{}, /must name its workspace/],
    [{ workspace, permissions: { allow: {} } }, /unsupported key permissions/],
    [{ workspace, polcy: {} }, /unsupported key polcy/],
    [{ workspace, environment: { image: "x", pull: true } }, /unsupported key pull/],
    [{ workspace, policy: { security: { runAsNonRoot: false } } }, /unsupported key security/],
    [null, /must be an object/],
  ])("refuses %j", (value, message) => {
    expect(() => verifyThreadSandbox(value)).toThrow(message)
  })
})

describe("verifyThreadSandboxPolicy", () => {
  it.each([
    [{ network: { mode: "deny", allowlist: ["10.0.0.0/8"] } }, /not enforced/],
    [{ network: { mode: "allow", denylist: ["169.254.169.254"] } }, /not enforced/],
    [{ network: { mode: "open" } }, /network.mode/],
    [{ env: { "1BAD": "x" } }, /not a valid variable name/],
    [{ env: { OK: "a\u0000b" } }, /without NUL/],
    [{ env: { OK: 1 } }, /without NUL/],
    [{ resources: { memoryMb: 0 } }, /memoryMb must be a positive integer/],
    [{ resources: { cpus: Number.NaN } }, /cpus must be a positive number/],
    [{ resources: { timeoutMs: 1.5 } }, /timeoutMs must be a positive integer/],
    [{ resources: { gpus: 1 } }, /unsupported key gpus/],
    [{ resources: { diskGb: 4 } }, /diskGb is not enforced/],
  ])("refuses %j", (value, message) => {
    expect(() => verifyThreadSandboxPolicy(value)).toThrow(message)
  })
})

describe("verifyImageReference", () => {
  it.each([
    "node:24-slim",
    `ghcr.io/org/app@sha256:${"a".repeat(64)}`,
    "b4-factory-cli:0123456789ab-ba9876543210",
  ])("accepts %s", (reference) => expect(verifyImageReference(reference)).toBe(reference))
  it.each(["", "--privileged", "-x", "a b", "tag\n", "x".repeat(513), 42])(
    "refuses %j",
    (reference) => {
      expect(() => verifyImageReference(reference)).toThrow(/image reference/)
    },
  )
})

describe("verifyThreadSandboxRecord", () => {
  it("round-trips to one canonical text whatever the input's key order", () => {
    const a = verifyThreadSandboxRecord({
      policy: { resources: { memoryMb: 1 }, env: { B: "2", A: "1" } },
      image: "x:1",
      version: 1,
    })
    const b = verifyThreadSandboxRecord({
      version: 1,
      image: "x:1",
      policy: { env: { A: "1", B: "2" }, resources: { memoryMb: 1 } },
    })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(JSON.stringify(a)).toBe(
      '{"version":1,"image":"x:1","policy":{"env":{"A":"1","B":"2"},"resources":{"memoryMb":1}}}',
    )
  })
  it("refuses another version and unknown keys", () => {
    expect(() => verifyThreadSandboxRecord({ version: 2 })).toThrow(/version/)
    expect(() => verifyThreadSandboxRecord({ version: 1, extra: 1 })).toThrow(
      /unsupported key extra/,
    )
  })
})

describe("own properties only", () => {
  it("refuses an env variable named __proto__ rather than dropping it", () => {
    expect(() =>
      verifyThreadSandboxPolicy(JSON.parse('{"env":{"__proto__":"x","A":"1"}}')),
    ).toThrow(/__proto__.*not a valid variable name/)
  })
  it("refuses an accessor, which could answer the check and the copy differently", () => {
    let reads = 0
    const network = {
      get mode() {
        reads += 1
        return reads === 1 ? "deny" : "allow"
      },
    }
    expect(() => verifyThreadSandboxPolicy({ network })).toThrow(/must be a data property/)
  })
  it("reads nothing from a polluted Object.prototype", () => {
    const proto = Object.prototype as Record<string, unknown>
    try {
      proto.image = "evil:latest"
      proto.policy = { network: { mode: "allow" } }
      proto.environment = { image: "evil:latest" }
      proto.mode = "allow"
      proto.memoryMb = 1
      expect(verifyThreadSandboxRecord({ version: 1 })).toEqual({ version: 1 })
      expect(JSON.stringify(verifyThreadSandbox({ workspace }))).toBe(JSON.stringify({ workspace }))
      expect(() => verifyThreadSandbox({ workspace, environment: {} })).toThrow(/image reference/)
      expect(() => verifyThreadSandboxPolicy({ network: {} })).toThrow(/network.mode/)
      expect(JSON.stringify(verifyThreadSandboxPolicy({ resources: {} }))).toBe('{"resources":{}}')
    } finally {
      for (const key of ["image", "policy", "environment", "mode", "memoryMb"]) delete proto[key]
    }
  })
})

describe("record size", () => {
  it("measures a record whose env passes every per-field bound yet exceeds the cap", () => {
    const env = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`V${i}`, "x".repeat(30_000)]),
    )
    const record = verifyThreadSandboxRecord({ version: 1, policy: { env } })
    expect(threadSandboxRecordBytes(record)).toBeGreaterThan(MAX_THREAD_SANDBOX_RECORD_BYTES)
  })
})

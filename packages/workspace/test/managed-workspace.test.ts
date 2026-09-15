import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  captureWorkspaceDefinition,
  createWorkspaceIntent,
  verifyCapturedWorkspaceDefinition,
  verifyCreationStatus,
  verifyReadyWorkspace,
  verifyWorkspaceIntent,
} from "../src/managed-workspace-node.ts"
import { createSourceBundle } from "../src/source-bundle.ts"

const source = createSourceBundle([
  { path: "index.ts", bytes: Buffer.from("hello"), executable: false },
])
const definition = {
  version: 1 as const,
  source,
  environmentLinks: [{ path: "node_modules", target: "/opt/deps/node_modules" }],
  baseline: "git" as const,
}
const environment = {
  binding: { provider: "test", scope: "project", account: "local" },
  identity: "image-sha256:abc",
}
const input = {
  operationId: "11111111-1111-4111-8111-111111111111",
  installationId: "22222222-2222-4222-8222-222222222222",
  threadId: "a thread",
  definition,
  environment,
}
const ready = () => {
  const intent = createWorkspaceIntent(input)
  return {
    intent,
    workspace: {
      reference: {
        version: 1,
        operationId: intent.operationId,
        installationId: intent.installationId,
        threadId: intent.threadId,
        intentDigest: intent.digest,
        resource: { id: "resource-1" },
      },
      provenance: {
        sourceDigest: source.digest,
        environment,
        baselineCommit: "a".repeat(40),
        retention: { filesystem: "until-destroy", memory: "discarded" },
      },
    },
  }
}

describe("managed workspace contracts", () => {
  it("snapshots nested input and binds environment independently of source", () => {
    const value = createWorkspaceIntent(input)
    expect(verifyWorkspaceIntent(JSON.parse(JSON.stringify(value)))).toEqual(value)
    expect(Object.isFrozen(value.environment.binding)).toBe(true)
    expect(Object.isFrozen(value.environmentLinks[0])).toBe(true)
    expect(Object.isFrozen(environment)).toBe(false)
    const changed = createWorkspaceIntent({
      ...input,
      environment: { ...environment, identity: "different" },
    })
    expect(changed.digest).not.toBe(value.digest)
    expect(changed.sourceDigest).toBe(value.sourceDigest)
    expect(() => verifyWorkspaceIntent({ ...value, threadId: "other" })).toThrow()
  })
  it("rejects malformed definitions, accessors, links and path conflicts", () => {
    for (const link of [
      { path: "INDEX.ts/x", target: "/opt/deps" },
      { path: ".GIT/x", target: "/opt/deps" },
      { path: "../deps", target: "/opt/deps" },
      { path: "deps", target: "/opt/../deps" },
      { path: "deps", target: "relative" },
      { path: "deps", target: "/opt\\deps" },
    ])
      expect(() =>
        verifyCapturedWorkspaceDefinition({ ...definition, environmentLinks: [link] }),
      ).toThrow()
    expect(() => verifyCapturedWorkspaceDefinition({ ...definition, extra: true })).toThrow()
    expect(() =>
      verifyCapturedWorkspaceDefinition({
        ...definition,
        get baseline() {
          throw new Error("invoked")
        },
      }),
    ).toThrow(/data/)
    expect(() =>
      verifyCapturedWorkspaceDefinition({
        ...definition,
        environmentLinks: [
          { path: "z", target: "/z" },
          { path: "a", target: "/a" },
        ],
      }),
    ).toThrow()
    expect(() => createWorkspaceIntent({ ...input, operationId: "bad" })).toThrow()
    expect(() =>
      createWorkspaceIntent({
        ...input,
        environment: { ...environment, binding: { ...environment.binding, account: "" } },
      }),
    ).toThrow()
  })
  it("verifies ready ownership, provenance and retention", () => {
    const { intent, workspace } = ready()
    expect(verifyReadyWorkspace(workspace, intent)).toEqual(workspace)
    expect(() =>
      verifyReadyWorkspace(
        { ...workspace, reference: { ...workspace.reference, threadId: "wrong" } },
        intent,
      ),
    ).toThrow()
    expect(() =>
      verifyReadyWorkspace(
        { ...workspace, provenance: { ...workspace.provenance, sourceDigest: "b".repeat(64) } },
        intent,
      ),
    ).toThrow()
    expect(() =>
      verifyReadyWorkspace(
        { ...workspace, provenance: { ...workspace.provenance, baselineCommit: undefined } },
        intent,
      ),
    ).toThrow()
    expect(() =>
      verifyReadyWorkspace(
        {
          ...workspace,
          provenance: {
            ...workspace.provenance,
            retention: { filesystem: "expires", memory: "discarded" },
          },
        },
        intent,
      ),
    ).toThrow()
    expect(() =>
      verifyReadyWorkspace(
        {
          ...workspace,
          provenance: {
            ...workspace.provenance,
            retention: { filesystem: "expires", memory: "discarded", expiresAt: "tomorrow" },
          },
        },
        intent,
      ),
    ).toThrow()
  })
  it("rejects malformed resources and accepts finite expiration and no baseline", () => {
    const { intent, workspace } = ready()
    for (const resource of [
      { id: undefined },
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`key${i}`, "id"])),
      { id: "x".repeat(16385) },
      new Date(),
    ]) {
      expect(() =>
        verifyReadyWorkspace(
          { ...workspace, reference: { ...workspace.reference, resource } },
          intent,
        ),
      ).toThrow()
    }
    const expires = {
      ...workspace,
      provenance: {
        ...workspace.provenance,
        retention: {
          filesystem: "expires",
          memory: "retained",
          expiresAt: "2030-01-01T00:00:00.000Z",
        },
      },
    }
    expect(verifyReadyWorkspace(expires, intent).provenance.retention.expiresAt).toBe(
      "2030-01-01T00:00:00.000Z",
    )
    const without = createWorkspaceIntent({
      ...input,
      definition: { version: 1, source, environmentLinks: [] },
    })
    const noBaseline = {
      ...workspace,
      reference: { ...workspace.reference, intentDigest: without.digest },
      provenance: {
        sourceDigest: source.digest,
        environment,
        retention: { filesystem: "until-destroy", memory: "discarded" },
      },
    }
    expect(verifyReadyWorkspace(noBaseline, without).provenance.baselineCommit).toBeUndefined()
    expect(() =>
      verifyReadyWorkspace(
        { ...noBaseline, provenance: { ...noBaseline.provenance, baselineCommit: "a".repeat(40) } },
        without,
      ),
    ).toThrow()
  })
  it("rejects source/link directory casing conflicts and accepts gitignore", () => {
    const bundled = createSourceBundle([
      { path: "Src/index.ts", bytes: Buffer.from("source"), executable: false },
    ])
    expect(() =>
      verifyCapturedWorkspaceDefinition({
        ...definition,
        source: bundled,
        environmentLinks: [{ path: "src/deps", target: "/deps" }],
      }),
    ).toThrow()
    const ignored = createSourceBundle([
      { path: ".gitignore", bytes: Buffer.from("node_modules"), executable: false },
    ])
    expect(verifyCapturedWorkspaceDefinition({ ...definition, source: ignored }).source).toEqual(
      ignored,
    )
    const modified = JSON.parse(JSON.stringify(definition))
    const snapshot = verifyCapturedWorkspaceDefinition(modified)
    modified.source.files[0].base64 = ""
    modified.environmentLinks[0].target = "/other"
    expect(snapshot.source.files[0]?.base64).toBe(source.files[0]?.base64)
    expect(snapshot.environmentLinks[0]?.target).toBe("/opt/deps/node_modules")
  })
  it("captures source and canonicalizes links, validates options", async () => {
    const root = await mkdtemp(join(tmpdir(), "managed-workspace-"))
    try {
      await writeFile(join(root, "index.ts"), "hello")
      const captured = await captureWorkspaceDefinition(root, {
        source: { directory: ".", include: ["index.ts"] },
        environmentLinks: [
          { path: "z", target: "/z" },
          { path: "a", target: "/a" },
        ],
      })
      expect(captured.source).toEqual(source)
      expect(captured.environmentLinks.map((x) => x.path)).toEqual(["a", "z"])
      expect(Object.isFrozen(captured.source.files)).toBe(true)
      await expect(
        captureWorkspaceDefinition(
          root,
          { source: { directory: ".", include: ["index.ts"] } },
          { signal: "bad" as unknown as AbortSignal },
        ),
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("creation status boundary", () => {
  it("snapshots every valid status and verifies ready identity", () => {
    const { intent, workspace } = ready()
    for (const value of [
      { status: "absent" },
      { status: "pending" },
      { status: "unknown", reason: "pending remote lookup" },
      {
        status: "failed",
        reason: { code: "retryable", message: "quota unavailable" },
        resourcesRemain: false,
      },
      { status: "ready", workspace },
    ]) {
      const result = verifyCreationStatus(value, intent)
      expect(result).toEqual(value)
      expect(Object.isFrozen(result)).toBe(true)
      if (result.status === "failed") expect(Object.isFrozen(result.reason)).toBe(true)
    }
    expect(() =>
      verifyCreationStatus(
        {
          status: "ready",
          workspace: { ...workspace, reference: { ...workspace.reference, threadId: "wrong" } },
        },
        intent,
      ),
    ).toThrow()
  })
  it("rejects malformed status, reason, resource flags, and accessors", () => {
    const intent = createWorkspaceIntent(input)
    for (const value of [
      { status: "absent", extra: true },
      { status: "pending", reason: "x" },
      { status: "unknown", reason: "" },
      { status: "ready" },
      { status: "failed", reason: "string", resourcesRemain: true },
      { status: "failed", reason: { code: "arbitrary", message: "x" }, resourcesRemain: true },
      { status: "failed", reason: { code: "retryable", message: "x" }, resourcesRemain: "yes" },
      {
        status: "failed",
        reason: { code: "retryable", message: "x", extra: true },
        resourcesRemain: false,
      },
      {
        get status() {
          throw new Error("getter executed")
        },
      },
    ]) {
      expect(() => verifyCreationStatus(value, intent)).toThrow()
    }
  })
})

import { expect, expectTypeOf, it } from "vitest"
import type {
  CapturedWorkspaceDefinition,
  SandboxConfig,
  WorkspaceDefinition,
  WorkspaceResolver,
  WorkspaceResolverInput,
} from "../src/index.ts"

it("SandboxConfig.workspace is a definition, a resolver, or absent", async () => {
  expectTypeOf<SandboxConfig["workspace"]>().toEqualTypeOf<
    WorkspaceDefinition | WorkspaceResolver | undefined
  >()
  const definition: WorkspaceDefinition = { source: { directory: ".", include: ["a"] } }
  const resolver: WorkspaceResolver = async (thread: WorkspaceResolverInput) => {
    expectTypeOf(thread.metadata).toEqualTypeOf<Readonly<Record<string, unknown>>>()
    expectTypeOf(thread.signal).toEqualTypeOf<AbortSignal>()
    return thread.metadata.kind === "captured"
      ? ({
          version: 1,
          source: { version: 1, digest: "0".repeat(64), files: [] },
          environmentLinks: [],
        } as CapturedWorkspaceDefinition)
      : definition
  }
  const withDefinition: Pick<SandboxConfig, "workspace"> = { workspace: definition }
  const withResolver: Pick<SandboxConfig, "workspace"> = { workspace: resolver }
  // @ts-expect-error a resolver must be a function or a definition, never a bare value
  const rejected: Pick<SandboxConfig, "workspace"> = { workspace: 42 }
  expect(rejected.workspace).toBe(42)
  expect(withDefinition.workspace).toBe(definition)
  const resolved = await resolver({
    threadId: "t1",
    metadata: {},
    signal: new AbortController().signal,
  })
  expect(resolved).toBe(definition)
  expect(typeof withResolver.workspace).toBe("function")
})

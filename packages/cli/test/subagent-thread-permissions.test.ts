import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { PermissionsStore, ThreadPermissionGrants } from "@b4run/permissions"
import { AIMessage } from "@langchain/core/messages"
import { Annotation, END, START, StateGraph } from "@langchain/langgraph"
import { ToolNode } from "@langchain/langgraph/prebuilt"
import { afterEach, expect, it, vi } from "vitest"
import { materializeResolvedRouteGraph } from "../src/lib/runtime/execute-route.ts"

const tempDirs: string[] = []

// Every thread-scoped store the runtime builds, in order: the parent's preparation first,
// then one per subagent dispatch.
const built = vi.hoisted(() => [] as PermissionsStore[])
// The base each of those stores was built over.
const bases = vi.hoisted(() => [] as PermissionsStore[])
vi.mock("@b4run/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@b4run/permissions")>()
  return {
    ...actual,
    createThreadPermissionsStore: (
      options: Parameters<typeof actual.createThreadPermissionsStore>[0],
    ) => {
      const store = actual.createThreadPermissionsStore(options)
      built.push(store)
      bases.push(options.base)
      return store
    },
  }
})

afterEach(async () => {
  built.splice(0)
  bases.splice(0)
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
  vi.doUnmock("langchain")
  vi.doUnmock("@langchain/openai")
})

it("gates a subagent with its parent thread's permissions and records its Always grant there", async () => {
  const previousMode = process.env.B4_PERMISSIONS_MODE
  delete process.env.B4_PERMISSIONS_MODE // the app's default mode, interactive
  try {
    const appRoot = await fixtureApp()
    // The parent thread's record: one allow-list and one grant store, keyed by the SANDBOX key.
    const parentGrants: Record<string, string[]> = {}
    const grants: ThreadPermissionGrants = {
      list: () => parentGrants,
      add(tool, pattern) {
        const list = parentGrants[tool] ?? []
        list.push(pattern)
        parentGrants[tool] = list
      },
    }
    const threadPermissions = vi.fn((_key: string) => ({
      permissions: { allow: { bash: ["npm test"] } },
      grants,
    }))
    const getForThread = vi.fn(async () => ({
      exec: { execute: vi.fn() },
      filesystem: {
        list: vi.fn(),
        mkdir: vi.fn(),
        read: vi.fn(),
        remove: vi.fn(),
        stat: vi.fn(),
        write: vi.fn(),
      },
      workspaceRoot: "/workspace",
    }))
    const createAgent = vi.fn((_options: unknown) => ({
      invoke: vi.fn(async () => ({ messages: [new AIMessage("Child complete.")] })),
    }))
    vi.doMock("langchain", async (importOriginal) => ({
      ...(await importOriginal<typeof import("langchain")>()),
      createAgent,
    }))
    vi.doMock("@langchain/openai", () => ({ ChatOpenAI: class {} }))

    await materializeResolvedRouteGraph({
      appRoot,
      routeFile: `${appRoot}/src/app/parent/index.ts`,
      routeId: "/parent",
      routePath: "src/app/parent/index.ts",
      sandboxManager: { getForThread, getWorkspace: () => undefined, threadPermissions } as never,
      sandboxThreadId: "sandbox-root",
    })
    await invokeTask(findTaskTool(createAgent.mock.calls[0]?.[0]), "child-call")

    // The parent's preparation and the child's both asked for the PARENT's record.
    expect(threadPermissions.mock.calls.map(([key]) => key)).toEqual([
      "sandbox-root",
      "sandbox-root",
    ])
    expect(built).toHaveLength(2)
    const [parent, child] = built as [PermissionsStore, PermissionsStore]
    // Not stacked: the child's store is built over the same app store as the parent's,
    // never over the parent's thread-scoped store.
    expect(bases).toHaveLength(2)
    expect(bases[1]).toBe(bases[0])
    expect(bases[1]).not.toBe(parent)
    expect(child.mode).toBe("interactive")
    expect(child.match("bash", "npm test")).toBe("allow")
    expect(child.match("bash", "make all")).toBe("unknown")
    // The child's Always lands in the parent thread's record, and the parent's next
    // preparation (a load of the same record) honours it.
    await child.addAllow("bash", "make")
    expect(parentGrants).toEqual({ bash: ["make"] })
    await parent.load()
    expect(parent.match("bash", "make all")).toBe("allow")
  } finally {
    if (previousMode === undefined) delete process.env.B4_PERMISSIONS_MODE
    else process.env.B4_PERMISSIONS_MODE = previousMode
  }
})

async function fixtureApp(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "b4-subagent-sandbox-"))
  tempDirs.push(appRoot)
  const files = {
    "package.json": '{"type":"module"}\n',
    "b4.config.ts": "export default {}\n",
    "src/app/parent/index.ts": `import { agent } from "@b4run/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "Parent." })\n`,
    "src/app/parent/subagents/researcher/index.ts": `import { agent } from "@b4run/sdk"\nexport default agent({ model: "gpt-5-mini", systemPrompt: "Child." })\n`,
  }
  await Promise.all(
    Object.entries(files).map(async ([relativePath, source]) => {
      const filePath = join(appRoot, relativePath)
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, source, "utf8")
    }),
  )
  return appRoot
}

function findTaskTool(options: unknown): { readonly name: string } {
  const tools = (options as { readonly tools?: readonly { readonly name: string }[] } | undefined)
    ?.tools
  const task = tools?.find(({ name }) => name === "task")
  if (!task) throw new Error("Expected materialized root task tool")
  return task
}

async function invokeTask(task: { readonly name: string }, callId: string): Promise<void> {
  const graph = new StateGraph(Annotation.Root({ messages: Annotation<unknown[]>() }))
    .addNode("tools", new ToolNode([task as never]))
    .addEdge(START, "tools")
    .addEdge("tools", END)
    .compile()
  await graph.invoke(
    {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            {
              args: { input: "Inspect", subagent: "researcher" },
              id: callId,
              name: "task",
              type: "tool_call",
            },
          ],
        }),
      ],
    },
    { configurable: { thread_id: "sandbox-thread" } },
  )
}

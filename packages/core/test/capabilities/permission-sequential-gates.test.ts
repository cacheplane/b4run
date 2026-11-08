import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPermissionsStore } from "@b4run/permissions/node"
import { Annotation, Command, END, MemorySaver, START, StateGraph } from "@langchain/langgraph"
import { expect, it } from "vitest"
import { __resetApprovalGrantsForTests } from "../../src/capabilities/approval-grants.ts"
import { gatePathOp, wrapToolWithApproval } from "../../src/capabilities/permission-gate.ts"

it.each([false, true])(
  "records actual common tool/resource gate restart semantics (effect prefix %s)",
  async (effectPrefix) => {
    const root = mkdtempSync(join(tmpdir(), "b4-sequential-core-gates-"))
    __resetApprovalGrantsForTests()
    let prefixes = 0,
      effects = 0,
      bodies = 0
    try {
      const rules = createPermissionsStore({
        appRoot: root,
        config: undefined,
        mode: "interactive",
      })
      const tool = wrapToolWithApproval(
        {
          name: "writeOutside",
          async run(_input: unknown, _context: unknown) {
            bodies++
            if (effectPrefix) prefixes++
            const allowed = await gatePathOp(
              rules,
              "writeFile",
              "/outside/result.txt",
              "/workspace",
            )
            if (allowed.allowed) effects++
            return "done"
          },
        },
        rules,
      )
      const graph = new StateGraph(Annotation.Root({ result: Annotation<unknown> }))
        .addNode("work", async () => ({ result: await tool.run({}, {}) }))
        .addEdge(START, "work")
        .addEdge("work", END)
        .compile({ checkpointer: new MemorySaver() })
      const config = {
        configurable: { thread_id: crypto.randomUUID() },
        durability: "sync" as const,
      }
      await graph.invoke({}, config)
      const first = await graph.getState(config)
      expect(first.tasks[0]?.interrupts[0]?.value).toMatchObject({ kind: "tool" })
      await graph.invoke(new Command({ resume: "once" }), config)
      const second = await graph.getState(config)
      expect(second.tasks[0]?.interrupts[0]?.value).toMatchObject({ kind: "path" })
      expect(second.config.configurable?.checkpoint_id).toBe(
        first.config.configurable?.checkpoint_id,
      )
      expect(second.tasks[0]?.id).toBe(first.tasks[0]?.id)
      expect(second.tasks[0]?.interrupts[0]?.id).toBe(first.tasks[0]?.interrupts[0]?.id)
      expect(prefixes).toBe(effectPrefix ? 1 : 0)
      expect(effects).toBe(0)
      await graph.invoke(new Command({ resume: "once" }), config)
      expect(bodies).toBe(2)
      expect(prefixes).toBe(effectPrefix ? 2 : 0)
      expect(effects).toBe(1)
    } finally {
      __resetApprovalGrantsForTests()
      rmSync(root, { recursive: true, force: true })
    }
  },
  30_000,
)

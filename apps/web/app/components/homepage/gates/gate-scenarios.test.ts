import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  createWorkspaceMarker,
  gateToolOp,
  resolveGuardedSubagent,
  resolveSubagentRegistry,
  resolveToolScope,
} from "@b4run/core"
import { discoverRoutes, extractToolSchemasForRoute, nodeMarkerFs } from "@b4run/core/node"
import { createPermissionsStore } from "@b4run/permissions/node"
import { dockerSandbox } from "@b4run/sandbox"
import {
  Annotation,
  Command,
  END,
  isGraphInterrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { describe, expect, it } from "vitest"
import { contrast } from "../../../../lib/design-system-checks"
import { COLOR, SHIKI_FOREGROUNDS } from "../../../../lib/design-tokens"
import { DOCS_INDEX } from "../../docs/search-index"
import appConfig from "./fixtures/b4.config"
import support from "./fixtures/src/app/support/index"
import translator from "./fixtures/src/app/support/subagents/translator/index"
import {
  BASH_COMMAND,
  type BoardId,
  CONFIG_FILES,
  FIXTURES_APP,
  GATES,
  GUARDRAILS_LINK,
  gateBoards,
  gateScenarios,
  linesContaining,
  TASK_INPUT_LENGTH,
} from "./gate-scenarios"
import { gateSources } from "./gate-sources"

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const appRoot = resolve(repoRoot, FIXTURES_APP)
const supportDir = join(appRoot, "src/app/support")
const board = (id: BoardId) => {
  const found = gateBoards.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`No board ${id}`)
  return found
}
const stateOf = (id: BoardId, gate: string) =>
  board(id).steps.find((step) => step.gate === gate)?.state

/** The Node permissions store `b4 dev` builds, from the fixture's `permissions`. */
const permissionsStore = () =>
  createPermissionsStore({
    appRoot,
    config: {
      version: 1,
      allow: appConfig.permissions?.allow ?? {},
      deny: appConfig.permissions?.deny ?? {},
    },
    mode: appConfig.permissions?.mode ?? "interactive",
  })

const context = () => ({ signal: new AbortController().signal })

/**
 * Runs `call` as the one node of a real LangGraph graph with a checkpointer,
 * the way an agent run executes a tool: `start` returns what the run paused
 * with, and `resume` answers it and returns what the call produced.
 */
function pausable(call: () => unknown) {
  const graph = new StateGraph(Annotation.Root({ outcome: Annotation<string> }))
    .addNode("call", async () => {
      try {
        return { outcome: JSON.stringify(await call()) }
      } catch (error) {
        if (isGraphInterrupt(error)) throw error
        return { outcome: `threw: ${error instanceof Error ? error.message : String(error)}` }
      }
    })
    .addEdge(START, "call")
    .addEdge("call", END)
    .compile({ checkpointer: new MemorySaver() })
  const config = { configurable: { thread_id: "thread-1" } }
  return {
    start: async () => {
      const state = await graph.invoke({}, config)
      return (state as { __interrupt__?: { value: unknown }[] }).__interrupt__?.[0]?.value
    },
    resume: async (decision: "once" | "deny") =>
      (await graph.invoke(new Command({ resume: decision }), config)).outcome,
  }
}

/**
 * The route's real runBash, over the fixture's Docker sandbox: the workspace
 * marker gets the sandbox's backends and workspace root, as the CLI hands them
 * over when `sandbox` is configured. A recording Docker client stands in for
 * the daemon, the way @b4run/sandbox's own unit tests do.
 */
async function sandboxedRunBash(store: ReturnType<typeof permissionsStore>) {
  const runs: string[][] = []
  const exec: { container: string; command: readonly string[] }[] = []
  const network = appConfig.sandbox?.network
  if (!network) throw new Error("The fixture sets a network policy")
  const provider = dockerSandbox({
    scope: "my-agent",
    image: "node:24-slim",
    docker: {
      run: async (args) => {
        runs.push([...args])
        return { stdout: args[0] === "ps" ? "" : "ok", stderr: "", exitCode: 0 }
      },
      exec: async (container, command) => {
        exec.push({ container, command })
        // The exec backend checks that its started marker came back first.
        const marker = /__B4_EXEC_STARTED_[0-9a-f-]+__/u.exec(command.join(" "))?.[0] ?? ""
        return { stdout: `${marker}\n`, stderr: "", exitCode: 0 }
      },
    },
  })
  const handle = await provider.acquire({
    threadId: "thread-1",
    policy: { network },
    signal: new AbortController().signal,
  })
  const workspace = await createWorkspaceMarker().load(supportDir, {
    appRoot,
    markerFs: nodeMarkerFs,
    workspaceRoot: handle.workspaceRoot,
    backends: { exec: handle.exec, filesystem: handle.filesystem },
    permissions: store,
    routeManifest: await discoverRoutes({ appRoot }),
    descriptor: support,
  })
  const runBash = workspace.tools?.find((tool) => tool.name === "runBash")
  if (!runBash) throw new Error("The workspace marker gives the route runBash")
  return { runBash, exec, runs }
}

describe("the tracer shows real config", () => {
  it("shows each fixture exactly as it is on disk", () => {
    for (const [id, file] of Object.entries(CONFIG_FILES)) {
      expect(gateSources[id as keyof typeof CONFIG_FILES], file.origin).toBe(
        readFileSync(resolve(repoRoot, file.origin), "utf8"),
      )
    }
  })

  it("marks, for every scenario, lines that really are in its file", () => {
    for (const scenario of gateScenarios) {
      const text = gateSources[scenario.file]
      for (const part of scenario.why) expect(text, `${scenario.id}: ${part}`).toContain(part)
      expect(linesContaining(text, scenario.why).length, scenario.id).toBeGreaterThan(0)
    }
  })

  it("has a board for every scenario and each answer, with the four checks in order", () => {
    expect(gateBoards.map((candidate) => candidate.id).sort()).toEqual(
      [
        "bash",
        "bash-deny",
        "bash-once",
        "delegate",
        "delete",
        "read",
        "refund",
        "refund-deny",
        "refund-once",
      ].sort(),
    )
    for (const candidate of gateBoards) {
      expect(
        candidate.steps.map((step) => step.gate),
        candidate.id,
      ).toEqual(GATES.map((gate) => gate.id))
      expect(
        `${candidate.result} ${candidate.steps.map((step) => step.note).join(" ")}`,
      ).not.toContain("—")
    }
  })

  it("links every scenario and the section to docs headings that exist", () => {
    for (const href of [
      ...gateScenarios.map((scenario) => scenario.docsHref),
      GUARDRAILS_LINK.href,
    ]) {
      const [path, anchor] = href.split("#")
      const page = DOCS_INDEX.find((entry) => entry.href === path)
      expect(page, href).toBeDefined()
      expect(
        page?.headings.map((heading) => heading.anchor),
        href,
      ).toContain(anchor)
    }
  })
})

describe("each check answers as the framework does", () => {
  it("tool scope: the route keeps readFile, runBash and refund, and deleteUser never reaches the model", async () => {
    const authored = await extractToolSchemasForRoute({
      routeDir: supportDir,
      sharedToolsDir: join(appRoot, "src"),
      tsconfig: resolve(repoRoot, "packages/config-typescript/node.json"),
    })
    expect(authored.map((tool) => tool.name).sort()).toEqual(["deleteUser", "refund"])
    // With a sandbox, the runtime hands markers the sandbox's workspace root.
    const manifest = await discoverRoutes({ appRoot })
    const context = {
      appRoot,
      markerFs: nodeMarkerFs,
      workspaceRoot: "/workspace",
      routeManifest: manifest,
      descriptor: support,
    }
    const marker = createWorkspaceMarker()
    expect(await marker.detect(supportDir, context)).toBe(true)
    const workspace = await marker.load(supportDir, context)
    const kept = resolveToolScope(
      [
        ...authored.map((tool) => ({ name: tool.name, origin: "authored" as const })),
        ...(workspace.tools ?? []).map((tool) => ({
          name: tool.name,
          origin: "capability" as const,
        })),
      ],
      support.tools,
      { isSubagent: false, routeId: "/support" },
    )
    expect([...kept].sort()).toEqual(
      ["editFile", "listDir", "readFile", "refund", "runBash", "writeFile"].sort(),
    )
    expect(stateOf("read", "scope")).toBe("passed")
    expect(stateOf("refund", "scope")).toBe("passed")
    expect(stateOf("bash", "scope")).toBe("passed")
    expect(stateOf("delete", "scope")).toBe("stopped")
  }, 60_000)

  it("permission: with no allow rule, runBash and refund both pause for a person", async () => {
    // The fixture sets no allow or deny rules, so nothing matches either call.
    expect(appConfig.permissions).toEqual({ mode: "interactive" })
    const store = permissionsStore()
    expect(store.match("bash", BASH_COMMAND)).toBe("unknown")
    expect(support.tools?.approve).toEqual(["refund"])
    expect(store.match("tool", "refund")).toBe("unknown")

    // In a real LangGraph run, the gate pauses with a permission-request interrupt.
    const refund = pausable(() => gateToolOp(store, "refund", '{"amount":500}'))
    const refundPause = await refund.start()
    expect(refundPause).toMatchObject({ type: "permission-request", kind: "tool" })
    expect(await refund.resume("once")).toBe('{"allowed":true}')
    const refundDenied = pausable(() => gateToolOp(store, "refund", '{"amount":500}'))
    await refundDenied.start()
    expect(await refundDenied.resume("deny")).toContain("Permission denied by user: tool refund")

    const { runBash, exec } = await sandboxedRunBash(store)
    const bash = pausable(() => runBash.run({ command: BASH_COMMAND }, context()))
    expect(await bash.start()).toMatchObject({
      type: "permission-request",
      kind: "command",
      detail: { command: BASH_COMMAND },
    })
    // Nothing reached the sandbox while the run waited.
    expect(exec).toEqual([])

    expect(stateOf("bash", "permission")).toBe("waiting")
    expect(stateOf("refund", "permission")).toBe("waiting")
    expect(stateOf("refund-once", "permission")).toBe("passed")
    expect(stateOf("refund-deny", "permission")).toBe("stopped")
  }, 60_000)

  it("runBash, allowed once: the command runs in the sandbox Docker started with no network", async () => {
    expect(appConfig.sandbox?.network).toEqual({ mode: "deny" })
    const store = permissionsStore()
    const { runBash, exec, runs } = await sandboxedRunBash(store)
    const bash = pausable(() => runBash.run({ command: BASH_COMMAND }, context()))
    await bash.start()
    await bash.resume("once")
    const started = runs.find((args) => args[0] === "run") ?? []
    expect(started.join(" ")).toContain("--network none")
    const container = started[started.indexOf("--name") + 1]
    expect(exec).toHaveLength(1)
    expect(exec[0]?.container).toBe(container)
    expect(exec[0]?.command.join(" ")).toContain(BASH_COMMAND)
    // Allowed once: nothing is saved, so the next call asks again.
    expect(store.match("bash", BASH_COMMAND)).toBe("unknown")
    expect(stateOf("bash-once", "permission")).toBe("passed")
    expect(stateOf("bash-once", "sandbox")).toBe("contained")
  }, 60_000)

  it("runBash, denied: the tool fails with the reason, and nothing reaches the sandbox", async () => {
    const { runBash, exec } = await sandboxedRunBash(permissionsStore())
    const bash = pausable(() => runBash.run({ command: BASH_COMMAND }, context()))
    await bash.start()
    expect(await bash.resume("deny")).toBe(`threw: Permission denied by user: ${BASH_COMMAND}`)
    expect(exec).toEqual([])
    expect(stateOf("bash-deny", "permission")).toBe("stopped")
    expect(board("bash-deny").result).toContain('"Permission denied by user"')
  }, 60_000)

  it("delegation: a long input is refused before translator starts, and a short one goes through", async () => {
    const manifest = await discoverRoutes({ appRoot })
    expect(manifest.routes.map((route) => [route.id, route.kind])).toEqual([
      ["/support", "agent"],
      ["/support/subagents/translator", "agent"],
    ])
    const registry = await resolveSubagentRegistry({
      descriptor: support,
      descriptorRouteIndex: new Map([[translator, ["/support/subagents/translator"]]]),
      parentRouteDir: supportDir,
      parentRouteId: "/support",
      routeManifest: manifest,
      loadDescription: async () => translator.description ?? "",
    })
    const dispatch = (input: string) =>
      resolveGuardedSubagent({
        callId: "call-1",
        input,
        name: "translator",
        registry,
        runtime: { parentRouteId: "/support", signal: new AbortController().signal },
        interruptCapable: false,
        resolve: async () => "started",
      })
    const refused = await dispatch("x".repeat(TASK_INPUT_LENGTH))
    expect(refused.ok).toBe(false)
    const message = refused.ok ? "" : refused.message
    expect(message).toBe("[B4_E3002] Send the translator one reply at a time.")
    expect(board("delegate").result).toContain(`"${message}"`)
    expect(board("delegate").steps.at(-1)?.note).toContain(
      TASK_INPUT_LENGTH.toLocaleString("en-US"),
    )
    expect((await dispatch("Merci pour votre patience.")).ok).toBe(true)
    expect(stateOf("delegate", "delegation")).toBe("stopped")
  }, 60_000)
})

describe("the tracer's colours stay readable", () => {
  /** `color-mix(in srgb, a p%, b)`, as the browser computes it. */
  const mix = (a: string, b: string, share: number) => {
    const channels = (hex: string) =>
      [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16))
    const [ca, cb] = [channels(a), channels(b)]
    return `#${ca
      .map((value, index) =>
        Math.round(value * share + (cb[index] ?? 0) * (1 - share))
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`
  }

  it("keeps every code colour at 4.5:1 or more on a marked line", () => {
    const marked = mix(COLOR["relay-tint"], COLOR.panel, 0.14)
    for (const foreground of SHIKI_FOREGROUNDS) {
      expect(contrast(foreground, marked), foreground).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("keeps each state's text at 4.5:1 or more on its tint", () => {
    expect(contrast(COLOR.ok, COLOR["ok-tint"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(COLOR.warn, COLOR["warn-tint"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(COLOR.danger, COLOR["danger-tint"])).toBeGreaterThanOrEqual(4.5)
    expect(contrast(COLOR["ink-muted"], COLOR.page)).toBeGreaterThanOrEqual(4.5)
  })
})

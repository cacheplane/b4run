import { readFileSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveSandboxManager } from "@b4run/cli/runtime"
import {
  createWorkspaceMarker,
  resolveGuardedSubagent,
  resolveSubagentRegistry,
  resolveToolScope,
  wrapToolWithApproval,
} from "@b4run/core"
import { discoverRoutes, extractToolSchemasForRoute, nodeMarkerFs } from "@b4run/core/node"
import { createPermissionsStore } from "@b4run/permissions/node"
import { type DockerSandboxOptions, dockerSandbox } from "@b4run/sandbox"
import {
  Annotation,
  Command,
  END,
  isGraphInterrupt,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph"
import { describe, expect, it, vi } from "vitest"
import { contrast } from "../../../../lib/design-system-checks"
import { COLOR, SHIKI_FOREGROUNDS } from "../../../../lib/design-tokens"
import { DOCS_INDEX } from "../../docs/search-index"
import appConfig from "./fixtures/b4.config"
import support from "./fixtures/src/app/support/index"
import translator from "./fixtures/src/app/support/subagents/translator/index"
import refund from "./fixtures/src/app/support/tools/refund"
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
  type ScenarioId,
  TASK_INPUT_LENGTH,
} from "./gate-scenarios"
import { gateSources } from "./gate-sources"

/**
 * The fixture config builds its provider with `dockerSandbox({ scope, image })`.
 * The real function runs; this only records the options it was given, so the
 * tests start their recording sandboxes with exactly the fixture's options.
 */
const fixtureDocker = vi.hoisted(() => [] as DockerSandboxOptions[])
vi.mock("@b4run/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@b4run/sandbox")>()
  return {
    ...actual,
    dockerSandbox: (options: DockerSandboxOptions) => {
      fixtureDocker.push(options)
      return actual.dockerSandbox(options)
    },
  }
})

const repoRoot = fileURLToPath(new URL("../../../../../../", import.meta.url))
const appRoot = resolve(repoRoot, FIXTURES_APP)
const supportDir = join(appRoot, "src/app/support")
const board = (id: BoardId) => {
  const found = gateBoards.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`No board ${id}`)
  return found
}
const scenarioOf = (id: ScenarioId) => {
  const found = gateScenarios.find((candidate) => candidate.id === id)
  if (!found) throw new Error(`No scenario ${id}`)
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

/** A tool as the runtime holds it: a name, and `run(input, context)`. */
type RunContext = { readonly signal: AbortSignal }
interface RuntimeToolShape {
  readonly name: string
  readonly run: (input: unknown, runContext: RunContext) => unknown
}

/**
 * The fixture's refund tool as the runtime serves it under `approve`: a
 * function default export becomes the tool's `run`, and execute-route-core
 * wraps it with wrapToolWithApproval. `onRun` sees each call that gets through.
 */
const approvedRefund = (
  store: ReturnType<typeof permissionsStore>,
  onRun: (input: unknown) => void = () => {},
) => {
  const tool: RuntimeToolShape = {
    name: "refund",
    run: (input) => {
      onRun(input)
      return refund(input as Parameters<typeof refund>[0])
    },
  }
  return wrapToolWithApproval<RunContext, RuntimeToolShape>(tool, store)
}

/**
 * Runs `call` as the one node of a real LangGraph graph with a checkpointer,
 * the way an agent run executes a tool: `start` returns what the run paused
 * with, and `resume` answers it and returns what the call produced.
 */
function pausable(call: () => unknown) {
  const graph = new StateGraph(Annotation.Root({ outcome: Annotation<unknown> }))
    .addNode("call", async () => {
      try {
        return { outcome: await call() }
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
    /** What the call produced, for a run that finished without pausing. */
    outcome: async () => (await graph.getState(config)).values.outcome as unknown,
  }
}

/** The options the fixture's `b4.config.ts` passed to `dockerSandbox`, taken before any test builds its own. */
const fixtureOptions = [...fixtureDocker]
function fixtureDockerOptions(): DockerSandboxOptions {
  expect(appConfig.sandbox?.provider.name).toBe("docker")
  const [options, ...rest] = fixtureOptions
  if (!options || rest.length > 0) throw new Error("The fixture config builds one Docker sandbox")
  return options
}

/** The contents the recording sandbox serves for any file read. */
const NOTES = "Refunds over $1,000 need a manager.\n"

/**
 * A Docker client that records every call instead of reaching a daemon, the
 * way @b4run/sandbox's own unit tests do. Each `docker exec` answers with the
 * started marker the backends check for. The filesystem backend's path jail
 * runs `realpath -m <path>`, answered with the path itself (no symlinks), and
 * `cat <path>` gets NOTES.
 */
function recordingDocker() {
  const runs: string[][] = []
  const exec: { container: string; command: readonly string[] }[] = []
  const docker: NonNullable<DockerSandboxOptions["docker"]> = {
    run: async (args) => {
      runs.push([...args])
      return { stdout: args[0] === "ps" ? "" : "ok", stderr: "", exitCode: 0 }
    },
    exec: async (container, command) => {
      exec.push({ container, command })
      const script = command.join(" ")
      const marker = /__B4_(?:EXEC|FILESYSTEM)_STARTED_[0-9a-f-]+__/u.exec(script)?.[0] ?? ""
      const realpath = /; realpath -m '([^']*)'$/u.exec(script)?.[1]
      const body =
        realpath !== undefined ? `${realpath}\n` : /; cat '[^']*'$/u.test(script) ? NOTES : ""
      return { stdout: `${marker}\n${body}`, stderr: "", exitCode: 0 }
    },
  }
  /** The `docker run` that started the thread's keeper container. */
  const keeper = () => {
    const started = runs.filter((args) => args[0] === "run" && args.includes("--name"))
    expect(started).toHaveLength(1)
    return started[0] ?? []
  }
  return { docker, runs, exec, keeper }
}

/**
 * The route's real workspace tools, over the fixture's Docker sandbox: the
 * workspace marker gets the sandbox's backends and workspace root, as the CLI
 * hands them over when `sandbox` is configured.
 */
async function sandboxedWorkspace(store: ReturnType<typeof permissionsStore>) {
  const recorder = recordingDocker()
  const network = appConfig.sandbox?.network
  if (!network) throw new Error("The fixture sets a network policy")
  const provider = dockerSandbox({ ...fixtureDockerOptions(), docker: recorder.docker })
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
  const tool = (name: string) => {
    const found = workspace.tools?.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`The workspace marker gives the route ${name}`)
    return found
  }
  return { runBash: tool("runBash"), readFile: tool("readFile"), ...recorder }
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
    const refundCall = pausable(() => approvedRefund(store).run({ amount: 500 }, context()))
    expect(await refundCall.start()).toMatchObject({
      type: "permission-request",
      kind: "tool",
      detail: { toolName: "refund" },
    })
    const { runBash, exec } = await sandboxedWorkspace(store)
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

  it("refund, allowed once: the tool runs and returns its result, and nothing is saved", async () => {
    const store = permissionsStore()
    const call = pausable(() => approvedRefund(store).run({ amount: 500 }, context()))
    await call.start()
    expect(await call.resume("once")).toEqual({ refunded: 500 })
    // Nothing is saved, so the next refund asks again.
    expect(store.match("tool", "refund")).toBe("unknown")
    expect(stateOf("refund-once", "permission")).toBe("passed")
    expect(board("refund-once").result).toBe("refund runs. The next refund asks again.")
  }, 60_000)

  it("refund, denied: the model gets the coded reason as the tool result, and refund never runs", async () => {
    const store = permissionsStore()
    const ran: unknown[] = []
    const tool = approvedRefund(store, (input) => ran.push(input))
    const call = pausable(() => tool.run({ amount: 500 }, context()))
    await call.start()
    const reason = await call.resume("deny")
    expect(reason).toBe("[B4_E3001] Permission denied by user: tool refund")
    expect(ran).toEqual([])
    expect(store.match("tool", "refund")).toBe("unknown")
    expect(stateOf("refund-deny", "permission")).toBe("stopped")
    expect(board("refund-deny").result).toBe(
      `refund doesn't run. The model gets "${reason}" as the tool result and can adapt.`,
    )
  }, 60_000)

  it("readFile: a path inside the workspace asks no one, and the read runs in the sandbox container", async () => {
    const store = permissionsStore()
    const { readFile, exec, keeper } = await sandboxedWorkspace(store)
    const read = pausable(() => readFile.run({ path: "notes.md" }, context()))
    // No permission interrupt: the call runs straight through.
    expect(await read.start()).toBeUndefined()
    expect(await read.outcome()).toBe(NOTES)
    const started = keeper()
    const container = started[started.indexOf("--name") + 1]
    expect(exec.length).toBeGreaterThan(0)
    expect(exec.every((call) => call.container === container)).toBe(true)
    expect(exec.at(-1)?.command.at(-1)).toContain("cat '/workspace/notes.md'")
    expect(stateOf("read", "scope")).toBe("passed")
    expect(stateOf("read", "permission")).toBe("passed")
    expect(stateOf("read", "sandbox")).toBe("contained")
    expect(board("read").steps[2]?.note).toBe("It reads the file inside the sandbox container.")
    expect(board("read").result).toBe("readFile runs inside the sandbox, and no one is asked.")
  }, 60_000)

  it("runBash, allowed once: the command runs in the sandbox Docker started with no network", async () => {
    expect(appConfig.sandbox?.network).toEqual({ mode: "deny" })
    const store = permissionsStore()
    const { runBash, exec, keeper } = await sandboxedWorkspace(store)
    const bash = pausable(() => runBash.run({ command: BASH_COMMAND }, context()))
    await bash.start()
    await bash.resume("once")
    const started = keeper()
    expect(started[started.indexOf("--network") + 1]).toBe("none")
    const container = started[started.indexOf("--name") + 1]
    expect(exec).toHaveLength(1)
    expect(exec[0]?.container).toBe(container)
    expect(exec[0]?.command.join(" ")).toContain(BASH_COMMAND)
    // Allowed once: nothing is saved, so the next call asks again.
    expect(store.match("bash", BASH_COMMAND)).toBe("unknown")
    expect(stateOf("bash-once", "permission")).toBe("passed")
    expect(stateOf("bash-once", "sandbox")).toBe("contained")
  }, 60_000)

  it("without a network line, the CLI's default policy gives the container Docker's ordinary network", async () => {
    // The same app with the network line removed, resolved by the CLI's own
    // sandbox resolution: the config file hands over a recording provider.
    const recorder = recordingDocker()
    const docker = dockerSandbox({ ...fixtureDockerOptions(), docker: recorder.docker })
    const policies: unknown[] = []
    const provider: typeof docker = {
      ...docker,
      acquire: (request) => {
        policies.push(request.policy)
        return docker.acquire(request)
      },
    }
    const dir = await mkdtemp(join(tmpdir(), "b4-gates-default-network-"))
    const slot = "__b4GatesDefaultNetworkProvider"
    Object.assign(globalThis, { [slot]: provider })
    try {
      await writeFile(join(dir, "package.json"), '{ "type": "module" }\n')
      await writeFile(
        join(dir, "b4.config.ts"),
        `export default { sandbox: { provider: (globalThis as Record<string, unknown>).${slot} } }\n`,
      )
      const manager = await resolveSandboxManager(dir)
      if (!manager) throw new Error("The config has a sandbox")
      await manager.getForThread("thread-1", new AbortController().signal)
    } finally {
      Reflect.deleteProperty(globalThis, slot)
      await rm(dir, { recursive: true, force: true })
    }
    // The CLI falls back to allow mode, and Docker runs allow mode as a plain bridge network.
    expect(policies).toEqual([
      expect.objectContaining({ network: expect.objectContaining({ mode: "allow" }) }),
    ])
    const started = recorder.keeper()
    expect(started[started.indexOf("--network") + 1]).toBe("bridge")
    // No metadata-address block reaches Docker, in the keeper's args or anywhere else.
    expect(recorder.runs.flat().join(" ")).not.toContain("169.254")
    expect(scenarioOf("bash").explain).toBe(
      'No bash allow rule matches curl, so runBash asks first. Once allowed, it has no network because this config sets mode: "deny". Without that line the sandbox falls back to allow mode, and Docker gives the container ordinary network access.',
    )
    expect(scenarioOf("bash").explain).not.toContain("169.254")
  }, 60_000)

  it("runBash, denied: the tool fails with the reason, and nothing reaches the sandbox", async () => {
    const { runBash, exec } = await sandboxedWorkspace(permissionsStore())
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

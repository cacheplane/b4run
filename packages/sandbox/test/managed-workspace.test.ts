import type { ReadyWorkspace, SandboxWorkspaceReader } from "@b4run/workspace"
import { describe, expect, it } from "vitest"
import type { Docker } from "../src/docker/docker-cli.ts"
import { createDockerManagedWorkspaces } from "../src/docker/managed-workspace.ts"

describe("managed Docker environment", () => {
  it("pins the image and daemon identity", async () => {
    const calls: readonly string[][] = []
    const docker: Docker = {
      run: async (args) => {
        ;(calls as string[][]).push([...args])
        return {
          exitCode: 0,
          stderr: "",
          stdout: args[0] === "info" ? "daemon-one\n" : `sha256:${"a".repeat(64)}\n`,
        }
      },
      exec: async () => {
        throw new Error("unexpected execution")
      },
    }
    const provider = createDockerManagedWorkspaces({ scope: "app", image: "mutable:tag", docker })
    expect(await provider.resolveEnvironment(new AbortController().signal)).toEqual({
      binding: { provider: "docker", scope: "app", account: "daemon-one" },
      identity: `sha256:${"a".repeat(64)}`,
    })
    expect(calls).toContainEqual(["image", "inspect", "--format", "{{.Id}}", "mutable:tag"])
  })
  it("does not mistake daemon failure for absence", async () => {
    const docker: Docker = {
      run: async () => ({ exitCode: 1, stderr: "daemon unavailable", stdout: "" }),
      exec: async () => {
        throw new Error("unexpected")
      },
    }
    await expect(
      createDockerManagedWorkspaces({ scope: "app", image: "tag", docker }).resolveEnvironment(
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "uncertain" })
  })
})

import { createSourceBundle, createWorkspaceIntent } from "@b4run/workspace/node"

const signal = new AbortController().signal
const source = createSourceBundle([
  { path: "binary", bytes: new Uint8Array([0, 255]), executable: true },
])
function fixture(
  options: {
    /** The provider's configured image. */
    readonly image?: string
    /** What `docker image inspect --format {{.Id}} <ref>` answers per reference. */
    readonly identities?: Readonly<Record<string, string>>
    readonly images?: (reference: string) => boolean
  } = {},
) {
  const objects = new Map<
    string,
    { Labels?: Record<string, string>; Config?: { Labels: Record<string, string> } }
  >()
  const calls: string[][] = []
  let losePublication = false
  const docker: Docker = {
    async run(args) {
      calls.push([...args])
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" })
      if (args[0] === "info") return ok("daemon")
      if (args[0] === "image")
        return ok(
          args.includes("{{json .Config.Volumes}}")
            ? "null"
            : (options.identities?.[String(args.at(-1))] ?? `sha256:${"a".repeat(64)}`),
        )
      if (args[0] === "ps") {
        // A reader-label filter is honoured exactly; any other listing answers the sessions.
        const reader = args.find((arg) => arg.startsWith("label=b4.sandbox.reader="))
        if (reader) {
          const [key, value] = [
            "b4.sandbox.reader",
            reader.slice("label=b4.sandbox.reader=".length),
          ]
          return ok(
            [...objects.entries()]
              .filter(([, item]) => item.Config?.Labels[key] === value)
              .map(([name]) => name)
              .join("\n"),
          )
        }
        return ok([...objects.keys()].filter((k) => k.includes("session")).join("\n"))
      }
      if (args.includes("inspect")) {
        const item = objects.get(args.at(-1)!)
        if (item && args.includes("{{.Mountpoint}}"))
          return ok(`/var/lib/docker/volumes/${args.at(-1)}/_data`)
        return item
          ? ok(JSON.stringify([item]))
          : { exitCode: 1, stdout: "", stderr: "Error: No such object: missing" }
      }
      if (args[0] === "rm" || args[1] === "rm") {
        objects.delete(args.at(-1)!)
        return ok()
      }
      const labels: Record<string, string> = {}
      args.forEach((arg, i) => {
        if (arg === "--label") {
          const pair = args[i + 1]!
          const at = pair.indexOf("=")
          labels[pair.slice(0, at)] = pair.slice(at + 1)
        }
      })
      const name = args[0] === "volume" ? args.at(-1)! : args[args.indexOf("--name") + 1]!
      objects.set(name, args[0] === "volume" ? { Labels: labels } : { Config: { Labels: labels } })
      if (losePublication && args[0] === "create") {
        losePublication = false
        throw new Error("lost acknowledgement")
      }
      return ok(name)
    },
    async exec() {
      return { exitCode: 0, stderr: "", stdout: "{}" }
    },
  }
  /** A provider over the SAME daemon and scope, as another process would construct it. */
  const providerFor = (image: string | undefined, images = options.images) =>
    createDockerManagedWorkspaces({
      scope: "app",
      ...(image !== undefined ? { image } : {}),
      ...(images !== undefined ? { images } : {}),
      docker,
    })
  const provider = providerFor(options.image ?? "tag")
  const intent = async () =>
    createWorkspaceIntent({
      operationId: "00000000-0000-4000-8000-000000000001",
      installationId: "00000000-0000-4000-8000-000000000002",
      threadId: "thread",
      definition: { version: 1, source, environmentLinks: [] },
      environment: await provider.resolveEnvironment(signal),
    })
  return {
    docker,
    objects,
    calls,
    provider,
    providerFor,
    intent,
    losePublication: () => {
      losePublication = true
    },
  }
}
describe("managed Docker publication", () => {
  it("recovers a lost publication acknowledgement without reseeding", async () => {
    const f = fixture(),
      intent = await f.intent()
    f.losePublication()
    const ready = await f.provider.create(intent, source, signal)
    const runs = f.calls.filter((c) => c[0] === "run").length
    expect(await f.provider.create(intent, source, signal)).toEqual(ready)
    expect(f.calls.filter((c) => c[0] === "run")).toHaveLength(runs)
  })
  it("reports published storage loss without recreating it", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    f.objects.delete(ready.reference.resource.volume!)
    await expect(f.provider.create(intent, source, signal)).rejects.toMatchObject({ code: "lost" })
  })
  it("rejects foreign labels before destructive actions", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    f.objects.set(ready.reference.resource.volume!, { Labels: {} })
    const before = f.calls.length
    await expect(
      f.provider.destroy({ intent, reference: ready.reference }, signal),
    ).rejects.toMatchObject({ code: "conflict" })
    expect(f.calls.slice(before).some((c) => c.includes("rm"))).toBe(false)
  })
  it("stale release cannot remove the replacement incarnation", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    const a = await f.provider.reconnect(ready, { network: { mode: "deny" } }, signal)
    const b = await f.provider.reconnect(ready, { network: { mode: "deny" } }, signal)
    await f.provider.release(a.reference, signal)
    expect([...f.objects.keys()].some((k) => k.endsWith(b.reference.incarnation))).toBe(true)
  })
})

it("stops a surviving preparer before removing partial storage", async () => {
  const f = fixture(),
    intent = await f.intent(),
    ready = await f.provider.create(intent, source, signal)
  const record = f.objects.get(ready.reference.resource.record!)!
  f.objects.delete(ready.reference.resource.record!)
  const name = ready.reference.resource.record!.replace("record", "prepare")
  f.objects.set(name, record)
  const before = f.calls.length
  await f.provider.create(intent, source, signal)
  const mutations = f.calls.slice(before).filter((c) => c.includes("rm"))
  expect(mutations[0]).toEqual(["rm", "-f", name])
  expect(mutations[1]).toEqual(["volume", "rm", ready.reference.resource.volume])
})
it("resumes deletion when the volume is already gone", async () => {
  const f = fixture(),
    intent = await f.intent(),
    ready = await f.provider.create(intent, source, signal)
  f.objects.delete(ready.reference.resource.volume!)
  await f.provider.destroy({ intent, reference: ready.reference }, signal)
  expect(f.objects.size).toBe(0)
})

it("rejects images with implicit writable volumes before creating resources", async () => {
  const f = fixture(),
    intent = await f.intent(),
    run = f.docker.run
  f.docker.run = async (args, opts) =>
    args.includes("{{json .Config.Volumes}}")
      ? { exitCode: 0, stdout: '{"/opt/deps":{}}', stderr: "" }
      : run(args, opts)
  await expect(f.provider.create(intent, source, signal)).rejects.toMatchObject({
    code: "unsupported",
  })
  expect(f.objects.size).toBe(0)
})

it("rejects a conflicting intent for an existing operation before mutation", async () => {
  const f = fixture(),
    intent = await f.intent()
  await f.provider.create(intent, source, signal)
  const changedSource = createSourceBundle([
    { path: "changed", bytes: Buffer.from("different"), executable: false },
  ])
  const changed = createWorkspaceIntent({
    operationId: intent.operationId,
    installationId: intent.installationId,
    threadId: intent.threadId,
    environment: intent.environment,
    definition: { version: 1, source: changedSource, environmentLinks: [] },
  })
  const before = f.calls.length
  await expect(f.provider.create(changed, changedSource, signal)).rejects.toMatchObject({
    code: "conflict",
  })
  expect(
    f.calls.slice(before).some((c) => c.includes("rm") || c.includes("create") || c[0] === "run"),
  ).toBe(false)
})

it("confirms incarnation removal before a cancelled command settles", async () => {
  const f = fixture(),
    intent = await f.intent(),
    ready = await f.provider.create(intent, source, signal)
  const session = await f.provider.reconnect(ready, { network: { mode: "deny" } }, signal)
  const controller = new AbortController()
  f.docker.exec = async () => {
    controller.abort()
    throw Error("CLI aborted while process survives")
  }
  await expect(
    session.handle.exec.runCommand(
      { command: "sleep 500" },
      { signal: controller.signal, workspaceRoot: "/workspace" },
    ),
  ).rejects.toThrow()
  expect([...f.objects.keys()].some((k) => k.endsWith(session.reference.incarnation))).toBe(false)
  let replayed = false
  f.docker.exec = async () => {
    replayed = true
    return { exitCode: 0, stdout: "", stderr: "" }
  }
  await expect(
    session.handle.exec.runCommand(
      { command: "echo unsafe" },
      { signal, workspaceRoot: "/workspace" },
    ),
  ).rejects.toMatchObject({ code: "uncertain" })
  expect(replayed).toBe(false)
})

it.each(["thread", "environment", "links", "baseline"] as const)(
  "conflicts on changed %s with the same operation",
  async (field) => {
    const f = fixture(),
      intent = await f.intent()
    await f.provider.create(intent, source, signal)
    const changed = createWorkspaceIntent({
      operationId: intent.operationId,
      installationId: intent.installationId,
      threadId: field === "thread" ? "other-thread" : intent.threadId,
      environment:
        field === "environment"
          ? { ...intent.environment, identity: `sha256:${"b".repeat(64)}` }
          : intent.environment,
      definition: {
        version: 1,
        source,
        environmentLinks: field === "links" ? [{ path: "deps", target: "/opt/deps" }] : [],
        ...(field === "baseline" ? { baseline: "git" as const } : {}),
      },
    })
    const before = f.calls.length
    await expect(f.provider.create(changed, source, signal)).rejects.toMatchObject({
      code: "conflict",
    })
    expect(
      f.calls.slice(before).some((c) => c.includes("rm") || c.includes("create") || c[0] === "run"),
    ).toBe(false)
  },
)

it("prepares the verified source snapshot even when caller mutates transport after admission", async () => {
  const f = fixture(),
    intent = await f.intent()
  const mutable = JSON.parse(JSON.stringify(source))
  let sent: unknown
  f.docker.exec = async (_container, _command, opts) => {
    sent = JSON.parse(opts?.stdin ?? "{}")
    return { exitCode: 0, stdout: "{}", stderr: "" }
  }
  const creating = f.provider.create(intent, mutable, signal)
  mutable.files[0].base64 = Buffer.from("changed after verification").toString("base64")
  await creating
  expect(sent).toMatchObject({ files: source.files })
})

it.each(["ordinary command failure", "daemon stream disconnected"])(
  "retires an incarnation after returned nonzero: %s",
  async (message) => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    const session = await f.provider.reconnect(ready, { network: { mode: "deny" } }, signal)
    f.docker.exec = async () => ({ exitCode: 1, stdout: "", stderr: message })
    expect(
      await session.handle.exec.runCommand(
        { command: "npm test" },
        { signal, workspaceRoot: "/workspace" },
      ),
    ).toEqual({ exitCode: 1, stdout: "", stderr: message })
    expect([...f.objects.keys()].some((k) => k.endsWith(session.reference.incarnation))).toBe(false)
    let replayed = false
    f.docker.exec = async () => {
      replayed = true
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    await expect(
      session.handle.exec.runCommand(
        { command: "echo next" },
        { signal, workspaceRoot: "/workspace" },
      ),
    ).rejects.toMatchObject({ code: "uncertain" })
    expect(replayed).toBe(false)
  },
)

describe("managed Docker workspace reader", () => {
  const open = async (f: ReturnType<typeof fixture>, ready: ReadyWorkspace) =>
    f.provider.openWorkspaceReader?.({
      workspace: ready,
      signal,
    }) as Promise<SandboxWorkspaceReader>

  it("destroy removes the thread's readers left open (a read abandoned at its deadline), and no other", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    await open(f, ready)
    await open(f, ready)
    const readers = () => [...f.objects.keys()].filter((name) => name.startsWith("b4-ws-reader-"))
    expect(readers()).toHaveLength(2)
    const foreign = "b4-ws-reader-someone-else-00000000"
    f.objects.set(foreign, { Config: { Labels: { "b4.sandbox.reader": "someone-else" } } })
    await f.provider.destroy({ intent, reference: ready.reference }, signal)
    expect(readers()).toEqual([foreign])
    f.objects.delete(foreign)
    expect(f.objects.size).toBe(0)
  })

  it("binds the managed volume read-only and never names a session container", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    const session = await f.provider.reconnect(ready, { network: { mode: "deny" } }, signal)
    const sessionName = [...f.objects.keys()].find((k) => k.endsWith(session.reference.incarnation))
    expect(sessionName).toMatch(/^b4-ws-session-/)
    const before = f.calls.length
    const reader = await open(f, ready)
    expect(reader.threadId).toBe("thread")
    expect(reader.workspaceRoot).toBe("/workspace")
    const readerRun = f.calls.slice(before).find((c) => c[0] === "run")
    expect(readerRun).toBeDefined()
    const name = readerRun?.[readerRun.indexOf("--name") + 1] ?? ""
    const key = ready.reference.resource.volume?.slice("b4-ws-volume-".length)
    expect(name.startsWith(`b4-ws-reader-${key}-`)).toBe(true)
    const line = readerRun?.join(" ") ?? ""
    expect(line).toContain(
      `--mount type=bind,source=/var/lib/docker/volumes/${ready.reference.resource.volume}/_data,target=/workspace,readonly`,
    )
    expect(line).not.toContain("type=volume")
    expect(line).toContain("--network none")
    expect(line).toContain("--cap-drop ALL")
    expect(line).toContain("--security-opt no-new-privileges")
    expect(line).toContain("--read-only")
    expect(line).toContain(`--label b4.sandbox.reader=${key}`)
    expect(line).toContain(`sha256:${"a".repeat(64)} sleep infinity`)
    expect(f.objects.has(name)).toBe(true)
    await reader.close()
    expect(f.objects.has(name)).toBe(false)
    const commands = f.calls.slice(before)
    expect(commands.some((c) => c[0] === "ps")).toBe(false)
    expect(commands.some((c) => c.some((arg) => arg.includes("b4-ws-session-")))).toBe(false)
    // The session is untouched: still present, never removed or restarted.
    expect(f.objects.has(sessionName as string)).toBe(true)
  })

  it("rejects a lost record without creating anything", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    f.objects.delete(ready.reference.resource.record as string)
    const size = f.objects.size
    await expect(open(f, ready)).rejects.toMatchObject({ code: "lost" })
    expect(f.objects.size).toBe(size)
  })

  it("rejects a lost volume without creating anything", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    f.objects.delete(ready.reference.resource.volume as string)
    const size = f.objects.size
    await expect(open(f, ready)).rejects.toMatchObject({ code: "lost" })
    expect(f.objects.size).toBe(size)
    expect(
      f.calls.some(
        (c) => c[0] === "run" && c.includes("--mount") && c.join(" ").includes("b4-ws-reader-"),
      ),
    ).toBe(false)
  })

  it("rejects a reference paired with another workspace's provenance", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    const forged: ReadyWorkspace = {
      reference: ready.reference,
      provenance: { ...ready.provenance, sourceDigest: `sha256:${"b".repeat(64)}` },
    }
    await expect(open(f, forged)).rejects.toMatchObject({ code: "conflict" })
  })

  it("rejects a foreign volume before opening", async () => {
    const f = fixture(),
      intent = await f.intent(),
      ready = await f.provider.create(intent, source, signal)
    f.objects.set(ready.reference.resource.volume as string, { Labels: {} })
    await expect(open(f, ready)).rejects.toMatchObject({ code: "conflict" })
    expect(f.calls.some((c) => c[0] === "run" && c.join(" ").includes("b4-ws-reader-"))).toBe(false)
  })
})

describe("managed Docker: the image is the intent's, not the provider's", () => {
  const one = `sha256:${"a".repeat(64)}`
  const two = `sha256:${"b".repeat(64)}`

  it("reconnects, reads, releases and destroys in the recorded image, whatever image the provider was built with", async () => {
    const f = fixture({
      image: "factory:one",
      identities: { "factory:one": one, "factory:two": two },
    })
    const intent = await f.intent()
    expect(intent.environment.identity).toBe(one)
    const ready = await f.provider.create(intent, source, signal)
    // Another process's provider: same daemon, same scope, a different configured image.
    const other = f.providerFor("factory:two")
    const before = f.calls.length
    const session = await other.reconnect(ready, { network: { mode: "deny" } }, signal)
    const reader = (await other.openWorkspaceReader?.({
      workspace: ready,
      signal,
    })) as SandboxWorkspaceReader
    await reader.close()
    await other.release(session.reference, signal)
    await other.destroy({ intent, reference: ready.reference }, signal)
    const after = f.calls.slice(before)
    const started = after.filter((call) => call[0] === "run")
    // The session and the reader: each started from the recorded identity.
    expect(started.length).toBeGreaterThanOrEqual(2)
    for (const call of started) expect(call).toContain(one)
    // The other provider's image was never looked up, named or run.
    expect(after.some((call) => call.includes("factory:two") || call.includes(two))).toBe(false)
    expect(f.objects.size).toBe(0)
  })
})
describe("managed Docker: per-thread images", () => {
  const one = `sha256:${"a".repeat(64)}`
  const two = `sha256:${"b".repeat(64)}`
  const identities = { "factory:one": one, "factory:two": two }

  it("resolves an allowed image to its own identity", async () => {
    const f = fixture({ image: "factory:one", identities, images: (ref) => ref === "factory:two" })
    const environment = await f.provider.resolveImageEnvironment?.("factory:two", signal)
    expect(environment).toEqual({
      binding: { provider: "docker", scope: "app", account: "daemon" },
      identity: two,
    })
    expect(f.calls).toContainEqual(["image", "inspect", "--format", "{{.Id}}", "factory:two"])
  })
  it("needs no predicate for its own image", async () => {
    const f = fixture({ image: "factory:one", identities })
    expect((await f.provider.resolveImageEnvironment?.("factory:one", signal))?.identity).toBe(one)
  })
  it.each([
    ["an image the predicate refuses", "factory:three"],
    ["a reference that reads as a flag", "--privileged"],
    ["a reference with whitespace", "factory two"],
  ])("refuses %s before any Docker call", async (_why, reference) => {
    const f = fixture({ image: "factory:one", identities, images: (ref) => ref === "factory:two" })
    await expect(f.provider.resolveImageEnvironment?.(reference, signal)).rejects.toMatchObject({
      code: "unsupported",
    })
    expect(f.calls).toEqual([])
  })
  it("refuses every other image when no predicate is configured", async () => {
    const f = fixture({ image: "factory:one", identities })
    await expect(f.provider.resolveImageEnvironment?.("factory:two", signal)).rejects.toMatchObject(
      { code: "unsupported" },
    )
    expect(f.calls).toEqual([])
  })
  it("lets a throwing predicate fail the admission rather than allow", async () => {
    const f = fixture({
      image: "factory:one",
      identities,
      images: () => {
        throw new Error("catalog unavailable")
      },
    })
    await expect(f.provider.resolveImageEnvironment?.("factory:two", signal)).rejects.toThrow(
      /catalog unavailable/,
    )
    expect(f.calls).toEqual([])
  })
  it("without a default image, refuses a thread that names none", async () => {
    const f = fixture({ identities, images: () => true })
    const bare = f.providerFor(undefined)
    await expect(bare.resolveEnvironment(signal)).rejects.toMatchObject({ code: "unsupported" })
    expect(f.calls).toEqual([])
    expect((await bare.resolveImageEnvironment?.("factory:two", signal))?.identity).toBe(two)
  })
})

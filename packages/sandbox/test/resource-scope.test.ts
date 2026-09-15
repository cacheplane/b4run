import { execFileSync } from "node:child_process"
import { describe, expect, test, vi } from "vitest"
import { dockerSandbox } from "../src/docker/docker-sandbox.ts"
import { kubernetesSandbox } from "../src/kubernetes/kube-sandbox.ts"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const policy = { network: { mode: "deny" as const } }
const signal = () => new AbortController().signal
const vector = "93c4fcf034837c402e3d6f16f1ed08abda918380"

describe("required sandbox resource scope", () => {
  test.each([undefined, null, "", " \n", 42])("rejects invalid scope %j before I/O", (scope) => {
    const run = vi.fn()
    const client = fakeKubeClient()
    const create = vi.spyOn(client, "createNamespacedPvcIfAbsent")
    // Deliberately exercise untyped configuration callers.
    expect(() =>
      dockerSandbox({ image: "i", scope: scope as string, docker: { run, exec: run } }),
    ).toThrow(/scope/i)
    expect(() => kubernetesSandbox({ image: "i", scope: scope as string, client })).toThrow(
      /scope/i,
    )
    expect(run).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  test("both providers follow a fixed resource identity across processes", async () => {
    const independent = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { resourceScope } from ${JSON.stringify(new URL("../src/resource-scope.ts", import.meta.url).href)}; process.stdout.write(resourceScope("app")("thread"))`,
      ],
      { encoding: "utf8" },
    )
    expect(independent).toBe(vector)
    const runs: string[][] = []
    const docker = {
      run: async (args: readonly string[]) => {
        runs.push([...args])
        return { stdout: "", stderr: "", exitCode: args[0] === "volume" ? 1 : 0 }
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    }
    const d = dockerSandbox({ image: "i", scope: "app", docker })
    expect((await d.acquire({ threadId: "thread", policy, signal: signal() })).threadId).toBe(
      "thread",
    )
    expect(runs.flat()).toContain(`b4-sbx-${vector}`)
    expect(runs.flat()).toContain(`b4-sbx-vol-${vector}:/workspace`)
    await d.release("thread")
    await d.destroy("thread")
    expect(runs).toContainEqual(["rm", "-f", `b4-sbx-${vector}`])
    expect(runs).toContainEqual(["volume", "rm", `b4-sbx-vol-${vector}`])
    const client = fakeKubeClient()
    const k = kubernetesSandbox({ image: "i", scope: "app", client })
    expect((await k.acquire({ threadId: "thread", policy, signal: signal() })).threadId).toBe(
      "thread",
    )
    expect(client.pods.get(`b4-sbx-${vector}`)?.spec.pvcName).toBe(`b4-sbx-vol-${vector}`)
    expect(client.netpols.get(`b4-sbx-net-${vector}`)?.threadLabelValue).toBe(vector)
  })

  test("opaque identifiers do not collide after normalization or concatenation", async () => {
    const client = fakeKubeClient()
    const pairs = [
      ["app", "A"],
      ["app", "a"],
      ["app", "a/b"],
      ["app", "a_b"],
      ["app", "a-b"],
      ["other", "a"],
      ["a:b", "c"],
      ["a", "b:c"],
      ["app", "💡"],
      ["app", "x".repeat(500)],
      ["app", "x".repeat(499) + "y"],
      [" app", "a"],
      ["APP", "a"],
    ]
    for (const [scope, threadId] of pairs) {
      await kubernetesSandbox({ image: "i", scope: scope!, client }).acquire({
        threadId: threadId!,
        policy,
        signal: signal(),
      })
    }
    expect(client.pvcs.size).toBe(pairs.length)
    for (const name of client.pvcs.keys()) expect(name).toMatch(/^b4-sbx-vol-[0-9a-f]{40}$/)
  })

  test("reattaches edits after release and provider restart; destroy stays within scope", async () => {
    const client = fakeKubeClient()
    const make = (scope: string) => kubernetesSandbox({ image: "i", scope, client })
    for (const scope of ["one", "two"]) {
      const p = make(scope)
      const h = await p.acquire({ threadId: "same", policy, signal: signal() })
      await h.filesystem.writeFile("/workspace/edit.txt", scope, {
        signal: signal(),
        workspaceRoot: "/workspace",
      })
      await p.release("same")
    }
    const first = make("one")
    expect(
      await (
        await first.acquire({ threadId: "same", policy, signal: signal() })
      ).filesystem.readFile("/workspace/edit.txt", {
        signal: signal(),
        workspaceRoot: "/workspace",
      }),
    ).toBe("one")
    await first.destroy("same")
    const second = make("two")
    expect(
      await (
        await second.acquire({ threadId: "same", policy, signal: signal() })
      ).filesystem.readFile("/workspace/edit.txt", {
        signal: signal(),
        workspaceRoot: "/workspace",
      }),
    ).toBe("two")
    await second.destroy("same")
    expect(client.pvcs.size).toBe(0)
  })
})

test("scope is required at both the type and runtime boundaries", () => {
  // @ts-expect-error scope is required
  expect(() => dockerSandbox({ image: "i" })).toThrow(/scope/i)
  // @ts-expect-error scope is required
  expect(() => kubernetesSandbox({ image: "i" })).toThrow(/scope/i)
})

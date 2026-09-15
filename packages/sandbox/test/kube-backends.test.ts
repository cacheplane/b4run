import { expect, test } from "vitest"
import { kubeExec } from "../src/kubernetes/kube-exec.ts"
import { kubeFilesystem } from "../src/kubernetes/kube-filesystem.ts"
import { fakeKubeClient } from "./support/fake-kube-client.ts"

const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })

async function withPod() {
  const k = fakeKubeClient()
  await k.createNamespacedPvcIfAbsent("ns", { name: "vol", labels: {}, storageGi: 1 })
  await k.createNamespacedPod("ns", {
    name: "p",
    image: "i",
    labels: {},
    pvcName: "vol",
    env: [],
    limits: {},
    podSecurityContext: {},
    containerSecurityContext: {},
    readOnlyRootFilesystem: true,
    automountServiceAccountToken: false,
  })
  return k
}

test("runCommand execs sh -c and returns the exit code", async () => {
  const k = await withPod()
  const exec = kubeExec(k, "ns", "p", {})
  const r = await exec.runCommand({ command: "true" }, ctx("/workspace"))
  expect(r.exitCode).toBe(0)
})

test("cwd defaults to workspaceRoot; invalid env key throws", async () => {
  const k = await withPod()
  const seen: string[] = []
  const spy = {
    ...k,
    exec: async (ns: string, pod: string, argv: readonly string[]) => {
      seen.push(argv.join(" "))
      return k.exec(ns, pod, argv)
    },
  }
  const exec = kubeExec(spy, "ns", "p", {})
  await exec.runCommand({ command: "true" }, ctx("/workspace"))
  expect(seen[0]).toContain("cd '/workspace' &&")
  await expect(
    exec.runCommand({ command: "true", env: { "1bad": "x" } }, ctx("/workspace")),
  ).rejects.toThrow(/Invalid environment variable name/)
})

test("timeout wraps argv and annotates exit 124", async () => {
  const k = await withPod()
  const spy = { ...k, exec: async () => ({ stdout: "", stderr: "", exitCode: 124 }) }
  const exec = kubeExec(spy, "ns", "p", { timeoutMs: 500 })
  const r = await exec.runCommand({ command: "sleep 5" }, ctx("/workspace"))
  expect(r.exitCode).toBe(124)
  expect(r.stderr).toContain("after 1s")
  expect(r.stderr).toContain("resources.timeoutMs: 500ms")
})

test("kubeFilesystem round-trips write→read→list", async () => {
  const k = await withPod()
  const fs = kubeFilesystem(k, "ns", "p")
  await fs.writeFile("/workspace/a.txt", "hello", ctx("/workspace"))
  expect(await fs.readFile("/workspace/a.txt", ctx("/workspace"))).toBe("hello")
  expect(await fs.listDir("/workspace", ctx("/workspace"))).toContain("a.txt")
})

test("kubeFilesystem preserves binary bytes, names, and symlink identity", async () => {
  const k = await withPod()
  const bytes = Buffer.from([0, 255, 128, 10])
  const spy = {
    ...k,
    exec: async (_ns: string, _pod: string, argv: readonly string[]) => {
      const command = argv[2] ?? ""
      const stdout = command.startsWith("stat ")
        ? "a1ff 7\n"
        : command.startsWith("readlink ")
          ? "../file"
          : command.startsWith("find ")
            ? "/workspace/.gitignore\0/workspace/ space \0/workspace/new\nline\0"
            : (command.includes("B4_READ_STATUS")
                ? Buffer.concat([bytes, Buffer.from("\nB4_READ_STATUS_0\n")])
                : bytes
              ).toString("base64")
      return { stdout, stderr: "", exitCode: 0 }
    },
  }
  const fs = kubeFilesystem(spy, "ns", "p")
  expect(await fs.readBinaryFile?.("/workspace/binary", ctx("/workspace"))).toEqual(bytes)
  await expect(
    fs.readBinaryFile?.("/workspace/binary", ctx("/workspace"), { maxBytes: 3 }),
  ).rejects.toThrow("maxBytes")
  expect(await fs.listDir("/workspace", ctx("/workspace"))).toEqual([
    ".gitignore",
    " space ",
    "new\nline",
  ])
  expect(await fs.lstat?.("/workspace/link", ctx("/workspace"))).toEqual({
    kind: "symlink",
    size: 7,
    executable: true,
    target: "../file",
  })
})

import { randomUUID } from "node:crypto"
import { inspectWorkspace } from "@b4run/workspace"
import {
  ApiException,
  CoreV1Api,
  KubeConfig,
  NetworkingV1Api,
  type V1NetworkPolicy,
} from "@kubernetes/client-node"
import { describe, expect, test } from "vitest"
import { kubernetesSandbox } from "../src/index.ts"
import { resourceScope } from "../src/resource-scope.ts"
import { runProviderConformance } from "../src/testing/index.ts"
import {
  assertDnsEvidence,
  assertEgressEvidence,
  assertRestrictedSecurityEvidence,
  buildDnsProbeCommand,
  buildEgressProbeCommand,
  buildRestrictedSecurityProbeCommand,
  parseEgressControlUrl,
} from "./support/kube-conformance-evidence.ts"

// Real-cluster lane. The compatibility harness supplies a short-lived token
// kubeconfig and all live inputs; ordinary package tests skip this entire suite.
const enabled = process.env.B4_TEST_K8S === "1"

function requiredLiveEnvironment(name: string): string {
  const value = process.env[name]
  if (enabled && (value === undefined || value.trim().length === 0)) {
    throw new Error(`${name} is required when B4_TEST_K8S=1`)
  }
  return value ?? ""
}

const IMAGE = requiredLiveEnvironment("B4_TEST_K8S_IMAGE")
const NS = requiredLiveEnvironment("B4_TEST_K8S_NS")
const STORAGE_CLASS = requiredLiveEnvironment("B4_TEST_K8S_STORAGE_CLASS")
const EGRESS_CONTROL_URL = enabled
  ? parseEgressControlUrl(requiredLiveEnvironment("B4_TEST_K8S_EGRESS_CONTROL_URL"))
  : ""
const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const make = () =>
  kubernetesSandbox({
    scope: "sandbox-test",
    image: IMAGE,
    namespace: NS,
    storageClass: STORAGE_CLASS,
    startupTimeoutMs: 120_000,
  })

function liveClients(): { readonly core: CoreV1Api; readonly networking: NetworkingV1Api } {
  const kubeconfig = new KubeConfig()
  kubeconfig.loadFromDefault()
  return {
    core: kubeconfig.makeApiClient(CoreV1Api),
    networking: kubeconfig.makeApiClient(NetworkingV1Api),
  }
}

async function waitForPodDeletion(core: CoreV1Api, name: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await core.readNamespacedPod({ name, namespace: NS })
    } catch (error) {
      if (error instanceof ApiException && error.code === 404) return
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for Pod ${NS}/${name} to be deleted`)
}

describe.skipIf(!enabled)("kubernetesSandbox (real cluster)", { timeout: 240_000 }, () => {
  runProviderConformance({ name: "kubernetesSandbox", makeProvider: make, describe })

  test("production preflight validates the short-lived token permissions", async () => {
    const provider = make()
    if (provider.preflight === undefined) throw new Error("Kubernetes preflight is unavailable")
    const result = await provider.preflight()

    expect(result.ok, result.detail).toBe(true)
    expect(result.detail).toBe(`Kubernetes reachable; required permissions granted in "${NS}".`)
  })

  test("runs with the restricted object and kernel security contract", async () => {
    const provider = make()
    const threadId = `restricted-${randomUUID().slice(0, 8)}`
    try {
      const sandbox = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const { core } = liveClients()
      const [pod, pvc] = await Promise.all([
        core.readNamespacedPod({ name: `b4-sbx-${resourceId(threadId)}`, namespace: NS }),
        core.readNamespacedPersistentVolumeClaim({
          name: `b4-sbx-vol-${resourceId(threadId)}`,
          namespace: NS,
        }),
      ])

      expect(pod.spec?.automountServiceAccountToken).toBe(false)
      expect(pod.spec?.securityContext).toMatchObject({
        runAsNonRoot: true,
        runAsUser: 1000,
        runAsGroup: 1000,
        fsGroup: 1000,
        fsGroupChangePolicy: "OnRootMismatch",
        seccompProfile: { type: "RuntimeDefault" },
      })
      expect(pod.spec?.containers[0]?.securityContext).toMatchObject({
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      })
      expect(pvc.status?.phase).toBe("Bound")

      const probe = await sandbox.exec.runCommand(
        { command: buildRestrictedSecurityProbeCommand() },
        ctx(sandbox.workspaceRoot),
      )

      expect(probe.exitCode, probe.stderr).toBe(0)
      assertRestrictedSecurityEvidence(probe.stdout)
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("network deny blocks egress while DNS remains available", async () => {
    const provider = make()
    const threadId = `network-${randomUUID().slice(0, 8)}`
    try {
      const sandbox = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const dns = await sandbox.exec.runCommand(
        { command: buildDnsProbeCommand(EGRESS_CONTROL_URL) },
        ctx(sandbox.workspaceRoot),
      )
      expect(dns.exitCode, dns.stderr).toBe(0)
      assertDnsEvidence(dns.stdout)

      const fetchResult = await sandbox.exec.runCommand(
        { command: buildEgressProbeCommand(EGRESS_CONTROL_URL) },
        ctx(sandbox.workspaceRoot),
      )
      expect(fetchResult.exitCode).toBe(7)
      assertEgressEvidence(fetchResult.stdout, "blocked")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("chart backstop blocks allow-mode sandbox egress without a per-thread policy", async () => {
    const provider = make()
    const threadId = `egress-${randomUUID().slice(0, 8)}`
    try {
      const sandbox = await provider.acquire({
        threadId,
        policy: { network: { mode: "allow" } },
        signal: ctx("/").signal,
      })
      const { networking } = liveClients()
      const policies = await networking.listNamespacedNetworkPolicy({ namespace: NS })
      const perThreadPolicy = policies.items.find(
        (policy) =>
          policy.metadata?.name === `b4-sbx-net-${resourceId(threadId)}` ||
          policy.metadata?.labels?.["b4.run/thread"] === resourceId(threadId),
      )
      expect(perThreadPolicy).toBeUndefined()

      const dns = await sandbox.exec.runCommand(
        { command: buildDnsProbeCommand(EGRESS_CONTROL_URL) },
        ctx(sandbox.workspaceRoot),
      )
      expect(dns.exitCode, dns.stderr).toBe(0)
      assertDnsEvidence(dns.stdout)

      const fetchResult = await sandbox.exec.runCommand(
        { command: buildEgressProbeCommand(EGRESS_CONTROL_URL) },
        ctx(sandbox.workspaceRoot),
      )
      expect(fetchResult.exitCode).toBe(7)
      assertEgressEvidence(fetchResult.stdout, "blocked")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("batched inspection matches per-entry inspection in a few execs", async () => {
    const provider = make()
    const threadId = `batch-${randomUUID().slice(0, 8)}`
    try {
      const h = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const run = (command: string) => h.exec.runCommand({ command }, ctx(h.workspaceRoot))
      const made = await run(
        [
          "mkdir -p src .git/objects 'sp ace' \"[glob]*?\"",
          "printf 'hello\\n' > src/a.ts",
          "printf 'caf\\303\\251' > \"src/$(printf 'caf\\303\\251').ts\"",
          ": > empty.txt",
          'printf q > "it\'s.txt"',
          "printf g > '[glob]*?/x.txt'",
          "printf s > 'sp ace/y.txt'",
          "printf git > .git/objects/ignored",
          "ln -s /opt/deps deps",
        ].join(" && "),
      )
      expect(made.stderr).toBe("")
      expect(made.exitCode).toBe(0)
      const { lstat, readBinaryFile, walkTree } = h.filesystem
      if (!lstat || !readBinaryFile || !walkTree)
        throw new Error("the Kubernetes backend lost a read capability")
      const options = {
        excludeRootDirectories: [".git"],
        expectedRootSymlinks: { deps: "/opt/deps" },
      }

      let started = performance.now()
      const batched = await inspectWorkspace(h, options)
      const batchedMs = performance.now() - started
      started = performance.now()
      const single = await inspectWorkspace(
        {
          workspaceRoot: h.workspaceRoot,
          filesystem: {
            lstat: lstat.bind(h.filesystem),
            readBinaryFile: readBinaryFile.bind(h.filesystem),
            listDir: h.filesystem.listDir.bind(h.filesystem),
          },
        },
        options,
      )
      console.log(
        `kube inspection of ${single.entries} entries: batched ${batchedMs.toFixed(0)} ms, per-entry ${(performance.now() - started).toFixed(0)} ms`,
      )
      expect(batched).toEqual(single)
      expect(batched.files["src/café.ts"]).toBe("café")
      expect(batched.files["[glob]*?/x.txt"]).toBe("g")
      expect(batched.symlinks).toEqual({ deps: "/opt/deps" })

      // Pruning happens in the pod, not only in the inspection loop.
      const walked = async (prune: readonly string[]) =>
        (
          await walkTree.call(h.filesystem, h.workspaceRoot, ctx(h.workspaceRoot), {
            maxEntries: 100,
            prune,
          })
        ).map((entry) => entry.path)
      expect(await walked([".git"])).not.toContain(".git/objects")
      expect(await walked([])).toContain(".git/objects/ignored")

      // Enough long paths that the batch read spans several execs, each script on stdin.
      expect(
        (
          await run(
            'mkdir -p src/deep && i=0; while [ $i -lt 1200 ]; do printf "$i" > src/deep/a-file-with-a-rather-long-name-$i.txt; i=$((i+1)); done',
          )
        ).exitCode,
      ).toBe(0)
      started = performance.now()
      const large = await inspectWorkspace(h, options)
      console.log(
        `kube batched inspection of ${large.entries} entries: ${(performance.now() - started).toFixed(0)} ms`,
      )
      expect(Object.keys(large.files)).toHaveLength(Object.keys(batched.files).length + 1200)
      expect(large.files["src/deep/a-file-with-a-rather-long-name-1199.txt"]).toBe("1199")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("workspace persists across release and reattach", async () => {
    const provider = make()
    const threadId = `persistence-${randomUUID().slice(0, 8)}`
    try {
      const first = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      await first.filesystem.writeFile(
        `${first.workspaceRoot}/keep`,
        "durable",
        ctx(first.workspaceRoot),
      )
      await provider.release(threadId)
      const second = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      expect(
        await second.filesystem.readFile(`${second.workspaceRoot}/keep`, ctx(second.workspaceRoot)),
      ).toBe("durable")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("recreates an externally deleted keeper over the same PVC", async () => {
    const provider = make()
    const threadId = `recreate-${randomUUID().slice(0, 8)}`
    const podName = `b4-sbx-${resourceId(threadId)}`
    const pvcName = `b4-sbx-vol-${resourceId(threadId)}`
    try {
      const first = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      await first.filesystem.writeFile(
        `${first.workspaceRoot}/keeper-data`,
        "preserved",
        ctx(first.workspaceRoot),
      )
      const { core } = liveClients()
      const [initialPod, initialPvc] = await Promise.all([
        core.readNamespacedPod({ name: podName, namespace: NS }),
        core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: NS }),
      ])
      expect(initialPod.metadata?.uid).toBeTruthy()
      expect(initialPvc.metadata?.uid).toBeTruthy()

      await core.deleteNamespacedPod({ name: podName, namespace: NS, gracePeriodSeconds: 0 })
      await waitForPodDeletion(core, podName)

      const second = await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const [replacementPod, retainedPvc] = await Promise.all([
        core.readNamespacedPod({ name: podName, namespace: NS }),
        core.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace: NS }),
      ])
      expect(replacementPod.metadata?.uid).toBeTruthy()
      expect(replacementPod.metadata?.uid).not.toBe(initialPod.metadata?.uid)
      expect(retainedPvc.metadata?.uid).toBe(initialPvc.metadata?.uid)
      expect(
        await second.filesystem.readFile(
          `${second.workspaceRoot}/keeper-data`,
          ctx(second.workspaceRoot),
        ),
      ).toBe("preserved")
    } finally {
      await provider.destroy(threadId)
    }
  })

  test("updates an existing owned NetworkPolicy on reacquire", async () => {
    const provider = make()
    const threadId = `policy-${randomUUID().slice(0, 8)}`
    const policyName = `b4-sbx-net-${resourceId(threadId)}`
    try {
      await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const { networking } = liveClients()
      const existing = await networking.readNamespacedNetworkPolicy({
        name: policyName,
        namespace: NS,
      })
      expect(existing.metadata?.labels).toMatchObject({
        "app.kubernetes.io/managed-by": "b4",
        "b4.run/thread": resourceId(threadId),
      })
      expect(existing.metadata?.resourceVersion).toBeTruthy()
      expect(existing.metadata?.uid).toBeTruthy()

      const modified: V1NetworkPolicy = {
        ...existing,
        spec: {
          podSelector: { matchLabels: { "b4.run/thread": resourceId(threadId) } },
          policyTypes: ["Egress"],
          egress: [],
        },
      }
      await networking.replaceNamespacedNetworkPolicy({
        name: policyName,
        namespace: NS,
        body: modified,
      })

      await provider.acquire({
        threadId,
        policy: { network: { mode: "deny" } },
        signal: ctx("/").signal,
      })
      const updated = await networking.readNamespacedNetworkPolicy({
        name: policyName,
        namespace: NS,
      })
      expect(updated.metadata?.uid).toBe(existing.metadata?.uid)
      expect(updated.metadata?.labels).toMatchObject({
        "app.kubernetes.io/managed-by": "b4",
        "b4.run/thread": resourceId(threadId),
      })
      expect(updated.spec).toEqual({
        podSelector: { matchLabels: { "b4.run/thread": resourceId(threadId) } },
        policyTypes: ["Egress"],
        egress: [
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
              },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
            ],
          },
        ],
      })
    } finally {
      await provider.destroy(threadId)
    }
  })
})

const resourceId = resourceScope("sandbox-test")

test.skipIf(!enabled)(
  "scoped storage survives provider restart and isolated destruction",
  async () => {
    const threadId = randomUUID()
    const create = (scope: string) =>
      kubernetesSandbox({ image: IMAGE, namespace: NS, storageClass: STORAGE_CLASS, scope })
    const scopes = ["scope-restart-one", "scope-restart-two"]
    const providers = scopes.map(create)
    const policy = { network: { mode: "deny" as const } }
    try {
      for (const [index, provider] of providers.entries()) {
        const handle = await provider.acquire({
          threadId,
          policy,
          signal: ctx("/workspace").signal,
        })
        await handle.filesystem.writeFile(
          "/workspace/scope.txt",
          String(index),
          ctx(handle.workspaceRoot),
        )
        await provider.release(threadId)
      }
      for (const [index, scope] of scopes.entries()) {
        const provider = create(scope)
        const handle = await provider.acquire({
          threadId,
          policy,
          signal: ctx("/workspace").signal,
        })
        expect(
          await handle.filesystem.readFile("/workspace/scope.txt", ctx(handle.workspaceRoot)),
        ).toBe(String(index))
        await provider.destroy(threadId)
      }
    } finally {
      await Promise.all(providers.map((provider) => provider.destroy(threadId)))
    }
  },
  120_000,
)

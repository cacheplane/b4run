import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FilesystemBackend, inspectWorkspace, withWorkspaceReader } from "@b4run/workspace"
import { describe, expect, test } from "vitest"
import { createDocker, type Docker, type SpawnResult } from "../src/docker/docker-cli.ts"
import { dockerSandbox } from "../src/index.ts"
import { resourceScope } from "../src/resource-scope.ts"
import { runProviderConformance } from "../src/testing/index.ts"

// Real-Docker lane. Runs ONLY when B4_TEST_DOCKER=1 (the dedicated CI job
// sets it; the default validate lane never does). Locally: B4_TEST_DOCKER=1
// with a running Docker daemon.
const enabled = process.env.B4_TEST_DOCKER === "1"
const IMAGE =
  "docker.io/library/node:22-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436"
const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const policyDeny = { network: { mode: "deny" } } as const
const pollIntervalMs = 100

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function pollCommand(
  command: () => Promise<SpawnResult>,
  accept: (result: SpawnResult) => boolean,
  deadlineMs: number,
): Promise<SpawnResult> {
  const deadline = Date.now() + deadlineMs
  let lastResult: SpawnResult | undefined
  do {
    lastResult = await command()
    if (accept(lastResult)) return lastResult
    await wait(pollIntervalMs)
  } while (Date.now() < deadline)

  throw new Error(
    `Docker command did not reach the expected state within ${deadlineMs}ms; last result: ${JSON.stringify(lastResult)}`,
  )
}

async function waitForContainerFile(
  docker: Docker,
  container: string,
  containerPath: string,
  deadlineMs: number,
): Promise<string> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "b4-pids-ready-"))
  const destination = join(temporaryDirectory, "ready")
  const deadline = Date.now() + deadlineMs
  let lastCopy: SpawnResult | undefined

  try {
    do {
      await rm(destination, { force: true })
      lastCopy = await docker.run(["cp", `${container}:${containerPath}`, destination])
      if (lastCopy.exitCode === 0) return await readFile(destination, "utf8")
      await wait(pollIntervalMs)
    } while (Date.now() < deadline)

    const [state, pids] = await Promise.all([
      docker.run(["inspect", "--format", "{{json .State}}", container]),
      docker.run(["stats", "--no-stream", "--format", "{{.PIDs}}", container]),
    ])
    throw new Error(
      `PID saturation was not ready within ${deadlineMs}ms; last copy: ${JSON.stringify(lastCopy)}; container state: ${state.stdout.trim() || state.stderr.trim()}; observed PIDs: ${pids.stdout.trim() || pids.stderr.trim()}`,
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

describe.skipIf(!enabled)("dockerSandbox (real Docker)", { timeout: 120_000 }, () => {
  runProviderConformance({
    name: "dockerSandbox",
    makeProvider: () => dockerSandbox({ scope: "sandbox-test", image: IMAGE }),
    describe,
    workspaceReads: true,
  })

  test("network deny blocks egress (curl/wget fails inside)", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
    const threadId = `net-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      // The workload image has Node; use fetch with a short timeout and no curl dependency.
      const r = await h.exec.runCommand(
        {
          command: `node -e "fetch('https://registry.npmjs.org/', {signal: AbortSignal.timeout(5000)}).then(()=>{console.log('REACHED');process.exit(0)}).catch(()=>{console.log('BLOCKED');process.exit(7)})"`,
        },
        ctx(h.workspaceRoot),
      )
      expect(r.exitCode).toBe(7)
      expect(r.stdout).toContain("BLOCKED")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("host filesystem is untouched by sandbox writes", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
    const threadId = `host-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      await h.filesystem.writeFile(
        `${h.workspaceRoot}/host-check.txt`,
        "sandboxed",
        ctx(h.workspaceRoot),
      )
      expect(
        await h.filesystem.readFile(`${h.workspaceRoot}/host-check.txt`, ctx(h.workspaceRoot)),
      ).toBe("sandboxed")
      expect(existsSync("/workspace/host-check.txt")).toBe(false)
      expect(existsSync(`${process.cwd()}/workspace/host-check.txt`)).toBe(false)
    } finally {
      await p.destroy(threadId)
    }
  })

  test("restart durability: release then reacquire reattaches the volume", {
    timeout: 180_000,
  }, async () => {
    const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
    const threadId = `dur-${randomUUID()}`
    try {
      const h1 = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      await h1.filesystem.writeFile(`${h1.workspaceRoot}/persist.txt`, "v1", ctx(h1.workspaceRoot))
      await p.release(threadId) // container gone, volume kept
      const h2 = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      expect(
        await h2.filesystem.readFile(`${h2.workspaceRoot}/persist.txt`, ctx(h2.workspaceRoot)),
      ).toBe("v1")
    } finally {
      await p.destroy(threadId)
    }
  })

  // Adversarial hardening conformance: these tests actually attempt the abuse
  // (bounded process storm, /etc write, non-root escalation, timeout overrun) and assert
  // containment. fakeSandbox can't enforce kernel controls (caps/pids/
  // read-only/non-root), so these properties are Docker-lane-only.

  test("configured PID limit contains a bounded process storm", {
    timeout: 180_000,
  }, async () => {
    const pidsLimit = 32
    const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
    const threadId = `fork-${randomUUID()}`
    try {
      const h = await p.acquire({
        threadId,
        policy: { ...policyDeny, security: { pidsLimit } },
        signal: ctx("/").signal,
      })
      const successMarker = "SPAWN_STORM_COMPLETED"
      const storm = `
        const { spawn } = require("node:child_process")

        function errorDetails(error) {
          return {
            code: typeof error.code === "string" ? error.code : "UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
          }
        }

        const attempts = Array.from({ length: ${pidsLimit * 4} }, () => new Promise((resolve) => {
          let child
          try {
            child = spawn("sleep", ["2"], { stdio: "ignore" })
          } catch (error) {
            resolve({ error: errorDetails(error), started: false })
            return
          }
          child.once("spawn", () => resolve({ started: true }))
          child.once("error", (error) => resolve({ error: errorDetails(error), started: false }))
        }))
        Promise.all(attempts).then((results) => {
          const errors = results.flatMap((result) => result.started ? [] : [result.error])
          const report = { errors, started: results.length - errors.length }
          if (errors.length === 0) {
            console.log("${successMarker}")
          } else {
            console.error("SPAWN_STORM_BLOCKED:" + JSON.stringify(report))
            process.exitCode = 42
          }
        })
      `
      const r = await h.exec.runCommand(
        { command: `node -e ${shellQuote(storm)}` },
        ctx(h.workspaceRoot),
      )
      expect(r.exitCode).not.toBe(0)
      expect(r.stdout).not.toContain(successMarker)
      expect(r.stderr).toContain("SPAWN_STORM_BLOCKED:")
      const reportText = r.stderr
        .split("\n")
        .find((line) => line.startsWith("SPAWN_STORM_BLOCKED:"))
        ?.slice("SPAWN_STORM_BLOCKED:".length)
      expect(reportText, `missing spawn-storm report in stderr: ${r.stderr}`).toBeDefined()
      const report = JSON.parse(reportText ?? "{}") as {
        errors?: Array<{ code?: unknown; message?: unknown }>
        started?: unknown
      }
      expect(report.started).toEqual(expect.any(Number))
      expect(report.started).toBeGreaterThan(0)
      expect(report.errors).toEqual(expect.any(Array))
      expect(report.errors).not.toHaveLength(0)
      for (const error of report.errors ?? []) {
        expect(error).toEqual({ code: expect.any(String), message: expect.any(String) })
        expect(
          error.code === "EAGAIN" ||
            (typeof error.message === "string" &&
              error.message.includes("Resource temporarily unavailable")),
        ).toBe(true)
      }

      const alive = await pollCommand(
        () => h.exec.runCommand({ command: "echo alive" }, ctx(h.workspaceRoot)),
        (result) => result.exitCode === 0 && result.stdout.trim() === "alive",
        10_000,
      )
      expect(alive).toMatchObject({ exitCode: 0, stdout: "alive\n" })
    } finally {
      await p.destroy(threadId)
    }
  })

  test("recycles a PID-exhausted keeper and preserves its workspace", {
    timeout: 180_000,
  }, async () => {
    const pidsLimit = 32
    const recoveryCommands = 24
    const docker = createDocker()
    const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE, docker })
    const threadId = `pid-recovery-${randomUUID()}`
    const container = `b4-sbx-${resourceId(threadId)}`
    const readinessPath = "/workspace/.pids-ready.json"
    const readinessTemporaryPath = "/workspace/.pids-ready.json.tmp"
    const sentinelPath = "/workspace/pid-recovery-sentinel.txt"
    const sentinel = `sentinel-${randomUUID()}`

    try {
      const h = await p.acquire({
        threadId,
        policy: { ...policyDeny, security: { pidsLimit } },
        signal: ctx("/").signal,
      })
      await h.filesystem.writeFile(sentinelPath, sentinel, ctx(h.workspaceRoot))
      const saturator = `
        const { renameSync, rmSync, writeFileSync } = require("node:fs")
        const { Worker } = require("node:worker_threads")
        let started = 0
        let settled = false
        const workers = []
        rmSync("${readinessTemporaryPath}", { force: true })
        rmSync("${readinessPath}", { force: true })

        function publishReadiness(status) {
          writeFileSync("${readinessTemporaryPath}", JSON.stringify(status))
          renameSync("${readinessTemporaryPath}", "${readinessPath}")
        }

        const keepAlive = setInterval(() => {}, 1000)
        const deadline = setTimeout(() => {
          settled = true
          publishReadiness({ status: "failed", reason: "deadline", started })
          clearInterval(keepAlive)
          process.exit(88)
        }, 5000)

        function fail(reason, error) {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          publishReadiness({ status: "failed", reason, code: error && error.code, started })
          clearInterval(keepAlive)
          process.exit(89)
        }

        function launch() {
          if (settled) return
          if (started >= ${pidsLimit * 4}) {
            fail("attempt-limit")
            return
          }
          let worker
          try {
            worker = new Worker("setInterval(() => {}, 1000)", { eval: true })
          } catch (error) {
            const message = String(error && error.message)
            if (error.code !== "ERR_WORKER_INIT_FAILED" || !message.includes("EAGAIN")) {
              fail("unexpected-worker-error", error)
              return
            }
            settled = true
            clearTimeout(deadline)
            publishReadiness({ status: "ready", code: error.code, message, started })
            return
          }
          worker.once("online", () => {
            workers.push(worker)
            started += 1
            launch()
          })
          worker.once("error", (error) => fail("worker-runtime-error", error))
        }

        launch()
      `
      const detached = await docker.run(["exec", "-d", container, "node", "-e", saturator])
      expect(detached).toMatchObject({ exitCode: 0 })

      const readiness = JSON.parse(
        await waitForContainerFile(docker, container, readinessPath, 10_000),
      ) as { code?: unknown; message?: unknown; started?: unknown; status?: unknown }
      expect(readiness).toMatchObject({ status: "ready", code: "ERR_WORKER_INIT_FAILED" })
      expect(readiness.message).toEqual(expect.stringContaining("EAGAIN"))
      expect(readiness.started).toEqual(expect.any(Number))
      const saturatedPids = await docker.run([
        "stats",
        "--no-stream",
        "--format",
        "{{.PIDs}}",
        container,
      ])
      expect(saturatedPids).toMatchObject({ exitCode: 0, stdout: `${pidsLimit}\n` })

      // What this test can guarantee, and what it deliberately does not.
      //
      // The cgroup is verifiably full above (EAGAIN from the saturator, and
      // `docker stats` reporting exactly `pidsLimit`). Under that pressure every
      // command must still succeed and the workspace must survive. Those are the
      // real contract and they are asserted below.
      //
      // Whether a keeper RECYCLE was needed to achieve it is not something this
      // test can force. Recovery in `docker-exec.ts` fires only when a command
      // fails to start with a PID-exhaustion signature; if Docker admits every
      // exec into the full cgroup — which it does on some engine and kernel
      // versions — nothing fails, so nothing is recovered, and the keeper is
      // correctly left alone. Asserting a recycle here therefore asserted a race,
      // and it failed intermittently on `main` while reporting "keeper did not
      // recycle", which reads like a product defect and is not one.
      //
      // The recovery path itself is covered deterministically in
      // `docker-backends.test.ts`, which injects a PID-exhaustion failure and
      // pins the whole contract: one token captured before the attempt, the
      // retry issued with an identical command, and the retried result returned.
      // That is a stronger check than this one was, and it cannot flake.
      const recovered = await Promise.all(
        Array.from({ length: recoveryCommands }, (_, index) =>
          h.exec.runCommand({ command: `echo recovered-${index}` }, ctx(h.workspaceRoot)),
        ),
      )
      expect(recovered).toEqual(
        Array.from({ length: recoveryCommands }, (_, index) => ({
          exitCode: 0,
          stderr: "",
          stdout: `recovered-${index}\n`,
        })),
      )
      const persisted = await h.filesystem.readFile(sentinelPath, ctx(h.workspaceRoot))
      expect(persisted).toBe(sentinel)
    } finally {
      await p.destroy(threadId)
    }
  })

  test("read-only root blocks /etc writes; workspace + /tmp writable", {
    timeout: 120_000,
  }, async () => {
    const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
    const threadId = `ro-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      const etc = await h.exec.runCommand(
        { command: "echo x > /etc/b4-probe" },
        ctx(h.workspaceRoot),
      )
      expect(etc.exitCode).not.toBe(0)
      const ws = await h.exec.runCommand(
        { command: "echo x > /workspace/probe && echo ok" },
        ctx(h.workspaceRoot),
      )
      expect(ws.stdout).toContain("ok")
      const tmp = await h.exec.runCommand(
        { command: "echo x > /tmp/probe && echo ok" },
        ctx(h.workspaceRoot),
      )
      expect(tmp.stdout).toContain("ok")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("runs as non-root by default", { timeout: 120_000 }, async () => {
    const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
    const threadId = `nr-${randomUUID()}`
    try {
      const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      const r = await h.exec.runCommand({ command: "id -u" }, ctx(h.workspaceRoot))
      expect(r.stdout.trim()).toBe("1000")
    } finally {
      await p.destroy(threadId)
    }
  })

  test("per-command timeout kills the in-container process (exit 124)", {
    timeout: 120_000,
  }, async () => {
    const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
    const threadId = `to-${randomUUID()}`
    try {
      const h = await p.acquire({
        threadId,
        policy: { network: { mode: "deny" }, resources: { timeoutMs: 500 } },
        signal: ctx("/").signal,
      })
      const r = await h.exec.runCommand({ command: "sleep 999" }, ctx(h.workspaceRoot))
      expect(r.exitCode).toBe(124)
      const ps = await h.exec.runCommand(
        { command: "ps -e -o args= 2>/dev/null | grep -c 'sleep 999' || true" },
        ctx(h.workspaceRoot),
      )
      expect(ps.stdout.trim()).toBe("0")
    } finally {
      await p.destroy(threadId)
    }
  })

  // The non-disturbance proof. A second, trusted process reads a thread's
  // workspace while the worker's keeper is live, and the keeper must come out
  // the other side byte-for-byte the same container.
  describe("batched workspace inspection", () => {
    // The same tree inspected through the batch methods (walkTree + readBinaryFiles, a few
    // execs) and through the per-entry methods alone (one exec per listDir/lstat/read) must
    // give the same inventory: the batch is only a transport, never a different policy.
    const perEntry = (h: { workspaceRoot: string; filesystem: FilesystemBackend }) => {
      const { lstat, readBinaryFile } = h.filesystem
      if (!lstat || !readBinaryFile) throw new Error("the Docker backend lost a per-entry read")
      return {
        workspaceRoot: h.workspaceRoot,
        filesystem: {
          lstat: lstat.bind(h.filesystem),
          readBinaryFile: readBinaryFile.bind(h.filesystem),
          listDir: h.filesystem.listDir.bind(h.filesystem),
        },
      }
    }
    const tree = [
      "mkdir -p src/deep/er .git/objects 'sp ace' \"[glob]*?\"",
      "printf 'hello\\n' > src/a.ts",
      "printf '\\357\\273\\277bom' > src/bom.ts",
      "printf 'caf\\303\\251' > \"src/$(printf 'caf\\303\\251').ts\"",
      ": > empty.txt",
      'printf q > "it\'s.txt"',
      "printf g > '[glob]*?/x.txt'",
      "printf s > 'sp ace/y.txt'",
      "printf git > .git/objects/ignored",
      "ln -s /opt/deps deps",
    ].join(" && ")
    // Enough long paths that the batch read needs more than one exec.
    const many =
      'i=0; while [ $i -lt 1200 ]; do printf "$i" > src/deep/er/a-file-with-a-rather-long-name-$i.txt; i=$((i+1)); done'
    const options = {
      excludeRootDirectories: [".git"],
      expectedRootSymlinks: { deps: "/opt/deps" },
    }

    test("matches the per-entry inventory, and reads many files in a few execs", {
      timeout: 300_000,
    }, async () => {
      const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
      const threadId = `batch-${randomUUID()}`
      try {
        const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
        const made = await h.exec.runCommand({ command: tree }, ctx(h.workspaceRoot))
        expect(made.stderr).toBe("")
        expect(made.exitCode).toBe(0)
        expect(h.filesystem.walkTree).toBeTypeOf("function")

        let started = performance.now()
        const batched = await inspectWorkspace(h, options)
        const batchedMs = performance.now() - started
        started = performance.now()
        const single = await inspectWorkspace(perEntry(h), options)
        const singleMs = performance.now() - started
        console.log(
          `inspection of ${single.entries} entries: batched ${batchedMs.toFixed(0)} ms, per-entry ${singleMs.toFixed(0)} ms`,
        )

        expect(batched).toEqual(single)
        expect(Object.keys(batched.files)).toHaveLength(7)
        expect(batched.files["src/café.ts"]).toBe("café")
        expect(batched.files["src/bom.ts"]).toBe("\ufeffbom")
        expect(batched.files["it's.txt"]).toBe("q")
        expect(batched.files["[glob]*?/x.txt"]).toBe("g")
        expect(batched.files["empty.txt"]).toBe("")
        expect(batched.files[".git/objects/ignored"]).toBeUndefined()
        expect(batched.symlinks).toEqual({ deps: "/opt/deps" })
        expect(batchedMs).toBeLessThan(singleMs)

        expect((await h.exec.runCommand({ command: many }, ctx(h.workspaceRoot))).exitCode).toBe(0)
        started = performance.now()
        const large = await inspectWorkspace(h, options)
        console.log(
          `batched inspection of ${large.entries} entries: ${(performance.now() - started).toFixed(0)} ms`,
        )
        expect(Object.keys(large.files)).toHaveLength(1207)
        expect(large.files["src/deep/er/a-file-with-a-rather-long-name-1199.txt"]).toBe("1199")
        expect(large.files["src/café.ts"]).toBe("café")
      } finally {
        await p.destroy(threadId)
      }
    })

    test("refuses what the per-entry walk refuses", { timeout: 300_000 }, async () => {
      const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
      const threadId = `batch-refuse-${randomUUID()}`
      try {
        const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
        const run = (command: string) => h.exec.runCommand({ command }, ctx(h.workspaceRoot))
        expect((await run("mkdir -p a/b && printf x > a/b/c && printf y > d")).exitCode).toBe(0)
        // Over the entry limit: the walk is cut off in the container, never truncated silently.
        await expect(inspectWorkspace(h, { maxEntries: 3 })).rejects.toThrow(/entries/)
        await expect(inspectWorkspace(perEntry(h), { maxEntries: 3 })).rejects.toThrow(/entries/)
        expect((await inspectWorkspace(h, { maxEntries: 4 })).entries).toBe(4)
        // A newline in a name reaches the name check intact rather than splitting a line.
        expect((await run("printf z > \"$(printf 'new\\nline')\"")).exitCode).toBe(0)
        await expect(inspectWorkspace(h)).rejects.toThrow(/Invalid workspace entry name/)
        await expect(inspectWorkspace(perEntry(h))).rejects.toThrow(/Invalid workspace entry name/)
      } finally {
        await p.destroy(threadId)
      }
    })

    test("refuses a file that grew past its walked size", { timeout: 300_000 }, async () => {
      const p = dockerSandbox({ scope: "sandbox-test", image: IMAGE })
      const threadId = `batch-grow-${randomUUID()}`
      try {
        const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
        await h.exec.runCommand({ command: "printf abc > f" }, ctx(h.workspaceRoot))
        const { walkTree, readBinaryFiles } = h.filesystem
        if (!walkTree || !readBinaryFiles) throw new Error("the Docker backend has no batch reads")
        const grown = {
          workspaceRoot: h.workspaceRoot,
          filesystem: {
            ...perEntry(h).filesystem,
            walkTree: walkTree.bind(h.filesystem),
            readBinaryFiles: async (
              requests: readonly { path: string; maxBytes: number }[],
              c: { signal: AbortSignal; workspaceRoot: string },
            ) => {
              await h.exec.runCommand({ command: "printf abcdef > f" }, ctx(h.workspaceRoot))
              return readBinaryFiles.call(h.filesystem, requests, c)
            },
          },
        }
        await expect(inspectWorkspace(grown)).rejects.toThrow(/exceeds maxBytes/)
      } finally {
        await p.destroy(threadId)
      }
    })
  })

  describe("openWorkspaceReader", () => {
    const readerScope = "sandbox-test"
    const keeperFor = (threadId: string) => `b4-sbx-${resourceScope(readerScope)(threadId)}`
    const containerId = async (docker: Docker, name: string) =>
      (await docker.run(["inspect", "--format", "{{.Id}}", name])).stdout.trim()

    test("reads a live thread's workspace without disturbing its keeper", {
      timeout: 180_000,
    }, async () => {
      const docker = createDocker()
      const p = dockerSandbox({ scope: readerScope, image: IMAGE })
      const threadId = `read-${randomUUID()}`
      const keeper = keeperFor(threadId)
      try {
        const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
        await h.filesystem.writeFile(
          `${h.workspaceRoot}/produced.txt`,
          "worker output\n",
          ctx(h.workspaceRoot),
        )
        const before = await containerId(docker, keeper)
        expect(before).not.toBe("")

        // A second provider instance — exactly the shape a separate process
        // has: it knows the scope and the thread id and nothing else.
        const reader = dockerSandbox({ scope: readerScope, image: IMAGE })
        const inspection = await withWorkspaceReader(
          reader,
          { threadId, signal: ctx("/").signal },
          (r) => inspectWorkspace(r),
        )
        expect(inspection.files["produced.txt"]).toBe("worker output\n")

        // Same container, still running, still usable.
        expect(await containerId(docker, keeper)).toBe(before)
        const running = await docker.run(["ps", "-q", "--filter", `name=^${keeper}$`])
        expect(running.stdout.trim()).not.toBe("")
        expect((await h.exec.runCommand({ command: "true" }, ctx(h.workspaceRoot))).exitCode).toBe(
          0,
        )
        await h.filesystem.writeFile(
          `${h.workspaceRoot}/after.txt`,
          "still writable\n",
          ctx(h.workspaceRoot),
        )
        expect(
          await h.filesystem.readFile(`${h.workspaceRoot}/after.txt`, ctx(h.workspaceRoot)),
        ).toBe("still writable\n")

        // No reader container survives the read.
        const strays = await docker.run([
          "ps",
          "-aq",
          "--filter",
          `label=b4.sandbox.reader=${resourceScope(readerScope)(threadId)}`,
        ])
        expect(strays.stdout.trim()).toBe("")
      } finally {
        await p.destroy(threadId)
      }
    })

    test("the workspace mount rejects writes at the kernel, and reads survive release", {
      timeout: 180_000,
    }, async () => {
      const docker = createDocker()
      const p = dockerSandbox({ scope: readerScope, image: IMAGE })
      const threadId = `read-ro-${randomUUID()}`
      const volume = `b4-sbx-vol-${resourceScope(readerScope)(threadId)}`
      try {
        const h = await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
        await h.filesystem.writeFile(
          `${h.workspaceRoot}/kept.txt`,
          "durable\n",
          ctx(h.workspaceRoot),
        )

        // The mount the reader uses is read-only to the kernel, not by policy.
        const mountpoint = (
          await docker.run(["volume", "inspect", "--format", "{{.Mountpoint}}", volume])
        ).stdout.trim()
        expect(mountpoint).not.toBe("")
        const write = await docker.run([
          "run",
          "--rm",
          "--mount",
          `type=bind,source=${mountpoint},target=/workspace,readonly`,
          IMAGE,
          "sh",
          "-c",
          "echo mutated > /workspace/kept.txt",
        ])
        expect(write.exitCode).not.toBe(0)
        expect(`${write.stderr}${write.stdout}`.toLowerCase()).toContain("read-only")

        // The case `docker exec` into the keeper could never serve: compute
        // dropped, volume retained.
        await p.release(threadId)
        const gone = await docker.run(["ps", "-aq", "--filter", `name=^${keeperFor(threadId)}$`])
        expect(gone.stdout.trim()).toBe("")

        const inspection = await withWorkspaceReader(
          dockerSandbox({ scope: readerScope, image: IMAGE }),
          { threadId, signal: ctx("/").signal },
          (r) => inspectWorkspace(r),
        )
        expect(inspection.files["kept.txt"]).toBe("durable\n")
      } finally {
        await p.destroy(threadId)
      }
    })

    test("a destroyed thread has no workspace to read", { timeout: 120_000 }, async () => {
      const docker = createDocker()
      const p = dockerSandbox({ scope: readerScope, image: IMAGE })
      const threadId = `read-gone-${randomUUID()}`
      const volume = `b4-sbx-vol-${resourceScope(readerScope)(threadId)}`
      await p.acquire({ threadId, policy: policyDeny, signal: ctx("/").signal })
      await p.destroy(threadId)
      await expect(
        withWorkspaceReader(p, { threadId, signal: ctx("/").signal }, async () => undefined),
      ).rejects.toMatchObject({ code: "B4_E2001" })

      // A failed open must leave no workspace behind. This covers the ordered
      // path only — the volume is already gone when `open` inspects it, so no
      // container is ever started. The dangerous case is the RACE (volume
      // present at inspect, destroyed before the run), which a named-volume
      // mount would resurrect and which no test can schedule deterministically.
      // What actually guards that is the mount FORM, pinned by the unit test
      // "mounts the thread volume read-only into a hardened, networkless
      // container": `--mount type=bind` cannot create anything, `-v name:...`
      // can. Reverting the form reds that unit test, not this one.
      const revived = await docker.run(["volume", "inspect", volume])
      expect(revived.exitCode).not.toBe(0)
    })
  })
})

const resourceId = resourceScope("sandbox-test")

test.skipIf(!enabled)(
  "scoped storage survives provider restart and isolated destruction",
  async () => {
    const threadId = randomUUID()
    const create = (scope: string) => dockerSandbox({ image: IMAGE, scope })
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

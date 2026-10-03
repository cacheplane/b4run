import type { SandboxProvider } from "@b4run/workspace"
import { inspectWorkspace, withWorkspaceReader } from "@b4run/workspace"
import { expect, test } from "vitest"

const ctx = (workspaceRoot: string) => ({ signal: new AbortController().signal, workspaceRoot })
const policy = { network: { mode: "allow" } } as const

export async function runProviderConformanceCase<T>(
  provider: Pick<SandboxProvider, "destroy">,
  threadIds: readonly string[],
  body: () => T | Promise<T>,
): Promise<T> {
  let bodyResult: T | undefined
  let bodyFailure: unknown
  let bodyPassed = false
  try {
    bodyResult = await body()
    bodyPassed = true
  } catch (error) {
    bodyFailure = error
  }

  const cleanupResults = await Promise.allSettled(
    threadIds.map((threadId) => Promise.resolve().then(() => provider.destroy(threadId))),
  )
  const cleanupFailures = cleanupResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  )

  if (!bodyPassed) {
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [bodyFailure, ...cleanupFailures],
        "SandboxProvider conformance body and cleanup failed",
      )
    }
    throw bodyFailure
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "SandboxProvider conformance cleanup failed")
  }
  return bodyResult as T
}

/**
 * The contract every SandboxProvider must satisfy. Reused by fakeSandbox (CI)
 * and dockerSandbox (gated Docker lane) so the fake cannot drift from reality.
 * Pass vitest's `describe` so the kit can group under any runner.
 */
export function runProviderConformance(opts: {
  readonly name: string
  readonly makeProvider: () => SandboxProvider
  readonly describe: (name: string, fn: () => void) => void
  /**
   * Declare the optional `openWorkspaceReader` capability. `true` registers the
   * workspace-read contract; omitted asserts the provider genuinely does not
   * implement it. Either way no test is skipped.
   */
  readonly workspaceReads?: boolean
}): void {
  opts.describe(`SandboxProvider conformance: ${opts.name}`, () => {
    test("acquire is idempotent per thread and reattaches the workspace", async () => {
      const p = opts.makeProvider()
      await runProviderConformanceCase(p, ["t1"], async () => {
        const a = await p.acquire({ threadId: "t1", policy, signal: ctx("/").signal })
        await a.filesystem.writeFile(`${a.workspaceRoot}/x`, "1", ctx(a.workspaceRoot))
        const b = await p.acquire({ threadId: "t1", policy, signal: ctx("/").signal })
        expect(await b.filesystem.readFile(`${b.workspaceRoot}/x`, ctx(b.workspaceRoot))).toBe("1")
      })
    })

    test("threads are isolated", async () => {
      const p = opts.makeProvider()
      await runProviderConformanceCase(p, ["a", "b"], async () => {
        const a = await p.acquire({ threadId: "a", policy, signal: ctx("/").signal })
        await a.filesystem.writeFile(`${a.workspaceRoot}/secret`, "s", ctx(a.workspaceRoot))
        const b = await p.acquire({ threadId: "b", policy, signal: ctx("/").signal })
        expect(await b.filesystem.listDir(b.workspaceRoot, ctx(b.workspaceRoot))).not.toContain(
          "secret",
        )
      })
    })

    test("release keeps the volume, destroy clears it", async () => {
      const p = opts.makeProvider()
      await runProviderConformanceCase(p, ["t"], async () => {
        const a = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        await a.filesystem.writeFile(`${a.workspaceRoot}/keep`, "1", ctx(a.workspaceRoot))
        await p.release("t")
        const r = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        expect(await r.filesystem.readFile(`${r.workspaceRoot}/keep`, ctx(r.workspaceRoot))).toBe(
          "1",
        )
        await p.destroy("t")
        const d = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        expect(await d.filesystem.listDir(d.workspaceRoot, ctx(d.workspaceRoot))).not.toContain(
          "keep",
        )
      })
    })

    test("exec returns a numeric exit code", async () => {
      const p = opts.makeProvider()
      await runProviderConformanceCase(p, ["t"], async () => {
        const a = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        const r = await a.exec.runCommand({ command: "true" }, ctx(a.workspaceRoot))
        expect(typeof r.exitCode).toBe("number")
      })
    })

    /**
     * `openWorkspaceReader` is optional — a provider whose storage cannot be
     * attached twice is expected to omit it — so the caller DECLARES it via
     * `workspaceReads` and the kit verifies the declaration.
     *
     * Declaring rather than probing is deliberate, twice over. Probing at
     * collection time would construct a provider even inside a skipped suite,
     * which the gated cluster providers cannot survive. Probing inside a test
     * body and skipping would emit a skipped/pending test, and the Kubernetes
     * compatibility harness refuses those outright
     * (`scripts/kubernetes-compat/report.ts`) precisely so a silent skip cannot
     * stand in for a contract nobody checked. So: no skips, and the honesty
     * test below closes the gap a bare declaration would open.
     */
    test("declares its workspace read capability honestly", async () => {
      const p = opts.makeProvider()
      if (opts.workspaceReads === true) {
        expect(typeof p.openWorkspaceReader).toBe("function")
      } else {
        expect(p.openWorkspaceReader).toBeUndefined()
      }
    })

    const readerTest = (name: string, body: (provider: SandboxProvider) => Promise<void>): void => {
      if (opts.workspaceReads !== true) return
      test(name, () => body(opts.makeProvider()))
    }

    readerTest("a workspace reader sees what the thread produced", async (p) => {
      await runProviderConformanceCase(p, ["t"], async () => {
        const a = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        await a.filesystem.writeFile(`${a.workspaceRoot}/produced.txt`, "out", ctx(a.workspaceRoot))
        const inspection = await withWorkspaceReader(
          p,
          { threadId: "t", signal: ctx("/").signal },
          (r) => inspectWorkspace(r),
        )
        expect(inspection.files["produced.txt"]).toBe("out")
      })
    })

    readerTest("a workspace reader exposes no write and no exec surface", async (p) => {
      await runProviderConformanceCase(p, ["t"], async () => {
        await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        await withWorkspaceReader(p, { threadId: "t", signal: ctx("/").signal }, async (r) => {
          const surface = r as unknown as Record<string, unknown>
          for (const member of ["writeFile", "mkdir", "removeFile", "touchFile"]) {
            expect(surface.filesystem).not.toHaveProperty(member)
          }
          expect(surface).not.toHaveProperty("exec")
        })
      })
    })

    readerTest("opening a reader for a thread with no workspace storage rejects", async (p) => {
      await runProviderConformanceCase(p, ["t"], async () => {
        await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        await p.destroy("t")
        await expect(
          withWorkspaceReader(p, { threadId: "t", signal: ctx("/").signal }, async () => undefined),
        ).rejects.toThrow()
      })
    })

    readerTest("reading a workspace leaves the thread's sandbox usable", async (p) => {
      await runProviderConformanceCase(p, ["t"], async () => {
        const a = await p.acquire({ threadId: "t", policy, signal: ctx("/").signal })
        await a.filesystem.writeFile(`${a.workspaceRoot}/before`, "1", ctx(a.workspaceRoot))
        await withWorkspaceReader(p, { threadId: "t", signal: ctx("/").signal }, (r) =>
          inspectWorkspace(r),
        )
        // The same handle the worker holds: still reads, still writes, still execs.
        expect(await a.filesystem.readFile(`${a.workspaceRoot}/before`, ctx(a.workspaceRoot))).toBe(
          "1",
        )
        await a.filesystem.writeFile(`${a.workspaceRoot}/after`, "2", ctx(a.workspaceRoot))
        expect(await a.filesystem.readFile(`${a.workspaceRoot}/after`, ctx(a.workspaceRoot))).toBe(
          "2",
        )
        const r = await a.exec.runCommand({ command: "true" }, ctx(a.workspaceRoot))
        expect(r.exitCode).toBe(0)
      })
    })
  })
}

import { fork } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { withCleanup } from "./support/recovery/cleanup.ts"
import { RecoveryCoordinator } from "./support/recovery/coordinator.ts"
import { RecoveryDocker } from "./support/recovery/docker.ts"
import { loadFixtureManifest } from "./support/recovery/manifest.ts"
import { RecoveryStore } from "./support/recovery/store.ts"
import type { Attempt, FaultPoint, WorkspaceRecord } from "./support/recovery/types.ts"

const enabled = process.env.B4_TEST_DOCKER === "1"
const image = process.env.B4_RECOVERY_IMAGE ?? "b4-code-fixer-recovery:local"
async function evidence(value: object): Promise<void> {
  if (process.env.B4_RECOVERY_EVIDENCE)
    await appendFile(process.env.B4_RECOVERY_EVIDENCE, `${JSON.stringify(value)}\n`)
}

interface WorkerResult {
  kind: string
  record?: WorkspaceRecord
  baseline?: string
  edit?: string
  message?: string
}
function worker(input: object): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./support/recovery/worker.ts", import.meta.url)),
      [JSON.stringify(input)],
      { silent: true, execArgv: [] },
    )
    let result: WorkerResult | undefined
    let errors = ""
    let timedOut = false
    child.stderr?.on("data", (chunk) => {
      errors += String(chunk)
    })
    child.stdout?.resume()
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, 90_000)
    child.on("message", (message) => {
      result = message as WorkerResult
      if (result.kind === "paused") child.kill("SIGKILL")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("exit", (code, signal) => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`Worker timed out: ${errors}`))
      else if (result?.kind === "paused" && signal === "SIGKILL") resolve(result)
      else if (code === 0 && result?.kind === "done") resolve(result)
      else reject(new Error(`${result?.message ?? "Worker failed"}: ${errors}`))
    })
  })
}

describe.skipIf(!enabled)("workspace recovery physical generations", { timeout: 120_000 }, () => {
  for (const fixture of ["cli-flags", "nullable-inputs"] as const) {
    test(`${fixture}: prepare, stop, attach, edit, release and reconnect`, async () => {
      const resources = new RecoveryDocker()
      const id = randomUUID()
      const a: Attempt = {
        installationId: id,
        logicalId: fixture,
        generationId: id,
        imageId: await resources.resolveImage(image),
        volumeName: `b4-recovery-${id}`,
        preparerName: `b4-recovery-prep-${id}`,
        sessionName: `b4-recovery-session-${id}`,
      }
      const source = await loadFixtureManifest(fixture)
      await withCleanup(
        async () => {
          const start = performance.now()
          await resources.prepare(a, source, a.imageId)
          await expect(resources.attach(a, a.imageId)).rejects.toThrow("Preparer still running")
          await resources.stop(a)
          expect((await resources.inspect(a)).preparer?.running).toBe(false)
          const prepared = performance.now()
          const session = await resources.attach(a, a.imageId)
          const baseline = resources.result(
            await resources.docker.exec(session, ["git", "rev-parse", "HEAD"]),
          )
          resources.result(
            await resources.docker.exec(session, [
              "node",
              "-e",
              "require('fs').writeFileSync('edit.txt','retained edit')",
            ]),
          )
          await resources.release(a)
          const released = performance.now()
          const fresh = new RecoveryDocker()
          const restarted = await fresh.attach(a, a.imageId)
          expect(fresh.result(await fresh.docker.exec(restarted, ["cat", "edit.txt"]))).toBe(
            "retained edit",
          )
          expect(
            fresh.result(await fresh.docker.exec(restarted, ["git", "rev-parse", "HEAD"])),
          ).toBe(baseline)
          await evidence({
            fixture,
            digest: source.digest,
            imageId: a.imageId,
            baseline,
            preparationMs: prepared - start,
            reattachmentMs: performance.now() - released,
          })
        },
        async () => {
          await resources.destroy(a)
          expect(await resources.inspect(a)).toEqual({ volume: false })
        },
      )
    })
  }
})

describe.skipIf(!enabled)("workspace recovery across host processes", { timeout: 120_000 }, () => {
  test("missing selected Docker storage is reported without reseeding", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "b4-recovery-lost-"))
    const resources = new RecoveryDocker()
    const store = RecoveryStore.open(stateDir)
    const coordinator = new RecoveryCoordinator(store, resources)
    await withCleanup(
      async () => {
        const session = await coordinator.create(
          "lost",
          await loadFixtureManifest("cli-flags"),
          await resources.resolveImage(image),
        )
        await coordinator.release("lost")
        await resources.destroy(session.record.attempt)
        await expect(coordinator.reconnect("lost")).rejects.toMatchObject({
          code: "lost-workspace",
        })
        expect(await resources.hasResources(store.installationId, "lost")).toBe(false)
      },
      async () => {
        try {
          if (store.get("lost")) await coordinator.destroy("lost")
        } catch (error) {
          throw new Error(`Cleanup failed; records retained at ${stateDir}`, { cause: error })
        } finally {
          store.close()
        }
        await rm(stateDir, { recursive: true, force: true })
      },
    )
  })

  test("foreign labeled Docker volume is refused and left untouched", async () => {
    const resources = new RecoveryDocker()
    const id = randomUUID()
    const a: Attempt = {
      installationId: id,
      logicalId: "foreign",
      generationId: id,
      imageId: await resources.resolveImage(image),
      volumeName: `b4-recovery-foreign-${id}`,
      preparerName: `b4-recovery-prepare-${id}`,
      sessionName: `b4-recovery-session-${id}`,
    }
    await resources.checked([
      "volume",
      "create",
      "--label",
      `b4.recovery.installation=foreign-${id}`,
      a.volumeName,
    ])
    await withCleanup(
      async () => {
        await expect(resources.destroy(a)).rejects.toThrow("ownership")
        expect(
          (await resources.checked(["volume", "ls", "--format", "{{.Name}}"])).split("\n"),
        ).toContain(a.volumeName)
      },
      async () => {
        // This harness created the foreign test resource; the coordinator has no authority over it.
        await resources.checked(["volume", "rm", a.volumeName])
      },
    )
  })

  for (const fixture of ["cli-flags", "nullable-inputs"] as const) {
    for (const pause of [undefined, "copying", "stopped", "published"] as const) {
      test(`${fixture}: ${pause ?? "edited ready workspace"} host restart`, async () => {
        const stateDir = await mkdtemp(join(tmpdir(), "b4-recovery-process-"))
        const input = { stateDir, logicalId: fixture, fixture, image }
        const resources = new RecoveryDocker()
        let oldAttempt: Attempt | undefined
        await withCleanup(
          async () => {
            const first = await worker({
              ...input,
              command: "create",
              ...(pause ? { pause } : { edit: true }),
            })
            expect(first.kind).toBe(pause ? "paused" : "done")
            const inspected = RecoveryStore.open(stateDir)
            oldAttempt = inspected.get(fixture)?.attempt
            inspected.close()
            if (!oldAttempt) throw new Error("Missing persisted attempt")
            const second = await worker({ ...input, command: "reconnect" })
            expect(second.kind).toBe("done")
            expect(second.record?.status).toBe("ready")
            if (!pause) {
              expect(second.edit).toBe("// retained after host restart")
              expect(second.baseline).toBe(first.baseline)
            }
            if (pause === "copying" || pause === "stopped") {
              expect(second.record?.attempt.generationId).not.toBe(oldAttempt?.generationId)
              expect(await resources.inspect(oldAttempt)).toEqual({ volume: false })
            } else expect(second.record?.attempt.generationId).toBe(oldAttempt?.generationId)
            await evidence({
              fixture,
              pause: pause ?? "ready",
              source: second.record?.source.digest,
              imageId: second.record?.imageId,
              baseline: second.baseline,
            })
          },
          async () => {
            const store = RecoveryStore.open(stateDir)
            try {
              const record = store.get(fixture)
              if (record) {
                await new RecoveryCoordinator(store, resources).destroy(fixture)
                expect(await resources.inspect(record.attempt)).toEqual({ volume: false })
              }
            } catch (error) {
              throw new Error(`Cleanup failed; recovery records retained at ${stateDir}`, {
                cause: error,
              })
            } finally {
              store.close()
            }
            await rm(stateDir, { recursive: true, force: true })
          },
        )
      })
    }
  }

  test("interrupted deletion resumes without attachment", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "b4-recovery-delete-"))
    const input = { stateDir, logicalId: "delete", fixture: "cli-flags", image }
    await withCleanup(
      async () => {
        const created = await worker({ ...input, command: "create" })
        if (!created.record) throw new Error("Missing created record")
        expect(
          (await worker({ ...input, command: "destroy", pause: "deleting" satisfies FaultPoint }))
            .kind,
        ).toBe("paused")
        await expect(worker({ ...input, command: "reconnect" })).rejects.toThrow()
        await worker({ ...input, command: "destroy" })
        expect(await new RecoveryDocker().inspect(created.record.attempt)).toEqual({
          volume: false,
        })
      },
      async () => {
        const store = RecoveryStore.open(stateDir)
        try {
          if (store.get("delete"))
            await new RecoveryCoordinator(store, new RecoveryDocker()).destroy("delete")
        } catch (error) {
          throw new Error(`Cleanup failed; recovery records retained at ${stateDir}`, {
            cause: error,
          })
        } finally {
          store.close()
        }
        await rm(stateDir, { recursive: true, force: true })
      },
    )
  })
})

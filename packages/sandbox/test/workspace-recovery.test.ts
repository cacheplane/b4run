import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RecoveryCoordinator, RecoveryError } from "./support/recovery/coordinator.ts"
import { makeManifest } from "./support/recovery/manifest.ts"
import { RecoveryStore } from "./support/recovery/store.ts"
import type {
  Attempt,
  FaultHook,
  FaultPoint,
  RecoveryResources,
  SourceManifest,
} from "./support/recovery/types.ts"

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected test value")
  return value
}

const source = makeManifest(
  [{ path: "index.ts", content: "original", executable: false }],
  "/opt/fixtures/cli-flags/node_modules",
)
const imageId = "sha256:fixture"
type Physical = {
  attempt: Attempt
  content: string
  running: boolean
  session?: string
  sessionRunning?: boolean
}
class FakeResources implements RecoveryResources {
  volumes = new Map<string, Physical>()
  events: string[] = []
  fault: FaultHook = () => {}
  failInspect = false
  failStop = false
  failDestroy = false
  ignoreStop = false
  ignoreDestroy = false
  failAttachResponse = false
  sessionSequence = 0
  async hasResources(installationId: string, logicalId: string) {
    return [...this.volumes.values()].some(
      ({ attempt }) => attempt.installationId === installationId && attempt.logicalId === logicalId,
    )
  }
  async prepare(attempt: Attempt, manifest: SourceManifest): Promise<void> {
    this.events.push(`prepare:${attempt.generationId}`)
    const state = { attempt: structuredClone(attempt), content: "partial", running: true }
    this.volumes.set(attempt.volumeName, state)
    await this.fault("created", attempt)
    await this.fault("copying", attempt)
    state.content = required(manifest.files[0]).content
    attempt.preparerId = `preparer-${attempt.generationId}`
  }
  async inspect(attempt: Attempt) {
    if (this.failInspect) throw new RecoveryError("unavailable", "inspection unknown")
    const state = this.volumes.get(attempt.volumeName)
    if (state && state.attempt.generationId !== attempt.generationId)
      throw new RecoveryError("conflict", "foreign generation")
    return {
      volume: !!state,
      ...(state
        ? { preparer: { id: `preparer-${attempt.generationId}`, running: state.running } }
        : {}),
      ...(state?.session
        ? { session: { id: state.session, running: state.sessionRunning ?? false } }
        : {}),
    }
  }
  async stop(attempt: Attempt) {
    this.events.push(`stop:${attempt.generationId}`)
    if (this.failStop) throw new RecoveryError("unavailable", "stop unknown")
    const state = this.volumes.get(attempt.volumeName)
    if (state && !this.ignoreStop) {
      state.running = false
      state.sessionRunning = false
    }
  }
  async attach(attempt: Attempt) {
    const state = required(this.volumes.get(attempt.volumeName))
    expect(state.running).toBe(false)
    this.events.push(`attach:${attempt.generationId}`)
    state.session ??= `session-${attempt.generationId}-${++this.sessionSequence}`
    state.sessionRunning = true
    attempt.sessionId = state.session
    if (this.failAttachResponse) throw new Error("lost attach response")
    return state.session
  }
  async release(attempt: Attempt) {
    this.events.push(`release:${attempt.generationId}`)
    const state = this.volumes.get(attempt.volumeName)
    if (state) delete state.session
    delete attempt.sessionId
  }
  async destroy(attempt: Attempt) {
    this.events.push(`destroy:${attempt.generationId}`)
    if (this.failDestroy) throw new RecoveryError("unavailable", "cleanup failed")
    expect(this.volumes.get(attempt.volumeName)?.running ?? false).toBe(false)
    if (!this.ignoreDestroy) this.volumes.delete(attempt.volumeName)
  }
}
function crashAt(point: FaultPoint): FaultHook {
  return (current) => {
    if (current === point) throw new Error(`crash:${point}`)
  }
}

describe("experimental workspace recovery coordinator", () => {
  let directory: string
  let store: RecoveryStore
  let resources: FakeResources
  let coordinator: RecoveryCoordinator
  function restart(fault?: FaultHook) {
    store.close()
    store = RecoveryStore.open(directory)
    coordinator = new RecoveryCoordinator(store, resources, fault)
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "b4-recovery-coordinator-"))
    store = RecoveryStore.open(directory)
    resources = new FakeResources()
    coordinator = new RecoveryCoordinator(store, resources)
  })
  afterEach(() => {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it("publishes only stopped preparation and preserves edits and provenance on release/restart", async () => {
    const initial = await coordinator.create("workspace", source, imageId)
    expect(initial.record.status).toBe("ready")
    expect(store.get("workspace")?.attempt.sessionId).toBe(initial.sessionId)
    required(resources.volumes.get(initial.record.attempt.volumeName)).content = "user edit"
    await coordinator.release("workspace")
    restart()
    const resumed = await coordinator.reconnect("workspace")
    expect(resumed.record.attempt.generationId).toBe(initial.record.attempt.generationId)
    expect(resources.volumes.get(resumed.record.attempt.volumeName)?.content).toBe("user edit")
    expect(resources.events.filter((event) => event.startsWith("prepare:"))).toHaveLength(1)
    expect(resumed.record.imageId).toBe(imageId)
  })

  it.each(["intent", "created", "copying", "validated", "stopped"] as const)(
    "replaces unpublished attempt after crash at %s without partial attachment",
    async (point) => {
      resources.fault = crashAt(point)
      coordinator = new RecoveryCoordinator(store, resources, crashAt(point))
      await expect(coordinator.create("workspace", source, imageId)).rejects.toThrow(
        `crash:${point}`,
      )
      const abandoned = required(store.get("workspace")).attempt
      expect(resources.events.some((event) => event.startsWith("attach:"))).toBe(false)
      resources.fault = () => {}
      restart()
      const resumed = await coordinator.reconnect("workspace")
      expect(resumed.record.attempt.generationId).not.toBe(abandoned.generationId)
      expect(resources.volumes.has(abandoned.volumeName)).toBe(false)
      expect(resources.volumes.get(resumed.record.attempt.volumeName)?.content).toBe("original")
      expect(resources.events.indexOf(`stop:${abandoned.generationId}`)).toBeLessThan(
        resources.events.indexOf(`destroy:${abandoned.generationId}`),
      )
    },
  )

  it("reuses published generation after lost publication response", async () => {
    coordinator = new RecoveryCoordinator(store, resources, crashAt("published"))
    await expect(coordinator.create("workspace", source, imageId)).rejects.toThrow(
      "crash:published",
    )
    const selected = required(store.get("workspace"))
    restart()
    expect(
      (await coordinator.create("workspace", source, imageId)).record.attempt.generationId,
    ).toBe(selected.attempt.generationId)
    expect(resources.events.filter((event) => event.startsWith("prepare:"))).toHaveLength(1)
  })

  it.each(["failInspect", "failStop"] as const)(
    "refuses replacement when %s leaves abandoned compute unresolved",
    async (failure) => {
      resources.fault = crashAt("copying")
      await expect(coordinator.create("workspace", source, imageId)).rejects.toThrow(
        "crash:copying",
      )
      const abandoned = required(store.get("workspace"))
      resources[failure] = true
      restart()
      await expect(coordinator.reconnect("workspace")).rejects.toMatchObject({
        code: "unavailable",
      })
      expect(store.get("workspace")?.attempt.generationId).toBe(abandoned.attempt.generationId)
      expect(resources.events.some((event) => event.startsWith("destroy:"))).toBe(false)
      expect(store.get("workspace")?.status).toBe("preparing")
    },
  )

  it("preserves abandoned attempt metadata when cleanup fails and retries it", async () => {
    resources.fault = crashAt("created")
    await expect(coordinator.create("workspace", source, imageId)).rejects.toThrow("crash:created")
    const abandoned = required(store.get("workspace"))
    resources.failDestroy = true
    restart()
    await expect(coordinator.reconnect("workspace")).rejects.toThrow("cleanup failed")
    expect(store.get("workspace")?.attempt.generationId).toBe(abandoned.attempt.generationId)
    resources.failDestroy = false
    resources.fault = () => {}
    restart()
    await coordinator.reconnect("workspace")
    expect(resources.volumes.has(abandoned.attempt.volumeName)).toBe(false)
  })

  it("reports lost selected storage without substitution", async () => {
    const selected = await coordinator.create("workspace", source, imageId)
    resources.volumes.delete(selected.record.attempt.volumeName)
    restart()
    await expect(coordinator.reconnect("workspace")).rejects.toMatchObject({
      code: "lost-workspace",
    })
    expect(resources.events.filter((event) => event.startsWith("prepare:"))).toHaveLength(1)
  })

  it("rejects conflicting intent and leaves unrelated generations untouched", async () => {
    const selected = await coordinator.create("workspace", source, imageId)
    const other = await coordinator.create("other", source, imageId)
    const changed = makeManifest(
      [{ path: "index.ts", content: "new default", executable: false }],
      source.dependencyTarget,
    )
    await expect(coordinator.create("workspace", changed, imageId)).rejects.toMatchObject({
      code: "conflict",
    })
    await expect(
      coordinator.create("workspace", source, "sha256:new-default"),
    ).rejects.toMatchObject({ code: "conflict" })
    await coordinator.destroy("workspace")
    expect(resources.volumes.has(selected.record.attempt.volumeName)).toBe(false)
    expect(resources.volumes.has(other.record.attempt.volumeName)).toBe(true)
  })

  it("leaves foreign resources intact", async () => {
    resources.fault = crashAt("created")
    await expect(coordinator.create("workspace", source, imageId)).rejects.toThrow("crash:created")
    const abandoned = required(store.get("workspace"))
    required(resources.volumes.get(abandoned.attempt.volumeName)).attempt.generationId = "foreign"
    restart()
    await expect(coordinator.reconnect("workspace")).rejects.toMatchObject({ code: "conflict" })
    expect(resources.events.some((event) => event.startsWith("destroy:"))).toBe(false)
  })

  it.each(["deleting", "cleanup"] as const)(
    "retains deletion intent across %s interruption and blocks attachment",
    async (failure) => {
      await coordinator.create("workspace", source, imageId)
      if (failure === "deleting")
        coordinator = new RecoveryCoordinator(store, resources, crashAt("deleting"))
      else resources.failDestroy = true
      await expect(coordinator.destroy("workspace")).rejects.toThrow()
      expect(store.get("workspace")?.status).toBe("deleting")
      resources.failDestroy = false
      restart()
      const attaches = resources.events.filter((event) => event.startsWith("attach:")).length
      await expect(coordinator.reconnect("workspace")).rejects.toMatchObject({ code: "conflict" })
      await coordinator.destroy("workspace")
      expect(store.get("workspace")?.status).toBe("deleted")
      expect(resources.volumes.size).toBe(0)
      expect(resources.events.filter((event) => event.startsWith("attach:"))).toHaveLength(attaches)
    },
  )
  it("requires observed stopped state even when stop reports success", async () => {
    resources.ignoreStop = true
    await expect(coordinator.create("workspace", source, imageId)).rejects.toMatchObject({
      code: "unavailable",
    })
    expect(store.get("workspace")?.status).toBe("preparing")
    expect(resources.events.some((event) => event.startsWith("attach:"))).toBe(false)
    restart()
    await expect(coordinator.reconnect("workspace")).rejects.toMatchObject({ code: "unavailable" })
    expect(resources.events.some((event) => event.startsWith("destroy:"))).toBe(false)
  })

  it("does not mark deletion complete on an unconfirmed successful removal", async () => {
    await coordinator.create("workspace", source, imageId)
    resources.ignoreDestroy = true
    await expect(coordinator.destroy("workspace")).rejects.toMatchObject({ code: "unavailable" })
    expect(store.get("workspace")?.status).toBe("deleting")
    expect(resources.volumes.size).toBe(1)
  })

  it("discovers and pins a session after its create response was lost without preparing again", async () => {
    resources.failAttachResponse = true
    await expect(coordinator.create("workspace", source, imageId)).rejects.toThrow(
      "lost attach response",
    )
    const before = required(store.get("workspace"))
    expect(before.status).toBe("ready")
    expect(before.attempt.sessionId).toBeUndefined()
    resources.failAttachResponse = false
    restart()
    const resumed = await coordinator.reconnect("workspace")
    expect(store.get("workspace")?.attempt.sessionId).toBe(resumed.sessionId)
    expect(resources.events.filter((event) => event.startsWith("prepare:"))).toHaveLength(1)
  })

  it("recovers a lost replacement attachment response after release removed the pinned session", async () => {
    const initial = await coordinator.create("workspace", source, imageId)
    // The daemon completed release, but the host died before committing pin removal.
    await resources.release(structuredClone(initial.record.attempt))
    expect(store.get("workspace")?.attempt.sessionId).toBe(initial.sessionId)
    restart()
    resources.failAttachResponse = true
    await expect(coordinator.reconnect("workspace")).rejects.toThrow("lost attach response")
    const replacementId = required(resources.volumes.get(initial.record.attempt.volumeName)).session
    expect(replacementId).not.toBe(initial.sessionId)
    resources.failAttachResponse = false
    restart()
    const resumed = await coordinator.reconnect("workspace")
    expect(resumed.sessionId).toBe(replacementId)
    expect(store.get("workspace")?.attempt.sessionId).toBe(replacementId)
    expect(resources.events.filter((event) => event.startsWith("prepare:"))).toHaveLength(1)
  })

  it("rejects immutable physical ID replacement before attachment or destruction", async () => {
    const selected = await coordinator.create("workspace", source, imageId)
    required(resources.volumes.get(selected.record.attempt.volumeName)).session = "replacement-id"
    await expect(coordinator.reconnect("workspace")).rejects.toMatchObject({ code: "conflict" })
    await expect(coordinator.destroy("workspace")).rejects.toMatchObject({ code: "conflict" })
    expect(resources.events.some((event) => event.startsWith("destroy:"))).toBe(false)
    expect(resources.volumes.size).toBe(1)
  })

  it("rejects invalid source digest before recording or creating resources", async () => {
    await expect(
      coordinator.create("workspace", { ...source, digest: "forged" }, imageId),
    ).rejects.toMatchObject({ code: "conflict" })
    expect(store.get("workspace")).toBeUndefined()
    expect(resources.events).toEqual([])
  })

  it("refuses attachment when metadata is missing", async () => {
    await expect(coordinator.reconnect("unknown")).rejects.toMatchObject({ code: "not-found" })
    expect(resources.events).toEqual([])
  })
  it("refuses a new create when orphan resources exist for its logical identity", async () => {
    const orphan: Attempt = {
      installationId: store.installationId,
      logicalId: "workspace",
      generationId: "orphan",
      imageId,
      volumeName: "orphan-volume",
      preparerName: "orphan-preparer",
      sessionName: "orphan-session",
    }
    resources.volumes.set(orphan.volumeName, {
      attempt: orphan,
      content: "preserve",
      running: false,
    })
    await expect(coordinator.create("workspace", source, imageId)).rejects.toMatchObject({
      code: "conflict",
    })
    expect(store.get("workspace")).toBeUndefined()
    expect(resources.volumes.get(orphan.volumeName)?.content).toBe("preserve")
    expect(resources.events).toEqual([])
  })

  it("rejects overlapping lifecycle calls before they can recover an active preparation", async () => {
    let resume: () => void = () => {}
    let entered: () => void = () => {}
    const preparing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const paused = new Promise<void>((resolve) => {
      resume = resolve
    })
    resources.fault = async (point) => {
      if (point === "copying") {
        entered()
        await paused
      }
    }
    const first = coordinator.create("workspace", source, imageId)
    await preparing
    try {
      await expect(coordinator.create("workspace", source, imageId)).rejects.toMatchObject({
        code: "unavailable",
      })
      await expect(coordinator.destroy("workspace")).rejects.toMatchObject({ code: "unavailable" })
      expect(
        resources.events.some((event) => event.startsWith("stop:") || event.startsWith("destroy:")),
      ).toBe(false)
    } finally {
      resume()
      await first
    }
  })
})

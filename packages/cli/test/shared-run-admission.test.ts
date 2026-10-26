import { deny } from "@b4run/sdk"
import { MemorySaver } from "@langchain/langgraph"
import { expect, test, vi } from "vitest"
import { createRuntimeFetchHandler } from "../src/lib/dev/runtime-fetch-core.js"
import {
  chatFixtureApp,
  fakeMemoryStore,
  fakePermissionsStore,
  inMemoryFilesystem,
  memoryThreadsStore,
  simpleScript,
} from "./helpers/fetch-entry-fixture.js"
import {
  buildStaticModulesForFixture,
  cleanup,
  withAimock,
} from "./helpers/static-modules-fixture.js"

function blockedAdmission() {
  return {
    signal: new AbortController().signal,
    tryAcquire: vi.fn(async (_threadId: string) => false),
    release: vi.fn(async () => {}),
  }
}

function aguiRequest(threadId = "shared-thread") {
  return new Request(`http://localhost/agui/${encodeURIComponent("/chat#agent")}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify({
      threadId,
      runId: crypto.randomUUID(),
      messages: [{ id: "user", role: "user", content: "hello from the bundle" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  })
}

async function fixture(
  admission: ReturnType<typeof blockedAdmission>,
  denied = false,
  onDispose?: () => Promise<void>,
) {
  const appRoot = await chatFixtureApp()
  const modules = await buildStaticModulesForFixture(appRoot)
  const { store: threadsStore } = memoryThreadsStore()
  const handler = await createRuntimeFetchHandler({
    appRoot,
    config: { backends: { filesystem: inMemoryFilesystem() } },
    modules,
    ...(denied ? { threadAccess: { fallback: () => deny({ status: 403 as const }) } } : {}),
    requestStores: () => ({
      checkpointer: new MemorySaver(),
      threadsStore,
      memoryStore: fakeMemoryStore(),
      permissionsStore: fakePermissionsStore(),
      runAdmission: admission,
      ...(onDispose ? { dispose: onDispose } : {}),
    }),
  })
  return { handler, threadsStore }
}

async function dispose(handler: Awaited<ReturnType<typeof fixture>>["handler"]) {
  await handler.close()
  for (const fn of cleanup.splice(0).reverse()) await fn()
}

test("AG-UI refuses another replica's run before creating a thread or starting a stream", async () => {
  const admission = blockedAdmission()
  const { handler, threadsStore } = await fixture(admission)
  try {
    const response = await handler.fetch(aguiRequest())
    if (response.status === 200) await response.body?.cancel()

    expect(response.status).toBe(409)
    expect(response.headers.get("retry-after")).toBe("1")
    expect(admission.tryAcquire).toHaveBeenCalledWith("shared-thread")
    expect(await threadsStore.getThread("shared-thread")).toBeUndefined()
  } finally {
    await dispose(handler)
  }
}, 60_000)

test("thread authorization rejects before shared ownership is claimed", async () => {
  const admission = blockedAdmission()
  const { handler } = await fixture(admission, true)
  try {
    const response = await handler.fetch(aguiRequest())

    expect(response.status).toBe(403)
    expect(admission.tryAcquire).not.toHaveBeenCalled()
  } finally {
    await dispose(handler)
  }
}, 60_000)

test("DELETE cannot remove checkpoints owned by a run on another replica", async () => {
  const admission = blockedAdmission()
  const { handler, threadsStore } = await fixture(admission)
  await threadsStore.createThread({ thread_id: "shared-thread" })
  try {
    const response = await handler.fetch(
      new Request("http://localhost/threads/shared-thread", { method: "DELETE" }),
    )

    expect(response.status).toBe(409)
    expect(admission.tryAcquire).toHaveBeenCalledWith("shared-thread")
    expect(await threadsStore.getThread("shared-thread")).toBeDefined()
  } finally {
    await dispose(handler)
  }
}, 60_000)

test("successful terminal frames wait for asynchronous shared release", async () => {
  const admission = blockedAdmission()
  admission.tryAcquire.mockResolvedValue(true)
  let releaseStarted!: () => void
  const started = new Promise<void>((resolve) => {
    releaseStarted = resolve
  })
  let finishRelease!: () => void
  const barrier = new Promise<void>((resolve) => {
    finishRelease = resolve
  })
  let released = false
  admission.release.mockImplementation(async () => {
    releaseStarted()
    await barrier
    released = true
  })
  const { handler } = await fixture(admission)
  await withAimock(simpleScript())
  try {
    const response = await handler.fetch(aguiRequest())
    let prematureTerminal = false
    let finished = false
    const consume = (async () => {
      const reader = response.body?.getReader()
      if (!reader) throw new Error("Expected SSE body")
      const decoder = new TextDecoder()
      let text = ""
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        text += decoder.decode(chunk.value)
        if (text.includes('"type":"RUN_FINISHED"')) {
          finished = true
          if (!released) prematureTerminal = true
        }
      }
      return text
    })()
    await started
    // Let a wrongly enqueued success frame reach its consumer while release
    // is held. The correct implementation cannot expose it until the barrier.
    await new Promise((resolve) => setTimeout(resolve, 25))
    finishRelease()
    const text = await consume

    expect(text).toContain("bundled reply")
    expect(finished).toBe(true)
    expect(prematureTerminal).toBe(false)
    expect(admission.release).toHaveBeenCalledTimes(1)
  } finally {
    finishRelease()
    await dispose(handler)
  }
}, 60_000)

for (const endpoint of ["stream", "wait"] as const) {
  test(`Agent Protocol ${endpoint} refuses shared contention before creating the thread`, async () => {
    const admission = blockedAdmission()
    const { handler, threadsStore } = await fixture(admission)
    try {
      const response = await handler.fetch(
        new Request(`http://localhost/threads/shared-thread/runs/${endpoint}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            route: "/chat#agent",
            input: { messages: [{ role: "user", content: "hello" }] },
          }),
        }),
      )
      if (response.status === 200) await response.body?.cancel()

      expect(response.status).toBe(409)
      expect(admission.tryAcquire).toHaveBeenCalledWith("shared-thread")
      expect(await threadsStore.getThread("shared-thread")).toBeUndefined()
    } finally {
      await dispose(handler)
    }
  }, 60_000)
}

test("Agent Protocol resume takes shared ownership before inspecting parked state", async () => {
  const admission = blockedAdmission()
  const { handler, threadsStore } = await fixture(admission)
  await threadsStore.createThread({ thread_id: "shared-thread" })
  try {
    const response = await handler.fetch(
      new Request("http://localhost/threads/shared-thread/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          route: "/chat#agent",
          resume: [{ interruptId: "park", status: "resolved", payload: "once" }],
        }),
      }),
    )

    expect(response.status).toBe(409)
    expect(admission.tryAcquire).toHaveBeenCalledWith("shared-thread")
  } finally {
    await dispose(handler)
  }
}, 60_000)

test("request stores are disposed even when shared release rejects", async () => {
  const admission = blockedAdmission()
  admission.release.mockRejectedValue(new Error("ownership cleanup unavailable"))
  const onDispose = vi.fn(async () => {})
  const { handler } = await fixture(admission, false, onDispose)
  try {
    const response = await handler.fetch(aguiRequest())

    expect(response.status).toBe(409)
    await vi.waitFor(() => expect(onDispose).toHaveBeenCalledTimes(1))
  } finally {
    await dispose(handler)
  }
}, 60_000)

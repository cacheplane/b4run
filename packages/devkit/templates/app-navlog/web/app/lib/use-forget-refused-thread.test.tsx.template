// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { ThreadAccess } from "./thread-access"
import { createLocalThreadSource, type ThreadSource, type WorkbenchThread } from "./thread-source"
import { useForgetRefusedThread } from "./use-forget-refused-thread"

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  }
}

let container: HTMLDivElement
let root: Root
let source: ThreadSource
let check: ReturnType<typeof vi.fn<(id: string, signal: AbortSignal) => Promise<ThreadAccess>>>
let forgotten: WorkbenchThread[]

function Probe({ threads, active }: { threads: readonly WorkbenchThread[]; active: string }) {
  useForgetRefusedThread({
    source,
    threads,
    activeThreadId: active,
    onForgotten: (next) => forgotten.push(next),
    check,
  })
  return null
}

async function render(active: string): Promise<void> {
  await act(async () => {
    root.render(<Probe threads={source.list()} active={active} />)
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  source = createLocalThreadSource(memoryStorage())
  check = vi.fn(async () => "refused" as ThreadAccess)
  forgotten = []
  container = document.createElement("div")
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
})

describe("useForgetRefusedThread", () => {
  test("an opened thread the server refuses is forgotten, and the next one opens", async () => {
    const kept = source.create()
    source.touch(kept.id, "Kept")
    const stale = source.create()
    source.touch(stale.id, "From an earlier visit")
    await render(stale.id)
    expect(check).toHaveBeenCalledWith(stale.id, expect.any(AbortSignal))
    expect(source.list().map((thread) => thread.id)).toEqual([kept.id])
    expect(forgotten.map((thread) => thread.id)).toEqual([kept.id])
  })

  test("an untitled thread is never asked about: it has not run yet", async () => {
    const fresh = source.create()
    await render(fresh.id)
    expect(check).not.toHaveBeenCalled()
  })

  test("a thread that gains its title while open is not asked about", async () => {
    // The first message titles the thread before the run has created it on the
    // server, so asking then would forget a conversation about to exist.
    const fresh = source.create()
    await render(fresh.id)
    source.touch(fresh.id, "Plan a flight")
    await render(fresh.id)
    expect(check).not.toHaveBeenCalled()
    expect(source.list().map((thread) => thread.id)).toEqual([fresh.id])
  })

  test("a thread the server opens, or no answer, is kept", async () => {
    const thread = source.create()
    source.touch(thread.id, "Mine")
    for (const answer of ["open", "unknown"] as const) {
      check.mockResolvedValueOnce(answer)
      await render(thread.id)
      act(() => root.unmount())
      root = createRoot(container)
    }
    expect(source.list().map((entry) => entry.id)).toEqual([thread.id])
    expect(forgotten).toEqual([])
  })
})

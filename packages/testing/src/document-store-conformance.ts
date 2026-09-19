import { ConflictError, type DocumentStore } from "@b4run/sdk"
import { expect, test } from "vitest"

/** The document shape the suite stores. Nested on purpose — see the copy tests. */
interface Doc {
  readonly generation: number
  readonly nested: { readonly items: string[] }
}

const doc = (generation: number): Doc => ({ generation, nested: { items: ["a"] } })

/**
 * The contract every `DocumentStore` must satisfy.
 *
 * ONE suite, answered by the in-process store (always, in `@b4run/testing`'s
 * own tests) and by the Postgres store (gated on a real database). That is the
 * whole point: the memory implementation is not a mock that happens to have
 * the same method names, it is a second implementation of this contract, and
 * this file is what stops the two from drifting apart the moment one of them
 * is fixed.
 *
 * Everything here goes through the public interface, never the tables, so a
 * backend stays free to pick its own column types.
 *
 * Pass vitest's `describe`; `makeStore` returns a FRESH, EMPTY store per call.
 */
export function runDocumentStoreConformance(opts: {
  readonly name: string
  readonly makeStore: () => Promise<DocumentStore<Doc>> | DocumentStore<Doc>
  readonly describe: (name: string, fn: () => void) => void
  readonly close?: (store: DocumentStore<Doc>) => Promise<void> | void
}): void {
  const { name, makeStore, describe, close } = opts
  describe(`DocumentStore conformance: ${name}`, () => {
    test("create returns a key whose document loads at version 0", async () => {
      const s = await makeStore()
      try {
        const key = await s.create(doc(1))
        expect(typeof key).toBe("string")
        expect(key.length).toBeGreaterThan(0)
        const loaded = await s.load(key)
        expect(loaded).toEqual({ version: 0, value: doc(1) })
      } finally {
        await close?.(s)
      }
    })

    test("create generates a distinct key every time", async () => {
      const s = await makeStore()
      try {
        const keys = await Promise.all([s.create(doc(1)), s.create(doc(2)), s.create(doc(3))])
        expect(new Set(keys).size).toBe(3)
      } finally {
        await close?.(s)
      }
    })

    test("load returns undefined for an unknown key", async () => {
      const s = await makeStore()
      try {
        expect(await s.load("nope")).toBeUndefined()
      } finally {
        await close?.(s)
      }
    })

    test("commit at the current version replaces the value and bumps it", async () => {
      const s = await makeStore()
      try {
        const key = await s.create(doc(1))
        await s.commit(key, 0, doc(2))
        expect(await s.load(key)).toEqual({ version: 1, value: doc(2) })
        await s.commit(key, 1, doc(3))
        expect(await s.load(key)).toEqual({ version: 2, value: doc(3) })
      } finally {
        await close?.(s)
      }
    })

    test("commit at a stale version throws ConflictError and changes nothing", async () => {
      // The two-tabs case. The loser must not win by writing second.
      const s = await makeStore()
      try {
        const key = await s.create(doc(1))
        await s.commit(key, 0, doc(2))
        await expect(s.commit(key, 0, doc(99))).rejects.toBeInstanceOf(ConflictError)
        expect(await s.load(key)).toEqual({ version: 1, value: doc(2) })
      } finally {
        await close?.(s)
      }
    })

    test("commit at a version ahead of the document throws ConflictError", async () => {
      const s = await makeStore()
      try {
        const key = await s.create(doc(1))
        await expect(s.commit(key, 7, doc(2))).rejects.toBeInstanceOf(ConflictError)
      } finally {
        await close?.(s)
      }
    })

    test("commit with a number on a missing key throws ConflictError", async () => {
      // Not an insert: quoting a version asserts the document was read, and it
      // was not. The caller has to go round again.
      const s = await makeStore()
      try {
        await expect(s.commit("ghost", 0, doc(1))).rejects.toBeInstanceOf(ConflictError)
        expect(await s.load("ghost")).toBeUndefined()
      } finally {
        await close?.(s)
      }
    })

    test("commit with null inserts under a caller-supplied key at version 0", async () => {
      const s = await makeStore()
      try {
        await s.commit("thread-1", null, doc(1))
        expect(await s.load("thread-1")).toEqual({ version: 0, value: doc(1) })
      } finally {
        await close?.(s)
      }
    })

    test("commit with null on an existing key throws ConflictError", async () => {
      // This is how a binding keyed by someone else's id is claimed exactly
      // once: whoever gets the insert owns it, everyone else is told so.
      const s = await makeStore()
      try {
        await s.commit("thread-1", null, doc(1))
        await expect(s.commit("thread-1", null, doc(2))).rejects.toBeInstanceOf(ConflictError)
        expect(await s.load("thread-1")).toEqual({ version: 0, value: doc(1) })
      } finally {
        await close?.(s)
      }
    })

    test("only one of N concurrent inserts on the same key wins", async () => {
      const s = await makeStore()
      try {
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) => s.commit("claim", null, doc(i))),
        )
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
        for (const r of results) {
          if (r.status === "rejected") expect(r.reason).toBeInstanceOf(ConflictError)
        }
        expect((await s.load("claim"))?.version).toBe(0)
      } finally {
        await close?.(s)
      }
    })

    test("only one of N concurrent commits at the same version wins", async () => {
      const s = await makeStore()
      try {
        const key = await s.create(doc(0))
        const results = await Promise.allSettled(
          Array.from({ length: 8 }, (_, i) => s.commit(key, 0, doc(i + 1))),
        )
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
        expect((await s.load(key))?.version).toBe(1)
      } finally {
        await close?.(s)
      }
    })

    test("the ConflictError reports the key and the version that was quoted", async () => {
      const s = await makeStore()
      try {
        await s.commit("k", null, doc(1))
        await expect(s.commit("k", null, doc(2))).rejects.toMatchObject({
          key: "k",
          expectedVersion: null,
        })
        await expect(s.commit("k", 5, doc(2))).rejects.toMatchObject({
          key: "k",
          expectedVersion: 5,
        })
      } finally {
        await close?.(s)
      }
    })

    test("delete removes the document, and is a no-op on a missing key", async () => {
      const s = await makeStore()
      try {
        const key = await s.create(doc(1))
        await s.delete(key)
        expect(await s.load(key)).toBeUndefined()
        await expect(s.delete(key)).resolves.toBeUndefined()
        // The version counter goes with it: the key is free to be claimed again.
        await s.commit(key, null, doc(2))
        expect(await s.load(key)).toEqual({ version: 0, value: doc(2) })
      } finally {
        await close?.(s)
      }
    })

    test("never hands out a shared reference", async () => {
      // The memory store is the one that could cheat here, and cheating would
      // let an application mutate state without committing — a habit that only
      // breaks once there is a database.
      const s = await makeStore()
      try {
        const key = await s.create(doc(1))
        const a = await s.load(key)
        const b = await s.load(key)
        expect(a?.value).not.toBe(b?.value)
        expect(a?.value.nested).not.toBe(b?.value.nested)
        expect(a?.value).toEqual(b?.value)
      } finally {
        await close?.(s)
      }
    })

    test("mutating a value after writing it does not change what was stored", async () => {
      const s = await makeStore()
      try {
        const value = doc(1)
        const key = await s.create(value)
        value.nested.items.push("mutated")
        expect((await s.load(key))?.value.nested.items).toEqual(["a"])

        const committed = doc(2)
        await s.commit(key, 0, committed)
        committed.nested.items.push("mutated")
        expect((await s.load(key))?.value.nested.items).toEqual(["a"])
      } finally {
        await close?.(s)
      }
    })

    test("mutating a loaded value does not change what is stored", async () => {
      const s = await makeStore()
      try {
        const key = await s.create(doc(1))
        const loaded = await s.load(key)
        loaded?.value.nested.items.push("mutated")
        expect((await s.load(key))?.value.nested.items).toEqual(["a"])
      } finally {
        await close?.(s)
      }
    })

    test("documents are independent of one another", async () => {
      const s = await makeStore()
      try {
        const a = await s.create(doc(1))
        const b = await s.create(doc(2))
        await s.commit(a, 0, doc(10))
        expect(await s.load(b)).toEqual({ version: 0, value: doc(2) })
      } finally {
        await close?.(s)
      }
    })
  })
}

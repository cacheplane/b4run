/**
 * The application document store: a versioned JSON document, written with
 * compare-and-swap.
 *
 * B4.run already persists everything IT owns — checkpoints, threads,
 * permissions — and nothing an application owns, so every stateful app
 * rebuilds this layer beside it. The contract lives here, in the package every
 * app already depends on, so that the backends (`@b4run/postgres-storage`, the
 * in-process one below) share ONE `ConflictError` class. Two structurally
 * identical `ConflictError`s would be a silent `instanceof` failure at the
 * exact moment a caller needs to decide whether to retry, which is the only
 * moment this error is ever read.
 */

/** A document and the version a `commit` must quote to replace it. */
export interface Document<T> {
  /** 0 on insert, incremented by every successful `commit`. */
  readonly version: number
  readonly value: T
}

/**
 * A `commit` lost the race: the stored version is not the one the caller read
 * (or the key already existed, for an insert). Reload and retry — two browser
 * tabs approving the same thing is the case this whole store exists for.
 *
 * A class rather than a code, and exported from `@b4run/sdk` rather than from
 * each backend, so `catch (e) { if (e instanceof ConflictError) … }` works for
 * a caller that does not know which backend it got.
 */
export class ConflictError extends Error {
  /** The key whose write was rejected. */
  readonly key: string
  /** The version the caller quoted; `null` when it was attempting an insert. */
  readonly expectedVersion: number | null

  constructor(key: string, expectedVersion: number | null) {
    super(
      expectedVersion === null
        ? `document ${JSON.stringify(key)} already exists`
        : `document ${JSON.stringify(key)} is not at version ${expectedVersion}`,
    )
    this.name = "ConflictError"
    this.key = key
    this.expectedVersion = expectedVersion
  }
}

/**
 * A named collection of versioned documents.
 *
 * Declared here as the backend-neutral contract, exactly as `ThreadsStore` is
 * declared for the thread backends: a backend adds its own lifecycle
 * (`ready()`, `close()`) on top rather than putting it here, so an application
 * can hold a `DocumentStore<T>` without knowing whether it has a pool.
 *
 * Keys are opaque strings. Values must survive a JSON round trip — they are
 * stored as JSONB — so no `Date`, `Map`, `undefined` or class instance
 * survives; the store makes no attempt to revive one.
 */
export interface DocumentStore<T> {
  /**
   * Insert `value` under a freshly generated key and return it. The document
   * starts at version 0.
   */
  create(value: T): Promise<string>
  /** The document at `key`, or `undefined` if there is none. */
  load(key: string): Promise<Document<T> | undefined>
  /**
   * Compare-and-swap.
   *
   * With a number, replaces the document only if it is still at
   * `expectedVersion`, bumping it by one. With `null`, INSERTS under a
   * caller-supplied key and fails if anything is already there — that is how a
   * binding keyed by someone else's id (a B4.run thread id, say) is claimed
   * exactly once across concurrent instances.
   *
   * Throws {@link ConflictError} in either case when it loses. It is not an
   * error condition so much as a signal: reload, re-apply, commit again.
   */
  commit(key: string, expectedVersion: number | null, value: T): Promise<void>
  /** Remove the document at `key`. No-op if there is none. */
  delete(key: string): Promise<void>
}

/**
 * A process-local `DocumentStore`. Not a mock.
 *
 * It enforces compare-and-swap and deep-copies on the way in and on the way
 * out, so an application developed against it cannot acquire a habit —
 * mutating a loaded value in place, skipping a version check — that only
 * breaks once there is a `DATABASE_URL`. It answers the same conformance
 * suite as the Postgres store (`runDocumentStoreConformance` in
 * `@b4run/testing`), which is what keeps that claim true.
 *
 * What it deliberately does NOT do is survive a restart or coordinate two
 * processes. Use it for local development and for tests; reach for
 * `@b4run/postgres-storage` when the state has to outlive the process.
 */
export function createMemoryDocumentStore<T>(): DocumentStore<T> {
  const docs = new Map<string, Document<T>>()

  // structuredClone, not a JSON round trip: it preserves the exact value the
  // caller handed over rather than quietly dropping `undefined` properties,
  // which would make the memory store disagree with itself about what it
  // stored. (What JSONB accepts is a separate question, and the contract above
  // states it.)
  const copy = (value: T): T => structuredClone(value)

  return {
    async create(value) {
      const key = crypto.randomUUID()
      docs.set(key, { version: 0, value: copy(value) })
      return key
    },

    async load(key) {
      const current = docs.get(key)
      // A fresh object every time. Handing back the stored reference would let
      // a caller mutate the store without committing — and would make a lost
      // update invisible here but fatal against Postgres.
      return current ? { version: current.version, value: copy(current.value) } : undefined
    },

    async commit(key, expectedVersion, value) {
      const current = docs.get(key)
      if (expectedVersion === null) {
        if (current) throw new ConflictError(key, null)
        docs.set(key, { version: 0, value: copy(value) })
        return
      }
      if (!current || current.version !== expectedVersion)
        throw new ConflictError(key, expectedVersion)
      docs.set(key, { version: current.version + 1, value: copy(value) })
    },

    async delete(key) {
      docs.delete(key)
    },
  }
}

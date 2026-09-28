import type { Migration } from "../internal/migrate.js"

/**
 * Schema for the durable approval-grant store — the consumption record behind
 * `InterruptGrantStore` in `@b4run/sdk`.
 *
 * Two rules govern every edit to this file.
 *
 * **A shipped migration is frozen.** `runMigrations` remembers only the
 * highest `version` it has applied (see `internal/migrate.ts`), so editing the
 * `up` of a version that has already run on someone's `.b4/*.sqlite` changes
 * nothing for them and silently forks their schema from a fresh install's. To
 * change the shape of this table, append a NEW version whose `up` is an
 * `ALTER TABLE`; never touch an existing one. Versions are numbered per
 * database FILE, not per package — `schema_version` lives in whichever file
 * this migration set was run against, which is why each store in this package
 * opens its own file and starts its own numbering at 1.
 *
 * **No column default is load-bearing.** There are no `DEFAULT` clauses here,
 * by repo rule: every INSERT in `store.ts` names every column and supplies
 * every value, so the row a reader gets back is exactly the row the caller
 * described. A default would let a future column quietly materialize a value
 * nobody wrote — which for `consumed_at` or `voided_at`, the two columns the
 * single-use guarantee is decided on, would be a security bug rather than a
 * tidiness one.
 *
 * Column notes:
 * - `PRIMARY KEY (thread_id, interrupt_id)` is what makes `issue` reject a
 *   duplicate without a read-then-write race: the constraint, not a prior
 *   SELECT, decides.
 * - `expires_at`, `consumed_at`, `consumed_decision` and `voided_at` are
 *   nullable because NULL is the meaningful state — "no TTL", "not yet
 *   answered", "not superseded" — and the conditional UPDATE in `consume`
 *   tests exactly those NULLs.
 * - `checkpoint_ns` is LangGraph's namespace for the parked task, stored
 *   verbatim; see the doc comment on `InterruptGrantRecord.checkpointNs` for
 *   why it stands in for the `resume_key`/`checkpoint_id` halves of the
 *   binding.
 * - The `thread_id` index serves `listForThread` and the `voidOutstanding`
 *   sweep, both of which scan by thread; the primary key's leading column
 *   would cover it in SQLite today, but the index states the access pattern
 *   rather than relying on the PK's internal representation staying that way.
 */
export const INTERRUPT_GRANTS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE interrupt_grants (
        thread_id TEXT NOT NULL,
        interrupt_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT,
        consumed_at TEXT,
        consumed_decision TEXT,
        voided_at TEXT,
        PRIMARY KEY (thread_id, interrupt_id)
      );
      CREATE INDEX idx_interrupt_grants_thread ON interrupt_grants(thread_id);
    `,
  },
]

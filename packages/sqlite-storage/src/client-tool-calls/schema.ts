import type { Migration } from "../internal/migrate.js"

/**
 * `client_tool_calls` (cacheplane/b4run#743). Versions 1-3 are frozen. Two rules, as for
 * interrupt_grants: a shipped migration is frozen — change the shape by
 * APPENDING a version, never by editing one — and no column default is
 * load-bearing: every INSERT names all fourteen columns (migration 2's
 * `DEFAULT 'client'` exists only to backfill rows that predate `kind`).
 */
export const CLIENT_TOOL_CALLS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `
      CREATE TABLE client_tool_calls (
        thread_id    TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        interrupt_id TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        run_id       TEXT NOT NULL,
        route_id     TEXT NOT NULL,
        issued_at    TEXT NOT NULL,
        expires_at   TEXT,
        answered_at  TEXT,
        result       TEXT,
        voided_at    TEXT,
        PRIMARY KEY (thread_id, tool_call_id)
      );
      CREATE INDEX idx_client_tool_calls_thread ON client_tool_calls(thread_id);
    `,
  },
  {
    // `kind` is NOT NULL and so needs a DEFAULT for SQLite's ADD COLUMN to
    // backfill the version-1 rows (all client calls). That default exists for
    // the backfill only: every INSERT names `kind`, so it is never load-bearing.
    version: 2,
    up: `
      ALTER TABLE client_tool_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'client' CHECK (kind IN ('client', 'server'));
      ALTER TABLE client_tool_calls ADD COLUMN settled_at TEXT;
    `,
  },
  {
    // The parent `task` link for a subagent's calls; null at the root and for
    // every row that predates it. No default and no CHECK: nullable is the rule.
    version: 3,
    up: "ALTER TABLE client_tool_calls ADD COLUMN parent_tool_call_id TEXT;",
  },
]

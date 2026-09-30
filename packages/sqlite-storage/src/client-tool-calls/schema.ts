import type { Migration } from "../internal/migrate.js"

/**
 * `client_tool_calls` (cacheplane/b4run#743). Two rules, as for
 * interrupt_grants: a shipped migration is frozen — change the shape by
 * APPENDING a version, never by editing one — and no column default is
 * load-bearing: every INSERT names every column.
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
]

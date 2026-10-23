import { Pool } from "pg"

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[]
  readonly rowCount: number
}

export interface SqlTransaction {
  query<Row extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>
}

export interface SqlExecutor extends SqlTransaction {
  transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>
  end(): Promise<void>
}

/**
 * An executor bound to one open transaction, so a helper that opens its own transaction (such as
 * `stopContact`) joins the caller's instead.
 */
export function nestedExecutor(tx: SqlTransaction): SqlExecutor {
  return {
    query: (text, params) => tx.query(text, params),
    transaction: (fn) => fn(tx),
    end: async () => undefined,
  }
}

/**
 * Serialises admitting an inbound receipt with the final authorisation of a sequence send.
 * Admission takes it exclusively; a send takes it shared, so sends never wait on each other,
 * and a receipt admitted before a send's check is always visible to that check.
 */
export const REPLY_GATE_LOCK = "select pg_advisory_xact_lock(hashtext('b4-growth-reply-gate'))"
export const REPLY_GATE_SHARED_LOCK =
  "select pg_advisory_xact_lock_shared(hashtext('b4-growth-reply-gate'))"

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export function createPgExecutor(databaseUrl: string): SqlExecutor {
  const { hostname } = new URL(databaseUrl)
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 3,
    ...(LOCAL_HOSTS.has(hostname) ? {} : { ssl: { rejectUnauthorized: true } }),
  })

  // An idle client that loses its connection emits "error" on the pool; unhandled, that
  // crashes the process. pg discards the dead client itself, so only log.
  pool.on("error", (error: Error) => {
    process.stderr.write(`growth database pool error: ${error.message}\n`)
  })

  async function run<Row extends Record<string, unknown>>(
    target: { query: Pool["query"] },
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>> {
    const result = await target.query(text, params === undefined ? undefined : [...params])
    return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 }
  }

  return {
    query: (text, params) => run(pool, text, params),
    async transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      const tx: SqlTransaction = { query: (text, params) => run(client, text, params) }
      try {
        await client.query("begin")
        const value = await fn(tx)
        await client.query("commit")
        return value
      } catch (error) {
        await client.query("rollback").catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
    async end() {
      await pool.end()
    },
  }
}

export function loadGrowthDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.GROWTH_DATABASE_URL?.trim()
  if (!value) throw new Error("GROWTH_DATABASE_URL is not set")
  return value
}

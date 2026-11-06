import type { SqlClient, SqlPool } from "../sql.js"

const enlisted = new WeakMap<SqlClient, { check(): void; fail(error: unknown): void }>()
/** Internal lifetime-bound child handle; never commits/releases its parent. */
export function enlistClient(
  client: SqlClient,
  check: () => void,
  fail: (error: unknown) => void,
): SqlClient {
  const lease: SqlClient = {
    async query<R>(sql: string, values?: readonly unknown[]) {
      check()
      try {
        return await client.query<R>(sql, values)
      } catch (error) {
        fail(error)
        throw error
      }
    },
    release() {
      enlisted.delete(lease)
      client.release()
    },
  }
  enlisted.set(lease, { check, fail })
  return lease
}

/** Roll back best-effort — a failing ROLLBACK must not mask the original error. */
export async function rollbackQuietly(client: SqlClient): Promise<void> {
  try {
    await client.query("ROLLBACK")
  } catch {
    // Swallow: propagate the root-cause error from the caller's catch instead.
  }
}

/** Run `fn` on a pooled client inside BEGIN/COMMIT, rolling back on any throw. */
export async function withTransaction<T>(
  pool: SqlPool,
  fn: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  const context = enlisted.get(client)
  if (context) {
    try {
      context.check()
      return await fn(client)
    } catch (error) {
      context.fail(error)
      throw error
    } finally {
      client.release()
    }
  }
  try {
    await client.query("BEGIN")
    const result = await fn(client)
    await client.query("COMMIT")
    return result
  } catch (err) {
    await rollbackQuietly(client)
    throw err
  } finally {
    client.release()
  }
}

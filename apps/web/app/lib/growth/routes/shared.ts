import { createPgExecutor, type SqlExecutor } from "../database"

let executor: { url: string; value: SqlExecutor } | undefined

/**
 * One memoised pool per server process, shared by every growth route. The first
 * URL wins for the process lifetime; a later call with a different URL throws.
 */
export function getSharedExecutor(url: string): SqlExecutor {
  if (executor === undefined) executor = { url, value: createPgExecutor(url) }
  else if (executor.url !== url) {
    throw new Error("growth executor already created for a different database URL")
  }
  return executor.value
}

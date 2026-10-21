import { createPgExecutor, type SqlExecutor } from "../database"

let executor: SqlExecutor | undefined

/** One memoised pool per server process, shared by every growth route. */
export function getSharedExecutor(url: string): SqlExecutor {
  executor ??= createPgExecutor(url)
  return executor
}

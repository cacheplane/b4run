import type { SqlExecutor, SqlQueryResult, SqlTransaction } from "./database"

export interface RecordedCall {
  readonly text: string
  readonly params: readonly unknown[]
}

// Test support: records every call and replays scripted results in order.
// biome-ignore lint/suspicious/noExplicitAny: scripted rows are heterogeneous test data
export function recordingExecutor(results: SqlQueryResult<any>[] = []): {
  executor: SqlExecutor
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let next = 0
  const tx: SqlTransaction = {
    async query(text, params) {
      calls.push({ text, params: params ?? [] })
      const result = results[next]
      next += 1
      return result ?? { rows: [], rowCount: 0 }
    },
  }
  const executor: SqlExecutor = {
    query: tx.query,
    transaction: (fn) => fn(executor),
    async end() {},
  }
  return { executor, calls }
}

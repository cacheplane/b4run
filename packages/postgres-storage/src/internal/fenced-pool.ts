import type { SqlClient, SqlPool, SqlResult } from "../sql.js"
import { rollbackQuietly } from "./tx.js"

/** Ownership operations used inside each short storage transaction. */
interface Fence {
  assertUsable(): void
  active(): boolean
  validate(client: SqlClient): Promise<void>
}

/** Wrap a structural pool, preserving explicit transactions and safe client release. */
export function createFencedPool(raw: SqlPool, fence: Fence): SqlPool {
  const wrap = (client: SqlClient): SqlClient => {
    let transaction = false
    let released = false
    let queue: Promise<unknown> = Promise.resolve()
    const execute = async <R>(sql: string, values?: readonly unknown[]): Promise<SqlResult<R>> => {
      // Runtime stores bind data as positional parameters. Reject uncertain
      // lexical forms before scanning; dollar quotes can look like identifiers,
      // and backslash string semantics depend on connection settings.
      if (fence.active() && (/\$(?![0-9])/.test(sql) || sql.includes("\\")))
        throw new Error(
          "postgres-storage: unsupported fenced SQL syntax; use positional parameters",
        )
      const normalized = structuralSql(sql).trim().replace(/;\s*$/, "").trim().toUpperCase()
      const control =
        /^(BEGIN|START|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PREPARE|ABORT)(?:\s|$)/.exec(
          normalized,
        )?.[1]
      const controls = ["BEGIN", "START TRANSACTION", "COMMIT", "END", "ROLLBACK"]
      if (control && !controls.includes(normalized))
        throw new Error("postgres-storage: unsupported transaction control")
      if ((fence.active() || control) && normalized.includes(";"))
        throw new Error("postgres-storage: unsupported compound statement")
      if (control === "ROLLBACK") {
        const result = await client.query<R>("ROLLBACK")
        transaction = false
        return result
      }
      try {
        fence.assertUsable()
      } catch (error) {
        if (transaction) await rollbackQuietly(client)
        transaction = false
        throw error
      }
      if (control === "BEGIN" || normalized === "START TRANSACTION") {
        if (transaction) throw new Error("postgres-storage: nested BEGIN is unsupported")
        await client.query(sql, values)
        transaction = true
        try {
          await fence.validate(client)
        } catch (error) {
          await rollbackQuietly(client)
          transaction = false
          throw error
        }
        return { rows: [] }
      }
      if (control === "COMMIT" || control === "END") {
        if (!transaction) throw new Error("postgres-storage: COMMIT without BEGIN")
        try {
          await fence.validate(client)
          return await client.query<R>(sql, values)
        } catch (error) {
          await rollbackQuietly(client)
          throw error
        } finally {
          transaction = false
        }
      }
      if (transaction) {
        await fence.validate(client)
        return client.query<R>(sql, values)
      }
      if (!fence.active()) return client.query<R>(sql, values)
      await client.query("BEGIN")
      try {
        await fence.validate(client)
        const result = await client.query<R>(sql, values)
        await fence.validate(client)
        await client.query("COMMIT")
        return result
      } catch (error) {
        await rollbackQuietly(client)
        throw error
      }
    }
    return {
      query<R = unknown>(sql: string, values?: readonly unknown[]) {
        if (released) return Promise.reject(new Error("postgres-storage: client released"))
        const result = queue.then(() => execute<R>(sql, values))
        queue = result.catch(() => {})
        return result
      },
      release() {
        if (released) return
        released = true
        void queue.then(async () => {
          if (transaction) await rollbackQuietly(client)
          client.release()
        })
      },
    }
  }
  return {
    async query<R = unknown>(sql: string, values?: readonly unknown[]) {
      fence.assertUsable()
      const client = wrap(await raw.connect())
      try {
        return await client.query<R>(sql, values)
      } finally {
        client.release()
      }
    },
    async connect() {
      return wrap(await raw.connect())
    },
    async end() {
      /* The admission owns lifecycle; consumers cannot close its pool. */
    },
  }
}

/** Remove literals and comments before recognizing transaction boundaries. */
function structuralSql(sql: string): string {
  let output = ""
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i]
    if (sql.startsWith("--", i)) {
      const end = sql.slice(i + 2).search(/[\r\n]/)
      i = end < 0 ? sql.length : i + 3 + end
      output += " "
    } else if (sql.startsWith("/*", i)) {
      let depth = 1
      i += 2
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) {
          depth++
          i += 2
        } else if (sql.startsWith("*/", i)) {
          depth--
          i += 2
        } else i++
      }
      if (depth) throw new Error("postgres-storage: unsupported unterminated SQL comment")
      output += " "
    } else if (ch === "'" || ch === '"') {
      const escapedLiteral = ch === "'" && /(?:^|[^a-z0-9_])e$/i.test(output)
      i++
      let ended = false
      while (i < sql.length) {
        if (escapedLiteral && sql[i] === "\\") i += 2
        else if (sql[i] === ch) {
          i++
          if (sql[i] === ch) i++
          else {
            ended = true
            break
          }
        } else i++
      }
      if (!ended) throw new Error("postgres-storage: unsupported unterminated SQL literal")
      output += "?"
    } else if (ch === "$" && /^\$(?:[a-z_][a-z0-9_]*)?\$/i.test(sql.slice(i))) {
      const delimiter = /^\$(?:[a-z_][a-z0-9_]*)?\$/i.exec(sql.slice(i))?.[0] ?? "$$"
      const end = sql.indexOf(delimiter, i + delimiter.length)
      if (end < 0) throw new Error("postgres-storage: unsupported unterminated SQL literal")
      i = end + delimiter.length
      output += "?"
    } else {
      output += ch
      i++
    }
  }
  return output
}

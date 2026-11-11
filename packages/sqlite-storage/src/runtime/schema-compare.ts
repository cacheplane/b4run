/** Closed comparison of source DDL. Quoted contents are never case/space folded. */
interface Token {
  readonly kind: "word" | "identifier" | "string" | "number" | "symbol"
  readonly value: string
}
const keywords = new Set(
  "CREATE TABLE INDEX UNIQUE ON CONSTRAINT PRIMARY KEY FOREIGN REFERENCES DEFERRABLE INITIALLY DEFERRED NOT NULL CHECK DEFAULT INTEGER BIGINT TEXT BLOB BYTEA TIMESTAMPTZ NO ACTION DELETE UPDATE DESC ASC COLLATE WHERE CAST AS IS AND OR GLOB"
    .toLowerCase()
    .split(" "),
)
function tokens(sql: string): Token[] {
  const result: Token[] = []
  let at = 0
  while (at < sql.length) {
    const unit = sql[at]!
    if (/[ \t\r\n\f]/.test(unit)) {
      at++
      continue
    }
    if (sql.startsWith("--", at) || sql.startsWith("/*", at))
      throw new Error("Unsupported schema comment")
    if (["'", '\"', "`", "["].includes(unit)) {
      const end = unit === "[" ? "]" : unit
      let value = "",
        closed = false
      at++
      while (at < sql.length) {
        const next = sql[at++]!
        if (next !== end) value += next
        else if (unit !== "[" && sql[at] === end) {
          value += end
          at++
        } else {
          closed = true
          break
        }
      }
      if (!closed) throw new Error("Unterminated schema token")
      result.push({ kind: unit === "'" ? "string" : "identifier", value })
      continue
    }
    const word = /^[a-z_][a-z0-9_]*/i.exec(sql.slice(at))?.[0]
    if (word) {
      result.push({ kind: "word", value: word })
      at += word.length
      continue
    }
    const number = /^[0-9]+/.exec(sql.slice(at))?.[0]
    if (number) {
      result.push({ kind: "number", value: number })
      at += number.length
      continue
    }
    const symbol = ["<=", ">=", "<>", "=", "<", ">", "(", ")", ",", "."].find((candidate) =>
      sql.startsWith(candidate, at),
    )
    if (!symbol) throw new Error("Unsupported schema token")
    result.push({ kind: "symbol", value: symbol })
    at += symbol.length
  }
  return result
}
export function compareRuntimeSchemaSQL(expected: string, actual: string): boolean {
  try {
    const source = tokens(expected),
      candidate = tokens(actual)
    return (
      source.length === candidate.length &&
      source.every((token, index) => {
        const other = candidate[index]!
        if (token.kind === "word") {
          if (other.kind === "word") return token.value.toLowerCase() === other.value.toLowerCase()
          return (
            other.kind === "identifier" &&
            !keywords.has(token.value.toLowerCase()) &&
            token.value === other.value
          )
        }
        if (token.kind === "identifier")
          return (
            (other.kind === "identifier" || other.kind === "word") && token.value === other.value
          )
        return token.kind === other.kind && token.value === other.value
      })
    )
  } catch {
    return false
  }
}

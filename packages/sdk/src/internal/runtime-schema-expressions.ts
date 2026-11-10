/** Closed source/catalog expression vocabulary. Never evaluates SQL. */
export type RuntimeBuiltinType =
  | "text"
  | "int4"
  | "int8"
  | "bool"
  | "json"
  | "jsonb"
  | "bytea"
  | "timestamptz"
export interface RuntimeExpressionContext {
  readonly relation: string
  readonly columnTypes: Readonly<Record<string, RuntimeBuiltinType>>
  readonly legacy?: boolean
  readonly expectedType?: RuntimeBuiltinType
  readonly strictLessThan?: { readonly left: string; readonly right: string }
}
export interface RuntimeExpression {
  readonly kind: string
  readonly type: RuntimeBuiltinType
  readonly value?: string | number | boolean
  readonly name?: string
  readonly operator?: string
  readonly children?: readonly RuntimeExpression[]
}
interface Token {
  readonly kind: "word" | "identifier" | "string" | "number" | "symbol"
  readonly value: string
}
const numbers = new Set([0, 1, 32, 36, 64, 256, 1048576, 9007199254740991])
function lex(source: string): Token[] {
  const tokens: Token[] = []
  let position = 0
  while (position < source.length) {
    const char = source[position]!
    if (/[ \t\r\n\f]/.test(char)) {
      position++
      continue
    }
    if (source.startsWith("--", position) || source.startsWith("/*", position))
      throw new Error("SQL comments are not source expressions")
    if (char === "'" || char === '"') {
      const delimiter = char
      let value = "",
        closed = false
      position++
      while (position < source.length) {
        const unit = source[position++]!
        if (unit !== delimiter) value += unit
        else if (source[position] === delimiter) {
          value += delimiter
          position++
        } else {
          closed = true
          break
        }
      }
      if (!closed) throw new Error("Unterminated SQL token")
      tokens.push({ kind: delimiter === "'" ? "string" : "identifier", value })
      continue
    }
    const word = /^[a-z_][a-z0-9_$]*/i.exec(source.slice(position))?.[0]
    if (word) {
      tokens.push({ kind: "word", value: word.toLowerCase() })
      position += word.length
      continue
    }
    const number = /^[0-9]+/.exec(source.slice(position))?.[0]
    if (number) {
      tokens.push({ kind: "number", value: number })
      position += number.length
      continue
    }
    const operator = [
      "->>",
      "->",
      "::",
      "!~",
      ">=",
      "<=",
      "<>",
      "=",
      ">",
      "<",
      "(",
      ")",
      ",",
      ".",
    ].find((candidate) => source.startsWith(candidate, position))
    if (!operator) throw new Error("Unsupported SQL expression token")
    tokens.push({ kind: "symbol", value: operator })
    position += operator.length
  }
  return tokens
}
const types: Readonly<Record<string, RuntimeBuiltinType>> = {
  text: "text",
  integer: "int4",
  int4: "int4",
  bigint: "int8",
  int8: "int8",
  boolean: "bool",
  bool: "bool",
  json: "json",
  jsonb: "jsonb",
  bytea: "bytea",
  timestamptz: "timestamptz",
}
class Parser {
  private position = 0
  constructor(
    private readonly tokens: readonly Token[],
    private readonly context: RuntimeExpressionContext,
  ) {}
  private has(value: string) {
    return this.tokens[this.position]?.value === value
  }
  private take(value?: string): Token {
    const token = this.tokens[this.position++]
    if (!token || (value !== undefined && token.value !== value))
      throw new Error("Unexpected SQL expression token")
    return token
  }
  private node(
    kind: string,
    type: RuntimeBuiltinType,
    rest: Omit<RuntimeExpression, "kind" | "type"> = {},
  ): RuntimeExpression {
    return { kind, type, ...rest }
  }
  parse(): RuntimeExpression {
    let node = this.or()
    if (this.position !== this.tokens.length) throw new Error("Extra SQL expression tokens")
    if (
      node.kind === "integer" &&
      this.context.expectedType &&
      ["int4", "int8"].includes(this.context.expectedType)
    )
      node = { ...node, type: this.context.expectedType }
    const inspect = (value: RuntimeExpression, parent?: RuntimeExpression) => {
      if (
        value.kind === "cast" &&
        value.type === "json" &&
        !(parent?.kind === "is-not-null" && parent.children?.[0] === value)
      )
        throw new Error("JSON input cast is lexical IsNotNull only")
      value.children?.forEach((child) => {
        inspect(child, value)
      })
    }
    inspect(node)
    return node
  }
  private boolean(kind: "and" | "or", children: readonly RuntimeExpression[]): RuntimeExpression {
    if (children.some((child) => child.type !== "bool"))
      throw new Error("Expected boolean source operands")
    return children.length === 1
      ? children[0]!
      : this.node(kind, "bool", {
          children: children.flatMap((child) => (child.kind === kind ? child.children! : [child])),
        })
  }
  private or(): RuntimeExpression {
    const children = [this.and()]
    while (this.has("or")) {
      this.take()
      children.push(this.and())
    }
    return children.length === 1 ? children[0]! : this.boolean("or", children)
  }
  private and(): RuntimeExpression {
    const children = [this.compare()]
    while (this.has("and")) {
      this.take()
      children.push(this.compare())
    }
    return children.length === 1 ? children[0]! : this.boolean("and", children)
  }
  private compare(): RuntimeExpression {
    const left = this.json()
    if (this.has("is")) {
      this.take()
      const negated = this.has("not")
      if (negated) this.take()
      this.take("null")
      return this.node(negated ? "is-not-null" : "is-null", "bool", { children: [left] })
    }
    const token = this.tokens[this.position]?.value
    if (!token || !["=", ">", ">=", "<=", "<>", "<", "!~"].includes(token)) return left
    this.take()
    const right = this.json()
    if (token === "<") {
      const pair = this.context.strictLessThan
      const admitted =
        pair &&
        ((pair.left === "previous_version_seq" &&
          pair.right === "version_seq" &&
          this.context.relation.endsWith("recovery_versions")) ||
          (pair.left === "previous_cut_seq" &&
            pair.right === "through_seq" &&
            this.context.relation.endsWith("recovery_cuts")))
      if (
        !pair ||
        !admitted ||
        left.kind !== "column" ||
        right.kind !== "column" ||
        left.name !== pair.left ||
        right.name !== pair.right ||
        left.type !== "int8" ||
        right.type !== "int8"
      )
        throw new Error("Strict comparison outside exact source context")
    }
    if (token === "!~") {
      if (
        left.kind !== "column" ||
        left.type !== "text" ||
        right.kind !== "text" ||
        right.value !== "[^0-9a-f]"
      )
        throw new Error("Unknown recovery HEX regex")
    } else if (
      !(
        (left.type === right.type && ["text", "bool", "int4", "int8"].includes(left.type)) ||
        (["int4", "int8"].includes(left.type) && ["int4", "int8"].includes(right.type))
      )
    )
      throw new Error("Unapproved operator signature")
    return this.node("compare", "bool", {
      operator: `pg_catalog.${token}(${left.type},${right.type})`,
      children: [left, right],
    })
  }
  private json(): RuntimeExpression {
    let left = this.cast()
    while (this.has("->") || this.has("->>")) {
      const operator = this.take().value,
        right = this.cast()
      if (!this.context.legacy || left.type !== "jsonb" || right.kind !== "text")
        throw new Error("JSON extraction outside exact legacy context")
      left = this.node("json-get", operator === "->" ? "jsonb" : "text", {
        operator,
        children: [left, right],
      })
    }
    return left
  }
  private type(): RuntimeBuiltinType {
    const parts = [this.take()]
    if (this.has(".")) {
      this.take()
      parts.push(this.take())
    }
    if (
      parts.some((part) => !["word", "identifier"].includes(part.kind)) ||
      (parts.length === 2 && parts[0]!.value !== "pg_catalog")
    )
      throw new Error("Unknown cast type namespace")
    const type = types[parts.at(-1)!.value]
    if (!type) throw new Error("Unknown builtin cast type")
    return type
  }
  private convert(child: RuntimeExpression, type: RuntimeBuiltinType): RuntimeExpression {
    if (type === "text" && child.kind === "text") return child
    if (["int4", "int8"].includes(type) && (child.kind === "integer" || child.kind === "text")) {
      const text = String(child.value)
      if (
        !/^(0|[1-9][0-9]*)$/.test(text) ||
        !numbers.has(Number(text)) ||
        (type === "int4" && Number(text) > 2147483647)
      )
        throw new Error("Unknown literal numeric coercion")
      return this.node("integer", type, { value: Number(text) })
    }
    if (type === "int8" && child.kind === "call" && child.name === "pg_catalog.current_setting")
      return this.node("cast", type, { children: [child] })
    if (type === "json" && child.kind === "column" && child.type === "text")
      return this.node("cast", type, { children: [child] })
    if (
      type === "jsonb" &&
      this.context.legacy &&
      child.kind === "column" &&
      child.name === "payload" &&
      child.type === "text"
    )
      return this.node("cast", type, { children: [child] })
    throw new Error("Unsupported source cast")
  }
  private cast(): RuntimeExpression {
    let value = this.atom()
    while (this.has("::")) {
      this.take()
      value = this.convert(value, this.type())
    }
    return value
  }
  private atom(): RuntimeExpression {
    if (this.has("(")) {
      this.take()
      const value = this.or()
      this.take(")")
      return value
    }
    const token = this.take()
    if (token.kind === "string") return this.node("text", "text", { value: token.value })
    if (token.kind === "number") {
      const value = Number(token.value)
      if (!numbers.has(value) || String(value) !== token.value)
        throw new Error("Unknown source numeric constant")
      return this.node("integer", value > 2147483647 ? "int8" : "int4", { value })
    }
    if (token.kind !== "word" && token.kind !== "identifier")
      throw new Error("Expected known source operand")
    if (token.kind === "word" && ["true", "false"].includes(token.value))
      return this.node("boolean", "bool", { value: token.value === "true" })
    if (token.kind === "word" && token.value === "cast") {
      this.take("(")
      const value = this.or()
      this.take("as")
      const type = this.type()
      this.take(")")
      return this.convert(value, type)
    }
    const names = [token.value]
    while (this.has(".")) {
      this.take()
      const next = this.take()
      if (!["word", "identifier"].includes(next.kind)) throw new Error("Unknown qualified operand")
      names.push(next.value)
    }
    if (this.has("(")) {
      const name = names.at(-1)!
      if (
        names.length > 2 ||
        (names.length === 2 && names[0] !== "pg_catalog") ||
        !["current_setting", "length", "octet_length", "substr"].includes(name)
      )
        throw new Error("Unknown source builtin")
      this.take()
      const children = [this.or()]
      while (this.has(",")) {
        this.take()
        children.push(this.or())
      }
      this.take(")")
      const signature = children.map((child) => child.type).join(",")
      if (
        (name === "substr" && signature !== "text,int4,int4") ||
        (name !== "substr" && signature !== "text")
      )
        throw new Error("Unknown builtin signature")
      return this.node("call", name === "current_setting" || name === "substr" ? "text" : "int4", {
        name: `pg_catalog.${name}`,
        children,
      })
    }
    const column = names.at(-1)!,
      relation = names.slice(0, -1).join(".")
    if (
      relation &&
      relation !== this.context.relation &&
      relation !== this.context.relation.split(".").at(-1)
    )
      throw new Error("Wrong source relation")
    const type = this.context.columnTypes[column]
    if (!type) throw new Error("Unknown source column")
    return this.node("column", type, { name: column })
  }
}
export function parseRuntimeExpression(
  source: string,
  context: RuntimeExpressionContext,
): RuntimeExpression {
  return new Parser(lex(source), context).parse()
}
export function runtimeExpressionsEqual(
  expected: string,
  actual: string,
  context: RuntimeExpressionContext,
): boolean {
  try {
    return (
      JSON.stringify(parseRuntimeExpression(expected, context)) ===
      JSON.stringify(parseRuntimeExpression(actual, context))
    )
  } catch {
    return false
  }
}

// A small evaluator for the GitHub Actions expression language, enough to decide a job's
// `if:` under a stated event. It exists so a contract test can ask what a guard DOES (is
// this job skipped for a factory pull request?) instead of whether its text contains a
// substring: a guard placed on the wrong side of an `||` contains the text and guards
// nothing. Anything it does not understand throws, so an unfamiliar `if:` fails the test
// rather than being guessed at.
//
// Semantics follow GitHub's documentation: `==` and `!=` compare strings case-insensitively
// and coerce mixed types to numbers (so `always() == 1` and `null == ''` are true),
// `&&` and `||` return an operand (not a boolean), falsy is false, 0, -0, "", null and NaN,
// a missing property is null, and the status functions are answered from the context.
//
// Three-valued when asked (`context.unknownByDefault`): every property the context does not
// state, and every status function it does not answer, is UNKNOWN, and UNKNOWN propagates
// through `!`, comparisons and functions, while `false && x` is still false and `true || x`
// still true. A guard test asks whether a job is DEFINITELY skipped for a factory pull
// request: a job that runs only when some job output is "true", or on `failure()`, is not.

const TOKEN =
  /\s*(?:(?<string>'(?:[^']|'')*')|(?<number>-?\d+(?:\.\d+)?)|(?<op>&&|\|\||==|!=|<=|>=|[!<>()[\].,])|(?<word>[A-Za-z_][A-Za-z0-9_-]*))/y

function tokenize(source) {
  const tokens = []
  TOKEN.lastIndex = 0
  let at = 0
  while (at < source.length) {
    if (/^\s*$/u.test(source.slice(at))) break
    TOKEN.lastIndex = at
    const match = TOKEN.exec(source)
    if (match === null)
      throw new SyntaxError(`Unexpected input at ${at}: ${source.slice(at, at + 20)}`)
    at = TOKEN.lastIndex
    const { string, number, op, word } = match.groups
    if (string !== undefined)
      tokens.push({ kind: "string", value: string.slice(1, -1).replaceAll("''", "'") })
    else if (number !== undefined) tokens.push({ kind: "number", value: Number(number) })
    else if (op !== undefined) tokens.push({ kind: "op", value: op })
    else tokens.push({ kind: "word", value: word })
  }
  return tokens
}

/** How an expression opens when it is wrapped. */
const OPEN = `\${{`

/** The expression inside an `if:`: a bare expression, or one wrapped whole in `${{ }}`. */
export function unwrapExpression(text) {
  const trimmed = String(text).trim()
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/u.exec(trimmed)
  if (wrapped) {
    if (wrapped[1].includes(OPEN)) throw new SyntaxError(`Nested ${OPEN} }} is not one expression`)
    return wrapped[1]
  }
  if (trimmed.includes(OPEN)) throw new SyntaxError("A partly wrapped if: is not one expression")
  return trimmed
}

function parse(source) {
  const tokens = tokenize(unwrapExpression(source))
  let index = 0
  const peek = () => tokens[index]
  const take = (value) => {
    const token = tokens[index]
    if (token?.kind !== "op" || token.value !== value)
      throw new SyntaxError(`Expected ${value} at token ${index}`)
    index += 1
  }
  const isOp = (value) => peek()?.kind === "op" && peek().value === value

  function primary() {
    const token = tokens[index]
    if (token === undefined) throw new SyntaxError("Unexpected end of expression")
    index += 1
    if (token.kind === "string" || token.kind === "number")
      return { type: "literal", value: token.value }
    if (token.kind === "op" && token.value === "(") {
      const inner = or()
      take(")")
      return inner
    }
    if (token.kind === "op" && token.value === "!") return { type: "not", operand: unary() }
    if (token.kind !== "word") throw new SyntaxError(`Unexpected ${token.value}`)
    if (token.value === "true") return { type: "literal", value: true }
    if (token.value === "false") return { type: "literal", value: false }
    if (token.value === "null") return { type: "literal", value: null }
    if (isOp("(")) {
      take("(")
      const args = []
      if (!isOp(")")) {
        args.push(or())
        while (isOp(",")) {
          take(",")
          args.push(or())
        }
      }
      take(")")
      return { type: "call", name: token.value.toLowerCase(), args }
    }
    let node = { type: "path", path: [token.value] }
    for (;;) {
      if (isOp(".")) {
        take(".")
        const name = tokens[index]
        if (name?.kind !== "word") throw new SyntaxError("Expected a property name after .")
        index += 1
        node = { type: "path", path: [...node.path, name.value] }
      } else if (isOp("[")) {
        take("[")
        const key = tokens[index]
        if (key?.kind !== "string") throw new SyntaxError("Only a string index is supported")
        index += 1
        take("]")
        node = { type: "path", path: [...node.path, key.value] }
      } else return node
    }
  }
  function unary() {
    return primary()
  }
  function comparison() {
    let left = unary()
    while (["==", "!=", "<", "<=", ">", ">="].some(isOp)) {
      const op = tokens[index].value
      index += 1
      left = { type: "compare", op, left, right: unary() }
    }
    return left
  }
  function and() {
    let left = comparison()
    while (isOp("&&")) {
      take("&&")
      left = { type: "and", left, right: comparison() }
    }
    return left
  }
  function or() {
    let left = and()
    while (isOp("||")) {
      take("||")
      left = { type: "or", left, right: and() }
    }
    return left
  }
  const tree = or()
  if (index !== tokens.length) throw new SyntaxError(`Trailing input at token ${index}`)
  return tree
}

/** A value the context does not state: neither truthy nor falsy until something decides it. */
export const UNKNOWN = Symbol("unknown")

const isFalsy = (value) =>
  value === false ||
  value === null ||
  value === undefined ||
  value === "" ||
  value === 0 ||
  Number.isNaN(value)

/** true, false, or UNKNOWN. */
const truth = (value) => (value === UNKNOWN ? UNKNOWN : !isFalsy(value))

/**
 * GitHub's coercion of a value to a number for a mixed-type comparison: null is 0, a boolean
 * 0 or 1, a string its number ("" and whitespace are 0, hex and exponents parse, anything else
 * NaN), and an object or array NaN.
 */
function toNumber(value) {
  if (value === null) return 0
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number") return value
  if (typeof value === "string") return value.trim() === "" ? 0 : Number(value.trim())
  return Number.NaN
}

/**
 * `==` as GitHub evaluates it: same types compare directly (strings case-insensitively,
 * objects by identity); different types are both coerced to numbers, and NaN equals nothing.
 */
function looselyEqual(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase()
  const kind = (value) => (value === null ? "null" : typeof value)
  if (kind(a) === kind(b)) return a === b
  return toNumber(a) === toNumber(b)
}

/**
 * Evaluate `expression` (an `if:` value) against `context`: an object whose top-level keys
 * are the expression contexts (`github`, `needs`, ...) and whose `status` names the job
 * status functions' answers (`{ cancelled: false, success: true, ... }`). Returns true or
 * false, or UNKNOWN when `context.unknownByDefault` is set and what the context leaves
 * unstated decides the answer.
 */
export function evaluateExpression(expression, context) {
  const tree = parse(expression)
  const unknownByDefault = context.unknownByDefault === true
  const missing = unknownByDefault ? UNKNOWN : null
  const lookup = (path) => {
    let value = context
    for (const segment of path) {
      if (value === UNKNOWN) return UNKNOWN
      if (value === null || value === undefined || typeof value !== "object") return missing
      value = Object.hasOwn(value, segment) ? value[segment] : missing
    }
    return value === undefined ? missing : value
  }
  const evaluate = (node) => {
    switch (node.type) {
      case "literal":
        return node.value
      case "path":
        return lookup(node.path)
      case "not": {
        const value = truth(evaluate(node.operand))
        return value === UNKNOWN ? UNKNOWN : !value
      }
      case "and": {
        const left = evaluate(node.left)
        const l = truth(left)
        if (l === false) return left
        const right = evaluate(node.right)
        if (l === true) return right
        // Unknown on the left: false either way only when the right is definitely falsy.
        return truth(right) === false ? false : UNKNOWN
      }
      case "or": {
        const left = evaluate(node.left)
        const l = truth(left)
        if (l === true) return left
        const right = evaluate(node.right)
        if (l === false) return right
        return truth(right) === true ? true : UNKNOWN
      }
      case "compare": {
        const left = evaluate(node.left)
        const right = evaluate(node.right)
        if (left === UNKNOWN || right === UNKNOWN) return UNKNOWN
        if (node.op === "==") return looselyEqual(left, right)
        if (node.op === "!=") return !looselyEqual(left, right)
        throw new SyntaxError(`Unsupported comparison ${node.op}`)
      }
      case "call": {
        const status = context.status ?? {}
        if (["always", "success", "failure", "cancelled"].includes(node.name)) {
          if (node.args.length !== 0) throw new SyntaxError(`${node.name}() takes no arguments`)
          if (typeof status[node.name] === "boolean") return status[node.name]
          if (unknownByDefault) return UNKNOWN
          throw new SyntaxError(`The context does not answer ${node.name}()`)
        }
        const args = node.args.map(evaluate)
        if (node.name === "startswith" || node.name === "endswith" || node.name === "contains") {
          if (args.length !== 2) throw new SyntaxError(`${node.name}() takes two arguments`)
          if (args.includes(UNKNOWN)) return UNKNOWN
          const [subject, search] = args.map((value) => String(value ?? "").toLowerCase())
          if (node.name === "startswith") return subject.startsWith(search)
          if (node.name === "endswith") return subject.endsWith(search)
          return subject.includes(search)
        }
        throw new SyntaxError(`Unsupported function ${node.name}()`)
      }
      default:
        throw new SyntaxError(`Unknown node ${node.type}`)
    }
  }
  return truth(evaluate(tree))
}

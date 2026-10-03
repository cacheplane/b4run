/**
 * Re-serialize a stream of raw JSON text fragments into the exact bytes
 * `JSON.stringify(JSON.parse(raw))` would produce, emitting each byte as soon
 * as it is guaranteed to match.
 *
 * Why this exists: a provider streams the argument JSON the model wrote, but
 * the AG-UI wire carries `JSON.stringify(args)` of the parsed object, and
 * consumers append deltas verbatim. The two texts differ in whitespace, escape
 * form, number form and, for two rare shapes, member order. Working token by
 * token keeps the emitted text a prefix of the canonical form:
 *
 * - whitespace between tokens is dropped and structural characters pass;
 * - string content is decoded as escapes complete and re-escaped with
 *   `JSON.stringify` itself, per fragment, withholding a trailing high
 *   surrogate until its pair arrives; object keys are held until complete;
 * - numbers and literals are held until a delimiter and re-serialized through
 *   `JSON.parse`/`JSON.stringify`.
 *
 * Two shapes cannot be canonicalized before their object closes: a duplicate
 * key (the first position keeps the last value) and an array-index-like key
 * (`JSON.stringify` sorts those first). On either, and on malformed input,
 * the stream switches permanently to raw passthrough from that token onward.
 * The concatenation is then still valid JSON that parses to the same value;
 * only its byte form differs from the canonical one.
 */
export interface CanonicalJsonStream {
  /** Feed the next raw fragment; returns the text safe to emit now. */
  push(fragment: string): string
  /** Signal the end of the raw text; returns whatever was still held. */
  flush(): string
}

type Expect = "key" | "colon" | "value" | "commaOrEnd"

interface ObjectFrame {
  readonly kind: "object"
  readonly keys: Set<string>
  expect: Expect
}

interface ArrayFrame {
  readonly kind: "array"
  expect: "value" | "commaOrEnd"
  empty: boolean
}

type Frame = ObjectFrame | ArrayFrame

interface StringToken {
  readonly kind: "string"
  readonly isKey: boolean
  /** Raw text so far, including the opening quote, for passthrough. */
  raw: string
  /** Decoded code units not yet emitted (all of them, for a key). */
  pending: string
  /** An escape sequence in progress, starting with the backslash. */
  escape: string
}

interface NumberToken {
  readonly kind: "number"
  text: string
}

interface LiteralToken {
  readonly kind: "literal"
  text: string
}

type Token = StringToken | NumberToken | LiteralToken

const SHORT_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
}

const ARRAY_INDEX_KEY = /^(?:0|[1-9]\d{0,9})$/

function isArrayIndexKey(key: string): boolean {
  return ARRAY_INDEX_KEY.test(key) && Number(key) < 4294967295
}

function isHighSurrogate(unit: string): boolean {
  const code = unit.charCodeAt(0)
  return code >= 0xd800 && code <= 0xdbff
}

function escapeBody(text: string): string {
  return text.length === 0 ? "" : JSON.stringify(text).slice(1, -1)
}

function isNumberChar(ch: string): boolean {
  return (
    (ch >= "0" && ch <= "9") || ch === "-" || ch === "+" || ch === "." || ch === "e" || ch === "E"
  )
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\r" || ch === "\t"
}

export function createCanonicalJsonStream(): CanonicalJsonStream {
  let raw = false
  let done = false
  const stack: Frame[] = []
  let token: Token | undefined

  /** The raw text a held token contributes when the stream fails over. */
  function heldRaw(): string {
    if (token === undefined) return ""
    if (token.kind === "string") {
      // A value string may already have emitted part of itself canonically;
      // what is still pending goes out escaped so the text stays valid JSON.
      return token.isKey ? token.raw : escapeBody(token.pending) + token.escape
    }
    return token.text
  }

  function fail(): string {
    const held = heldRaw()
    raw = true
    token = undefined
    return held
  }

  function top(): Frame | undefined {
    return stack[stack.length - 1]
  }

  /** A complete value has been produced at the current level. */
  function completeValue(): void {
    const frame = top()
    if (frame === undefined) {
      done = true
      return
    }
    frame.expect = "commaOrEnd"
    if (frame.kind === "array") frame.empty = false
  }

  function startValue(ch: string): string | undefined {
    const frame = top()
    const isKey = frame?.kind === "object" && frame.expect === "key"
    if (ch === '"') {
      token = { kind: "string", isKey, raw: '"', pending: "", escape: "" }
      // A value string's opening quote is certain; a key is held whole.
      return isKey ? "" : '"'
    }
    if (isKey) return undefined
    if (ch === "{") {
      stack.push({ kind: "object", keys: new Set(), expect: "key" })
      return ch
    }
    if (ch === "[") {
      stack.push({ kind: "array", expect: "value", empty: true })
      return ch
    }
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      token = { kind: "number", text: ch }
      return ""
    }
    if (ch === "t" || ch === "f" || ch === "n") {
      token = { kind: "literal", text: ch }
      return ""
    }
    return undefined
  }

  function completeNumber(text: string): string | undefined {
    try {
      return JSON.stringify(JSON.parse(text))
    } catch {
      return undefined
    }
  }

  /** Handle one character outside a string token; undefined means failure. */
  function structural(ch: string): string | undefined {
    if (isWhitespace(ch)) return ""
    if (done) return undefined
    const frame = top()
    if (frame === undefined) return startValue(ch)
    switch (frame.expect) {
      case "key":
        if (ch === "}" && frame.kind === "object" && frame.keys.size === 0) {
          stack.pop()
          completeValue()
          return ch
        }
        return startValue(ch)
      case "colon":
        if (ch !== ":" || frame.kind !== "object") return undefined
        frame.expect = "value"
        return ch
      case "value":
        if (ch === "]" && frame.kind === "array" && frame.empty) {
          stack.pop()
          completeValue()
          return ch
        }
        return startValue(ch)
      case "commaOrEnd":
        if (ch === ",") {
          frame.expect = frame.kind === "object" ? "key" : "value"
          return ch
        }
        if ((ch === "}" && frame.kind === "object") || (ch === "]" && frame.kind === "array")) {
          stack.pop()
          completeValue()
          return ch
        }
        return undefined
    }
  }

  /** Handle one character inside a string token; undefined means failure. */
  function stringChar(current: StringToken, ch: string): string | undefined {
    if (current.escape.length > 0) {
      const sequence = current.escape + ch
      if (sequence.length === 2) {
        if (ch === "u") {
          current.escape = sequence
          current.raw += ch
          return ""
        }
        const decoded = SHORT_ESCAPES[ch]
        if (decoded === undefined) return undefined
        current.escape = ""
        current.pending += decoded
        current.raw += ch
        return ""
      }
      if (!/^[0-9a-fA-F]$/.test(ch)) return undefined
      current.raw += ch
      if (sequence.length < 6) {
        current.escape = sequence
        return ""
      }
      current.escape = ""
      current.pending += String.fromCharCode(Number.parseInt(sequence.slice(2), 16))
      return ""
    }
    if (ch === "\\") {
      current.escape = ch
      current.raw += ch
      return ""
    }
    if (ch === '"') {
      if (current.isKey) {
        const frame = top()
        if (frame?.kind !== "object") return undefined
        if (frame.keys.has(current.pending) || isArrayIndexKey(current.pending)) return undefined
        frame.keys.add(current.pending)
        frame.expect = "colon"
        token = undefined
        return JSON.stringify(current.pending)
      }
      const out = `${escapeBody(current.pending)}"`
      token = undefined
      completeValue()
      return out
    }
    if (ch.charCodeAt(0) < 0x20) return undefined
    current.raw += ch
    current.pending += ch
    return ""
  }

  /** Emit what a value string can already commit to, keeping a lone high surrogate. */
  function drainValueString(): string {
    if (token?.kind !== "string" || token.isKey || token.pending.length === 0) return ""
    let text = token.pending
    let carry = ""
    const last = text[text.length - 1]
    if (last !== undefined && isHighSurrogate(last)) {
      carry = last
      text = text.slice(0, -1)
    }
    token.pending = carry
    return escapeBody(text)
  }

  function consume(ch: string): string | undefined {
    if (token?.kind === "string") return stringChar(token, ch)
    if (token?.kind === "number") {
      if (isNumberChar(ch)) {
        token.text += ch
        return ""
      }
      const canonical = completeNumber(token.text)
      if (canonical === undefined) return undefined
      token = undefined
      completeValue()
      const rest = structural(ch)
      return rest === undefined ? undefined : canonical + rest
    }
    if (token?.kind === "literal") {
      const text = token.text + ch
      if (text === "true" || text === "false" || text === "null") {
        token = undefined
        completeValue()
        return text
      }
      if (!"true".startsWith(text) && !"false".startsWith(text) && !"null".startsWith(text)) {
        return undefined
      }
      token.text = text
      return ""
    }
    return structural(ch)
  }

  return {
    push(fragment) {
      if (raw) return fragment
      let out = ""
      for (let index = 0; index < fragment.length; index++) {
        const ch = fragment[index] as string
        const emitted = consume(ch)
        if (emitted === undefined) return out + fail() + fragment.slice(index)
        out += emitted
      }
      return out + drainValueString()
    },
    flush() {
      if (raw || token === undefined) return ""
      const held = token
      token = undefined
      if (held.kind === "number") return completeNumber(held.text) ?? ""
      if (held.kind === "literal") return ""
      // An unterminated value string commits what it has, minus a partial
      // escape, so the emitted text stays a prefix of the canonical form.
      return held.isKey ? "" : escapeBody(held.pending)
    },
  }
}

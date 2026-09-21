import { describe, expect, test } from "vitest"
import { createCanonicalJsonStream } from "../src/canonical-json-stream.ts"

/** Push `raw` in the given fragment lengths and return everything emitted. */
function run(raw: string, lengths: readonly number[]): string {
  const stream = createCanonicalJsonStream()
  let out = ""
  let offset = 0
  for (const length of lengths) {
    out += stream.push(raw.slice(offset, offset + length))
    offset += length
  }
  if (offset < raw.length) out += stream.push(raw.slice(offset))
  return out + stream.flush()
}

function canonical(raw: string): string {
  return JSON.stringify(JSON.parse(raw))
}

/** Deterministic pseudo-random fragmentation so failures reproduce. */
function fragmentations(length: number, seed: number): number[][] {
  const results: number[][] = [[length], Array.from({ length }, () => 1)]
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state
  }
  for (let round = 0; round < 8; round++) {
    const lengths: number[] = []
    let remaining = length
    while (remaining > 0) {
      const size = Math.min(remaining, 1 + (next() % 7))
      lengths.push(size)
      remaining -= size
    }
    results.push(lengths)
  }
  return results
}

const OBJECTS: unknown[] = [
  {},
  [],
  { city: "Paris" },
  { query: "agents", limit: 10, verbose: true, cursor: null, ratio: -0.5, big: 1e21, tiny: 1e-7 },
  { nested: { list: [1, 2, { deep: [[]] }], text: 'a"quote" and \\ backslash\n\ttabs' } },
  { unicode: "café ☕ 😀   ", pair: "😀", lone: "\ud83d" },
  { markdown: "# Title\n\nSome **bold** text with `code` and a [link](https://x.y/z?a=1&b=2)." },
  { emptyString: "", emptyArray: [], emptyObject: {}, zero: 0, negZero: -0 },
  [{ a: 1 }, "two", 3, false, null, [4, [5]]],
  "a bare string",
  42,
  true,
  null,
]

describe("createCanonicalJsonStream", () => {
  test("fragments of canonical JSON concatenate to exactly JSON.stringify of the parse", () => {
    for (const value of OBJECTS) {
      const raw = JSON.stringify(value)
      for (const lengths of fragmentations(raw.length, raw.length * 7 + 1)) {
        expect(run(raw, lengths), `${raw} split ${lengths.join(",")}`).toBe(canonical(raw))
      }
    }
  })

  test("canonicalizes whitespace, escapes and number forms the model may write", () => {
    const raw =
      ' { "a" : 1.0 , "b":[ 1E2, -0, 2.50 ] ,\n"c" : "caf\\u00e9 \\/ \\u0041" , "d":1e999 } '
    for (const lengths of fragmentations(raw.length, 3)) {
      expect(run(raw, lengths), lengths.join(",")).toBe(canonical(raw))
    }
    expect(canonical(raw)).toBe('{"a":1,"b":[100,0,2.5],"c":"café / A","d":null}')
  })

  test("emits string content as it arrives rather than holding until the closing quote", () => {
    const stream = createCanonicalJsonStream()
    expect(stream.push('{"content":"Hello, ')).toBe('{"content":"Hello, ')
    expect(stream.push("world")).toBe("world")
    expect(stream.push('"}')).toBe('"}')
    expect(stream.flush()).toBe("")
  })

  test("withholds a trailing high surrogate until its pair arrives", () => {
    const stream = createCanonicalJsonStream()
    expect(stream.push('{"s":"\ud83d')).toBe('{"s":"')
    expect(stream.push('\ude00"}')).toBe('😀"}')
  })

  test("withholds a partial escape sequence until it completes", () => {
    const stream = createCanonicalJsonStream()
    expect(stream.push('{"s":"x\\u00')).toBe('{"s":"x')
    expect(stream.push('e9y"}')).toBe('éy"}')
  })

  test("holds a number until its delimiter so a split number is never emitted twice", () => {
    const stream = createCanonicalJsonStream()
    expect(stream.push('{"n":12')).toBe('{"n":')
    expect(stream.push("3.")).toBe("")
    expect(stream.push("50}")).toBe("123.5}")
  })

  test("flush completes a held token at the end of the arguments", () => {
    const stream = createCanonicalJsonStream()
    expect(stream.push("[1, 2")).toBe("[1,")
    expect(stream.flush()).toBe("2")
  })

  test("a duplicate key falls to raw passthrough that still parses to the same object", () => {
    const raw = '{"a":1,"b":2,"a":3}'
    const out = run(raw, [5, 4, 3, 7])
    expect(out).not.toBe(canonical(raw))
    expect(JSON.parse(out)).toEqual(JSON.parse(raw))
    expect(out.startsWith('{"a":1,"b":2,')).toBe(true)
  })

  test("an array-index-like key falls to raw passthrough that still parses to the same object", () => {
    const raw = '{"b": 1, "1": 2}'
    const out = run(raw, [3, 3, 3, 3, 3, 3])
    expect(JSON.parse(out)).toEqual(JSON.parse(raw))
    // Everything before the hazard is canonical; from the hazard on it is raw.
    expect(out).toBe('{"b":1,"1": 2}')
  })

  test("malformed input falls to raw passthrough instead of throwing", () => {
    const stream = createCanonicalJsonStream()
    expect(stream.push('{"a":tru')).toBe('{"a":')
    expect(stream.push("th}")).toBe("truth}")
    expect(stream.push("anything after")).toBe("anything after")
    expect(stream.flush()).toBe("")
  })

  test("anything after the top-level value passes through raw", () => {
    const stream = createCanonicalJsonStream()
    expect(stream.push("{} ")).toBe("{}")
    expect(stream.push(" x")).toBe("x")
  })

  test("an empty fragment emits nothing", () => {
    const stream = createCanonicalJsonStream()
    expect(stream.push("")).toBe("")
    expect(stream.flush()).toBe("")
  })
})

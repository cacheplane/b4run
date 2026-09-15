import { describe, expect, it } from "vitest"
import { createSourceBundle, readSourceFile, verifySourceBundle } from "../src/source-bundle.ts"

describe("source bundle canonical construction", () => {
  it("uses sorted entries and the independently calculated SHA256 vector", () => {
    const files = [
      { path: "bin/run", bytes: Uint8Array.of(239, 187, 191, 0, 255, 128), executable: true },
      { path: ".gitignore", bytes: new Uint8Array(), executable: false },
    ]
    const bundle = createSourceBundle(files)
    expect(bundle).toEqual(createSourceBundle([...files].reverse()))
    expect(bundle.files.map((file) => file.path)).toEqual([".gitignore", "bin/run"])
    expect(bundle.digest).toBe("fc71232efd115691439b2f231d1d40e3d7a7724b3762137b2dc0129403e74306")
    expect(readSourceFile(bundle, "bin/run")).toEqual(files[0]?.bytes)
    expect(readSourceFile(bundle, ".gitignore")).toEqual(new Uint8Array())
  })
  it("accepts empty source and includes executable metadata in identity", () => {
    expect(verifySourceBundle(createSourceBundle([])).files).toEqual([])
    const file = { path: "run", bytes: Uint8Array.of(1), executable: false }
    expect(createSourceBundle([file]).digest).not.toBe(
      createSourceBundle([{ ...file, executable: true }]).digest,
    )
  })
  it("owns immutable data and returns independent read buffers", () => {
    const input = { path: "a", bytes: Uint8Array.of(1, 2), executable: false }
    const files = [input]
    const bundle = createSourceBundle(files)
    input.bytes.fill(9)
    input.path = "b"
    files.length = 0
    expect(Object.isFrozen(bundle)).toBe(true)
    expect(Object.isFrozen(bundle.files)).toBe(true)
    expect(Object.isFrozen(bundle.files[0])).toBe(true)
    readSourceFile(bundle, "a").fill(9)
    expect(readSourceFile(bundle, "a")).toEqual(Uint8Array.of(1, 2))
    const verified = verifySourceBundle(bundle)
    expect(verified).toEqual(bundle)
    expect(verified).not.toBe(bundle)
    expect(verified.files).not.toBe(bundle.files)
    expect(Object.isFrozen(verified.files[0])).toBe(true)
    expect(() => readSourceFile(bundle, "missing")).toThrow(/missing/i)
  })
})

const inputFile = (path: string, bytes = new Uint8Array()) => ({ path, bytes, executable: false })
const stored = () =>
  JSON.parse(JSON.stringify(createSourceBundle([inputFile("a", Uint8Array.of(0)), inputFile("b")])))
const MiB = 1024 * 1024

describe("portable source paths", () => {
  it.each([
    "",
    "/a",
    "../a",
    "a/../b",
    "./a",
    "a/./b",
    "a//b",
    "a/",
    "a\\b",
    "C:/a",
    "a\u0000",
    "a\n",
    "a\u007f",
    "a\ud800",
    "e\u0301",
    "é",
    "a:b",
    "a*b",
    "a?b",
    "a<b",
    "a>b",
    'a"b',
    "a|b",
    " a",
    "a ",
    "a.",
    "a  b",
    "CON",
    "con.txt",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM9.txt",
    "LPT1",
    "LPT9",
    "dir/NUL.bin",
    "a".repeat(256),
    `${"a".repeat(255)}/${"b".repeat(255)}/${"c".repeat(255)}/${"d".repeat(255)}/e`,
  ])("rejects invalid path %j", (path) => {
    expect(() => createSourceBundle([inputFile(path)])).toThrow(/path|segment/i)
    expect(() => readSourceFile(createSourceBundle([]), path)).toThrow(/path|segment/i)
    const value = stored()
    value.files[0].path = path
    expect(() => verifySourceBundle(value)).toThrow()
  })
  it.each([".gitignore", ".config/settings.json", "node_modules", ".git", "a b", "COM10", "x..y"])(
    "accepts portable path %j",
    (path) => {
      expect(createSourceBundle([inputFile(path)]).files[0]?.path).toBe(path)
    },
  )
  it("accepts exactly 1024 ASCII bytes with segments within 255 bytes", () => {
    const path = `${"a".repeat(255)}/${"b".repeat(255)}/${"c".repeat(255)}/${"d".repeat(254)}/e`
    expect(path.length).toBe(1024)
    expect(createSourceBundle([inputFile(path)]).files[0]?.path).toBe(path)
  })
  it.each([
    ["a", "a"],
    ["a", "A"],
    ["a", "a/b"],
    ["A", "a/b"],
    ["a/b", "A"],
  ])("rejects collisions %j / %j in both orders", (a, b) => {
    for (const paths of [
      [a, b],
      [b, a],
    ])
      expect(() => createSourceBundle(paths.map((path) => inputFile(path)))).toThrow(
        /conflict|duplicate|collision/i,
      )
  })
})

describe("strict persisted records", () => {
  it.each([null, [], 1, {}, { version: 2, digest: "0".repeat(64), files: [] }])(
    "rejects malformed bundle %j",
    (value) => {
      expect(() => verifySourceBundle(value)).toThrow()
    },
  )
  it.each([
    (v: ReturnType<typeof stored>) => {
      v.extra = true
    },
    (v: ReturnType<typeof stored>) => {
      v.files[0].extra = true
    },
    (v: ReturnType<typeof stored>) => {
      delete v.files[0].executable
    },
    (v: ReturnType<typeof stored>) => {
      v.files[0].executable = 0
    },
    (v: ReturnType<typeof stored>) => {
      v.files[0].path = 1
    },
    (v: ReturnType<typeof stored>) => {
      v.files[0].base64 = null
    },
    (v: ReturnType<typeof stored>) => {
      v.files[0].base64 = "AQ=="
    },
    (v: ReturnType<typeof stored>) => {
      v.files[0].executable = true
    },
    (v: ReturnType<typeof stored>) => {
      v.files[0].path = "c"
    },
    (v: ReturnType<typeof stored>) => {
      v.digest = "0".repeat(64)
    },
    (v: ReturnType<typeof stored>) => {
      v.digest = v.digest.toUpperCase()
    },
    (v: ReturnType<typeof stored>) => {
      v.version = 2
    },
    (v: ReturnType<typeof stored>) => {
      v.files.reverse()
    },
    (v: ReturnType<typeof stored>) => {
      v.files[1] = v.files[0]
    },
    (v: ReturnType<typeof stored>) => {
      v.files[1].path = "A/b"
    },
  ])("rejects modified or noncanonical records", (mutate) => {
    const value = stored()
    mutate(value)
    expect(() => verifySourceBundle(value)).toThrow()
    expect(() => readSourceFile(value, "a")).toThrow()
  })
  it.each(["AA", "AA=", "AA===", "A A==", "AA==\n", "AB==", "AAB=", "____", "!!!!", "===="])(
    "rejects noncanonical base64 %j",
    (base64) => {
      const value = stored()
      value.files[0].base64 = base64
      expect(() => verifySourceBundle(value)).toThrow(/base64/i)
    },
  )
  it("rejects malformed construction inputs without coercion", () => {
    for (const value of [
      null,
      {},
      [null],
      [{ path: "a", bytes: [1], executable: false }],
      [{ path: "a", bytes: new Uint8Array(), executable: 0 }],
    ]) {
      expect(() => createSourceBundle(value as Parameters<typeof createSourceBundle>[0])).toThrow()
    }
  })
})

describe("bounded source content", () => {
  it("allows exactly 10000 entries and rejects more before visiting entries", () => {
    expect(
      createSourceBundle(Array.from({ length: 10000 }, (_, i) => inputFile(`f${i}`))).files,
    ).toHaveLength(10000)
    expect(() => createSourceBundle(new Array(10001))).toThrow(/10000|count|entries/i)
    const value = stored()
    value.files = new Array(10001)
    expect(() => verifySourceBundle(value)).toThrow(/10000|count|entries/i)
  })
  it("enforces the 16 MiB file limit including persisted encoded size", () => {
    const bytes = new Uint8Array(16 * MiB)
    const bundle = createSourceBundle([inputFile("a", bytes)])
    expect(readSourceFile(bundle, "a").byteLength).toBe(16 * MiB)
    expect(() => createSourceBundle([inputFile("a", new Uint8Array(16 * MiB + 1))])).toThrow(
      /file.*limit/i,
    )
    const value = stored()
    value.files[0].base64 = "A".repeat(4 * Math.ceil((16 * MiB + 1) / 3))
    expect(() => verifySourceBundle(value)).toThrow(/file.*limit/i)
  })
  it("enforces 64 MiB total before encoding or decoding content", () => {
    const bytes = new Uint8Array(16 * MiB)
    const inputs = ["a", "b", "c", "d"].map((path) => inputFile(path, bytes))
    const bundle = createSourceBundle(inputs)
    expect(verifySourceBundle(bundle).digest).toBe(bundle.digest)
    expect(() => createSourceBundle([...inputs, inputFile("e", Uint8Array.of(0))])).toThrow(
      /total.*limit/i,
    )
    const value = {
      ...bundle,
      files: [...bundle.files, { path: "e", base64: "AA==", executable: false }],
    }
    expect(() => verifySourceBundle(value)).toThrow(/total.*limit/i)
  })
})

describe("persisted array shape", () => {
  it("rejects array properties outside the canonical serialized shape", () => {
    const value = stored()
    value.files.extra = true
    expect(() => verifySourceBundle(value)).toThrow(/array/i)
  })
  it("rejects accessor entries without invoking them", () => {
    const value = stored()
    let accessed = false
    const file = value.files[0]
    Object.defineProperty(value.files, "0", {
      get: () => {
        accessed = true
        return file
      },
    })
    expect(() => verifySourceBundle(value)).toThrow(/array/i)
    expect(accessed).toBe(false)
  })
})

describe("portable directory casing", () => {
  it.each([
    ["src/a.ts", "SRC/b.ts"],
    ["a/src/one", "a/SRC/two"],
    ["a/src/one", "A/src/two"],
  ])("rejects inconsistent shared directory casing %j / %j", (a, b) => {
    for (const paths of [
      [a, b],
      [b, a],
    ]) {
      expect(() => createSourceBundle(paths.map((path) => inputFile(path)))).toThrow(
        /collision|casing/i,
      )
    }
    const files = [a, b].sort().map((path) => ({ path, base64: "", executable: false }))
    expect(() => verifySourceBundle({ version: 1, digest: "0".repeat(64), files })).toThrow(
      /collision|casing/i,
    )
  })
  it("accepts consistently cased shared directories", () => {
    const bundle = createSourceBundle([
      inputFile("Src/nested/a"),
      inputFile("Src/nested/b"),
      inputFile("Src/other/c"),
    ])
    expect(verifySourceBundle(bundle)).toEqual(bundle)
  })
})

describe("read buffer ownership", () => {
  it("returns tight, separate backing buffers even for small files", () => {
    const bundle = createSourceBundle([inputFile("a", Uint8Array.of(1, 2))])
    const first = readSourceFile(bundle, "a")
    const second = readSourceFile(bundle, "a")
    expect(first.buffer.byteLength).toBe(first.byteLength)
    expect(second.buffer.byteLength).toBe(second.byteLength)
    expect(first.buffer).not.toBe(second.buffer)
    new Uint8Array(first.buffer).fill(9)
    expect(second).toEqual(Uint8Array.of(1, 2))
    expect(readSourceFile(bundle, "a")).toEqual(Uint8Array.of(1, 2))
  })
})

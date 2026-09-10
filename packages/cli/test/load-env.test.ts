import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, test } from "vitest"

import { loadEnvFile, loadEnvFiles } from "../src/lib/dev/load-env.js"

let tempDir: string
const originalEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "b4-env-"))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  // Restore any env vars we modified
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

function saveEnv(...keys: string[]) {
  for (const key of keys) {
    originalEnv[key] = process.env[key]
  }
}

describe("loadEnvFile", () => {
  test("loads variables from .env file", () => {
    saveEnv("TEST_B4_FOO", "TEST_B4_BAR")
    delete process.env.TEST_B4_FOO
    delete process.env.TEST_B4_BAR

    writeFileSync(join(tempDir, ".env"), "TEST_B4_FOO=hello\nTEST_B4_BAR=world\n")

    const count = loadEnvFile(tempDir)

    expect(count).toBe(2)
    expect(process.env.TEST_B4_FOO).toBe("hello")
    expect(process.env.TEST_B4_BAR).toBe("world")
  })

  test("does not override existing env vars", () => {
    saveEnv("TEST_B4_EXISTING")
    process.env.TEST_B4_EXISTING = "original"

    writeFileSync(join(tempDir, ".env"), "TEST_B4_EXISTING=overridden\n")

    const count = loadEnvFile(tempDir)

    expect(count).toBe(0)
    expect(process.env.TEST_B4_EXISTING).toBe("original")
  })

  test("skips comments and blank lines", () => {
    saveEnv("TEST_B4_ONLY")
    delete process.env.TEST_B4_ONLY

    writeFileSync(
      join(tempDir, ".env"),
      "# This is a comment\n\nTEST_B4_ONLY=value\n\n# Another comment\n",
    )

    const count = loadEnvFile(tempDir)

    expect(count).toBe(1)
    expect(process.env.TEST_B4_ONLY).toBe("value")
  })

  test("strips surrounding quotes", () => {
    saveEnv("TEST_B4_DOUBLE", "TEST_B4_SINGLE")
    delete process.env.TEST_B4_DOUBLE
    delete process.env.TEST_B4_SINGLE

    writeFileSync(
      join(tempDir, ".env"),
      "TEST_B4_DOUBLE=\"quoted value\"\nTEST_B4_SINGLE='single quoted'\n",
    )

    const count = loadEnvFile(tempDir)

    expect(count).toBe(2)
    expect(process.env.TEST_B4_DOUBLE).toBe("quoted value")
    expect(process.env.TEST_B4_SINGLE).toBe("single quoted")
  })

  test("returns 0 when no .env file exists", () => {
    const count = loadEnvFile(tempDir)
    expect(count).toBe(0)
  })

  test("auto-enables LANGCHAIN_TRACING_V2 when LANGSMITH_API_KEY is present", () => {
    saveEnv("LANGSMITH_API_KEY", "LANGCHAIN_TRACING_V2")
    delete process.env.LANGSMITH_API_KEY
    delete process.env.LANGCHAIN_TRACING_V2

    writeFileSync(join(tempDir, ".env"), "LANGSMITH_API_KEY=lsv2_test_key\n")

    const count = loadEnvFile(tempDir)

    expect(count).toBe(2) // key + auto-set tracing
    expect(process.env.LANGSMITH_API_KEY).toBe("lsv2_test_key")
    expect(process.env.LANGCHAIN_TRACING_V2).toBe("true")
  })

  test("does not override explicit LANGCHAIN_TRACING_V2=false", () => {
    saveEnv("LANGSMITH_API_KEY", "LANGCHAIN_TRACING_V2")
    delete process.env.LANGSMITH_API_KEY
    delete process.env.LANGCHAIN_TRACING_V2

    writeFileSync(
      join(tempDir, ".env"),
      "LANGSMITH_API_KEY=lsv2_test_key\nLANGCHAIN_TRACING_V2=false\n",
    )

    const _count = loadEnvFile(tempDir)

    expect(process.env.LANGCHAIN_TRACING_V2).toBe("false")
  })
})

describe("loadEnvFiles", () => {
  let dir: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "b4-loadenvfiles-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) delete process.env[k]
    }
  })

  it("loads from an explicit absolute path", () => {
    const p = join(dir, "custom.env")
    writeFileSync(p, "B4_TEST_A=1\n")
    delete process.env.B4_TEST_A
    const n = loadEnvFiles([p])
    expect(n).toBeGreaterThanOrEqual(1)
    expect(process.env.B4_TEST_A).toBe("1")
  })

  it("does not override an already-set var (shell wins)", () => {
    const p = join(dir, ".env")
    writeFileSync(p, "B4_TEST_B=fromfile\n")
    process.env.B4_TEST_B = "fromshell"
    loadEnvFiles([p])
    expect(process.env.B4_TEST_B).toBe("fromshell")
  })

  it("loads multiple paths in order; first to set a key wins", () => {
    const a = join(dir, "a.env")
    const b = join(dir, "b.env")
    writeFileSync(a, "B4_TEST_C=fromA\n")
    writeFileSync(b, "B4_TEST_C=fromB\n")
    delete process.env.B4_TEST_C
    loadEnvFiles([a, b])
    expect(process.env.B4_TEST_C).toBe("fromA")
  })

  it("missing file contributes zero", () => {
    const n = loadEnvFiles([join(dir, "nope.env")])
    expect(n).toBe(0)
  })

  it("auto-enables LANGCHAIN_TRACING_V2 when LANGSMITH_API_KEY present", () => {
    const p = join(dir, ".env")
    writeFileSync(p, "LANGSMITH_API_KEY=ls-xyz\n")
    delete process.env.LANGSMITH_API_KEY
    delete process.env.LANGCHAIN_TRACING_V2
    loadEnvFiles([p])
    expect(process.env.LANGCHAIN_TRACING_V2).toBe("true")
  })
})

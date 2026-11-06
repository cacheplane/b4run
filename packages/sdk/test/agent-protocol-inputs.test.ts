import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ValidateFunction } from "ajv"
import { Ajv2020 } from "ajv/dist/2020.js"
import { fullFormats } from "ajv-formats/dist/formats.js"
import { describe, expect, it } from "vitest"
import {
  applyAgentProtocolCorrection,
  type OpenApiDocument,
  readAgentProtocolInputs,
} from "../scripts/agent-protocol-inputs.mjs"

const fixturesDirectory = fileURLToPath(
  new URL("../../../test/agent-protocol/fixtures/", import.meta.url),
)
const inputs = readAgentProtocolInputs()
const expectedRequired = ["run_id", "created_at", "updated_at", "status", "metadata"]
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

type SchemaName = "RunStream" | "Run" | "Message"

function validators(document: OpenApiDocument): Record<SchemaName, ValidateFunction> {
  const ajv = new Ajv2020({ allErrors: true, strictTypes: false, strictRequired: false })
  for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format)
  // OpenAPI's components is a document container, not a JSON Schema assertion.
  // Register only that container annotation; referenced payload schemas retain validation.
  ajv.addKeyword({ keyword: "components", schemaType: "object", valid: true })
  ajv.addSchema({ $id: "urn:agent-protocol:contract", components: document.components })
  const compile = (name: SchemaName) =>
    ajv.compile({
      $ref: `urn:agent-protocol:contract#/components/schemas/${name}`,
    })
  return { RunStream: compile("RunStream"), Run: compile("Run"), Message: compile("Message") }
}

const original = validators(inputs.originalOpenapi)
const corrected = validators(inputs.correctedOpenapi)
const wireCases = JSON.parse(readFileSync(join(fixturesDirectory, "wire-cases.json"), "utf8")) as {
  name: string
  schema: SchemaName
  value: unknown
  originalValid: boolean
  correctedValid: boolean
}[]

function withFixtures(change: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "agent-protocol-inputs-"))
  try {
    cpSync(fixturesDirectory, directory, { recursive: true })
    change(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("pinned Agent Protocol source inputs", () => {
  it("matches immutable source bytes, license, versions, and manifest hashes", () => {
    expect(inputs.manifest.commit).toBe("455acf2eb2c55c634350f4c6a8da117d0ecfa7b1")
    expect(inputs.manifest.license).toBe("MIT")
    expect(inputs.manifest.versions).toEqual({ openapi: "0.1.6", cddl: "0.0.20" })
    expect(inputs.manifest.files.map((file) => file.path).sort()).toEqual([
      "LICENSE",
      "openapi.json",
      "protocol.cddl",
    ])
    for (const file of inputs.manifest.files) {
      const bytes = readFileSync(join(fixturesDirectory, "upstream", file.path))
      expect(bytes.length).toBe(file.bytes)
      expect(sha256(bytes)).toBe(file.sha256)
      expect(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")).toBe(
        file.gitBlobSha1,
      )
      expect(file.url).toBe(
        `https://raw.githubusercontent.com/langchain-ai/agent-protocol/${inputs.manifest.commit}/${file.path === "protocol.cddl" ? "streaming/protocol.cddl" : file.path}`,
      )
    }
    expect(inputs.originalOpenapi.info.version).toBe("0.1.6")
    expect(readFileSync(join(fixturesDirectory, "upstream/protocol.cddl"), "utf8")).toContain(
      "; Version: 0.0.20",
    )
    expect(readFileSync(join(fixturesDirectory, "upstream/LICENSE"), "utf8")).toContain(
      "Copyright (c) 2024 LangChain, Inc.",
    )
  })

  it("counts exactly 27 method/path operations", () => {
    const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"])
    const operations = Object.entries(inputs.originalOpenapi.paths).flatMap(([path, item]) =>
      Object.keys(item)
        .filter((method) => methods.has(method))
        .map((method) => `${method.toUpperCase()} ${path}`),
    )
    expect(operations).toHaveLength(27)
    expect(new Set(operations).size).toBe(27)
  })

  it("reproduces all five original RunStream request-required failures", () => {
    expect(original.RunStream({})).toBe(false)
    const originalErrors = original.RunStream.errors ?? []
    expect(originalErrors).toHaveLength(5)
    expect(originalErrors.map((error) => error.params.missingProperty).sort()).toEqual([
      "created_at",
      "metadata",
      "run_id",
      "status",
      "updated_at",
    ])
  })

  it("accepts the corrected empty RunStream request while Run responses still require their fields", () => {
    expect(corrected.RunStream({})).toBe(true)
    expect(corrected.Run({})).toBe(false)
    expect(corrected.Run.errors?.map((error) => error.params.missingProperty).sort()).toEqual([
      "created_at",
      "metadata",
      "run_id",
      "status",
      "updated_at",
    ])
  })

  it("validates an unmodified ordinary text-array Message", () => {
    expect(original.Message({ role: "user", content: [{ type: "text", text: "ok" }] })).toBe(true)
    expect(inputs.correctedOpenapi.components.schemas.Message).toEqual(
      inputs.originalOpenapi.components.schemas.Message,
    )
  })

  it("applies exactly one removal without changing the original or any other constraint", () => {
    const expected = structuredClone(inputs.originalOpenapi)
    const stream = expected.components.schemas.RunStream as {
      allOf: [unknown, { required?: string[] }]
    }
    delete stream.allOf[1].required
    expect(inputs.correctedOpenapi).toEqual(expected)
    expect(
      (
        inputs.originalOpenapi.components.schemas.RunStream as {
          allOf: [unknown, { required?: string[] }]
        }
      ).allOf[1].required,
    ).toEqual(expectedRequired)
    expect(inputs.corrections.operations).toEqual([
      {
        op: "remove",
        path: "/components/schemas/RunStream/allOf/1/required",
        expected: expectedRequired,
      },
    ])
  })

  it("rejects changed raw bytes before parsing or correction", () => {
    withFixtures((directory) => {
      writeFileSync(join(directory, "upstream/openapi.json"), "not even JSON")
      expect(() => readAgentProtocolInputs({ fixturesDirectory: directory })).toThrow(
        /OpenAPI SHA256 mismatch/,
      )
    })
  })

  it.each(["protocol.cddl", "LICENSE"])("rejects changed %s bytes", (file) => {
    withFixtures((directory) => {
      writeFileSync(join(directory, "upstream", file), "changed")
      expect(() => readAgentProtocolInputs({ fixturesDirectory: directory })).toThrow(
        /SHA256 mismatch/,
      )
    })
  })

  it.each(["source hash", "expected array", "additional operation"])(
    "rejects a changed correction %s",
    (field) => {
      withFixtures((directory) => {
        const correction = structuredClone(inputs.corrections)
        if (field === "source hash") correction.sourceSha256 = "0".repeat(64)
        if (field === "expected array") correction.operations[0].expected.reverse()
        if (field === "additional operation") correction.operations.push(correction.operations[0])
        writeFileSync(join(directory, "corrections.json"), JSON.stringify(correction))
        expect(() => readAgentProtocolInputs({ fixturesDirectory: directory })).toThrow(
          /correction contract/,
        )
      })
    },
  )

  it("rejects a correction at any other JSON pointer", () => {
    withFixtures((directory) => {
      const correction = structuredClone(inputs.corrections)
      correction.operations[0].path = "/components/schemas/Run/allOf/1/required"
      writeFileSync(join(directory, "corrections.json"), JSON.stringify(correction))
      expect(() => readAgentProtocolInputs({ fixturesDirectory: directory })).toThrow(
        /correction contract/,
      )
    })
  })

  it.each([
    ["reordered", ["created_at", "run_id", "updated_at", "status", "metadata"]],
    ["missing", undefined],
    ["shortened", ["run_id", "created_at", "updated_at", "status"]],
    ["wrong type", "run_id"],
  ])("rejects an unexpectedly %s target", (_name, required) => {
    const document = structuredClone(inputs.originalOpenapi)
    const stream = document.components.schemas.RunStream as {
      allOf: [unknown, { required?: unknown }]
    }
    if (required === undefined) delete stream.allOf[1].required
    else stream.allOf[1].required = required
    expect(() => applyAgentProtocolCorrection(document)).toThrow(/correction target/)
  })

  it.each(wireCases)("collects wire case: $name", (wire) => {
    expect(original[wire.schema](wire.value)).toBe(wire.originalValid)
    expect(corrected[wire.schema](wire.value)).toBe(wire.correctedValid)
  })
})

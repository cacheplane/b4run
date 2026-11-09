import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, posix } from "node:path"
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

  it("preserves all pinned source bytes in an isolated autocrlf checkout", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-protocol-checkout-"))
    const repository = join(directory, "repository")
    const templates = join(directory, "empty-templates")
    const emptyConfig = join(directory, "empty-config")
    const emptyAttributes = join(directory, "empty-attributes")
    const prefix = "test/agent-protocol/fixtures/upstream"
    const pins = [
      {
        path: "openapi.json",
        sha256: "7d069e43ca105e8127ce07ba7bd8bd7a78a2fadd6420009f2634a24cfb153f32",
      },
      {
        path: "protocol.cddl",
        sha256: "9cebafc02e523f509f880aa8ebaa2af077f8a7f0589d8063a50d610c3af78fb1",
      },
      {
        path: "LICENSE",
        sha256: "d9bb52f2e3540d60ff50d8f0f5b6ba649b7fd346948c4c3d086c8afb120763c7",
      },
    ]
    try {
      mkdirSync(join(repository, prefix), { recursive: true })
      mkdirSync(templates)
      writeFileSync(emptyConfig, "")
      writeFileSync(emptyAttributes, "")
      cpSync(
        fileURLToPath(new URL("../../../.gitattributes", import.meta.url)),
        join(repository, ".gitattributes"),
      )
      for (const pin of pins) {
        const source = join(fixturesDirectory, "upstream", pin.path)
        expect(sha256(readFileSync(source))).toBe(pin.sha256)
        cpSync(source, join(repository, prefix, pin.path))
      }
      const env = {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/^GIT_/i.test(key) &&
              !["GH_TOKEN", "GITHUB_TOKEN", "SSH_AUTH_SOCK"].includes(key.toUpperCase()),
          ),
        ),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: emptyConfig,
        GIT_ATTR_NOSYSTEM: "1",
      }
      const git = (args: readonly string[]) => {
        const result = spawnSync(
          "git",
          [
            "-c",
            "core.autocrlf=true",
            "-c",
            `core.attributesFile=${emptyAttributes}`,
            "-c",
            `core.hooksPath=${templates}`,
            ...args,
          ],
          { cwd: repository, env, timeout: 4_000 },
        )
        expect(result.error).toBeUndefined()
        expect(result.status).toBe(0)
        expect(result.signal).toBeNull()
      }
      git(["init", "--quiet", `--template=${templates}`])
      git(["add", "--", ".gitattributes", ...pins.map((pin) => `${prefix}/${pin.path}`)])
      for (const pin of pins) rmSync(join(repository, prefix, pin.path))
      git(["checkout-index", "--force", "--all"])
      // Collect every reconstructed source before comparing, so the first
      // failing pin cannot hide the other files' checkout behavior.
      const actual = pins.map((pin) => ({
        path: pin.path,
        sha256: sha256(readFileSync(join(repository, prefix, pin.path))),
      }))
      expect(actual).toEqual(pins)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

const sdkDirectory = fileURLToPath(new URL("../", import.meta.url))
const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url))
const railwayFixturePaths = [
  "upstream/openapi.json",
  "upstream/protocol.cddl",
  "upstream/LICENSE",
  "upstream/manifest.json",
  "corrections.json",
  "wire-cases.json",
  "b4-wire-cases.json",
]
const generatedAssetNames = [
  "tool-step.schema.json",
  "answer.schema.json",
  "agent-protocol.schema.json",
  "agent-protocol.fixtures.json",
]

// Deliberately recognizes only this Dockerfile's direct shell-form COPY inputs
// before the first dependency build. This is a generator-input check after tsc,
// not a Docker build or an implementation of Docker context/ignore semantics.
function railwayCopiedFixtures() {
  const dockerfile = readFileSync(
    new URL("../../../examples/navlog/server/Dockerfile.railway", import.meta.url),
    "utf8",
  )
  const lines = dockerfile.split(/\r?\n/u).map((line) => line.trim())
  const start = lines.findIndex((line) => line.startsWith("FROM "))
  const end = lines.findIndex((line) => /^RUN pnpm .* run build$/u.test(line))
  if (start < 0 || end <= start) throw new Error("Unrecognized Railway dependency-build boundary")
  const beforeBuild = lines.slice(start + 1, end)
  if (beforeBuild.some((line) => line.startsWith("FROM "))) {
    throw new Error("Unrecognized Railway build stage")
  }
  if (beforeBuild.filter((line) => line.startsWith("WORKDIR ")).join("\n") !== "WORKDIR /app") {
    throw new Error("Unrecognized Railway build working directory")
  }
  const copied = new Set<string>()
  for (const line of beforeBuild.filter((candidate) => candidate.startsWith("COPY "))) {
    const tokens = line.slice(5).split(/\s+/u)
    if (
      tokens.length < 2 ||
      tokens.some(
        (token) =>
          !/^(?:\.\/)?[A-Za-z0-9_./-]+$/u.test(token) ||
          token.startsWith("--") ||
          token.startsWith("/") ||
          token.split("/").includes(".."),
      )
    ) {
      throw new Error(`Unsupported Railway COPY form: ${line}`)
    }
    const destination = tokens.at(-1) as string
    for (const source of tokens.slice(0, -1)) {
      const directory = statSync(join(repositoryDirectory, source)).isDirectory()
      for (const file of railwayFixturePaths) {
        const fixture = `test/agent-protocol/fixtures/${file}`
        const suffix = posix.relative(source, fixture)
        if (suffix.startsWith("../") || suffix === ".." || (!directory && suffix !== "")) continue
        const target = posix.normalize(
          directory
            ? posix.join(destination, suffix)
            : destination.endsWith("/") || destination === "." || destination === "./"
              ? posix.join(destination, basename(source))
              : destination,
        )
        if (target === fixture) copied.add(file)
      }
    }
  }
  return copied
}

function privateRailwayEvidence(name: string, value: unknown) {
  const directory = process.env.B4_RAILWAY_PROTOCOL_TEST_EVIDENCE_DIR
  if (directory === undefined) return
  const info = lstatSync(directory)
  if (
    !isAbsolute(directory) ||
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    (process.getuid !== undefined && info.uid !== process.getuid())
  ) {
    throw new Error("Railway test evidence requires a caller-owned absolute 0700 directory")
  }
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(bytes) > 256 * 1024)
    throw new Error("Railway test evidence exceeded its bound")
  writeFileSync(join(directory, name), bytes, { flag: "wx", mode: 0o600 })
}

describe("Railway image protocol asset inputs", () => {
  it.each([
    { name: "full-input control", imageInputs: false },
    { name: "actual build-stage COPY closure", imageInputs: true },
  ])("runs the actual SDK generator with $name", ({ imageInputs }) => {
    const directory = mkdtempSync(join(tmpdir(), "railway-protocol-inputs-"))
    const stagedSdk = join(directory, "packages/sdk")
    const evidenceName = basename(directory)
    let primaryFailure: { error: unknown } | undefined
    let cleanupError: unknown
    try {
      mkdirSync(stagedSdk, { recursive: true })
      for (const entry of ["package.json", "scripts", "dist"]) {
        cpSync(join(sdkDirectory, entry), join(stagedSdk, entry), { recursive: true })
      }
      // Completed tsc output is supplied by the test's build prerequisite. Do
      // not let previously generated assets satisfy the generation assertions.
      for (const asset of generatedAssetNames) rmSync(join(stagedSdk, "dist", asset))
      const copied = imageInputs ? railwayCopiedFixtures() : new Set(railwayFixturePaths)
      for (const file of copied) {
        const target = join(directory, "test/agent-protocol/fixtures", file)
        mkdirSync(dirname(target), { recursive: true })
        cpSync(join(fixturesDirectory, file), target)
      }
      const argv = [join(stagedSdk, "scripts/write-schema.mjs")]
      const env = Object.fromEntries(
        ["PATH", "SystemRoot", "TEMP", "TMP", "TMPDIR"].flatMap((key) =>
          process.env[key] === undefined ? [] : [[key, process.env[key] as string]],
        ),
      )
      const result = spawnSync(process.execPath, argv, {
        cwd: directory,
        env,
        encoding: "utf8",
        timeout: 4_000,
        maxBuffer: 64 * 1024,
      })
      const assets = generatedAssetNames.map((file) => ({
        file,
        sha256: existsSync(join(stagedSdk, "dist", file))
          ? sha256(readFileSync(join(stagedSdk, "dist", file)))
          : null,
      }))
      privateRailwayEvidence(`${evidenceName}.result.json`, {
        stageRoot: directory,
        executable: process.execPath,
        argv,
        pid: result.pid,
        spawnSyncReturned: true,
        status: result.status,
        signal: result.signal,
        error: result.error === undefined ? null : String(result.error),
        stdout: result.stdout,
        stderr: result.stderr,
        copiedFixtures: [...copied],
        assets,
      })
      expect(result.error).toBeUndefined()
      expect(result.signal).toBeNull()
      // The message is the actual child diagnostic; no simulated ENOENT text.
      expect(result.status, result.stderr).toBe(0)
      for (const asset of generatedAssetNames) {
        expect(readFileSync(join(stagedSdk, "dist", asset))).toEqual(
          readFileSync(join(sdkDirectory, "dist", asset)),
        )
      }
    } catch (error) {
      primaryFailure = { error }
    } finally {
      try {
        rmSync(directory, { recursive: true, force: true })
      } catch (error) {
        cleanupError = error
      }
      try {
        privateRailwayEvidence(`${evidenceName}.cleanup.json`, {
          stageRoot: directory,
          removed: !existsSync(directory),
          error: cleanupError === undefined ? null : String(cleanupError),
        })
      } catch (error) {
        cleanupError ??= error
      }
    }
    if (primaryFailure !== undefined) throw primaryFailure.error
    if (cleanupError !== undefined) throw cleanupError
  })
})

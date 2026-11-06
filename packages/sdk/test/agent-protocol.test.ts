import { execFileSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Ajv2020 } from "ajv/dist/2020.js"
import { fullFormats } from "ajv-formats/dist/formats.js"
import { describe, expect, it } from "vitest"

const assetPath = fileURLToPath(new URL("../dist/agent-protocol.schema.json", import.meta.url))
const fixturesPath = fileURLToPath(new URL("../dist/agent-protocol.fixtures.json", import.meta.url))
const cases = JSON.parse(
  readFileSync(
    new URL("../../../test/agent-protocol/fixtures/b4-wire-cases.json", import.meta.url),
    "utf8",
  ),
) as { name: string; schema: string; value: unknown; valid: boolean }[]
const schema = existsSync(assetPath) ? JSON.parse(readFileSync(assetPath, "utf8")) : { $defs: {} }
const ajv = new Ajv2020({ allErrors: true, strictTypes: false, strictRequired: false })
for (const [name, format] of Object.entries(fullFormats)) ajv.addFormat(name, format)
for (const keyword of ["manifest", "corrections", "nativeSource", "notices"])
  ajv.addKeyword({ keyword, valid: true })
ajv.addSchema({ ...schema, $id: "urn:b4:agent-protocol:test" })

describe("published Agent Protocol contracts", () => {
  it.each(cases)("validates $name", (wire) => {
    expect(schema.$defs, `missing published definition ${wire.schema}`).toHaveProperty(wire.schema)
    const validate = ajv.compile({ $ref: `urn:b4:agent-protocol:test#/$defs/${wire.schema}` })
    expect(validate(wire.value), JSON.stringify(validate.errors)).toBe(wire.valid)
  })
  it("faithfully translates the pinned CDDL channel regexp to ECMAScript", () => {
    const cddl = readFileSync(
      new URL("../../../test/agent-protocol/fixtures/upstream/protocol.cddl", import.meta.url),
      "utf8",
    )
    expect(cddl).toContain('tstr .regexp "custom:.+"')
    expect(schema.$defs.AspChannel.anyOf).toContainEqual({
      type: "string",
      pattern: "^(?:custom:[^\\n\\r]+)$",
    })
  })
  it("preserves the distinct generic OpenAPI StreamingChannel schema", () => {
    const original = JSON.parse(
      readFileSync(
        new URL("../../../test/agent-protocol/fixtures/upstream/openapi.json", import.meta.url),
        "utf8",
      ),
    )
    expect(schema.$defs.StreamingChannel).toEqual(original.components.schemas.StreamingChannel)
    const check = (name: string, value: string) =>
      ajv.validate({ $ref: `urn:b4:agent-protocol:test#/$defs/${name}` }, value)
    expect(check("StreamingChannel", "custom:a\n")).toBe(true)
    expect(check("AspChannel", "custom:a\n")).toBe(false)
    expect(check("StreamingChannel", "custom:\u2028")).toBe(false)
    expect(check("AspChannel", "custom:\u2028")).toBe(true)
  })
  it("publishes both pinned JSON assets and exactly three contract subpaths", () => {
    expect(existsSync(fixturesPath), "missing fixture asset").toBe(true)
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(Object.keys(pkg.exports).filter((key) => key.startsWith("./agent-protocol"))).toEqual([
      "./agent-protocol",
      "./agent-protocol.schema.json",
      "./agent-protocol.fixtures.json",
    ])
    const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"))
    expect(fixtures.b4).toEqual(cases)
    expect(fixtures.upstream).toHaveLength(11)
    expect(fixtures.manifest.commit).toBe("455acf2eb2c55c634350f4c6a8da117d0ecfa7b1")
    expect(fixtures.notices).toContain("Copyright (c) 2024 LangChain, Inc.")
    expect(schema.manifest).toEqual(fixtures.manifest)
  })
})

// These are compile-time contracts checked by the SDK typecheck lane too.
import type {
  AspEvent,
  AspInputRespondEntry,
  AspResponseMeta,
  AspRunResult,
  AspStateForkResult,
  B4Command,
  B4Run,
  CallerRunMetadata,
  OperationLookupV1,
  PermissionResponseV1,
  ReceiptV1,
  RequestMetadataV1,
  RunStatus,
} from "../src/agent-protocol/index.ts"

const compileContracts = () => {
  const id = "871e7ea2-7a46-4678-bcac-3a912de1b008"
  const run: AspRunResult = { runId: id }
  const fork: AspStateForkResult = { runId: id, threadId: id }
  const meta: AspResponseMeta = { future: { any: [null, 1] }, b4: { v: 1 } }
  const event: AspEvent = {
    type: "event",
    method: "values",
    params: { namespace: [], timestamp: 0, data: { arbitrary: true } },
    future: [1],
  }
  const nativeReceipt: ReceiptV1 = {
    submissionId: "arbitrary-native-token",
    submissionKind: "agui",
    runId: id,
    turnId: id,
    acceptedAt: "2026-11-05T12:00:00Z",
    replayed: false,
    disposition: "accepted",
  }
  const inject: B4Command = {
    id: 1,
    method: "input.inject",
    params: {
      namespace: [],
      message: { role: "user", content: "hello", b4: { v: 1, submissionId: id } },
    },
  }
  // @ts-expect-error RunResult is closed; receipts belong in ResponseMeta.
  const badRun: AspRunResult = { runId: id, b4: { v: 1 } }
  // @ts-expect-error StateForkResult is closed too.
  const badFork: AspStateForkResult = { runId: id, threadId: id, b4: { v: 1 } }
  const badEntry: AspInputRespondEntry = {
    namespace: [],
    interruptId: "i",
    response: null,
    // @ts-expect-error An answer entry has no metadata carrier.
    metadata: {},
  }
  // @ts-expect-error Protected server fields are forbidden in request-side b4.
  const forged: RequestMetadataV1 = { v: 1, turnId: id }
  // @ts-expect-error exactOptionalPropertyTypes forbids explicit undefined.
  const undefinedExpectation: RequestMetadataV1 = { v: 1, expected: { runId: undefined } }
  // @ts-expect-error Canonical Run status has no stopped member.
  const badStatus: RunStatus = "stopped"
  // @ts-expect-error Permission decisions have three exact spellings.
  const badPermission: PermissionResponseV1 = { decision: "cancel" }
  // @ts-expect-error An accepted lookup must contain its receipt.
  const badLookup: OperationLookupV1 = { submissionId: id, submissionKind: "b4", state: "accepted" }
  // @ts-expect-error Public Run responses keep all standard required members.
  const incompleteRun: B4Run = {
    metadata: {
      b4: {
        v: 1,
        generation: id,
        turnId: id,
        phase: "accepted",
        continuation: "none",
        acceptedAt: "2026-11-05T12:00:00Z",
        effectsUncertain: false,
      },
    },
  }
  // @ts-expect-error Query-only selectors cannot become caller annotations.
  const forgedSelector: CallerRunMetadata = { "b4.submissionId": id }
  return {
    incompleteRun,
    forgedSelector,
    run,
    fork,
    meta,
    event,
    nativeReceipt,
    inject,
    badRun,
    badFork,
    badEntry,
    forged,
    undefinedExpectation,
    badStatus,
    badPermission,
    badLookup,
  }
}
void compileContracts

describe("built Agent Protocol consumers", () => {
  const sdkDirectory = fileURLToPath(new URL("..", import.meta.url))
  it("loads all three package subpaths using the real exports map", () => {
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import {AGENT_PROTOCOL_VERSIONS} from "@b4run/sdk/agent-protocol";
import schema from "@b4run/sdk/agent-protocol.schema.json" with {type:"json"};
import fixtures from "@b4run/sdk/agent-protocol.fixtures.json" with {type:"json"};
process.stdout.write(JSON.stringify({versions:AGENT_PROTOCOL_VERSIONS,count:fixtures.b4.length,definitions:Object.keys(schema.$defs).length}));`,
      ],
      { cwd: sdkDirectory, encoding: "utf8" },
    )
    expect(JSON.parse(output)).toMatchObject({
      versions: { openapi: "0.1.6", cddl: "0.0.20", b4: 1 },
      count: cases.length,
    })
  })
  it("has no Node or model imports in the actual JS and declaration graph", () => {
    const visited = new Set<string>()
    const visit = (path: string) => {
      if (visited.has(path)) return
      visited.add(path)
      const source = readFileSync(path, "utf8")
      for (const match of source.matchAll(/(?:from\s*|import\s*(?:\(\s*)?)(["'])([^"']+)\1/g)) {
        const specifier = match[2] as string
        expect(specifier.startsWith("./"), `${path}: ${specifier}`).toBe(true)
        const target = resolve(
          dirname(path),
          path.endsWith(".d.ts") ? specifier.replace(/\.js$/, ".d.ts") : specifier,
        )
        visit(target)
      }
      expect(source).not.toMatch(/(?:require|import)\s*\(\s*[`]/)
    }
    visit(join(sdkDirectory, "dist/agent-protocol/index.js"))
    visit(join(sdkDirectory, "dist/agent-protocol/index.d.ts"))
    expect(visited.size).toBeGreaterThanOrEqual(8)
  })
  it("compiles a consumer against built declarations and both JSON assets", () => {
    const directory = mkdtempSync(join(tmpdir(), "b4-contract-consumer-"))
    try {
      mkdirSync(join(directory, "node_modules/@b4run"), { recursive: true })
      symlinkSync(sdkDirectory, join(directory, "node_modules/@b4run/sdk"), "dir")
      writeFileSync(
        join(directory, "consumer.mts"),
        `import type {AspRunResult,AspStateForkResult,ReceiptV1,B4Command} from "@b4run/sdk/agent-protocol";
import schema from "@b4run/sdk/agent-protocol.schema.json" with {type:"json"};
import fixtures from "@b4run/sdk/agent-protocol.fixtures.json" with {type:"json"};
const run:AspRunResult={runId:"871e7ea2-7a46-4678-bcac-3a912de1b008"};
const fork:AspStateForkResult={runId:"871e7ea2-7a46-4678-bcac-3a912de1b008",threadId:"871e7ea2-7a46-4678-bcac-3a912de1b008"};
// @ts-expect-error closed result
const forged:AspRunResult={runId:"id",b4:{v:1}};
const native:ReceiptV1={submissionId:"arbitrary/native-token",submissionKind:"agui",runId:"id",turnId:"id",acceptedAt:"2026-11-05T12:00:00Z",replayed:false,disposition:"accepted"};
void [run,fork,forged,native,schema.$defs,fixtures.manifest];`,
      )
      const tsc = fileURLToPath(
        new URL("../../../node_modules/typescript/bin/tsc", import.meta.url),
      )
      execFileSync(
        process.execPath,
        [
          tsc,
          "--ignoreConfig",
          "--noEmit",
          "--module",
          "NodeNext",
          "--moduleResolution",
          "NodeNext",
          "--target",
          "ES2022",
          "--strict",
          "--exactOptionalPropertyTypes",
          "--resolveJsonModule",
          "--skipLibCheck",
          join(directory, "consumer.mts"),
        ],
        { cwd: sdkDirectory, encoding: "utf8" },
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  it("compiles every definition independently with Ajv", () => {
    for (const name of Object.keys(schema.$defs))
      expect(() => ajv.compile({ $ref: `urn:b4:agent-protocol:test#/$defs/${name}` })).not.toThrow()
  })
})

describe("deterministic pinned asset generation", () => {
  const sdkDirectory = fileURLToPath(new URL("..", import.meta.url))
  it("emits identical bytes on repeated builds and retains original conformance cases", () => {
    const directory = mkdtempSync(join(tmpdir(), "b4-contract-assets-"))
    try {
      const generator = new URL("../scripts/write-agent-protocol-schema.mjs", import.meta.url).href
      for (const name of ["first", "second"]) {
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "--eval",
            `import {writeAgentProtocolAssets} from ${JSON.stringify(generator)};writeAgentProtocolAssets({distDirectory:${JSON.stringify(join(directory, name))}})`,
          ],
          { cwd: sdkDirectory },
        )
      }
      for (const file of ["agent-protocol.schema.json", "agent-protocol.fixtures.json"]) {
        const expected = readFileSync(join(sdkDirectory, "dist", file))
        expect(readFileSync(join(directory, "first", file)).equals(expected)).toBe(true)
        expect(readFileSync(join(directory, "second", file)).equals(expected)).toBe(true)
      }
      const packed = JSON.parse(readFileSync(fixturesPath, "utf8"))
      const source = JSON.parse(
        readFileSync(
          new URL("../../../test/agent-protocol/fixtures/wire-cases.json", import.meta.url),
          "utf8",
        ),
      )
      expect(packed.upstream).toEqual(source)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe("built upstream schema preservation", () => {
  const upstreamCases = JSON.parse(
    readFileSync(
      new URL("../../../test/agent-protocol/fixtures/wire-cases.json", import.meta.url),
      "utf8",
    ),
  ) as { name: string; schema: string; value: unknown; correctedValid: boolean }[]
  it.each(upstreamCases)("retains corrected conformance: $name", (wire) => {
    const validate = ajv.compile({ $ref: `urn:b4:agent-protocol:test#/$defs/${wire.schema}` })
    expect(validate(wire.value), JSON.stringify(validate.errors)).toBe(wire.correctedValid)
  })
  it.each(["openapi.json", "protocol.cddl", "LICENSE"])(
    "fails asset generation on altered pinned %s",
    (file) => {
      const directory = mkdtempSync(join(tmpdir(), "b4-contract-tamper-"))
      try {
        const fixtures = join(directory, "fixtures")
        cpSync(
          fileURLToPath(new URL("../../../test/agent-protocol/fixtures", import.meta.url)),
          fixtures,
          { recursive: true },
        )
        writeFileSync(join(fixtures, "upstream", file), "tampered bytes")
        const output = join(directory, "output")
        const generator = new URL("../scripts/write-agent-protocol-schema.mjs", import.meta.url)
          .href
        const command = `import {writeAgentProtocolAssets} from ${JSON.stringify(generator)};writeAgentProtocolAssets({fixturesDirectory:${JSON.stringify(fixtures)},distDirectory:${JSON.stringify(output)}})`
        expect(() =>
          execFileSync(process.execPath, ["--input-type=module", "--eval", command], {
            stdio: "pipe",
          }),
        ).toThrow(/SHA256 mismatch/)
        expect(existsSync(join(output, "agent-protocol.schema.json"))).toBe(false)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  )
})

it("hashes shared normative inputs and corpus for SDK build and test caching", () => {
  const turbo = JSON.parse(readFileSync(new URL("../../../turbo.json", import.meta.url), "utf8"))
  for (const name of ["@b4run/sdk#build", "@b4run/sdk#test"]) {
    expect(turbo.tasks[name]?.inputs).toContain("$TURBO_ROOT$/test/agent-protocol/fixtures/**")
    expect(turbo.tasks[name]?.inputs).toContain("$TURBO_DEFAULT$")
  }
  expect(turbo.tasks["@b4run/sdk#build"].outputs).toContain("dist/**")
  expect(turbo.tasks["@b4run/sdk#build"].dependsOn).toContain("^build")
})

import type {
  AgentLimitsV1,
  InputDispositionV1,
  WebhookDeliverySummary,
} from "../src/agent-protocol/index.ts"

const compileApprovedShapes = () => {
  const id = "871e7ea2-7a46-4678-bcac-3a912de1b008"
  const input: InputDispositionV1 = {
    v: 1,
    inputId: id,
    runId: id,
    turnId: id,
    disposition: "applied",
    future: { opaque: true },
  }
  const limits: AgentLimitsV1 = {
    requestBytes: 1048576,
    pendingPrompts: 64,
    inbox: { entries: 128, bytes: 1048576, textBytes: 65536 },
  }
  const webhook: WebhookDeliverySummary = { state: "pending", attempts: 0 }
  const leaked: InputDispositionV1 = {
    v: 1,
    inputId: id,
    runId: id,
    turnId: id,
    disposition: "applied",
    // @ts-expect-error A disposition never exposes grant material.
    grant: "private",
  }
  // @ts-expect-error Common effective limits are required.
  const incomplete: AgentLimitsV1 = { requestBytes: 1048576 }
  const partial: AgentLimitsV1 = {
    requestBytes: 1048576,
    pendingPrompts: 64,
    // @ts-expect-error A present group is complete.
    inbox: { entries: 128, bytes: 1048576 },
  }
  // @ts-expect-error The public delivery summary has three exact states.
  const queued: WebhookDeliverySummary = { state: "queued", attempts: 0 }
  return { input, limits, webhook, leaked, incomplete, partial, queued }
}
void compileApprovedShapes

import type { StreamingChannel } from "../src/agent-protocol/index.ts"

const compilePublicMessageRoles = () => {
  // @ts-expect-error B4 REST resources use public roles, not ASP roles.
  const messages: B4Run["messages"] = [{ role: "human", content: "no" }]
  // @ts-expect-error Standard channels are enumerated or namespaced custom channels.
  const channel: StreamingChannel = "not-a-channel"
  return { messages, channel }
}
void compilePublicMessageRoles

it("preserves every native capability property and required key from the pinned closure", () => {
  const reference = JSON.parse(
    readFileSync(
      new URL(
        "../../../test/agent-protocol/fixtures/native-capability-property-keys.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    source: Record<string, unknown>
    definitions: Record<string, { properties: string[]; required: string[] }>
  }
  expect(schema.nativeSource).toEqual(reference.source)
  expect(Object.keys(reference.definitions)).toHaveLength(16)
  for (const [name, expected] of Object.entries(reference.definitions)) {
    const actual = schema.$defs[`Native${name}`] as {
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(
      Object.keys(actual.properties ?? {}).sort(),
      `${name} property names are wire fields, including names shared with schema annotations`,
    ).toEqual(expected.properties)
    expect([...(actual.required ?? [])].sort(), `${name} required keys`).toEqual(expected.required)
    for (const required of actual.required ?? [])
      expect(
        actual.properties,
        `${name}.${required} must be a declared property in this pinned closed object`,
      ).toHaveProperty(required)
  }
})

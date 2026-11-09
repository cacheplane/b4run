import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  AGENT_PROTOCOL_DEFINITIONS,
  AGENT_PROTOCOL_NATIVE_NOTICE,
  AGENT_PROTOCOL_NATIVE_SOURCE,
} from "../dist/agent-protocol/schema.js"
import { readAgentProtocolInputs } from "./agent-protocol-inputs.mjs"

const defaultFixturesDirectory = fileURLToPath(
  new URL("../../../test/agent-protocol/fixtures/", import.meta.url),
)
const defaultDistDirectory = fileURLToPath(new URL("../dist/", import.meta.url))

// Only OpenAPI's reference namespace changes in the published schema library.
// The corrected source document and raw upstream bytes remain untouched.
function rewriteReferences(value) {
  if (Array.isArray(value)) return value.map(rewriteReferences)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")
          ? child.replace("#/components/schemas/", "#/$defs/")
          : rewriteReferences(child),
      ]),
    )
  }
  return value
}

/** Deterministic build assets; no clock, network, model SDK, or generated source files. */
export function writeAgentProtocolAssets({
  fixturesDirectory = defaultFixturesDirectory,
  distDirectory = defaultDistDirectory,
} = {}) {
  const inputs = readAgentProtocolInputs({ fixturesDirectory })
  const shared = {
    manifest: inputs.manifest,
    corrections: inputs.corrections,
    nativeSource: AGENT_PROTOCOL_NATIVE_SOURCE,
    notices: `${inputs.sourceTexts.license}\n${AGENT_PROTOCOL_NATIVE_NOTICE}`,
  }
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:b4:agent-protocol:0.1.6:0.0.20:b4-v1",
    title: "Agent Protocol 0.1.6 / ASP 0.0.20 / B4 v1 schema library",
    $comment:
      "Select a named $defs entry for validation. manifest/corrections/nativeSource/notices are provenance annotations. B4 definitions are declared extensions, not upstream corrections.",
    ...shared,
    $defs: {
      ...rewriteReferences(inputs.correctedOpenapi.components.schemas),
      ...AGENT_PROTOCOL_DEFINITIONS,
    },
  }
  const fixtures = {
    ...shared,
    upstream: JSON.parse(readFileSync(join(fixturesDirectory, "wire-cases.json"), "utf8")),
    b4: JSON.parse(readFileSync(join(fixturesDirectory, "b4-wire-cases.json"), "utf8")),
  }
  mkdirSync(distDirectory, { recursive: true })
  for (const [file, value] of [
    ["agent-protocol.schema.json", schema],
    ["agent-protocol.fixtures.json", fixtures],
  ]) {
    writeFileSync(join(distDirectory, file), `${JSON.stringify(value, null, 2)}\n`)
  }
}

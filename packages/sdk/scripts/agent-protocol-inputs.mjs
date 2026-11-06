import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"

// These pins deliberately do not come from the editable provenance manifest.
const SOURCE_HASHES = {
  "openapi.json": "7d069e43ca105e8127ce07ba7bd8bd7a78a2fadd6420009f2634a24cfb153f32",
  "protocol.cddl": "9cebafc02e523f509f880aa8ebaa2af077f8a7f0589d8063a50d610c3af78fb1",
  LICENSE: "d9bb52f2e3540d60ff50d8f0f5b6ba649b7fd346948c4c3d086c8afb120763c7",
}
const CORRECTION_POINTER = "/components/schemas/RunStream/allOf/1/required"
const EXPECTED_REQUIRED = ["run_id", "created_at", "updated_at", "status", "metadata"]
const EXPECTED_OPERATIONS = [
  { op: "remove", path: CORRECTION_POINTER, expected: EXPECTED_REQUIRED },
]
const defaultFixturesDirectory = fileURLToPath(
  new URL("../../../test/agent-protocol/fixtures/", import.meta.url),
)

// Internal build/test helper. Generators must use the hash-enforcing reader below.
export function applyAgentProtocolCorrection(document) {
  const corrected = structuredClone(document)
  const segments = CORRECTION_POINTER.slice(1).split("/")
  const parent = segments.slice(0, -1).reduce((value, key) => value?.[key], corrected)
  const key = segments.at(-1)
  if (!isDeepStrictEqual(parent?.[key], EXPECTED_REQUIRED)) {
    throw new Error(`Unexpected correction target at ${CORRECTION_POINTER}`)
  }
  delete parent[key]
  return corrected
}

export function readAgentProtocolInputs({ fixturesDirectory = defaultFixturesDirectory } = {}) {
  // Check all normative bytes before parsing or applying any correction.
  const bytes = {}
  for (const [file, expectedHash] of Object.entries(SOURCE_HASHES)) {
    bytes[file] = readFileSync(join(fixturesDirectory, "upstream", file))
    const actualHash = createHash("sha256").update(bytes[file]).digest("hex")
    if (actualHash !== expectedHash) {
      throw new Error(
        `${file === "openapi.json" ? "OpenAPI" : file} SHA256 mismatch: ${actualHash}`,
      )
    }
  }
  const corrections = JSON.parse(readFileSync(join(fixturesDirectory, "corrections.json"), "utf8"))
  if (
    corrections.sourceSha256 !== SOURCE_HASHES["openapi.json"] ||
    !isDeepStrictEqual(corrections.operations, EXPECTED_OPERATIONS)
  ) {
    throw new Error("Unexpected Agent Protocol correction contract")
  }
  const originalOpenapi = JSON.parse(bytes["openapi.json"].toString("utf8"))
  return {
    originalOpenapi,
    correctedOpenapi: applyAgentProtocolCorrection(originalOpenapi),
    manifest: JSON.parse(readFileSync(join(fixturesDirectory, "upstream/manifest.json"), "utf8")),
    corrections,
    sourceTexts: {
      cddl: bytes["protocol.cddl"].toString("utf8"),
      license: bytes.LICENSE.toString("utf8"),
    },
  }
}

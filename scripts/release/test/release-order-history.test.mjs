import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { readReleaseInventory } from "../inventory.mjs"
import {
  CANONICAL_RELEASE_PACKAGE_ORDER,
  canonicalManifestBytes,
  HISTORICAL_RELEASE_PACKAGE_ORDER,
  manifestSha256,
  validateSealedReleaseManifest,
} from "../manifest.mjs"
import { canonicalNpmEvidenceBytes, parseNpmEvidence } from "../npm-evidence.mjs"
import { orderReleasePackages } from "../topology.mjs"

// Published B4 order before workspace storage acquired its source-bundle dependency.
// Keep this fixture literal: changing active policy must not rewrite historical bytes.
const PREVIOUS_B4_ORDER = [
  "@b4run/ag-ui",
  "@b4run/config-biome",
  "@b4run/config-typescript",
  "@b4run/devkit",
  "@b4run/sdk",
  "@b4run/langgraph",
  "@b4run/permissions",
  "@b4run/postgres-storage",
  "@b4run/sqlite-storage",
  "@b4run/memory",
  "@b4run/memory-pgvector",
  "@b4run/workspace",
  "@b4run/core",
  "@b4run/inspector",
  "@b4run/langchain",
  "@b4run/cli",
  "@b4run/sandbox",
  "@b4run/testing",
  "@b4run/evals",
  "@b4run/vite-plugin",
  "create-b4-app",
]
const candidate = {
  version: "0.8.31",
  commitSha: "a".repeat(40),
  publisherWorkflow: ".github/workflows/release.yml",
}
function manifestFor(order) {
  return {
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    ci: { workflow: "CI", runId: 100, runAttempt: 1 },
    artifact: {
      name: `release-v${candidate.version}-${candidate.commitSha.slice(0, 12)}`,
      prepareRunId: 200,
      prepareRunAttempt: 1,
    },
    packageOrder: [...order],
    packages: order.map((name) => {
      const bytes = Buffer.from(name)
      const sha512 = createHash("sha512").update(bytes).digest("hex")
      return {
        name,
        version: candidate.version,
        filename: `${name.replace(/^@/, "").replaceAll("/", "-")}-${candidate.version}.tgz`,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        sha512,
        npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
        access: "public",
      }
    }),
  }
}
function receiptFor(manifest) {
  return {
    schemaVersion: 1,
    version: candidate.version,
    commitSha: candidate.commitSha,
    manifestSha256: manifestSha256(manifest),
    complete: true,
    status: "NPM_COMPLETE",
    packages: manifest.packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      status: "present",
      size: entry.size,
      tarballSha256: entry.sha256,
      tarballSha512: entry.sha512,
      integrity: entry.npmIntegrity,
      latest: { status: "present", version: candidate.version },
      signature: { status: "valid", verifier: "npm-audit-signatures@11.17.0" },
      provenance: {
        predicateType: "https://slsa.dev/provenance/v1",
        workflow: candidate.publisherWorkflow,
        commitSha: candidate.commitSha,
        repository: "https://github.com/cacheplane/b4run",
        ref: `refs/tags/v${candidate.version}`,
      },
    })),
  }
}

test("current sealed order follows the changed live topology", async () => {
  const inventory = await readReleaseInventory({ root: process.cwd() })
  const order = orderReleasePackages(inventory.workspacePackages.filter((p) => !p.private)).map(
    (p) => p.name,
  )
  assert.deepEqual(CANONICAL_RELEASE_PACKAGE_ORDER, order)
  assert.ok(order.indexOf("@b4run/workspace") < order.indexOf("@b4run/sqlite-storage"))
  assert.deepEqual(
    validateSealedReleaseManifest(manifestFor(order), { candidate }).packageOrder,
    order,
  )
})

test("sealed historical B4 and Dawn manifests retain their original order and bytes", () => {
  for (const order of [PREVIOUS_B4_ORDER, HISTORICAL_RELEASE_PACKAGE_ORDER]) {
    const manifest = manifestFor(order)
    const before = canonicalManifestBytes(manifest)
    const validated = validateSealedReleaseManifest(manifest, { candidate })
    assert.deepEqual(validated.packageOrder, order)
    assert.deepEqual(canonicalManifestBytes(validated), before)
  }
  const arbitrary = [...PREVIOUS_B4_ORDER]
  ;[arbitrary[0], arbitrary[1]] = [arbitrary[1], arbitrary[0]]
  assert.throws(
    () => validateSealedReleaseManifest(manifestFor(arbitrary), { candidate }),
    /sealed.*order/,
  )
})

test("npm receipts follow the exact sealed B4 manifest, including the previous order", () => {
  for (const order of [PREVIOUS_B4_ORDER, CANONICAL_RELEASE_PACKAGE_ORDER]) {
    const manifest = manifestFor(order)
    const receipt = receiptFor(manifest)
    const context = {
      candidate,
      manifest,
      manifestSha256: manifestSha256(manifest),
    }
    assert.deepEqual(parseNpmEvidence(receipt, context), receipt)
    assert.deepEqual(JSON.parse(canonicalNpmEvidenceBytes(receipt, context)), receipt)
    // Callers with only the already-bound manifest hash still accept known B4 orders.
    assert.deepEqual(
      parseNpmEvidence(receipt, {
        candidate,
        manifestSha256: context.manifestSha256,
      }),
      receipt,
    )
    const swapped = structuredClone(receipt)
    ;[swapped.packages[0], swapped.packages[1]] = [swapped.packages[1], swapped.packages[0]]
    assert.throws(() => parseNpmEvidence(swapped, context), /package|order/)
    assert.throws(
      () =>
        parseNpmEvidence(swapped, {
          candidate,
          manifestSha256: context.manifestSha256,
        }),
      /package|order/,
    )
    const corrupt = structuredClone(receipt)
    corrupt.packages[0].tarballSha256 = "0".repeat(64)
    assert.throws(() => parseNpmEvidence(corrupt, context), /conflicts with the manifest/)
  }
})

test("a known receipt order cannot substitute for a different sealed manifest order", () => {
  const manifest = manifestFor(PREVIOUS_B4_ORDER)
  const other = manifestFor(CANONICAL_RELEASE_PACKAGE_ORDER)
  const receipt = receiptFor(other)
  receipt.manifestSha256 = manifestSha256(manifest)
  assert.notDeepEqual(other.packageOrder, manifest.packageOrder)
  assert.throws(
    () =>
      parseNpmEvidence(receipt, {
        candidate,
        manifest,
        manifestSha256: receipt.manifestSha256,
      }),
    /identity|manifest/,
  )
})

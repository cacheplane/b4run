import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as data from "../../historical-publication-data.mjs"
import {
  canonicalHistoricalPublicationRecordBytes,
  HISTORICAL_PUBLICATION_RECORD_PATH,
} from "../../historical-publication-record.mjs"
import { canonicalManifestBytes } from "../../manifest.mjs"
import { canonicalNpmEvidenceBytes } from "../../npm-evidence.mjs"
import { canonicalAuditResultBytes } from "../../terminal-records.mjs"
import { TEST_CANDIDATE, TEST_MANIFEST, testRecord } from "./historical-0155.mjs"

/** Materialize the exact authenticated synthetic historical data family for integrity regressions. */
export async function historicalFamilyFixture(t, { extraSupportBytes } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "historical-family-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const record = testRecord()
  const prefix = "scripts/release/historical-publications/evidence/v0.15.5/"
  const archive = await fs.readFile(new URL("./historical-0155-npm-evidence.zip", import.meta.url))
  record.original.artifact.size = archive.length
  const files = new Map([
    [record.original.artifact.path, archive],
    [
      `${prefix}npm-evidence.json`,
      canonicalNpmEvidenceBytes(record.original.npmEvidence, {
        candidate: TEST_CANDIDATE,
        manifest: TEST_MANIFEST,
        manifestSha256: record.incident.manifestSha256,
      }),
    ],
    [data.HISTORICAL_PUBLICATION_MANIFEST_PATH, canonicalManifestBytes(TEST_MANIFEST)],
    ...(extraSupportBytes === undefined ? [] : [[`${prefix}large.zip`, extraSupportBytes]]),
    ...record.original.audit.receipts.map((asset) => [
      `${prefix}${asset.name}`,
      canonicalAuditResultBytes(asset.receipt),
    ]),
    [`${prefix}bracket.json`, Buffer.from('{"syntheticTestBracket":true}\n')],
    [`${prefix}sweep-first.json`, Buffer.from('{"syntheticTestSweep":1}\n')],
    [`${prefix}sweep-second.json`, Buffer.from('{"syntheticTestSweep":2}\n')],
  ])
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
  for (const bracket of record.brackets)
    bracket.factsSha256 = hash(files.get(`${prefix}bracket.json`))
  record.sweeps[0].evidenceSha256 = hash(files.get(`${prefix}sweep-first.json`))
  record.sweeps[1].evidenceSha256 = hash(files.get(`${prefix}sweep-second.json`))
  record.supportingEvidence = [...files]
    .map(([path, bytes]) => ({ path, size: bytes.length, sha256: hash(bytes) }))
    .sort((a, b) => a.path.localeCompare(b.path, "en"))
  files.set(
    HISTORICAL_PUBLICATION_RECORD_PATH,
    canonicalHistoricalPublicationRecordBytes(record, { manifest: TEST_MANIFEST }),
  )
  for (const [file, bytes] of files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await fs.writeFile(path.join(root, file), bytes, { mode: 0o644 })
  }
  return { root, files, prefix, recordPath: path.join(root, HISTORICAL_PUBLICATION_RECORD_PATH) }
}

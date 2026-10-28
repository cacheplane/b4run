import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import * as data from "../historical-publication-data.mjs"

test("historical data inventory permits only an entirely absent incident family", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "historical-data-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))

  assert.deepEqual(await data.discoverHistoricalPublicationData({ root }), [])
  await fs.mkdir(path.join(root, "scripts/release/historical-publications"), { recursive: true })

  await assert.rejects(data.discoverHistoricalPublicationData({ root }))
})

test("binary fixture reads preserve actual non-UTF8 ZIP bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "historical-bytes-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, "archive.zip")
  const bytes = Buffer.from([0x50, 0x4b, 0xff, 0xfe])
  await fs.writeFile(file, bytes)
  const { readBoundedFixtureBytes } = await import("../fixture-io.mjs")

  assert.deepEqual(await readBoundedFixtureBytes(file, { root }), bytes)
})

import { createHash } from "node:crypto"
import {
  canonicalHistoricalPublicationRecordBytes,
  HISTORICAL_PUBLICATION_RECORD_PATH,
} from "../historical-publication-record.mjs"
import { canonicalManifestBytes } from "../manifest.mjs"
import { canonicalNpmEvidenceBytes } from "../npm-evidence.mjs"
import { canonicalAuditResultBytes } from "../terminal-records.mjs"
import { TEST_CANDIDATE, TEST_MANIFEST, testRecord } from "./fixtures/historical-0155.mjs"

async function familyFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "historical-family-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const record = testRecord()
  const prefix = "scripts/release/historical-publications/evidence/v0.15.5/"
  const archive = await fs.readFile(
    new URL("./fixtures/historical-0155-npm-evidence.zip", import.meta.url),
  )
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

test("optional authenticated historical data can be admitted through record-only bytes without source changes", async (t) => {
  const { root, files } = await familyFixture(t)

  const inventory = await data.discoverHistoricalPublicationData({ root })

  assert.deepEqual(inventory, [...files.keys()].sort())
})

for (const kind of [
  "malformed record",
  "manifest digest",
  "missing support",
  "unknown file",
  "symlink",
  "hardlink",
  "executable",
  "digest drift",
  "unknown directory",
]) {
  test(`historical admission rejects ${kind} without treating the family as absent`, async (t) => {
    const input = await familyFixture(t)
    const support = path.join(input.root, `${input.prefix}sweep-first.json`)
    if (kind === "malformed record") await fs.writeFile(input.recordPath, "{}\n")
    if (kind === "manifest digest")
      await fs.writeFile(path.join(input.root, data.HISTORICAL_PUBLICATION_MANIFEST_PATH), "{}\n")
    if (kind === "missing support") await fs.unlink(support)
    if (kind === "unknown file")
      await fs.writeFile(path.join(input.root, `${input.prefix}unknown.json`), "{}\n")
    if (kind === "symlink") {
      await fs.unlink(support)
      await fs.symlink(input.recordPath, support)
    }
    if (kind === "hardlink") await fs.link(support, path.join(input.root, "alias"))
    if (kind === "executable") await fs.chmod(support, 0o755)
    if (kind === "digest drift") await fs.writeFile(support, "changed\n")
    if (kind === "unknown directory") await fs.mkdir(path.join(input.root, `${input.prefix}nested`))

    await assert.rejects(data.discoverHistoricalPublicationData({ root: input.root }))
  })
}

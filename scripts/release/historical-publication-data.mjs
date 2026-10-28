import { createHash } from "node:crypto"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import { readBoundedFixtureBytes } from "./fixture-io.mjs"
import {
  HISTORICAL_0155_INCIDENT,
  HISTORICAL_PUBLICATION_RECORD_PATH,
  parseHistoricalPublicationRecord,
} from "./historical-publication-record.mjs"
import { manifestSha256, validateSealedReleaseManifest } from "./manifest.mjs"

/** Code-owned immutable manifest reader anchor for historical data admission. */
export const HISTORICAL_PUBLICATION_MANIFEST_PATH =
  "scripts/release/historical-publications/evidence/v0.15.5/manifest.json"
const FAMILY = "scripts/release/historical-publications"
const PREFIX = `${FAMILY}/evidence/v0.15.5/`
const MAX_BYTES = 64 * 1024 * 1024

/** Discover and authenticate the exact optional historical data family for content pinning. */
export async function discoverHistoricalPublicationData({ root }) {
  try {
    await lstat(path.join(root, FAMILY))
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
  const files = []
  const walk = async (relative) => {
    const metadata = await lstat(path.join(root, relative))
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      if (![FAMILY, `${FAMILY}/evidence`, PREFIX.slice(0, -1)].includes(relative))
        throw new Error("Unknown historical evidence directory")
      const members = await readdir(path.join(root, relative))
      if (members.length === 0 || members.length > 128)
        throw new Error("Incomplete or unbounded historical data family")
      for (const member of members) await walk(`${relative}/${member}`)
      return
    }
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o7777) !== 0o644)
      throw new Error("Historical admission requires regular mode 100644 files")
    if (relative !== HISTORICAL_PUBLICATION_RECORD_PATH && !relative.startsWith(PREFIX))
      throw new Error("Unknown historical data file")
    files.push(relative)
  }
  await walk(FAMILY)
  const read = (file, maxBytes = MAX_BYTES) =>
    readBoundedFixtureBytes(path.join(root, file), { root, maxBytes })
  const manifestBytes = await read(HISTORICAL_PUBLICATION_MANIFEST_PATH, 2 * 1024 * 1024)
  if (hash(manifestBytes) !== HISTORICAL_0155_INCIDENT.manifestSha256)
    throw new Error("Historical immutable manifest digest differs")
  const manifest = validateSealedReleaseManifest(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)),
    { candidate: HISTORICAL_0155_INCIDENT },
  )
  if (manifestSha256(manifest) !== hash(manifestBytes))
    throw new Error("Historical immutable manifest bytes are noncanonical")
  const record = parseHistoricalPublicationRecord(
    await read(HISTORICAL_PUBLICATION_RECORD_PATH, 2 * 1024 * 1024),
    { manifest },
  )
  const expected = [
    HISTORICAL_PUBLICATION_RECORD_PATH,
    ...record.supportingEvidence.map((x) => x.path),
  ]
  if (JSON.stringify([...files].sort()) !== JSON.stringify([...expected].sort()))
    throw new Error("Historical data inventory differs from its record")
  if (!record.supportingEvidence.some((x) => x.path === HISTORICAL_PUBLICATION_MANIFEST_PATH))
    throw new Error("Historical data lacks its code-owned manifest anchor")
  let total = 0
  for (const entry of record.supportingEvidence) {
    const bytes = await read(entry.path)
    total += bytes.length
    if (total > MAX_BYTES || bytes.length !== entry.size || hash(bytes) !== entry.sha256)
      throw new Error("Historical supporting bytes differ")
  }
  return Object.freeze(expected.sort())
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

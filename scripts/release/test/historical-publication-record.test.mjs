import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import * as records from "../historical-publication-record.mjs"
import { TEST_MANIFEST, testRecord } from "./fixtures/historical-0155.mjs"

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

test("historical records pin the reviewed tuple and canonical immutable receipt relation", () => {
  const raw = testRecord()

  const bytes = records.canonicalHistoricalPublicationRecordBytes(raw, {
    manifest: TEST_MANIFEST,
  })
  const parsed = records.parseHistoricalPublicationRecord(bytes, {
    manifest: TEST_MANIFEST,
  })
  raw.capture.operator.login = "changed"

  assert.equal(parsed.capture.operator.login, "fixture-operator")
  assert.ok(Object.isFrozen(parsed.original.npmEvidence.packages[0]))
  assert.equal(parsed.sha256, sha256(bytes))
  assert.deepEqual(
    records.canonicalHistoricalPublicationRecordBytes(parsed, {
      manifest: TEST_MANIFEST,
    }),
    bytes,
  )
  assert.equal(parsed.incident.version, "0.15.5")
  assert.throws(() =>
    records.parseHistoricalPublicationRecord(bytes, {
      manifestSha256: raw.incident.manifestSha256,
    }),
  )
})

test("historical records reject incident, schema, receipt, manifest and evidence drift", () => {
  const mutations = [
    (r) => {
      r.schemaVersion = 2
    },
    (r) => {
      r.policyRevision = "other"
    },
    (r) => {
      r.extra = true
    },
    ...Object.keys(records.HISTORICAL_0155_INCIDENT).map((key) => (r) => {
      r.incident[key] = typeof r.incident[key] === "number" ? 2 : "foreign"
    }),
    (r) => {
      r.original.npmEvidence.packages[0].size++
    },
    (r) => {
      r.original.npmEvidence.packages.pop()
    },
    (r) => {
      r.original.publisher.runId++
    },
    (r) => {
      r.original.publisher.jobs = []
    },
    (r) => {
      r.original.publisher.jobs[0].conclusion = "failure"
    },
    (r) => {
      r.original.publisher.jobs.push({ ...r.original.publisher.jobs[0] })
    },
    (r) => {
      r.original.artifact.sha256 = "a".repeat(64)
    },
    (r) => {
      r.original.artifact.path = "../escape"
    },
    (r) => {
      r.original.audit.run.conclusion = "failure"
    },
    (r) => {
      r.original.audit.receipts[0].sha256 = "a".repeat(64)
    },
    (r) => {
      r.sweeps[0].packages[0].sha256 = "a".repeat(64)
    },
    (r) => {
      r.sweeps[1].startedAt = r.sweeps[0].startedAt
    },
    (r) => {
      r.sweeps[0].packages.pop()
    },
    (r) => {
      r.sweeps[0].packages[0].verification = "historical-provenance"
    },
    (r) => {
      r.brackets[1].factsSha256 = "a".repeat(64)
    },
    (r) => {
      r.brackets[0].releaseOwnersInactive = false
    },
    (r) => {
      r.capture.finishedAt = "2026-10-27T12:20:00.000Z"
    },
    (r) => {
      r.supportingEvidence = []
    },
    (r) => {
      r.supportingEvidence.find((file) => file.path.endsWith("npm-evidence.zip")).size++
    },
    (r) => {
      r.capture.operator.login = "x".repeat(257)
    },
    (r) => {
      r.original.publisher.extra = true
    },
  ]
  for (const mutate of mutations) {
    const raw = testRecord()
    mutate(raw)

    assert.throws(() =>
      records.parseHistoricalPublicationRecord(raw, {
        manifest: TEST_MANIFEST,
      }),
    )
  }
  const manifest = structuredClone(TEST_MANIFEST)
  manifest.packages[0].size++

  assert.throws(() => records.parseHistoricalPublicationRecord(testRecord(), { manifest }))
})

test("historical records reject noncanonical, oversized and hostile JSON", () => {
  const record = testRecord()
  const canonical = records.canonicalHistoricalPublicationRecordBytes(record, {
    manifest: TEST_MANIFEST,
  })
  const hostile = Object.create({ hidden: true })
  Object.assign(hostile, record)
  const accessor = testRecord()
  Object.defineProperty(accessor.capture, "controllerSha", {
    enumerable: true,
    get() {
      throw Error("accessed")
    },
  })

  for (const raw of [
    Buffer.concat([canonical, Buffer.from(" ")]),
    "{",
    Buffer.from([0xff]),
    " ".repeat(records.HISTORICAL_PUBLICATION_RECORD_MAX_BYTES + 1),
    hostile,
    accessor,
    JSON.parse('{"__proto__":{}}'),
  ]) {
    assert.throws(() =>
      records.parseHistoricalPublicationRecord(raw, {
        manifest: TEST_MANIFEST,
      }),
    )
  }
})

test("trusted Git record reads enforce exact path, canonical regular mode, and absent fail-closed behavior", async () => {
  const bytes = records.canonicalHistoricalPublicationRecordBytes(testRecord(), {
    manifest: TEST_MANIFEST,
  })
  const recordPath = "scripts/release/historical-publications/v0.15.5.json"
  const git = {
    async listTreeEntries({ ref }) {
      assert.equal(ref, "f".repeat(40))
      return `100644 blob ${"a".repeat(40)}\t${recordPath}\0`
    },
    async showFile({ path }) {
      assert.equal(path, recordPath)
      return bytes.toString()
    },
  }

  assert.equal(
    (
      await records.readHistoricalPublicationRecord({
        git,
        ref: "f".repeat(40),
        manifest: TEST_MANIFEST,
      })
    ).incident.version,
    "0.15.5",
  )
  assert.equal(
    await records.readHistoricalPublicationRecord({
      git: { ...git, listTreeEntries: async () => "" },
      ref: "f".repeat(40),
      manifest: TEST_MANIFEST,
    }),
    null,
  )
  for (const listing of [
    "bad",
    `120000 blob ${"a".repeat(40)}\t${recordPath}\0`,
    `100755 blob ${"a".repeat(40)}\t${recordPath}\0`,
    `${await git.listTreeEntries({ ref: "f".repeat(40) })}${await git.listTreeEntries({ ref: "f".repeat(40) })}`,
  ]) {
    await assert.rejects(
      records.readHistoricalPublicationRecord({
        git: { ...git, listTreeEntries: async () => listing },
        ref: "f".repeat(40),
        manifest: TEST_MANIFEST,
      }),
    )
  }
  await assert.rejects(
    records.readHistoricalPublicationRecord({
      git: { ...git, showFile: async () => "{}" },
      ref: "f".repeat(40),
      manifest: TEST_MANIFEST,
    }),
  )
})

test("historical records reject independent original and temporal binding changes", () => {
  const mutations = [
    ...[
      "repository",
      "repositoryId",
      "runId",
      "runAttempt",
      "workflow",
      "ref",
      "commitSha",
      "status",
      "conclusion",
    ].flatMap((key) =>
      ["publisher", "audit"].map((which) => (r) => {
        const run = which === "publisher" ? r.original.publisher : r.original.audit.run
        run[key] = typeof run[key] === "number" ? 2 : "foreign"
      }),
    ),
    ...["id", "name", "runId", "serviceDigest", "size"].map((key) => (r) => {
      r.original.artifact[key] = typeof r.original.artifact[key] === "number" ? -1 : "foreign"
    }),
    (r) => {
      r.original.audit.receipts[1].id = r.original.audit.receipts[0].id
    },
    (r) => {
      r.original.audit.receipts[1].name = "wrong.json"
    },
    (r) => {
      r.original.audit.receipts[1].size++
    },
    (r) => {
      r.original.audit.receipts[0].receipt.commitSha = "a".repeat(40)
    },
    (r) => {
      r.capture.startedAt = "2026-10-27T12:00:01.000Z"
    },
    (r) => {
      r.capture.finishedAt = "2026-10-27T12:01:59.000Z"
    },
    (r) => {
      r.capture.startedAt = "2026-02-31T12:00:00.000Z"
    },
    (r) => {
      r.brackets[0].observedAt = "2026-10-27T12:00:01.000Z"
    },
    (r) => {
      r.brackets[1].observedAt = "2026-10-27T12:01:59.000Z"
    },
    (r) => {
      r.sweeps[0].finishedAt = "2026-10-27T12:01:30.000Z"
    },
    (r) => {
      r.sweeps[1].finishedAt = "2026-10-27T12:01:19.000Z"
    },
    (r) => {
      r.sweeps[1].startedAt = "2026-10-27T12:00:59.000Z"
    },
    (r) => {
      r.sweeps[0].evidenceSha256 = "a".repeat(64)
    },
    (r) => {
      r.brackets[0].factsSha256 = "a".repeat(64)
      r.brackets[1].factsSha256 = "a".repeat(64)
    },
    (r) => {
      r.supportingEvidence.reverse()
    },
    (r) => {
      r.supportingEvidence[0].path =
        "scripts/release/historical-publications/evidence/v0.15.5/./alias.json"
    },
    (r) => {
      r.supportingEvidence[0].extra = true
    },
    (r) => {
      r.supportingEvidence[0].size = 64 * 1024 * 1024 + 1
    },
    (r) => {
      r.sweeps[0].packages[0].extra = true
    },
    (r) => {
      r.sweeps[0].packages[0].sha512 = "a".repeat(128)
    },
    (r) => {
      r.sha256 = "0".repeat(64)
    },
  ]
  for (const mutate of mutations) {
    const raw = testRecord()
    mutate(raw)

    assert.throws(() =>
      records.parseHistoricalPublicationRecord(raw, {
        manifest: TEST_MANIFEST,
      }),
    )
  }
})

test("historical record objects cannot introduce even a matching computed digest field", () => {
  const raw = testRecord()
  raw.sha256 = sha256(
    records.canonicalHistoricalPublicationRecordBytes(raw, {
      manifest: TEST_MANIFEST,
    }),
  )

  assert.throws(() => records.parseHistoricalPublicationRecord(raw, { manifest: TEST_MANIFEST }))
})

test("production historical admission record remains absent", async () => {
  const { access } = await import("node:fs/promises")

  await assert.rejects(
    access(new URL("../historical-publications/v0.15.5.json", import.meta.url)),
    { code: "ENOENT" },
  )
})

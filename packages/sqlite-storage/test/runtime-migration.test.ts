import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { asciiJsonV1, encodeRecoveryIdentityTuple } from "@b4run/sdk/internal/runtime-schema"
import { expect, it, vi } from "vitest"
import { bindRuntimeStore, createRuntimeBinding } from "../src/runtime/binding.ts"
import {
  installationContext,
  openRuntimeInstallation,
  type RuntimeInstallation,
} from "../src/runtime/index.ts"
import * as cleanupData from "./fixtures/runtime-data.ts"

const assetRoot = new URL("../../../test/agent-protocol/fixtures/runtime-v1/", import.meta.url)
const manifest = JSON.parse(readFileSync(new URL("manifest.json", assetRoot), "utf8")) as {
  sqlite: {
    path: string
    sha256: string
    identity: { installationId: string; generation: string; threadId: string; throughSeq: number }
    catalog: { objects: unknown[] }
    preservedRecords: Record<
      string,
      { columns: string[]; count: number; canonicalRowSHA256: string[] }
    >
    journal: { seq: number; eventId: string; payloadSHA256: string }[]
  }
}
const expected = manifest.sqlite
const expectedRecords = Object.fromEntries(
  Object.entries(expected.preservedRecords).map(([name, value]) => [
    name,
    { count: value.count, canonicalRowSHA256: value.canonicalRowSHA256 },
  ]),
)
const pristine = new URL(expected.path, assetRoot)
const sha = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex")
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error("Non-JSON value in pinned fixture oracle")
  return encoded
}
function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error("Invalid pinned fixture identifier")
  return `"${value}"`
}
function recordHashes(db: DatabaseSync) {
  return Object.fromEntries(
    Object.entries(expected.preservedRecords).map(([name, item]) => {
      if (!item.columns.length) throw new Error("Pinned v1 column projection is missing")
      const columns = item.columns.map(identifier).join(",")
      const rows = db.prepare(`SELECT ${columns} FROM ${identifier(name)}`).all()
      return [
        name,
        { count: rows.length, canonicalRowSHA256: rows.map((row) => sha(canonical(row))).sort() },
      ]
    }),
  )
}

it("migrates the qualified physical-v1 SQLite copy atomically while preserving original journal and private facts", () => {
  expect(sha(readFileSync(pristine)), "pinned original bytes before copy").toBe(expected.sha256)
  const appRoot = mkdtempSync(join(tmpdir(), "b4-sqlite-migration-"))
  chmodSync(appRoot, 0o700)
  const directory = join(appRoot, ".b4/agent-protocol/v1")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "runtime.sqlite")
  copyFileSync(pristine, path)
  chmodSync(path, 0o600)
  let owner: RuntimeInstallation | undefined
  let db: DatabaseSync | undefined
  let failure: unknown
  const cleanup: unknown[] = []
  let version = 0,
    installationMatches = false,
    allOriginalRecordsMatch = false,
    journalMatches = false
  try {
    // Open only the writable test copy for preinspection, never the pristine asset.
    db = new DatabaseSync(path, { readOnly: true })
    const originalMarker = db.prepare("SELECT * FROM runtime_installation").get()
    const originalCatalog = db
      .prepare(
        "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
      )
      .all()
    const knownCatalogMatches =
      sha(canonical(originalCatalog)) === sha(canonical(expected.catalog.objects))
    const oldMarkerMatches =
      originalMarker?.version === 1 &&
      originalMarker.installation_id === expected.identity.installationId
    const originalRecordsMatch = canonical(recordHashes(db)) === canonical(expectedRecords)
    // Hash/Boolean inputs only: no private row/token/native channel reaches diagnostics.
    expect(knownCatalogMatches, "actual qualified old catalog prerequisite").toBe(true)
    expect(oldMarkerMatches, "actual old marker prerequisite").toBe(true)
    expect(originalRecordsMatch, "all preserved old native row prerequisites").toBe(true)
    db.close()
    db = undefined
    owner = openRuntimeInstallation(appRoot)
    db = new DatabaseSync(owner.path, { readOnly: true })
    const marker = db.prepare("SELECT version,installation_id FROM runtime_installation").get()
    version = Number(marker?.version)
    installationMatches =
      owner.installationId === expected.identity.installationId &&
      marker?.installation_id === expected.identity.installationId
    allOriginalRecordsMatch = canonical(recordHashes(db)) === canonical(expectedRecords)
    const raw = db.prepare("SELECT seq,id,payload FROM journal ORDER BY seq").all()
    journalMatches =
      canonical(
        raw.map((row) => ({
          seq: row.seq,
          eventId: row.id,
          payloadSHA256: sha(String(row.payload)),
        })),
      ) === canonical(expected.journal)
    const scope = db
      .prepare("SELECT generation,through_seq FROM scopes WHERE thread_id=?")
      .get(expected.identity.threadId)
    expect(
      scope?.generation === expected.identity.generation &&
        scope.through_seq === expected.identity.throughSeq,
      "original generation and H prerequisite",
    ).toBe(true)
  } catch (error) {
    failure = error
  } finally {
    try {
      db?.close()
      db = undefined
    } catch (error) {
      cleanup.push(error)
    }
    try {
      owner?.close()
      owner = undefined
    } catch (error) {
      cleanup.push(error)
    }
    // Preserve the exact owned copy if a normal resource close failed.
    if (cleanup.length === 0) {
      try {
        rmSync(appRoot, { recursive: true })
      } catch (error) {
        cleanup.push(error)
      }
    }
  }
  if (failure !== undefined || cleanup.length)
    throw new AggregateError(
      [...(failure !== undefined ? [failure] : []), ...cleanup],
      "SQLite migration case or normal cleanup failed",
    )
  expect(sha(readFileSync(pristine)), "pinned original bytes after normal cleanup").toBe(
    expected.sha256,
  )
  expect(installationMatches, "original installation UUID preserved").toBe(true)
  expect(allOriginalRecordsMatch, "all original payload/native/private rows preserved").toBe(true)
  expect(journalMatches, "nine numbered journal facts preserved byte-for-byte").toBe(true)
  // Existing old factory opens successfully with version1; this is the intended behavioral RED.
  expect(version, "known physical-v1 installation advances atomically to physical2").toBe(2)
})

// This regression deliberately uses only the existing factory before any
// comparator/migration implementation. Pristine assets are read as bytes only.
function literalNamespaceFiles(directory: string) {
  return Object.fromEntries(
    readdirSync(directory)
      .sort()
      .map((name) => {
        const path = join(directory, name),
          stat = lstatSync(path)
        return [
          name,
          stat.isFile() && !stat.isSymbolicLink() ? sha(readFileSync(path)) : "non-regular-entry",
        ]
      }),
  )
}
function inspectLiteralCandidate(path: string, appRoot: string) {
  const inspection = mkdtempSync(join(appRoot, "literal-inspect-"))
  const copy = join(inspection, "runtime.sqlite")
  let db: DatabaseSync | undefined
  try {
    copyFileSync(path, copy)
    if (existsSync(`${path}-wal`)) copyFileSync(`${path}-wal`, `${copy}-wal`)
    db = new DatabaseSync(copy, { readOnly: true })
    return {
      catalog: db
        .prepare(
          "SELECT name,type,tbl_name,sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY name",
        )
        .all(),
      marker:
        db.prepare("SELECT format,version,installation_id FROM runtime_installation").get() ?? null,
      records: recordHashes(db),
      journal: db
        .prepare("SELECT seq,id,payload FROM journal ORDER BY seq")
        .all()
        .map((row) => ({ seq: row.seq, eventId: row.id, payloadSHA256: sha(String(row.payload)) })),
      scope:
        db
          .prepare("SELECT generation,through_seq FROM scopes WHERE thread_id=?")
          .get(expected.identity.threadId) ?? null,
    }
  } finally {
    // If native close fails, leave this exact inspection for the outer guard;
    // never delete a known unclosed copy to hide cleanup failure.
    db?.close()
    rmSync(inspection, { recursive: true })
  }
}
function runLiteralCase(kind: "unmodified" | "case-only") {
  expect(sha(readFileSync(pristine)), "literal-case pristine bytes before copy").toBe(
    expected.sha256,
  )
  const appRoot = mkdtempSync(join(tmpdir(), "b4-sqlite-literal-"))
  chmodSync(appRoot, 0o700)
  const directory = join(appRoot, ".b4/agent-protocol/v1")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "runtime.sqlite")
  copyFileSync(pristine, path)
  chmodSync(path, 0o600)
  let editor: DatabaseSync | undefined, owner: RuntimeInstallation | undefined
  let failure: unknown
  const cleanup: unknown[] = []
  const facts: Record<string, unknown> = {
    kind,
    appRoot,
    factoryOpened: false,
    rejected: false,
    returnedOwnerNormallyClosed: false,
    fixtureRemoved: false,
  }
  try {
    const original = inspectLiteralCandidate(path, appRoot)
    expect(
      canonical(original.catalog) === canonical(expected.catalog.objects),
      "literal-case actual qualified native catalog prerequisite",
    ).toBe(true)
    expect(
      original.marker?.version === 1 &&
        original.marker.installation_id === expected.identity.installationId,
      "literal-case actual qualified marker prerequisite",
    ).toBe(true)
    expect(
      canonical(original.records) === canonical(expectedRecords),
      "literal-case all19 original private/native records prerequisite",
    ).toBe(true)
    expect(
      canonical(original.journal) === canonical(expected.journal),
      "literal-case all9 original journal bytes prerequisite",
    ).toBe(true)
    const originalIndex = original.catalog.find((row) => row.name === "receipts_operation")?.sql
    if (
      typeof originalIndex !== "string" ||
      originalIndex.split("'$.operation.scopeKey'").length !== 2
    )
      throw new Error("Exact qualified index literal prerequisite absent")
    const changedIndex = originalIndex.replace("'$.operation.scopeKey'", "'$.operation.scopekey'")
    if (kind === "case-only") {
      editor = new DatabaseSync(path)
      editor.exec("DROP INDEX receipts_operation")
      editor.exec(changedIndex)
      editor.close()
      editor = undefined
    }
    const before = inspectLiteralCandidate(path, appRoot)
    const wantedCatalog =
      kind === "case-only"
        ? original.catalog.map((row) =>
            row.name === "receipts_operation" ? { ...row, sql: changedIndex } : row,
          )
        : original.catalog
    expect(
      canonical(before.catalog) === canonical(wantedCatalog),
      "literal-case candidate differs only in the intended native index literal",
    ).toBe(true)
    expect(
      canonical(before.records) === canonical(original.records) &&
        canonical(before.journal) === canonical(original.journal) &&
        canonical(before.marker) === canonical(original.marker),
      "literal-case mutation preserves all original data/marker prerequisites",
    ).toBe(true)
    const beforeFiles = literalNamespaceFiles(directory)
    facts.originalIndexSQL = originalIndex
    facts.candidateIndexSQL = kind === "case-only" ? changedIndex : originalIndex
    facts.candidateCatalogSHA256Before = sha(canonical(before.catalog))
    facts.candidateLogicalSHA256Before = sha(canonical(before))
    facts.candidateFilesBefore = beforeFiles
    try {
      owner = openRuntimeInstallation(appRoot)
      facts.factoryOpened = true
      facts.returnedInstallationId = owner.installationId
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "Incompatible runtime schema or installation marker; use a fresh namespace"
      )
        facts.rejected = true
      else throw error
    } finally {
      if (owner) {
        try {
          owner.close()
          owner = undefined
          facts.returnedOwnerNormallyClosed = true
        } catch (error) {
          cleanup.push(error)
        }
      }
    }
    if (cleanup.length) throw new Error("Returned literal-case owner did not normally close")
    // Capture factory-caused file changes BEFORE a separate private-copy read;
    // the candidate itself is never opened for post-attempt inspection.
    const afterFiles = literalNamespaceFiles(directory)
    const after = inspectLiteralCandidate(path, appRoot)
    facts.candidateFilesAfter = afterFiles
    facts.candidateFilesUnchanged = canonical(beforeFiles) === canonical(afterFiles)
    facts.candidateCatalogSHA256After = sha(canonical(after.catalog))
    facts.candidateLogicalSHA256After = sha(canonical(after))
    facts.candidateLogicalUnchanged = canonical(before) === canonical(after)
    facts.returnedPhysicalVersion = Number(after.marker?.version)
    facts.installationPreserved =
      after.marker?.installation_id === expected.identity.installationId &&
      (facts.returnedInstallationId === undefined ||
        facts.returnedInstallationId === expected.identity.installationId)
    facts.all19RecordsPreserved = canonical(after.records) === canonical(expectedRecords)
    facts.all9JournalBytesPreserved = canonical(after.journal) === canonical(expected.journal)
    facts.generationAndHPreserved =
      after.scope?.generation === expected.identity.generation &&
      after.scope.through_seq === expected.identity.throughSeq
  } catch (error) {
    failure = error
  } finally {
    try {
      editor?.close()
      editor = undefined
    } catch (error) {
      cleanup.push(error)
    }
    if (readdirSync(appRoot).some((name) => name.startsWith("literal-inspect-")))
      cleanup.push(
        new Error("Known literal-case native inspection remains; preserve exact owned root"),
      )
    if (!cleanup.length) {
      try {
        rmSync(appRoot, { recursive: true })
        facts.fixtureRemoved = !existsSync(appRoot)
      } catch (error) {
        cleanup.push(error)
      }
    }
  }
  facts.pristineUnchanged = sha(readFileSync(pristine)) === expected.sha256
  facts.cleanupErrorCount = cleanup.length
  facts.setupFailed = failure !== undefined
  const evidence = process.env.B4_PROTOCOL_SQLITE_LITERAL_EVIDENCE
  if (evidence !== undefined) {
    if (!isAbsolute(evidence))
      throw new Error("Literal-case private evidence directory must be absolute")
    writeFileSync(join(evidence, `${kind}.json`), `${JSON.stringify(facts, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    })
  }
  if (failure !== undefined || cleanup.length)
    throw new AggregateError(
      [...(failure !== undefined ? [failure] : []), ...cleanup],
      "Literal-case setup/factory or normal cleanup failed",
    )
  return facts
}

it("opens the unmodified qualified v1 SQLite copy for literal-case control", () => {
  const facts = runLiteralCase("unmodified")
  expect(facts.factoryOpened, "unmodified literal-case control uses the actual factory").toBe(true)
  expect(
    facts.returnedOwnerNormallyClosed,
    "unmodified literal-case control owner normally closed",
  ).toBe(true)
  expect(
    facts.installationPreserved &&
      facts.all19RecordsPreserved &&
      facts.all9JournalBytesPreserved &&
      facts.generationAndHPreserved,
    "unmodified literal-case control preserves original identity/data",
  ).toBe(true)
  expect(
    facts.fixtureRemoved && facts.pristineUnchanged,
    "unmodified literal-case control owns and removes only its copy",
  ).toBe(true)
})

it("rejects a case-only JSON path change in the qualified v1 receipts index", () => {
  const facts = runLiteralCase("case-only")
  // Raw before/after facts and normal owner/copy closure are recorded first.
  // Old normalize() admits the changed literal; this is the intended RED.
  expect(
    facts.rejected,
    "literal-case schema change is refused before writable owner acquisition",
  ).toBe(true)
  expect(
    facts.candidateFilesUnchanged && facts.candidateLogicalUnchanged,
    "literal-case refusal leaves the deliberately mutated candidate exact",
  ).toBe(true)
  expect(
    facts.fixtureRemoved && facts.pristineUnchanged,
    "literal-case refusal normally closes/removes only its copy",
  ).toBe(true)
})

function migrationCopy() {
  const appRoot = mkdtempSync(join(tmpdir(), "b4-sqlite-atomic-"))
  const directory = join(appRoot, ".b4/agent-protocol/v1")
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "runtime.sqlite")
  copyFileSync(pristine, path)
  return { appRoot, directory, path }
}
function recoveryFacts(db: DatabaseSync) {
  const names = [
    "runtime_recovery_keys",
    "recovery_scopes",
    "recovery_entities",
    "recovery_generations",
    "recovery_branches",
    "recovery_objects",
    "recovery_current",
    "recovery_versions",
    "recovery_cuts",
    "recovery_checkpoints",
    "recovery_fragments",
    "recovery_anchors",
  ]
  return Object.fromEntries(
    names.map((name) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY 1,2`).all()]),
  )
}

it("seeds only truthful legacy descriptors and reuses key, scope, branch and marker on normal reopen", () => {
  const copy = migrationCopy()
  let owner: RuntimeInstallation | undefined
  let db: DatabaseSync | undefined
  try {
    owner = openRuntimeInstallation(copy.appRoot)
    db = new DatabaseSync(copy.path, { readOnly: true })
    const first = recoveryFacts(db)
    const marker = db.prepare("SELECT * FROM runtime_installation").get()
    const registry = first.recovery_scopes as Record<string, unknown>[]
    const generations = first.recovery_generations as Record<string, unknown>[]
    const branches = first.recovery_branches as Record<string, unknown>[]
    expect(first.runtime_recovery_keys).toHaveLength(1)
    expect(registry).toHaveLength(1)
    expect(registry[0]?.scope_identity_json).toBe(
      JSON.stringify([1, expected.identity.threadId, expected.identity.generation]),
    )
    expect(generations).toEqual([
      expect.objectContaining({
        baseline_kind: "legacy_unknown",
        legacy_through_seq: expected.identity.throughSeq,
        replay_after_seq: expected.identity.throughSeq,
        current_cut_seq: null,
        history_epoch: 0,
        accounting_status: "unknown",
        open_bytes: null,
        pending_bytes: null,
        pending_count: null,
        recent_bytes: null,
        recent_count: null,
      }),
    ])
    expect(branches).toEqual([
      expect.objectContaining({
        born_seq: expected.identity.throughSeq,
        root_checkpoint_id: null,
        parent_branch_id: null,
        invalidated_seq: null,
      }),
    ])
    for (const [name, rows] of Object.entries(first))
      if (
        ![
          "runtime_recovery_keys",
          "recovery_scopes",
          "recovery_generations",
          "recovery_branches",
        ].includes(name)
      )
        expect(rows, name).toEqual([])
    db.close()
    db = undefined
    owner.close()
    owner = undefined
    owner = openRuntimeInstallation(copy.appRoot)
    db = new DatabaseSync(copy.path, { readOnly: true })
    expect(recoveryFacts(db)).toEqual(first)
    expect(db.prepare("SELECT * FROM runtime_installation").get()).toEqual(marker)
  } finally {
    db?.close()
    owner?.close()
    rmSync(copy.appRoot, { recursive: true })
  }
})

it.each(["zero", "deleted", "missing-thread"])(
  "migrates legacy %s without inventing a canonical cut",
  (kind) => {
    const copy = migrationCopy()
    let owner: RuntimeInstallation | undefined
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(copy.path)
      if (kind === "zero") db.exec("DELETE FROM journal; UPDATE scopes SET through_seq=0")
      else if (kind === "deleted") db.exec("UPDATE scopes SET deleted=1")
      else db.exec("DELETE FROM threads")
      db.close()
      db = undefined
      owner = openRuntimeInstallation(copy.appRoot)
      db = new DatabaseSync(copy.path, { readOnly: true })
      expect(db.prepare("SELECT COUNT(*) AS n FROM recovery_cuts").get()?.n).toBe(0)
      const descriptors = db
        .prepare(
          "SELECT baseline_kind,legacy_through_seq,replay_after_seq,current_cut_seq FROM recovery_generations",
        )
        .all()
      expect(descriptors).toEqual(
        kind === "zero"
          ? [
              {
                baseline_kind: "legacy_unknown",
                legacy_through_seq: 0,
                replay_after_seq: 0,
                current_cut_seq: null,
              },
            ]
          : [],
      )
      expect(db.prepare("SELECT COUNT(*) AS n FROM recovery_scopes").get()?.n).toBe(
        kind === "zero" ? 1 : 0,
      )
    } finally {
      db?.close()
      owner?.close()
      rmSync(copy.appRoot, { recursive: true })
    }
  },
)

it.each(["negative", "unsafe", "real", "ahead"])(
  "refuses legacy %s watermark before owner or additive writes",
  (kind) => {
    const copy = migrationCopy()
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(copy.path)
      db.exec(
        kind === "ahead"
          ? "UPDATE scopes SET through_seq=8"
          : `UPDATE scopes SET through_seq=${({ negative: "-1", unsafe: "9007199254740992", real: "9.5" } as const)[kind as "negative" | "unsafe" | "real"]}`,
      )
      db.close()
      db = undefined
      const before = literalNamespaceFiles(copy.directory)
      expect(() => openRuntimeInstallation(copy.appRoot)).toThrow(/incompatible|watermark/i)
      expect(literalNamespaceFiles(copy.directory)).toEqual(before)
    } finally {
      db?.close()
      rmSync(copy.appRoot, { recursive: true })
    }
  },
)

it("creates fresh physical2 with one durable key and no fabricated Thread or H0 cut", () => {
  const appRoot = mkdtempSync(join(tmpdir(), "b4-sqlite-fresh2-"))
  let owner: RuntimeInstallation | undefined
  let db: DatabaseSync | undefined
  try {
    owner = openRuntimeInstallation(appRoot)
    db = new DatabaseSync(owner.path, { readOnly: true })
    expect(db.prepare("SELECT version FROM runtime_installation").get()?.version).toBe(2)
    expect(db.prepare("SELECT COUNT(*) AS n FROM runtime_recovery_keys").get()?.n).toBe(1)
    for (const name of ["threads", "recovery_scopes", "recovery_generations", "recovery_cuts"])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()?.n, name).toBe(0)
  } finally {
    db?.close()
    owner?.close()
    rmSync(appRoot, { recursive: true })
  }
})

it.each(["first-ddl", "seeded-before-marker"])(
  "rolls back real SQLite %s failure without retaining additive objects or seed",
  (stage) => {
    // Qualify the exact prototype interception seam against a real disposable
    // native connection first. A missed interception is setup failure.
    const probe = new DatabaseSync(":memory:")
    const exec = DatabaseSync.prototype.exec
    let qualified = false
    const qualification = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      exec.call(this, sql)
      if (this === probe && sql === "CREATE TABLE intercepted (id INTEGER)") {
        qualified =
          this.prepare("SELECT name FROM sqlite_master WHERE name='intercepted'").get()?.name ===
          "intercepted"
        throw new Error("Qualified native delegation")
      }
    })
    try {
      expect(() => probe.exec("CREATE TABLE intercepted (id INTEGER)")).toThrow(
        "Qualified native delegation",
      )
    } finally {
      qualification.mockRestore()
      probe.close()
    }
    expect(qualified, "prototype exec interception actually delegated native DDL").toBe(true)

    const copy = migrationCopy()
    const before = inspectLiteralCandidate(copy.path, copy.appRoot)
    const prepare = DatabaseSync.prototype.prepare
    let intercepted = false
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      exec.call(this, sql)
      if (stage === "first-ddl" && /^CREATE TABLE "runtime_recovery_keys"/i.test(sql)) {
        if (
          prepare
            .call(this, "SELECT name FROM sqlite_master WHERE name='runtime_recovery_keys'")
            .get()?.name !== "runtime_recovery_keys"
        )
          throw new Error("Real additive DDL interception prerequisite failed")
        intercepted = true
        throw new Error("Injected real SQL migration failure")
      }
    })
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql: string,
    ) {
      if (stage === "seeded-before-marker" && /^UPDATE runtime_installation/i.test(sql)) {
        const seeded = prepare
          .call(
            this,
            "SELECT (SELECT count(*) FROM runtime_recovery_keys) AS keys,(SELECT count(*) FROM recovery_generations) AS descriptors",
          )
          .get()
        if (seeded?.keys !== 1 || seeded.descriptors !== 1)
          throw new Error("Real seeded SQL interception prerequisite failed")
        intercepted = true
        throw new Error("Injected real SQL migration failure")
      }
      return prepare.call(this, sql)
    })
    let owner: RuntimeInstallation | undefined
    try {
      expect(() => {
        owner = openRuntimeInstallation(copy.appRoot)
      }).toThrow()
    } finally {
      prepareSpy.mockRestore()
      execSpy.mockRestore()
      owner?.close()
    }
    try {
      expect(intercepted, "actual SQL delegation reached the precise rollback stage").toBe(true)
      expect(inspectLiteralCandidate(copy.path, copy.appRoot)).toEqual(before)
      const db = new DatabaseSync(copy.path, { readOnly: true })
      try {
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE name LIKE 'recovery_%' OR name='runtime_recovery_keys'",
            )
            .all(),
        ).toEqual([])
      } finally {
        db.close()
      }
    } finally {
      rmSync(copy.appRoot, { recursive: true })
    }
  },
)

// Raw schema-domain/cleanup fixture only. These rows do not qualify a
// canonical cut, reducer, finalizer, or fresh-Thread H0 initialization.
function cleanupRecoveryRows(
  threadId: string,
  generation: string,
  key: string,
  branch: string,
  checkpointId: string,
) {
  const base = { thread_id: threadId, generation, scope_key: key }
  const identity = encodeRecoveryIdentityTuple([1, threadId, generation])
  const checkpointKey = "c".repeat(32),
    messageKey = "d".repeat(32),
    object = "e".repeat(64)
  const fragment = "90000000-0000-4000-8000-000000000005"
  const unknown = {
    open_bytes: null,
    pending_bytes: null,
    pending_count: null,
    recent_bytes: null,
    recent_count: null,
    accounting_status: "unknown",
  }
  const entity = (kind: "message" | "checkpoint", id: string, entityKey: string) => {
    const encoded = encodeRecoveryIdentityTuple([1, threadId, generation, [], kind, id])
    return {
      ...base,
      entity_key: entityKey,
      entity_kind: kind,
      identity_hash: sha(encoded),
      identity_json: encoded,
      namespace_json: "[]",
      public_id_json: asciiJsonV1(id),
    }
  }
  const rows: [string, Record<string, string | number | null>][] = [
    ["recovery_scopes", { ...base, scope_hash: sha(identity), scope_identity_json: identity }],
    [
      "recovery_branches",
      {
        ...base,
        branch_id: branch,
        parent_branch_id: null,
        born_seq: 0,
        invalidated_seq: null,
        root_checkpoint_id: null,
      },
    ],
    [
      "recovery_generations",
      {
        ...base,
        baseline_kind: "legacy_unknown",
        legacy_through_seq: 0,
        replay_after_seq: 0,
        branch_id: branch,
        current_cut_seq: null,
        history_epoch: 0,
        ...unknown,
      },
    ],
    [
      "recovery_objects",
      { ...base, object_id: object, kind: "history_fragment", payload: "{}", payload_bytes: 2 },
    ],
    ["recovery_entities", entity("checkpoint", checkpointId, checkpointKey)],
    ["recovery_entities", entity("message", "cleanup-message", messageKey)],
    [
      "recovery_cuts",
      {
        ...base,
        through_seq: 0,
        public_revision_json: '"raw-cleanup-fixture"',
        branch_id: branch,
        history_epoch: 0,
        previous_cut_seq: null,
        selected_checkpoint_key: null,
        selected_checkpoint_version_seq: null,
        values_object_id: null,
        state_status: "unknown",
        activity_status: "unknown",
        public_fingerprint: "f".repeat(64),
        ...unknown,
      },
    ],
    [
      "recovery_checkpoints",
      {
        ...base,
        checkpoint_key: checkpointKey,
        checkpoint_id: checkpointId,
        version_seq: 0,
        source_seq: 0,
        namespace_json: "[]",
        owner_run_id: null,
        turn_id: null,
        parent_checkpoint_id: null,
        state_status: "unknown",
        values_object_id: null,
        messages_supported: 0,
        authority_alias_id: null,
      },
    ],
    [
      "recovery_versions",
      {
        ...base,
        entity_kind: "message",
        entity_key: messageKey,
        version_seq: 0,
        source_seq: 0,
        namespace_json: "[]",
        owner_run_id: null,
        turn_id: null,
        checkpoint_id: null,
        object_id: object,
        is_open: 0,
        is_deleted: 0,
        authority_alias_id: null,
        previous_version_seq: null,
      },
    ],
    [
      "recovery_current",
      {
        ...base,
        entity_kind: "message",
        entity_key: messageKey,
        version_seq: 0,
        namespace_json: "[]",
        is_open: 0,
        wire_bytes: 2,
      },
    ],
    [
      "recovery_fragments",
      {
        ...base,
        branch_id: branch,
        fragment_id: fragment,
        item_key: messageKey,
        fragment_index: 0,
        source_seq: 0,
        commit_seq: 0,
        namespace_json: "[]",
        owner_run_id: null,
        turn_id: null,
        kind: "message",
        operation: "append",
        object_id: object,
        authority_alias_id: null,
      },
    ],
    [
      "recovery_anchors",
      {
        ...base,
        branch_id: branch,
        fragment_id: fragment,
        link_seq: 0,
        checkpoint_key: checkpointKey,
        checkpoint_version_seq: 0,
        checkpoint_fragment_index: 0,
      },
    ],
  ]
  return rows
}

it.each([
  "target",
  "wrong-generation",
  "wrong-intent",
  "wrong-fence",
  "active-owner",
  "mapping",
  "rollback",
])("temporary cleanup %s retains other generation and key with native atomicity", async (kind) => {
  const appRoot = mkdtempSync(join(tmpdir(), "b4-sqlite-cleanup2-"))
  let owner: RuntimeInstallation | undefined
  let restore: (() => void) | undefined
  try {
    owner = openRuntimeInstallation(appRoot)
    const db = installationContext(owner).db
    const data = cleanupData
    const store = bindRuntimeStore(owner, createRuntimeBinding(owner, data.scope), () => data.now)
    const otherGeneration = "90000000-0000-4000-8000-000000000002",
      otherCheckpoint = "90000000-0000-4000-8000-000000000003"
    await store.transaction(async (tx) => {
      await tx.runs.put({ ...data.run, unwoundAt: data.now })
      await tx.checkpoints.put(data.checkpoint)
      await tx.thread.put({
        ...data.thread,
        cleanupIntent: { intentId: "cleanup-exact", onCompletion: "delete" },
      })
      db.prepare("INSERT INTO scopes(thread_id,generation,fence,deleted) VALUES (?,?,1,1)").run(
        data.scope.threadId,
        otherGeneration,
      )
      db.prepare("INSERT INTO checkpoint_identities VALUES (?,?,?)").run(
        otherCheckpoint,
        data.scope.threadId,
        otherGeneration,
      )
      for (const [name, row] of [
        ...cleanupRecoveryRows(
          data.scope.threadId,
          data.scope.generation,
          "b".repeat(32),
          "90000000-0000-4000-8000-000000000004",
          data.checkpointId,
        ),
        ...cleanupRecoveryRows(
          data.scope.threadId,
          otherGeneration,
          "a".repeat(32),
          "90000000-0000-4000-8000-000000000006",
          otherCheckpoint,
        ),
      ]) {
        const columns = Object.keys(row)
        db.prepare(
          `INSERT INTO ${name}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ).run(...Object.values(row))
      }
    })
    const plan = {
      threadId: data.scope.threadId,
      generation: data.scope.generation,
      runId: data.runId,
      headCheckpointId: data.checkpointId,
      cleanupIntentId: "cleanup-exact",
      provider: {
        kind: "none" as const,
        installationId: owner.installationId,
        threadId: data.scope.threadId,
        generation: data.scope.generation,
      },
    }
    if (kind === "active-owner")
      db.prepare("UPDATE scopes SET execution_owner='active' WHERE generation=?").run(
        data.scope.generation,
      )
    if (kind === "wrong-fence")
      db.prepare("UPDATE scopes SET fence=fence+1 WHERE generation=?").run(data.scope.generation)
    if (kind === "mapping")
      db.prepare("UPDATE recovery_current SET generation=? WHERE scope_key=?").run(
        otherGeneration,
        "b".repeat(32),
      )
    if (kind === "target") {
      // Positive and negative native strict-bound CHECKs in the explicitly raw
      // fixture; these do not qualify public cut/finalizer semantics.
      db.exec("BEGIN IMMEDIATE")
      try {
        for (const [name, source] of cleanupRecoveryRows(
          data.scope.threadId,
          data.scope.generation,
          "b".repeat(32),
          "90000000-0000-4000-8000-000000000004",
          data.checkpointId,
        )) {
          if (name !== "recovery_cuts" && name !== "recovery_versions") continue
          const row =
            name === "recovery_cuts"
              ? { ...source, through_seq: 1, previous_cut_seq: 0 }
              : { ...source, version_seq: 1, previous_version_seq: 0 }
          const columns = Object.keys(row)
          db.prepare(
            `INSERT INTO ${name}(${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
          ).run(...Object.values(row))
        }
        db.exec("COMMIT")
      } catch (error) {
        if (db.isTransaction) db.exec("ROLLBACK")
        throw error
      }
      expect(() =>
        db
          .prepare(
            "UPDATE recovery_versions SET previous_version_seq=version_seq WHERE scope_key=?",
          )
          .run("b".repeat(32)),
      ).toThrow(/CHECK/)
      expect(() =>
        db
          .prepare("UPDATE recovery_cuts SET previous_cut_seq=through_seq WHERE scope_key=?")
          .run("b".repeat(32)),
      ).toThrow(/CHECK/)
    }
    const beforeRecovery = recoveryFacts(db)
    const beforeOld = db.prepare("SELECT * FROM threads ORDER BY 1,2").all()
    const beforePrivate = db.prepare("SELECT * FROM retained_subjects").all()
    let reached = false
    let deleteAttempts = 0
    if (kind === "mapping") {
      const prepare = DatabaseSync.prototype.prepare
      const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        if (this === db && /^DELETE FROM recovery_/i.test(sql)) deleteAttempts++
        return prepare.call(this, sql)
      })
      restore = () => spy.mockRestore()
    }
    if (kind === "rollback") {
      const prepare = DatabaseSync.prototype.prepare
      const spy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
        this: DatabaseSync,
        sql: string,
      ) {
        if (this === db && sql.startsWith("DELETE FROM aliases")) {
          if (
            prepare
              .call(this, "SELECT count(*) AS n FROM recovery_scopes WHERE generation=?")
              .get(data.scope.generation)?.n !== 0
          )
            throw new Error("Cleanup interception missed recovery deletes")
          reached = true
          throw new Error("Injected native cleanup failure")
        }
        return prepare.call(this, sql)
      })
      restore = () => spy.mockRestore()
    }
    const attempted = {
      ...plan,
      ...(kind === "wrong-generation" ? { generation: otherGeneration } : {}),
      ...(kind === "wrong-intent" ? { cleanupIntentId: "wrong" } : {}),
    }
    if (["wrong-fence", "mapping", "rollback"].includes(kind))
      await expect(store.finalizeTemporary(attempted)).rejects.toThrow()
    else expect(await store.finalizeTemporary(attempted)).toBe(kind === "target")
    restore?.()
    restore = undefined
    if (kind === "target") {
      for (const [name, rows] of Object.entries(recoveryFacts(db))) {
        if (name === "runtime_recovery_keys") expect(rows).toEqual(beforeRecovery[name])
        else {
          expect(
            (rows as Record<string, unknown>[]).some(
              (row) => row.generation === data.scope.generation,
            ),
            name,
          ).toBe(false)
          expect(rows, name).toEqual(
            (beforeRecovery[name] as Record<string, unknown>[]).filter(
              (row) => row.generation === otherGeneration,
            ),
          )
        }
      }
      expect(db.prepare("SELECT * FROM threads").all()).toEqual([])
      expect(db.prepare("SELECT count(*) AS n FROM retained_subjects").get()?.n).toBe(1)
      const installationId = owner.installationId
      owner.close()
      owner = undefined
      owner = openRuntimeInstallation(appRoot)
      expect(owner.installationId).toBe(installationId)
      const reopened = installationContext(owner).db
      expect(
        reopened
          .prepare("SELECT count(*) AS n FROM recovery_scopes WHERE generation=?")
          .get(data.scope.generation)?.n,
      ).toBe(0)
      expect(() => bindRuntimeStore(owner!, createRuntimeBinding(owner!, data.scope))).toThrow(
        /stale|fence/i,
      )
    } else {
      expect(recoveryFacts(db)).toEqual(beforeRecovery)
      expect(db.prepare("SELECT * FROM threads ORDER BY 1,2").all()).toEqual(beforeOld)
      expect(db.prepare("SELECT * FROM retained_subjects").all()).toEqual(beforePrivate)
      if (kind === "rollback")
        expect(reached, "real failure between new and old deletes").toBe(true)
      if (kind === "mapping")
        expect(deleteAttempts, "mapping corruption refuses before recovery deletes").toBe(0)
    }
  } finally {
    restore?.()
    owner?.close()
    rmSync(appRoot, { recursive: true })
  }
})

it("stores escaped Unicode and long identity TEXT with bounded recovery registry keys and reopens exact bytes", () => {
  const copy = migrationCopy()
  let owner: RuntimeInstallation | undefined
  try {
    owner = openRuntimeInstallation(copy.appRoot)
    const db = installationContext(owner).db
    const scope = db.prepare("SELECT scope_key FROM recovery_scopes").get()?.scope_key
    if (typeof scope !== "string") throw new Error("Expected migrated exact scope")
    const components = [
      "\0",
      "\\u0000",
      "\ud800",
      "\udc00",
      "\ud83d\ude00",
      "\ufffd",
      "e\u0301",
      "\u00e9",
      '"\\/',
      "",
      "n".repeat(65_537),
    ]
    const publicId = `message:${components.join("|")}${"m".repeat(65_537)}`
    const rows = (["message", "namespace"] as const).map((kind, index) => {
      const id = kind === "namespace" ? null : publicId
      const identity = encodeRecoveryIdentityTuple([
        1,
        expected.identity.threadId,
        expected.identity.generation,
        components,
        kind,
        id,
      ])
      return {
        key: String(index + 1).repeat(32),
        kind,
        identity,
        hash: sha(identity),
        namespace: asciiJsonV1(components),
        publicId: asciiJsonV1(id),
      }
    })
    db.exec("BEGIN IMMEDIATE")
    try {
      for (const row of rows)
        db.prepare("INSERT INTO recovery_entities VALUES (?,?,?,?,?,?,?,?,?)").run(
          expected.identity.threadId,
          expected.identity.generation,
          scope,
          row.key,
          row.kind,
          row.hash,
          row.identity,
          row.namespace,
          row.publicId,
        )
      db.exec("COMMIT")
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    }
    const first = db.prepare("SELECT * FROM recovery_entities ORDER BY entity_key").all()
    expect(first.map((row) => sha(String(row.identity_json)))).toEqual(rows.map((row) => row.hash))
    expect(
      first.every(
        (row) =>
          typeof row.entity_key === "string" &&
          row.entity_key.length === 32 &&
          typeof row.scope_key === "string" &&
          row.scope_key.length === 32,
      ),
    ).toBe(true)
    expect(first.map((row) => JSON.parse(String(row.namespace_json)))).toEqual(
      rows.map(() => components),
    )
    expect(JSON.parse(String(first[0]?.public_id_json))).toBe(publicId)
    expect(() => db.prepare("UPDATE recovery_entities SET entity_kind='namespaces'").run()).toThrow(
      /CHECK/,
    )
    owner.close()
    owner = undefined
    owner = openRuntimeInstallation(copy.appRoot)
    expect(
      installationContext(owner)
        .db.prepare("SELECT * FROM recovery_entities ORDER BY entity_key")
        .all(),
    ).toEqual(first)
  } finally {
    owner?.close()
    rmSync(copy.appRoot, { recursive: true })
  }
})

it("migrates the maximum exact safe SQLite watermark without rounding the legacy floors", () => {
  const copy = migrationCopy()
  let owner: RuntimeInstallation | undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(copy.path)
    db.exec("UPDATE scopes SET through_seq=9007199254740991")
    db.close()
    db = undefined
    owner = openRuntimeInstallation(copy.appRoot)
    db = new DatabaseSync(copy.path, { readOnly: true })
    expect(
      db
        .prepare(
          "SELECT legacy_through_seq,replay_after_seq,current_cut_seq FROM recovery_generations",
        )
        .get(),
    ).toEqual({
      legacy_through_seq: 9007199254740991,
      replay_after_seq: 9007199254740991,
      current_cut_seq: null,
    })
  } finally {
    db?.close()
    owner?.close()
    rmSync(copy.appRoot, { recursive: true })
  }
})

it("seeds multiple live legacy scopes with isolated exact identities and floors and reopens without duplicates", () => {
  const copy = migrationCopy()
  const additions = [
    {
      threadId: "81000000-0000-4000-8000-000000000001",
      generation: "81000000-0000-4000-8000-000000000011",
      throughSeq: 0,
    },
    {
      threadId: "81000000-0000-4000-8000-000000000002",
      generation: "81000000-0000-4000-8000-000000000011",
      throughSeq: 4,
    },
    {
      threadId: "81000000-0000-4000-8000-000000000003",
      generation: "81000000-0000-4000-8000-000000000013",
      throughSeq: 9007199254740991,
    },
  ]
  let owner: RuntimeInstallation | undefined
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(copy.path)
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE")
    try {
      for (const scope of additions) {
        db.prepare(
          "INSERT INTO scopes(thread_id,generation,fence,through_seq) VALUES (?,?,1,?)",
        ).run(scope.threadId, scope.generation, scope.throughSeq)
        const payload = {
          thread: { ...cleanupData.thread.thread, thread_id: scope.threadId },
          generation: scope.generation,
          revision: 1,
          headCheckpointId: null,
          currentRunId: null,
          pausedGeneration: null,
          protectedMetadata: {},
        }
        db.prepare(
          "INSERT INTO threads(thread_id,generation,revision,payload) VALUES (?,?,1,?)",
        ).run(scope.threadId, scope.generation, JSON.stringify(payload))
      }
      db.exec("COMMIT")
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK")
      throw error
    }
    const beforeRecords = recordHashes(db)
    db.close()
    db = undefined
    owner = openRuntimeInstallation(copy.appRoot)
    db = new DatabaseSync(copy.path, { readOnly: true })
    expect(recordHashes(db)).toEqual(beforeRecords)
    const first = recoveryFacts(db)
    const marker = db.prepare("SELECT * FROM runtime_installation").get()
    const registry = first.recovery_scopes as Record<string, unknown>[]
    const generations = first.recovery_generations as Record<string, unknown>[]
    const branches = first.recovery_branches as Record<string, unknown>[]
    const sources = [
      {
        threadId: expected.identity.threadId,
        generation: expected.identity.generation,
        throughSeq: expected.identity.throughSeq,
      },
      ...additions,
    ]
    expect(first.runtime_recovery_keys).toHaveLength(1)
    expect(registry).toHaveLength(sources.length)
    expect(generations).toHaveLength(sources.length)
    expect(branches).toHaveLength(sources.length)
    expect(new Set(registry.map((row) => row.scope_key)).size).toBe(sources.length)
    expect(new Set(branches.map((row) => row.branch_id)).size).toBe(sources.length)
    for (const source of sources) {
      const matches = registry.filter(
        (row) => row.thread_id === source.threadId && row.generation === source.generation,
      )
      expect(matches).toHaveLength(1)
      const scope = matches[0]!
      const identity = encodeRecoveryIdentityTuple([1, source.threadId, source.generation])
      expect(scope.scope_key).toMatch(/^[0-9a-f]{32}$/)
      expect(scope.scope_identity_json).toBe(identity)
      expect(scope.scope_hash).toBe(sha(identity))
      const descriptor = generations.filter((row) => row.scope_key === scope.scope_key)
      expect(descriptor).toEqual([
        expect.objectContaining({
          thread_id: source.threadId,
          generation: source.generation,
          baseline_kind: "legacy_unknown",
          legacy_through_seq: source.throughSeq,
          replay_after_seq: source.throughSeq,
          current_cut_seq: null,
          accounting_status: "unknown",
        }),
      ])
      expect(branches.filter((row) => row.scope_key === scope.scope_key)).toEqual([
        expect.objectContaining({
          thread_id: source.threadId,
          generation: source.generation,
          branch_id: descriptor[0]?.branch_id,
          born_seq: source.throughSeq,
          root_checkpoint_id: null,
        }),
      ])
    }
    for (const [name, rows] of Object.entries(first))
      if (
        ![
          "runtime_recovery_keys",
          "recovery_scopes",
          "recovery_generations",
          "recovery_branches",
        ].includes(name)
      )
        expect(rows, name).toEqual([])
    db.close()
    db = undefined
    owner.close()
    owner = undefined
    owner = openRuntimeInstallation(copy.appRoot)
    db = new DatabaseSync(copy.path, { readOnly: true })
    expect(recoveryFacts(db)).toEqual(first)
    expect(db.prepare("SELECT * FROM runtime_installation").get()).toEqual(marker)
    expect(recordHashes(db)).toEqual(beforeRecords)
  } finally {
    db?.close()
    owner?.close()
    rmSync(copy.appRoot, { recursive: true })
  }
})

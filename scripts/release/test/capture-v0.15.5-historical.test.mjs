import assert from "node:assert/strict"
import test from "node:test"
import * as capture from "../capture-v0.15.5-historical.mjs"

test("capture rejects an unreviewed or dirty checkout before constructing readers", async () => {
  let readers = 0

  for (const checkout of [
    { head: "b".repeat(40), status: "" },
    { head: "a".repeat(40), status: " M file" },
  ]) {
    await assert.rejects(
      capture.runHistorical0155Capture(
        ["--reviewed-commit", "a".repeat(40), "--output", "/private/tmp/proposed-historical-test"],
        {
          readCheckout: async () => checkout,
          createReaders: () => {
            readers++
            throw new Error("must not construct readers")
          },
        },
      ),
      /exact clean reviewed checkout/u,
    )
  }

  assert.equal(readers, 0)
})

test("capture rejects unsupported CLI inputs and pre-aborted captures", async () => {
  await assert.rejects(capture.runHistorical0155Capture(["--version", "0.15.7"]))
  const abort = new AbortController()
  abort.abort()

  await assert.rejects(
    capture.captureHistorical0155({
      reviewedCommit: "a".repeat(40),
      signal: abort.signal,
    }),
  )
})

function present(value, operation) {
  return { status: "PRESENT", value, operation, httpStatus: 200, code: null }
}
function bracketReader() {
  const sha = "a".repeat(40)
  return {
    getRepository: async () =>
      present({ id: 1210070282, full_name: "cacheplane/b4run", default_branch: "main" }),
    getAuthenticatedUser: async () => present({ id: 7, login: "operator" }),
    getRef: async ({ ref }) => present({ ref: `refs/${ref}`, object: { type: "commit", sha } }),
    compareCommits: async () => present({ status: "identical", merge_base_commit: { sha } }),
    listReleases: async () => present([]),
    listRepositoryWorkflowsComplete: async () =>
      present(
        capture.HISTORICAL_CAPTURE_OWNER_WORKFLOWS.map((path, index) => ({
          id: index + 1,
          path,
          state: "active",
        })),
      ),
    listWorkflowRunsAllShasComplete: async ({ workflowId }) => {
      const workflowPath = capture.HISTORICAL_CAPTURE_OWNER_WORKFLOWS[workflowId - 1]
      const runId =
        workflowPath === ".github/workflows/release.yml"
          ? 40370125207
          : workflowPath === ".github/workflows/published-artifact-verify.yml"
            ? 40376822663
            : null
      return present(
        runId === null
          ? []
          : [
              {
                id: runId,
                workflow_id: workflowId,
                path: workflowPath,
                repository: { id: 1210070282, full_name: "cacheplane/b4run" },
                head_sha: "877ce4899406cebabc150e80309cb5dbf2299bee",
                run_attempt: 1,
                status: "completed",
                conclusion: "success",
              },
            ],
      )
    },
  }
}

test("bracket authenticates repository, operator, main ancestry and complete owner drain", async () => {
  const github = bracketReader()
  const result = await capture.captureHistoricalBracket({ github, reviewedCommit: "a".repeat(40) })

  assert.equal(result.operator.login, "operator")
  assert.equal(result.main, "a".repeat(40))
  for (const change of [
    {
      getRepository: async () =>
        present({ id: 99, full_name: "cacheplane/b4run", default_branch: "main" }),
    },
    { getAuthenticatedUser: async () => present({ id: 0, login: "operator" }) },
    {
      compareCommits: async () =>
        present({ status: "behind", merge_base_commit: { sha: "b".repeat(40) } }),
    },
    { listRepositoryWorkflowsComplete: async () => present([]) },
    { listWorkflowRunsAllShasComplete: async () => present([{ status: "queued" }]) },
    { listWorkflowRunsAllShasComplete: async () => ({ status: "ERROR" }) },
  ]) {
    await assert.rejects(
      capture.captureHistoricalBracket({
        github: { ...github, ...change },
        reviewedCommit: "a".repeat(40),
      }),
    )
  }
})

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { canonicalManifestBytes } from "../manifest.mjs"
import { canonicalReleaseBody } from "../metadata.mjs"
import { canonicalAuditResultBytes } from "../terminal-records.mjs"
import { TEST_MANIFEST, testRecord } from "./fixtures/historical-0155.mjs"
import { observationForMarker } from "./support/marker-observation.mjs"

function binary(bytes) {
  return { status: "PRESENT", contentBase64: bytes.toString("base64"), bodyBytes: bytes.length }
}
async function originalReader() {
  const record = testRecord()
  const archive = await readFile(
    new URL("./fixtures/historical-0155-npm-evidence.zip", import.meta.url),
  )
  const manifest = canonicalManifestBytes(TEST_MANIFEST)
  const assets = [
    { id: 99, name: "manifest.json", size: manifest.length, digest: `sha256:${hash(manifest)}` },
    ...record.original.audit.receipts.map((x) => ({
      id: x.id,
      name: x.name,
      size: x.size,
      digest: `sha256:${x.sha256}`,
    })),
  ]
  const artifact = {
    id: record.incident.artifactId,
    name: record.incident.artifactName,
    digest: record.incident.archiveServiceDigest,
    size_in_bytes: archive.length,
    expired: false,
    expires_at: "2026-11-25T00:00:00Z",
    workflow_run: { id: record.incident.publisherRunId, head_sha: record.incident.commitSha },
  }
  const runs = [record.original.publisher, record.original.audit.run]
  const replace = (value) => {
    if (typeof value === "string")
      return value
        .replaceAll("0.8.22", "0.15.5")
        .replaceAll("0123456789abcdef0123456789abcdef01234567", record.incident.commitSha)
        .replaceAll("500", String(record.incident.auditRunId))
    if (value === 500) return record.incident.auditRunId
    if (Array.isArray(value)) return value.map(replace)
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
    return value
  }
  const marker = replace(observationForMarker({ phase: "AUDIT_VERIFIED" }).release.marker)
  marker.manifestSha256 = record.incident.manifestSha256
  marker.attestationSet.subjects[0].subjectSha256 = record.incident.manifestSha256
  marker.npmEvidenceSha256 = record.incident.originalReceiptSha256
  marker.audit.attemptSha256 = record.original.audit.receipts[0].sha256
  marker.audit.canonicalSha256 = record.original.audit.receipts[0].sha256
  const body = canonicalReleaseBody({ marker, manifest: null })
  const github = {
    getRelease: async () =>
      present({
        id: record.incident.releaseId,
        tag_name: record.incident.tag,
        immutable: true,
        draft: false,
        body,
      }),
    listReleaseAssets: async () => present(assets),
    downloadReleaseAsset: async ({ assetId }) =>
      binary(
        assetId === 99
          ? manifest
          : canonicalAuditResultBytes(
              record.original.audit.receipts.find((x) => x.id === assetId).receipt,
            ),
      ),
    getRef: async () =>
      present({
        ref: record.incident.publisherRef,
        object: { type: "tag", sha: record.incident.tagObjectSha },
      }),
    getGitTag: async () =>
      present({
        sha: record.incident.tagObjectSha,
        tag: record.incident.tag,
        object: { type: "commit", sha: record.incident.commitSha },
      }),
    getActionsRun: async ({ runId }) => {
      const run = runs.find((x) => x.runId === runId)
      return present(
        {
          id: runId,
          run_attempt: 1,
          repository: { id: run.repositoryId, full_name: run.repository },
          path: run.workflow,
          head_branch: "v0.15.5",
          head_sha: run.commitSha,
          status: run.status,
          conclusion: run.conclusion,
        },
        "actions-run",
      )
    },
    getActionsRunAttempt: async (args) => ({
      ...(await github.getActionsRun(args)),
      operation: "actions-run-attempt",
    }),
    listActionsRunJobsComplete: async ({ runId }) =>
      present(
        runs
          .find((x) => x.runId === runId)
          .jobs.map((x) => ({
            ...x,
            run_id: runId,
            runAttempt: 1,
            head_sha: record.incident.commitSha,
            startedAt: "2026-10-25T00:00:00Z",
            completedAt: "2026-10-25T01:00:00Z",
          })),
        "actions-run-jobs-complete",
      ),
    getActionsArtifact: async () => present(artifact),
    listActionsRunArtifacts: async () => present([artifact]),
    downloadActionsArtifact: async () => binary(archive),
  }
  return { github, artifact, assets, archive }
}
function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

test("original capture authenticates actual ZIP, manifest, successful runs/jobs and both audit assets without a future record", async () => {
  const input = await originalReader()

  const result = await capture.captureHistoricalOriginal({
    ...input,
    now: () => Date.parse("2026-10-27T00:00:00Z"),
  })

  assert.deepEqual(result.manifest, TEST_MANIFEST)
  assert.equal(result.original.artifact.sha256, hash(input.archive))
  assert.equal(result.files.size, 6)
  for (const change of [
    { getActionsRun: async () => present({}) },
    { listActionsRunJobsComplete: async () => present([]) },
    { downloadActionsArtifact: async () => binary(Buffer.from("different ZIP")) },
    { getRelease: async () => present({ id: 424591222, tag_name: "v0.15.5", immutable: false }) },
    { listReleaseAssets: async () => present([...input.assets, input.assets[0]]) },
    { downloadReleaseAsset: async () => binary(Buffer.from("{}\n")) },
  ]) {
    await assert.rejects(
      capture.captureHistoricalOriginal({
        github: { ...input.github, ...change },
        now: () => Date.parse("2026-10-27T00:00:00Z"),
      }),
    )
  }
})

function syntheticSweep() {
  const bytes = Buffer.from("actual downloaded package bytes")
  const sha512 = createHash("sha512").update(bytes).digest("hex")
  const manifest = structuredClone(TEST_MANIFEST)
  manifest.packages = manifest.packages.map((entry) => ({
    ...entry,
    size: bytes.length,
    sha256: hash(bytes),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
  }))
  let metadataReads = 0,
    byteReads = 0,
    audits = 0
  const npm = {
    observePackageVersion: async ({ name, version }) => {
      metadataReads++
      const unscoped = name.split("/").at(-1)
      return {
        status: "PRESENT",
        package: {
          name,
          version,
          integrity: manifest.packages[0].npmIntegrity,
          shasum: createHash("sha1").update(bytes).digest("hex"),
          tarballUrl: `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`,
        },
      }
    },
    downloadRegistryTarball: async ({ tarballUrl }) => {
      byteReads++
      return {
        status: "PRESENT",
        tarball: {
          url: tarballUrl,
          size: bytes.length,
          contentBase64: bytes.toString("base64"),
          sha1: createHash("sha1").update(bytes).digest("hex"),
          sha256: hash(bytes),
          sha512,
        },
      }
    },
  }
  const audit = {
    verifyPackages: async ({ entries }) => {
      audits++
      return entries.map((entry) => ({
        name: entry.name,
        version: entry.version,
        status: "verified",
        signature: { status: "valid" },
      }))
    },
    captureIncidentPackageCommand: async () => ({
      stdout: "actual-official-output",
      stderr: "",
      exitCode: 0,
    }),
  }
  return { manifest, npm, audit, counts: () => [metadataReads, byteReads, audits] }
}

test("each fresh sweep reads all 21 exact registry byte identities and separate official evidence", async () => {
  const input = syntheticSweep()

  const first = await capture.captureHistoricalSweep(input)
  const second = await capture.captureHistoricalSweep(input)

  assert.deepEqual(input.counts(), [42, 42, 2])
  assert.equal(first.packages.length, 21)
  assert.equal(second.packages.at(-1).verification, "historical-provenance")
  assert.equal(first.command.stdout, "actual-official-output")
  assert.equal(first.recordSha256, undefined)
  for (const change of [
    { observePackageVersion: async () => ({ status: "ABSENT" }) },
    { downloadRegistryTarball: async () => ({ status: "PRESENT", tarball: {} }) },
    {
      observePackageVersion: async ({ name, version }) => ({
        status: "PRESENT",
        package: { name, version, integrity: "wrong" },
      }),
    },
  ]) {
    await assert.rejects(
      capture.captureHistoricalSweep({ ...input, npm: { ...input.npm, ...change } }),
    )
  }
})

import { parseHistoricalPublicationRecord } from "../historical-publication-record.mjs"
import { TEST_OFFICIAL_AUDIT } from "./fixtures/historical-0155.mjs"

async function captureFixture() {
  let clock = Date.parse("2026-10-27T12:00:00Z")
  const source = await originalReader()
  const readOriginal = () =>
    capture.captureHistoricalOriginal({ github: source.github, now: () => clock })
  const readBracket = async () => ({
    operator: {
      id: 7,
      login: "operator",
      node_id: "MDQ6VXNlcjc=",
      type: "User",
      avatar_url: "https://avatars.githubusercontent.com/u/7?v=4",
      updated_at: "2026-10-27T11:00:00Z",
    },
    main: "a".repeat(40),
  })
  const readSweep = async () => {
    const startedAt = new Date(clock).toISOString()
    clock += 1000
    return {
      startedAt,
      finishedAt: new Date(clock).toISOString(),
      packages: TEST_MANIFEST.packages.map((entry) => ({
        ...entry,
        verification: entry.name === "create-b4-app" ? "historical-provenance" : "complete",
      })),
      observations: [],
      ordinary: [],
      command: { stdout: JSON.stringify(TEST_OFFICIAL_AUDIT), stderr: "", exitCode: 0 },
    }
  }
  return {
    reviewedCommit: "a".repeat(40),
    now: () => clock,
    wait: async (ms) => {
      clock += ms
    },
    readOriginal,
    readBracket,
    readSweep,
    advance: (ms) => {
      clock += ms
    },
  }
}

test("completed capture projects the operator identity from full GitHub user brackets into the strict record", async () => {
  const input = await captureFixture()

  const result = await capture.captureHistorical0155(input)
  const record = parseHistoricalPublicationRecord(result.recordBytes, { manifest: TEST_MANIFEST })

  assert.equal(
    Date.parse(record.sweeps[1].startedAt) - Date.parse(record.sweeps[0].startedAt),
    60000,
  )
  assert.equal(record.brackets[0].factsSha256, record.brackets[1].factsSha256)
  assert.equal(record.capture.controllerSha, input.reviewedCommit)
  assert.deepEqual(record.capture.operator, { id: 7, login: "operator" })
  const bracketFacts = JSON.parse(
    result.files.get("scripts/release/historical-publications/evidence/v0.15.5/bracket-facts.json"),
  )
  assert.deepEqual(bracketFacts.github, await input.readBracket())
  for (const operator of [bracketFacts.github.operator, { id: 0, login: "operator" }]) {
    const malformed = JSON.parse(result.recordBytes)
    malformed.capture.operator = operator
    assert.throws(() => parseHistoricalPublicationRecord(malformed, { manifest: TEST_MANIFEST }))
  }
  assert.equal(result.files.size, 9)
  assert.equal(record.supportingEvidence.length, 9)
  assert.equal(
    result.files
      .get("scripts/release/historical-publications/evidence/v0.15.5/sweep-first.json")
      .includes(Buffer.from("recordSha256")),
    false,
  )
  for (const [file, bytes] of result.files) {
    const expected = record.supportingEvidence.find((entry) => entry.path === file)
    assert.equal(hash(bytes), expected.sha256)
    assert.equal(bytes.length, expected.size)
  }
})

test("capture aborts on drift, incomplete official output, insufficient elapsed spacing or total budget", async () => {
  for (const kind of [
    "drift",
    "operator identity drift",
    "operator profile drift",
    "failed official",
    "spacing",
    "budget",
    "cancelled",
  ]) {
    const input = await captureFixture()
    if (kind === "drift") {
      let reads = 0
      input.readBracket = async () => ({
        operator: { id: 7, login: "operator" },
        main: String(++reads),
      })
    }
    if (kind === "operator identity drift" || kind === "operator profile drift") {
      const read = input.readBracket
      let reads = 0
      input.readBracket = async () => {
        const bracket = await read()
        const change =
          ++reads === 1
            ? {}
            : kind === "operator identity drift"
              ? { id: 8 }
              : {
                  updated_at: "2026-10-27T12:00:00Z",
                }
        return { ...bracket, operator: { ...bracket.operator, ...change } }
      }
    }
    if (kind === "failed official") {
      const read = input.readSweep
      input.readSweep = async () => ({
        ...(await read()),
        command: { stdout: JSON.stringify(TEST_OFFICIAL_AUDIT), stderr: "", exitCode: 1 },
      })
    }
    if (kind === "spacing") input.wait = async () => {}
    if (kind === "budget") input.wait = async () => input.advance(15 * 60_000)
    if (kind === "cancelled") {
      const abort = new AbortController()
      input.signal = abort.signal
      input.wait = async () => abort.abort()
    }

    await assert.rejects(
      capture.captureHistorical0155(input),
      kind.includes("drift") ? /GitHub identity or original evidence drifted/u : undefined,
      kind,
    )
  }
})

import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("private capture output is exclusive, exact and mode0600 without admitted repository writes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "historical-output-"))
  const canonicalRoot = await fs.realpath(root)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const result = await capture.captureHistorical0155(await captureFixture())
  await fs.mkdir(path.join(canonicalRoot, "repo"))
  const output = path.join(canonicalRoot, "capture")

  await capture.writeHistoricalCaptureOutput({
    cwd: path.join(canonicalRoot, "repo"),
    output,
    result,
  })

  for (const file of [
    "scripts/release/historical-publications/v0.15.5.json",
    ...result.files.keys(),
  ]) {
    const metadata = await fs.lstat(path.join(output, file))
    assert.equal(metadata.mode & 0o7777, 0o600)
    assert.equal(metadata.nlink, 1)
    assert.equal(metadata.isFile(), true)
  }
  assert.deepEqual(
    await fs.readFile(path.join(output, "scripts/release/historical-publications/v0.15.5.json")),
    result.recordBytes,
  )
  await assert.rejects(
    capture.writeHistoricalCaptureOutput({ cwd: path.join(canonicalRoot, "repo"), output, result }),
  )
  await assert.rejects(
    capture.writeHistoricalCaptureOutput({
      cwd: canonicalRoot,
      output: path.join(canonicalRoot, "inside-repository"),
      result,
    }),
  )
  await fs.symlink(output, path.join(canonicalRoot, "alias"))
  await assert.rejects(
    capture.writeHistoricalCaptureOutput({
      cwd: path.join(canonicalRoot, "repo"),
      output: path.join(canonicalRoot, "alias/new"),
      result,
    }),
  )
  const escaped = { ...result, files: new Map([["../escaped", Buffer.from("no")]]) }
  await assert.rejects(
    capture.writeHistoricalCaptureOutput({
      cwd: path.join(canonicalRoot, "repo"),
      output: path.join(canonicalRoot, "escaped-output"),
      result: escaped,
    }),
  )
})

test("initial capture cannot use retained private archive bytes when the service original is unavailable", async () => {
  const input = await originalReader()
  input.artifact.expired = true
  input.artifact.expires_at = "2026-10-26T00:00:00Z"
  input.github.downloadActionsArtifact = async () => ({
    status: "AMBIGUOUS",
    httpStatus: 410,
    operation: "actions-artifact-download",
    code: "HTTP_410",
  })

  await assert.rejects(
    capture.captureHistoricalOriginal({
      github: input.github,
      originalArchive: input.archive,
      now: () => Date.parse("2026-10-27T00:00:00Z"),
    }),
  )
  await assert.rejects(
    capture.runHistorical0155Capture([
      "--reviewed-commit",
      "a".repeat(40),
      "--output",
      "/private/tmp/output",
      "--original-archive",
      "/private/tmp/private.zip",
    ]),
  )
})

test("bracket rejects duplicate owner identities, malformed terminal runs and missing original run membership", async () => {
  const github = bracketReader()
  for (const runs of [
    [{ status: "completed", id: 0 }],
    [{ status: "completed", conclusion: "", id: 1 }],
  ]) {
    await assert.rejects(
      capture.captureHistoricalBracket({
        github: { ...github, listWorkflowRunsAllShasComplete: async () => present(runs) },
        reviewedCommit: "a".repeat(40),
      }),
    )
  }
  const workflows = capture.HISTORICAL_CAPTURE_OWNER_WORKFLOWS.map((path) => ({
    id: 1,
    path,
    state: "active",
  }))

  await assert.rejects(
    capture.captureHistoricalBracket({
      github: { ...github, listRepositoryWorkflowsComplete: async () => present(workflows) },
      reviewedCommit: "a".repeat(40),
    }),
  )
})

test("a cancelled capture does not wait indefinitely for a late read or write output", async () => {
  const abort = new AbortController()
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  const work = capture.captureHistorical0155({
    reviewedCommit: "a".repeat(40),
    signal: abort.signal,
    readOriginal: () => {
      started()
      return new Promise(() => {})
    },
  })
  await ready

  abort.abort(new Error("capture cancelled"))

  await assert.rejects(work, /capture cancelled/u)
})

test("restored complete ordinary npm proof stops the historical capture instead of claiming a missing proof", async () => {
  const input = await captureFixture()
  const output = structuredClone(TEST_OFFICIAL_AUDIT)
  output.verified[0].attestationBundles.unshift({
    predicateType: "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2",
      verificationMaterial: {
        publicKey: { hint: "SHA256:test" },
        tlogEntries: [{}],
        timestampVerificationData: { rfc3161Timestamps: [] },
      },
      dsseEnvelope: {
        payload: Buffer.from("{}").toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{ sig: "npm-verified", keyid: "SHA256:test" }],
      },
    },
    signedAccessSignatureUrl: "",
  })
  const read = input.readSweep
  input.readSweep = async () => ({
    ...(await read()),
    command: { stdout: JSON.stringify(output), stderr: "", exitCode: 0 },
  })

  await assert.rejects(
    capture.captureHistorical0155(input),
    /Ordinary npm verification is available/u,
  )
})

test("current editable Release marker cannot disagree with independently authenticated original evidence", async () => {
  const input = await originalReader()
  const read = input.github.getRelease
  input.github.getRelease = async () => {
    const result = await read()
    return {
      ...result,
      value: {
        ...result.value,
        body: result.value.body.replaceAll(
          "1401b7303458f1a9f31f325711b3275a5b765e0baaee4ab7d6c285d646cc4d1e",
          "f".repeat(64),
        ),
      },
    }
  }

  await assert.rejects(capture.captureHistoricalOriginal({ github: input.github }))
})

test("checkout verification rejects hidden index flags and foreign worktree roots with ordinary Git reads", async () => {
  const invocations = []
  const cwd = await fs.realpath(process.cwd())
  const run = async (command, args, options) => {
    invocations.push({ command, args, options })
    const operation = args.slice(4).join(" ")
    if (operation === "rev-parse --verify HEAD") return { stdout: `${"a".repeat(40)}\n` }
    if (operation === "rev-parse --show-toplevel") return { stdout: `${cwd}\n` }
    if (operation.startsWith("ls-files")) return { stdout: "H scripts/release/cli.mjs\0" }
    return { stdout: "" }
  }

  assert.deepEqual(
    await capture.readHistoricalCheckout(cwd, {
      run,
      environment: { PATH: "path" },
    }),
    { head: "a".repeat(40), status: "" },
  )
  assert.equal(
    invocations.every(
      ({ options }) => options.env.GIT_DIR === undefined && options.env.GIT_WORK_TREE === undefined,
    ),
    true,
  )
  for (const flag of ["h", "S"]) {
    await assert.rejects(
      capture.readHistoricalCheckout(cwd, {
        run: async (...args) =>
          args[1].includes("ls-files") ? { stdout: `${flag} hidden\0` } : run(...args),
      }),
    )
  }
  await assert.rejects(
    capture.readHistoricalCheckout(cwd, {
      run: async (...args) =>
        args[1].includes("--show-toplevel") ? { stdout: "/private/tmp\n" } : run(...args),
    }),
  )
})

test("operator command completes official cleanup and rechecks checkout before emitting private evidence", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "historical-command-"))
  const canonicalRoot = await fs.realpath(root)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(canonicalRoot, "repo"))
  const output = path.join(canonicalRoot, "capture")
  const result = await capture.captureHistorical0155(await captureFixture())
  let cleanup = false,
    checkouts = 0,
    writes = 0
  const dependencies = {
    cwd: path.join(canonicalRoot, "repo"),
    readCheckout: async () => {
      checkouts++
      return { head: "a".repeat(40), status: "" }
    },
    createReaders: async () => ({
      audit: {
        dispose: async () => {
          cleanup = true
        },
      },
    }),
    capture: async () => result,
    fileSystem: {
      ...fs,
      mkdir: async (...args) => {
        assert.equal(cleanup, true)
        writes++
        return fs.mkdir(...args)
      },
    },
  }

  await capture.runHistorical0155Capture(
    ["--reviewed-commit", "a".repeat(40), "--output", output],
    dependencies,
  )

  assert.equal(checkouts, 2)
  assert.ok(writes > 0)
  dependencies.createReaders = async () => ({
    audit: {
      dispose: async () => {
        throw new Error("cleanup failed")
      },
    },
  })
  await assert.rejects(
    capture.runHistorical0155Capture(
      ["--reviewed-commit", "a".repeat(40), "--output", path.join(canonicalRoot, "failed")],
      dependencies,
    ),
  )
  await assert.rejects(fs.lstat(path.join(canonicalRoot, "failed")), { code: "ENOENT" })
})

test("aliased checkout ancestors cannot redirect private output into the actual checkout", async (t) => {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "historical-cwd-alias-"))
  const root = await fs.realpath(created)
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, "actual"))
  const actualCheckout = path.join(root, "actual/repo")
  await fs.mkdir(actualCheckout)
  await fs.symlink(path.join(root, "actual"), path.join(root, "alias"))
  const aliasedCheckout = path.join(root, "alias/repo")
  const result = await capture.captureHistorical0155(await captureFixture())
  const output = path.join(actualCheckout, "private-output")

  await assert.rejects(
    capture.writeHistoricalCaptureOutput({ cwd: aliasedCheckout, output, result }),
  )
  await assert.rejects(fs.lstat(output), { code: "ENOENT" })
  let readers = 0
  await assert.rejects(
    capture.runHistorical0155Capture(["--reviewed-commit", "a".repeat(40), "--output", output], {
      cwd: aliasedCheckout,
      readCheckout: async () => ({ head: "a".repeat(40), status: "" }),
      createReaders: async () => {
        readers++
        return {}
      },
      capture: async () => result,
    }),
  )
  assert.equal(readers, 0)
  await assert.rejects(fs.lstat(output), { code: "ENOENT" })
  await assert.rejects(
    capture.readHistoricalCheckout(aliasedCheckout, {
      environment: {},
      run: async (_command, args) => ({
        stdout: args.includes("--verify")
          ? `${"a".repeat(40)}\n`
          : args.includes("--show-toplevel")
            ? `${actualCheckout}\n`
            : "",
      }),
    }),
  )
})

test("checkout verification rejects every ambient Git context before invoking Git", async () => {
  const cwd = await fs.realpath(process.cwd())
  let calls = 0
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT"]) {
    await assert.rejects(
      capture.readHistoricalCheckout(cwd, {
        environment: { PATH: "ordinary-path", [key]: "foreign-context" },
        run: async () => {
          calls++
          throw new Error("Git should not run")
        },
      }),
      /ambient Git/u,
    )
  }

  assert.equal(calls, 0)
})

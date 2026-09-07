import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { CANONICAL_RELEASE_PACKAGE_ORDER, manifestSha256 } from "../manifest.mjs"
import {
  assertBootstrapWindow,
  BOOTSTRAP_AUTHORIZATION_MAX_BYTES,
  BOOTSTRAP_MAX_WINDOW_MS,
  bootstrapAuthorizationSha256,
  canonicalBootstrapAuthorizationBytes,
  FIRST_PUBLICATION_PACKAGE_NAMES,
  NPM_AUTH_MODES,
  parseBootstrapAuthorization,
  redactBootstrapCredential,
  redactBootstrapError,
  validateBootstrapAuthorization,
  validateBootstrapToken,
} from "../npm-bootstrap.mjs"
import { releaseRecordSha256 } from "../release-record.mjs"

const VERSION = "0.9.0"
const COMMIT_SHA = "0123456789abcdef0123456789abcdef01234567"
const CANDIDATE = Object.freeze({
  version: VERSION,
  commitSha: COMMIT_SHA,
  ciWorkflow: "CI",
  ciCheck: "validate",
  publisherWorkflow: ".github/workflows/release.yml",
})
const NOT_BEFORE = "2026-09-08T00:00:00Z"
const EXPIRES_AT = "2026-09-08T12:00:00Z"
const NOT_BEFORE_MS = Date.parse(NOT_BEFORE)
const EXPIRES_AT_MS = Date.parse(EXPIRES_AT)

test("the fixed first-publication set is exactly the 21 code-owned names with no duplicates", () => {
  assert.equal(FIRST_PUBLICATION_PACKAGE_NAMES.length, 21)
  assert.equal(new Set(FIRST_PUBLICATION_PACKAGE_NAMES).size, 21)
  assert.deepEqual(
    [...FIRST_PUBLICATION_PACKAGE_NAMES],
    [...FIRST_PUBLICATION_PACKAGE_NAMES].sort(),
  )
  assert.deepEqual(
    [...FIRST_PUBLICATION_PACKAGE_NAMES].sort(),
    [...CANONICAL_RELEASE_PACKAGE_ORDER].sort(),
  )
  assert.ok(Object.isFrozen(FIRST_PUBLICATION_PACKAGE_NAMES))
  assert.deepEqual([...NPM_AUTH_MODES], ["oidc", "bootstrap"])
  assert.equal(BOOTSTRAP_MAX_WINDOW_MS, 24 * 60 * 60 * 1000)
})

test("parses only the exact canonical bounded authorization document", () => {
  const document = authorization()
  const raw = canonical(document)
  const parsed = parseBootstrapAuthorization(raw)
  assert.deepEqual(parsed, document)
  assert.ok(Object.isFrozen(parsed))
  assert.deepEqual(parseBootstrapAuthorization(Buffer.from(raw, "utf8")), document)
  assert.deepEqual(canonicalBootstrapAuthorizationBytes(document), Buffer.from(raw, "utf8"))
  assert.equal(
    bootstrapAuthorizationSha256(raw),
    createHash("sha256").update(raw, "utf8").digest("hex"),
  )

  const rejected = [
    ["absent", undefined],
    ["retired", ""],
    ["null", null],
    ["whitespace-only", "   "],
    ["noncanonical whitespace", `${JSON.stringify(document, null, 2)}`],
    ["noncanonical key order", JSON.stringify(document)],
    ["trailing newline", `${raw}\n`],
    ["array", "[]"],
    ["string", JSON.stringify(raw)],
    ["invalid JSON", "{"],
    [
      "oversized",
      canonical({ ...document, version: "1".repeat(BOOTSTRAP_AUTHORIZATION_MAX_BYTES) }),
    ],
    ["unknown key", canonical({ ...document, packages: FIRST_PUBLICATION_PACKAGE_NAMES })],
    ["missing key", canonical(omit(document, "expiresAt"))],
    ["schema version", canonical({ ...document, schemaVersion: 2 })],
    ["status", canonical({ ...document, status: "disabled" })],
    ["old repository", canonical({ ...document, repository: "cacheplane/dawnai" })],
    ["old repository id", canonical({ ...document, repositoryId: "1210070282" })],
    ["numeric repository id", canonical({ ...document, repositoryId: 1360603908 })],
    ["workflow", canonical({ ...document, publisherWorkflow: ".github/workflows/publish.yml" })],
    ["prerelease version", canonical({ ...document, version: "0.9.0-rc.1" })],
    ["build version", canonical({ ...document, version: "0.9.0+build" })],
    ["short sha", canonical({ ...document, commitSha: COMMIT_SHA.slice(0, 39) })],
    ["uppercase sha", canonical({ ...document, commitSha: COMMIT_SHA.toUpperCase() })],
    ["manifest digest", canonical({ ...document, manifestSha256: "z".repeat(64) })],
    ["record digest", canonical({ ...document, releaseRecordSha256: "a".repeat(63) })],
    ["millisecond timestamp", canonical({ ...document, notBefore: "2026-09-08T00:00:00.000Z" })],
    ["offset timestamp", canonical({ ...document, expiresAt: "2026-09-08T12:00:00+00:00" })],
    ["impossible timestamp", canonical({ ...document, notBefore: "2026-02-30T00:00:00Z" })],
    ["numeric timestamp", canonical({ ...document, notBefore: NOT_BEFORE_MS })],
    ["inverted window", canonical({ ...document, notBefore: EXPIRES_AT, expiresAt: NOT_BEFORE })],
    ["empty window", canonical({ ...document, expiresAt: NOT_BEFORE })],
    [
      "window over 24h",
      canonical({ ...document, notBefore: NOT_BEFORE, expiresAt: "2026-09-09T00:00:01Z" }),
    ],
  ]
  for (const [name, raw] of rejected) {
    assert.throws(() => parseBootstrapAuthorization(raw), TypeError, name)
  }
  assert.doesNotThrow(() =>
    parseBootstrapAuthorization(
      canonical({ ...document, notBefore: NOT_BEFORE, expiresAt: "2026-09-09T00:00:00Z" }),
    ),
  )
})

test("binds the authorization to the exact candidate, artifacts, environment, and name set", () => {
  const manifest = releaseManifest()
  const record = releaseRecord(manifest)
  const document = authorization({ manifest, record })
  const environment = bootstrapEnvironment()

  const bound = validateBootstrapAuthorization(parseBootstrapAuthorization(canonical(document)), {
    candidate: CANDIDATE,
    manifest,
    record,
    environment,
  })
  assert.deepEqual(Object.keys(bound).sort(), ["authorization", "authorizationSha256"])
  assert.deepEqual(bound.authorization, document)
  assert.equal(bound.authorizationSha256, bootstrapAuthorizationSha256(canonical(document)))
  assert.ok(Object.isFrozen(bound))

  const parsed = parseBootstrapAuthorization(canonical(document))
  const rejected = [
    ["other version", { candidate: { ...CANDIDATE, version: "0.9.1" } }],
    ["other commit", { candidate: { ...CANDIDATE, commitSha: "f".repeat(40) } }],
    [
      "other workflow",
      { candidate: { ...CANDIDATE, publisherWorkflow: ".github/workflows/x.yml" } },
    ],
    [
      "manifest digest drift",
      { manifest: { ...manifest, packages: [...manifest.packages].reverse() } },
    ],
    [
      "record digest drift",
      { record: { ...record, actionsArtifact: { ...record.actionsArtifact, id: "987654321" } } },
    ],
    [
      "missing name",
      { manifest: { ...manifest, packages: manifest.packages.slice(1) } },
      parseBootstrapAuthorization(
        canonical(
          authorization({
            manifest: { ...manifest, packages: manifest.packages.slice(1) },
            record,
          }),
        ),
      ),
    ],
    [
      "duplicate name",
      {
        manifest: {
          ...manifest,
          packages: [manifest.packages[0], ...manifest.packages.slice(0, -1)],
        },
      },
      parseBootstrapAuthorization(
        canonical(
          authorization({
            manifest: {
              ...manifest,
              packages: [manifest.packages[0], ...manifest.packages.slice(0, -1)],
            },
            record,
          }),
        ),
      ),
    ],
    [
      "unexpected name",
      {
        manifest: {
          ...manifest,
          packages: [...manifest.packages.slice(0, -1), packageEntry("@dawn-ai/create-app")],
        },
      },
      parseBootstrapAuthorization(
        canonical(
          authorization({
            manifest: {
              ...manifest,
              packages: [...manifest.packages.slice(0, -1), packageEntry("@dawn-ai/create-app")],
            },
            record,
          }),
        ),
      ),
    ],
    ["old repository", { environment: { ...environment, GITHUB_REPOSITORY: "cacheplane/dawnai" } }],
    ["old repository id", { environment: { ...environment, GITHUB_REPOSITORY_ID: "1210070282" } }],
    ["missing repository id", { environment: omit(environment, "GITHUB_REPOSITORY_ID") }],
    ["push event", { environment: { ...environment, GITHUB_EVENT_NAME: "push" } }],
    ["other ref", { environment: { ...environment, GITHUB_REF: "refs/heads/main" } }],
    ["other sha", { environment: { ...environment, GITHUB_SHA: "f".repeat(40) } }],
    [
      "other workflow ref",
      {
        environment: {
          ...environment,
          GITHUB_WORKFLOW_REF: `cacheplane/b4-run/.github/workflows/ci.yml@refs/tags/v${VERSION}`,
        },
      },
    ],
    ["self-hosted runner", { environment: { ...environment, RUNNER_ENVIRONMENT: "self-hosted" } }],
  ]
  for (const [name, overrides, document = parsed] of rejected) {
    assert.throws(
      () =>
        validateBootstrapAuthorization(document, {
          candidate: CANDIDATE,
          manifest,
          record,
          environment,
          ...overrides,
        }),
      /bootstrap/iu,
      name,
    )
  }
})

test("the operational window is checked with strict bounds and never extends itself", () => {
  const document = parseBootstrapAuthorization(canonical(authorization()))
  assert.doesNotThrow(() => assertBootstrapWindow(document, NOT_BEFORE_MS))
  assert.doesNotThrow(() => assertBootstrapWindow(document, EXPIRES_AT_MS - 1))
  assert.throws(() => assertBootstrapWindow(document, NOT_BEFORE_MS - 1), /not yet valid/iu)
  assert.throws(() => assertBootstrapWindow(document, EXPIRES_AT_MS), /expired/iu)
  assert.throws(
    () => assertBootstrapWindow(document, EXPIRES_AT_MS + BOOTSTRAP_MAX_WINDOW_MS),
    /expired/iu,
  )
  for (const now of [Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, 1.5]) {
    assert.throws(() => assertBootstrapWindow(document, now), TypeError)
  }
})

test("credential values are bounded printable strings and never appear in rejections", () => {
  assert.equal(validateBootstrapToken("npm_abcDEF0123456789"), "npm_abcDEF0123456789")
  const secretMarker = "SECRETMARKER"
  for (const value of [
    undefined,
    null,
    "",
    " ",
    `${secretMarker}\n`,
    `${secretMarker}\r`,
    `${secretMarker}\0`,
    `${secretMarker}`,
    `${secretMarker} with space`,
    `${secretMarker}é`,
    `${secretMarker}${"x".repeat(1024)}`,
    12345,
    { token: secretMarker },
  ]) {
    let caught = null
    try {
      validateBootstrapToken(value)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof TypeError, "rejection required")
    assert.doesNotMatch(caught.message, /SECRETMARKER/u)
    assert.doesNotMatch(String(caught.stack), /SECRETMARKER/u)
  }
})

test("redaction removes literal, base64, and URL-encoded credential forms from strings and errors", () => {
  const token = "npm_SeCrEt/Value+123=="
  const encoded = [
    token,
    Buffer.from(token, "utf8").toString("base64"),
    Buffer.from(token, "utf8").toString("base64url"),
    encodeURIComponent(token),
    JSON.stringify(token).slice(1, -1),
  ]
  const text = `npm ERR! ${encoded.join(" | ")} tail`
  const redacted = redactBootstrapCredential(text, token)
  for (const form of encoded) assert.equal(redacted.includes(form), false, form)
  assert.match(redacted, /\[REDACTED\]/u)
  assert.equal(redactBootstrapCredential("clean", token), "clean")
  assert.equal(redactBootstrapCredential(null, token), null)

  const inner = new Error(`inner ${token}`)
  inner.stdout = `out ${token}`
  inner.stderr = `err ${Buffer.from(token).toString("base64")}`
  const outer = new AggregateError([inner, new Error(`sibling ${token}`)], `outer ${token}`, {
    cause: new Error(`cause ${encodeURIComponent(token)}`),
  })
  const safe = redactBootstrapError(outer, token)
  assert.notEqual(safe, outer)
  const rendered = [
    safe.message,
    String(safe.stack),
    safe.cause?.message,
    ...(safe.errors ?? []).map(
      (error) => `${error.message} ${error.stdout ?? ""} ${error.stderr ?? ""}`,
    ),
    JSON.stringify(safe, Object.getOwnPropertyNames(safe)),
  ].join("\n")
  for (const form of encoded) assert.equal(rendered.includes(form), false, form)
  assert.match(safe.message, /outer \[REDACTED\]/u)
  assert.match(safe.cause.message, /cause \[REDACTED\]/u)
  assert.equal(safe.errors.length, 2)
  assert.equal(redactBootstrapError("plain", token), "plain")

  // Structured diagnostics hung off a rejection must be redacted too: a runner
  // that attaches captured output as an object or array must not leak the
  // credential through JSON rendering.
  const structured = new Error("structured failure")
  structured.details = { output: [`arr ${token}`], nested: { deep: `deep ${token}` } }
  structured.cycle = structured.details
  structured.details.self = structured.details
  structured.untouched = 7
  const safeStructured = redactBootstrapError(structured, token)
  const structuredRendered = JSON.stringify(safeStructured, (_key, value) =>
    typeof value === "object" && value !== null && value.self
      ? { ...value, self: "[cycle]" }
      : value,
  )
  assert.equal(structuredRendered.includes(token), false)
  assert.equal(safeStructured.details.output[0], "arr [REDACTED]")
  assert.equal(safeStructured.details.nested.deep, "deep [REDACTED]")
  assert.equal(safeStructured.details.self, safeStructured.details)
  assert.equal(safeStructured.cycle, safeStructured.details)
  assert.equal(safeStructured.untouched, 7)
  assert.equal(originalIsUnredacted(structured, token), true)
})

// The original error must never be mutated in place; redaction returns a copy.
function originalIsUnredacted(original, token) {
  return (
    original.details.output[0] === `arr ${token}` &&
    original.details.nested.deep === `deep ${token}`
  )
}

function authorization({ manifest = releaseManifest(), record = releaseRecord(manifest) } = {}) {
  return {
    schemaVersion: 1,
    status: "enabled",
    repository: "cacheplane/b4-run",
    repositoryId: "1360603908",
    publisherWorkflow: ".github/workflows/release.yml",
    version: VERSION,
    commitSha: COMMIT_SHA,
    manifestSha256: manifestSha256(manifest),
    releaseRecordSha256: releaseRecordSha256(record),
    notBefore: NOT_BEFORE,
    expiresAt: EXPIRES_AT,
  }
}

function canonical(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  )
}

function omit(value, key) {
  const { [key]: _omitted, ...rest } = value
  return rest
}

function bootstrapEnvironment() {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: `refs/tags/v${VERSION}`,
    GITHUB_REPOSITORY: "cacheplane/b4-run",
    GITHUB_REPOSITORY_ID: "1360603908",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: COMMIT_SHA,
    GITHUB_WORKFLOW_REF: `cacheplane/b4-run/.github/workflows/release.yml@refs/tags/v${VERSION}`,
    RUNNER_ENVIRONMENT: "github-hosted",
  }
}

function releaseManifest() {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    ci: { workflow: "CI", runId: 100, runAttempt: 1 },
    artifact: {
      name: `release-v${VERSION}-${COMMIT_SHA.slice(0, 12)}`,
      prepareRunId: 200,
      prepareRunAttempt: 1,
    },
    packageOrder: [...CANONICAL_RELEASE_PACKAGE_ORDER],
    packages: CANONICAL_RELEASE_PACKAGE_ORDER.map((name) => packageEntry(name)),
  }
}

function packageEntry(name) {
  const bytes = Buffer.from(`tarball ${name}`)
  const sha512 = createHash("sha512").update(bytes).digest("hex")
  const stem = name.startsWith("@") ? name.slice(1).replaceAll("/", "-") : name
  return {
    name,
    version: VERSION,
    filename: `${stem}-${VERSION}.tgz`,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha512,
    npmIntegrity: `sha512-${Buffer.from(sha512, "hex").toString("base64")}`,
    access: "public",
  }
}

function releaseRecord(manifest) {
  return {
    schemaVersion: 1,
    version: VERSION,
    commitSha: COMMIT_SHA,
    tag: `v${VERSION}`,
    manifestSha256: manifestSha256(manifest),
    actionsArtifact: {
      id: "123456789",
      name: manifest.artifact.name,
      serviceDigest: `sha256:${"a".repeat(64)}`,
      prepareRunId: "200",
      prepareRunAttempt: 1,
    },
  }
}

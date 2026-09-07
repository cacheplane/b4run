import { createHash } from "node:crypto"

import { snapshotJson } from "./adapter-normalize.mjs"
import { manifestSha256 } from "./manifest.mjs"
import { releaseRecordSha256 } from "./release-record.mjs"
import { isExactSemver, parseSemver } from "./semver.mjs"

// Narrow, expiring, candidate-bound registry credential exception for the first B4.run
// publication (docs/superpowers/plans/2026-09-07-b4-first-publication.md). npm trusted publishing
// cannot be configured for a name that does not exist yet, so exactly one publication may use a
// dedicated short-lived token. Everything else about the release stays as it is: the same
// GitHub-hosted workflow identity, sealed artifacts, escrow, serial publication, registry
// verification, and provenance checks. This module owns only the policy: the strict
// authorization parser, the identity binding, the per-mutation window check, the credential
// shape check, and credential redaction. It never reads the environment itself.

export const NPM_AUTH_MODES = Object.freeze(["oidc", "bootstrap"])
export const BOOTSTRAP_AUTHORIZATION_VARIABLE = "B4_NPM_BOOTSTRAP_AUTHORIZATION"
export const BOOTSTRAP_TOKEN_VARIABLE = "B4_NPM_BOOTSTRAP_TOKEN"
export const BOOTSTRAP_REPOSITORY = "cacheplane/b4-run"
export const BOOTSTRAP_REPOSITORY_ID = "1360603908"
export const BOOTSTRAP_PUBLISHER_WORKFLOW = ".github/workflows/release.yml"
export const BOOTSTRAP_MAX_WINDOW_MS = 24 * 60 * 60 * 1000
export const BOOTSTRAP_AUTHORIZATION_MAX_BYTES = 2048
export const BOOTSTRAP_TOKEN_MAX_BYTES = 512
export const BOOTSTRAP_REDACTION = "[REDACTED]"

// The fixed first-publication set is code-owned. The authorization variable cannot widen it.
export const FIRST_PUBLICATION_PACKAGE_NAMES = Object.freeze([
  "@b4run/ag-ui",
  "@b4run/cli",
  "@b4run/config-biome",
  "@b4run/config-typescript",
  "@b4run/core",
  "@b4run/devkit",
  "@b4run/evals",
  "@b4run/inspector",
  "@b4run/langchain",
  "@b4run/langgraph",
  "@b4run/memory",
  "@b4run/memory-pgvector",
  "@b4run/permissions",
  "@b4run/postgres-storage",
  "@b4run/sandbox",
  "@b4run/sdk",
  "@b4run/sqlite-storage",
  "@b4run/testing",
  "@b4run/vite-plugin",
  "@b4run/workspace",
  "create-b4-app",
])

const AUTHORIZATION_FIELDS = Object.freeze([
  "schemaVersion",
  "status",
  "repository",
  "repositoryId",
  "publisherWorkflow",
  "version",
  "commitSha",
  "manifestSha256",
  "releaseRecordSha256",
  "notBefore",
  "expiresAt",
])
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u
const TOKEN_PATTERN = /^[\x21-\x7e]+$/u
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true })

export function parseBootstrapAuthorization(raw) {
  const text = decodeAuthorizationText(raw)
  let value
  try {
    value = snapshotJson(JSON.parse(text))
  } catch (error) {
    throw new TypeError("npm bootstrap authorization is not valid JSON", { cause: error })
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new TypeError("npm bootstrap authorization must be one JSON object")
  }
  for (const field of AUTHORIZATION_FIELDS) {
    if (!Object.hasOwn(value, field)) {
      throw new TypeError(`npm bootstrap authorization is missing ${field}`)
    }
  }
  const extra = Object.keys(value).filter((field) => !AUTHORIZATION_FIELDS.includes(field))
  if (extra.length > 0) {
    throw new TypeError(`npm bootstrap authorization contains unknown field ${extra.sort()[0]}`)
  }
  if (
    value.schemaVersion !== 1 ||
    value.status !== "enabled" ||
    value.repository !== BOOTSTRAP_REPOSITORY ||
    value.repositoryId !== BOOTSTRAP_REPOSITORY_ID ||
    value.publisherWorkflow !== BOOTSTRAP_PUBLISHER_WORKFLOW
  ) {
    throw new TypeError("npm bootstrap authorization identity is not the B4.run release publisher")
  }
  if (!isReleaseVersion(value.version)) {
    throw new TypeError("npm bootstrap authorization version must be an exact release version")
  }
  if (typeof value.commitSha !== "string" || !SHA_PATTERN.test(value.commitSha)) {
    throw new TypeError("npm bootstrap authorization commit SHA is invalid")
  }
  for (const field of ["manifestSha256", "releaseRecordSha256"]) {
    if (typeof value[field] !== "string" || !SHA256_PATTERN.test(value[field])) {
      throw new TypeError(`npm bootstrap authorization ${field} is invalid`)
    }
  }
  const notBefore = parseCanonicalTimestamp(value.notBefore, "notBefore")
  const expiresAt = parseCanonicalTimestamp(value.expiresAt, "expiresAt")
  if (expiresAt <= notBefore) {
    throw new TypeError("npm bootstrap authorization window is empty or inverted")
  }
  if (expiresAt - notBefore > BOOTSTRAP_MAX_WINDOW_MS) {
    throw new TypeError("npm bootstrap authorization window exceeds 24 hours")
  }
  if (text !== canonicalAuthorizationText(value)) {
    throw new TypeError("npm bootstrap authorization bytes must be canonical")
  }
  return deepFreeze(value)
}

export function canonicalBootstrapAuthorizationBytes(authorization) {
  return Buffer.from(canonicalAuthorizationText(snapshotJson(authorization)), "utf8")
}

export function bootstrapAuthorizationSha256(raw) {
  return createHash("sha256").update(decodeAuthorizationText(raw), "utf8").digest("hex")
}

export function validateBootstrapAuthorization(
  authorization,
  { candidate, manifest, record, environment } = {},
) {
  const document = snapshotJson(authorization)
  if (document === null || Array.isArray(document) || typeof document !== "object") {
    throw new TypeError("npm bootstrap authorization must be parsed before validation")
  }
  const identity = snapshotJson(candidate)
  if (
    identity === null ||
    Array.isArray(identity) ||
    typeof identity !== "object" ||
    document.version !== identity.version ||
    document.commitSha !== identity.commitSha ||
    document.publisherWorkflow !== identity.publisherWorkflow
  ) {
    throw new Error("npm bootstrap authorization does not name the selected release candidate")
  }
  if (document.manifestSha256 !== manifestSha256(manifest)) {
    throw new Error("npm bootstrap authorization does not match the sealed release manifest")
  }
  if (document.releaseRecordSha256 !== releaseRecordSha256(record)) {
    throw new Error("npm bootstrap authorization does not match the release record")
  }
  assertFirstPublicationPackageSet(manifest)
  assertBootstrapEnvironment(environment, document)
  const raw = canonicalAuthorizationText(document)
  return deepFreeze({
    authorization: deepFreeze(document),
    authorizationSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
  })
}

export function assertBootstrapWindow(authorization, nowMs) {
  if (!Number.isSafeInteger(nowMs)) {
    throw new TypeError("npm bootstrap clock reading is invalid")
  }
  const notBefore = parseCanonicalTimestamp(authorization?.notBefore, "notBefore")
  const expiresAt = parseCanonicalTimestamp(authorization?.expiresAt, "expiresAt")
  if (nowMs < notBefore) {
    throw new Error("npm bootstrap authorization is not yet valid")
  }
  if (nowMs >= expiresAt) {
    throw new Error("npm bootstrap authorization has expired; provision a replacement window")
  }
}

export function validateBootstrapToken(value) {
  // Never echo the rejected value: every rejection carries the same fixed message.
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > BOOTSTRAP_TOKEN_MAX_BYTES ||
    !TOKEN_PATTERN.test(value)
  ) {
    throw new TypeError(
      "npm bootstrap token is missing, empty, oversized, or contains whitespace or control characters",
    )
  }
  return value
}

export function redactBootstrapCredential(value, token) {
  if (typeof value !== "string" || typeof token !== "string" || token.length === 0) return value
  let output = value
  for (const form of credentialForms(token)) {
    output = output.split(form).join(BOOTSTRAP_REDACTION)
  }
  return output
}

export function redactBootstrapError(error, token, seen = new Map()) {
  if (typeof error === "string") return redactBootstrapCredential(error, token)
  if (error === null || typeof error !== "object") return error
  if (seen.has(error)) return seen.get(error)
  const message = redactBootstrapCredential(
    typeof error.message === "string" ? error.message : String(error.message ?? ""),
    token,
  )
  const options = {}
  if ("cause" in error) options.cause = redactBootstrapError(error.cause, token, seen)
  const replacement =
    error instanceof AggregateError
      ? new AggregateError(
          (Array.isArray(error.errors) ? error.errors : []).map((inner) =>
            redactBootstrapError(inner, token, seen),
          ),
          message,
          options,
        )
      : error instanceof TypeError
        ? new TypeError(message, options)
        : new Error(message, options)
  seen.set(error, replacement)
  replacement.name = error.name
  replacement.stack = redactBootstrapCredential(String(error.stack ?? ""), token)
  for (const key of Object.getOwnPropertyNames(error)) {
    if (["message", "stack", "cause", "errors", "name"].includes(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    if (descriptor === undefined || !("value" in descriptor)) continue
    replacement[key] = redactBootstrapValue(descriptor.value, token, seen)
  }
  return replacement
}

// Own properties can carry structured diagnostics (a captured `{stdout, stderr}`
// object, an array of log lines). Copying them verbatim would leak the
// credential through JSON rendering, so every container is redacted in place of
// its original. Cycles resolve through the same `seen` map as nested errors.
function redactBootstrapValue(value, token, seen) {
  if (typeof value === "string") return redactBootstrapCredential(value, token)
  if (value instanceof Error) return redactBootstrapError(value, token, seen)
  if (Buffer.isBuffer(value)) {
    return Buffer.from(redactBootstrapCredential(value.toString("utf8"), token))
  }
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const copy = []
    seen.set(value, copy)
    for (const entry of value) copy.push(redactBootstrapValue(entry, token, seen))
    return copy
  }
  const prototype = Object.getPrototypeOf(value)
  // Only plain objects are rebuilt. An exotic instance is replaced by its
  // redacted string form rather than reconstructed with a wrong prototype.
  if (prototype !== Object.prototype && prototype !== null) {
    return redactBootstrapCredential(String(value), token)
  }
  const copy = {}
  seen.set(value, copy)
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = redactBootstrapValue(entry, token, seen)
  }
  return copy
}

function credentialForms(token) {
  const bytes = Buffer.from(token, "utf8")
  const forms = new Set([
    token,
    bytes.toString("base64"),
    bytes.toString("base64").replace(/=+$/u, ""),
    bytes.toString("base64url"),
    bytes.toString("hex"),
    encodeURIComponent(token),
    encodeURIComponent(token).toLowerCase(),
    JSON.stringify(token).slice(1, -1),
  ])
  forms.delete("")
  // Replace longer forms first so a form that is a prefix of another cannot leave a suffix.
  return [...forms].sort((left, right) => right.length - left.length)
}

function assertFirstPublicationPackageSet(manifest) {
  const packages = manifest?.packages
  if (!Array.isArray(packages)) {
    throw new Error("npm bootstrap requires the sealed release manifest package list")
  }
  const names = packages.map((entry) => entry?.name)
  const unique = new Set(names)
  if (
    names.length !== FIRST_PUBLICATION_PACKAGE_NAMES.length ||
    unique.size !== names.length ||
    FIRST_PUBLICATION_PACKAGE_NAMES.some((name) => !unique.has(name))
  ) {
    throw new Error("npm bootstrap manifest does not contain exactly the fixed 21-package set")
  }
}

function assertBootstrapEnvironment(environment, document) {
  if (environment === null || Array.isArray(environment) || typeof environment !== "object") {
    throw new TypeError("npm bootstrap environment must be an object")
  }
  const ref = `refs/tags/v${document.version}`
  const expected = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: ref,
    GITHUB_REPOSITORY: BOOTSTRAP_REPOSITORY,
    GITHUB_REPOSITORY_ID: BOOTSTRAP_REPOSITORY_ID,
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_SHA: document.commitSha,
    GITHUB_WORKFLOW_REF: `${BOOTSTRAP_REPOSITORY}/${BOOTSTRAP_PUBLISHER_WORKFLOW}@${ref}`,
    RUNNER_ENVIRONMENT: "github-hosted",
  }
  for (const [name, value] of Object.entries(expected)) {
    if (environment[name] !== value) {
      throw new Error(
        `npm bootstrap environment ${name} does not match the authorized B4.run release`,
      )
    }
  }
}

function decodeAuthorizationText(raw) {
  let text
  if (typeof raw === "string") {
    text = raw
  } else if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    try {
      text = UTF8_DECODER.decode(raw)
    } catch (error) {
      throw new TypeError("npm bootstrap authorization is not UTF-8", { cause: error })
    }
  } else {
    throw new TypeError("npm bootstrap authorization is absent or retired")
  }
  const byteLength = Buffer.byteLength(text, "utf8")
  if (byteLength === 0 || text.trim().length === 0) {
    throw new TypeError("npm bootstrap authorization is absent or retired")
  }
  if (byteLength > BOOTSTRAP_AUTHORIZATION_MAX_BYTES) {
    throw new TypeError("npm bootstrap authorization exceeds its byte limit")
  }
  return text
}

function canonicalAuthorizationText(value) {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    ),
  )
}

function parseCanonicalTimestamp(value, label) {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new TypeError(`npm bootstrap authorization ${label} must be a canonical UTC timestamp`)
  }
  const parsed = Date.parse(value)
  if (
    !Number.isSafeInteger(parsed) ||
    new Date(parsed).toISOString() !== `${value.slice(0, -1)}.000Z`
  ) {
    throw new TypeError(`npm bootstrap authorization ${label} is not a real UTC instant`)
  }
  return parsed
}

function isReleaseVersion(value) {
  if (typeof value !== "string" || !isExactSemver(value)) return false
  const parsed = parseSemver(value)
  // The first publication is a stable fixed-group release: no prerelease or build metadata.
  return parsed.build.length === 0 && parsed.prerelease.length === 0
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

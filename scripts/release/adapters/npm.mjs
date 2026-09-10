import { createHash } from "node:crypto"

import { snapshotJson } from "../adapter-normalize.mjs"
import { RELEASE_PAYLOAD_LIMITS } from "../limits.mjs"
import { isExactSemver } from "../semver.mjs"
import { createHttpGet } from "./http.mjs"

// Every observation is a JSON-safe envelope with status, operation, httpStatus, and code.
// PRESENT package observations additionally include the exact registry identity and evidence.
const OPERATIONS = new Set([
  "package-version",
  "package-metadata",
  "package-tarball",
  "first-publication-package",
])
// npm's actual public not-found bodies: the packument endpoint answers `{"error":"Not found"}` and
// the exact-version endpoint of an absent package answers the bare string `"Not Found"`. An existing
// package's absent version answers `"version not found: <version>"`, which proves the package exists
// and therefore conflicts with a packument-level absence. The CLI's E404 code never appears in the
// registry body; it is only the internal absence code.
const REGISTRY_NOT_FOUND_TEXT = /^not found$/iu
const FIRST_PUBLICATION_OPERATION = "first-publication-package"
const PACKAGE_NAME_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u
const SHA_PATTERN = /^[0-9a-f]{40}$/u
const DEFAULT_REGISTRY_ORIGIN = "https://registry.npmjs.org"
const MAX_REGISTRY_URL_BYTES = 2_048
const MAX_PACKAGE_NAME_BYTES = 256
const MAX_VERSION_BYTES = 256

export function createNpmReader(options = {}) {
  const context = createRegistryContext(options)
  return {
    observePackageMetadata({ name, signal }) {
      assertPackageName(name)
      return observePackageMetadata({ ...context, name, signal })
    },
    observePackageVersion({ name, version, signal }) {
      assertPackageName(name)
      assertExactVersion(version)
      return observePackageVersion({ ...context, name, version, signal })
    },
    downloadRegistryTarball({ tarballUrl, signal }) {
      return downloadRegistryTarball({ ...context, tarballUrl, signal })
    },
  }
}

// The explicitly selected first-publication reader. It is the only reader that may report a
// whole-package absence, and only after both trusted public endpoints answer with npm's own
// not-found bodies. Its standard observations are adapted to the publisher's internal
// absent/latest representation; nothing here fabricates a 200 response.
export function createFirstPublicationNpmReader(options = {}) {
  const context = createRegistryContext(options)
  const raw = {
    observeFirstPublicationPackage({ name, version, signal }) {
      assertPackageName(name)
      assertExactVersion(version)
      return observeFirstPublicationPackage({ ...context, name, version, signal })
    },
    downloadRegistryTarball({ tarballUrl, signal }) {
      return downloadRegistryTarball({ ...context, tarballUrl, signal })
    },
  }
  return { ...adaptFirstPublicationNpmReader(raw), ...raw }
}

// First publication needs absence for the candidate's own package family, but
// every other observation - above all the repository's already published
// history - must keep the default fail-closed reading. This composes the two:
// the default reader answers everything, and only a not-found on a package in
// the current family is re-read through the dedicated first-publication reader.
export function createFirstPublicationAwareNpmReader({ eligiblePackages = [], ...options } = {}) {
  const standard = createNpmReader(options)
  const first = createFirstPublicationNpmReader(options)
  // The caller supplies the package family eligible for first publication. With
  // none supplied this reader is exactly the default reader, so the widened
  // reading can never be reached by accident.
  const eligible = new Set(eligiblePackages)
  const observe = (method) => async (input) => {
    const observed = await standard[method](input)
    if (
      observed?.status !== "AMBIGUOUS" ||
      observed.httpStatus !== 404 ||
      !eligible.has(input?.name)
    ) {
      return observed
    }
    return first[method](input)
  }
  return {
    ...standard,
    observePackageMetadata: observe("observePackageMetadata"),
    observePackageVersion: observe("observePackageVersion"),
  }
}

export function adaptFirstPublicationNpmReader(reader) {
  for (const method of ["observeFirstPublicationPackage", "downloadRegistryTarball"]) {
    if (typeof reader?.[method] !== "function") {
      throw new TypeError(`first-publication npm reader must expose ${method}`)
    }
  }
  const observe = ({ name, version, signal }, operation) => {
    assertPackageName(name)
    assertExactVersion(version)
    return (async () => {
      const observed = await reader.observeFirstPublicationPackage({
        name,
        version,
        ...(signal === undefined ? {} : { signal }),
      })
      return adaptFirstPublicationObservation(observed, { name, version, operation })
    })()
  }
  return {
    observePackageMetadata(input) {
      return observe(input, "package-metadata")
    },
    observePackageVersion(input) {
      return observe(input, "package-version")
    },
    downloadRegistryTarball(input) {
      return reader.downloadRegistryTarball(input)
    },
  }
}

function adaptFirstPublicationObservation(observed, { name, version, operation }) {
  if (
    observed === null ||
    typeof observed !== "object" ||
    observed.operation !== FIRST_PUBLICATION_OPERATION
  ) {
    return failure("ERROR", operation, null, "MALFORMED_ENVELOPE")
  }
  if (observed.status === "ABSENT") {
    return observed.httpStatus === 404 && observed.code === "E404"
      ? failure("ABSENT", operation, 404, "E404")
      : failure("ERROR", operation, null, "MALFORMED_ENVELOPE")
  }
  if (observed.status !== "PRESENT") {
    return failure(
      observed.status === "AMBIGUOUS" ? "AMBIGUOUS" : "ERROR",
      operation,
      Number.isInteger(observed.httpStatus) ? observed.httpStatus : null,
      safeRegistryCode(observed.code) ?? "MALFORMED_ENVELOPE",
    )
  }
  const pkg = observed.package
  if (
    !isObject(pkg) ||
    pkg.name !== name ||
    !Array.isArray(pkg.versions) ||
    !(pkg.latest === null || isExactSemver(pkg.latest))
  ) {
    return failure("ERROR", operation, observed.httpStatus, "MALFORMED_SCHEMA")
  }
  // First publication admits exactly one prior state per name: the candidate version alone.
  if (pkg.versions.length !== 1 || pkg.versions[0] !== version || !isObject(pkg.candidate)) {
    return failure("AMBIGUOUS", operation, observed.httpStatus, "FIRST_PUBLICATION_FOREIGN_VERSION")
  }
  if (pkg.candidate.name !== name || pkg.candidate.version !== version) {
    return failure("ERROR", operation, observed.httpStatus, "MALFORMED_SCHEMA")
  }
  if (operation === "package-metadata") {
    return {
      status: "PRESENT",
      operation,
      httpStatus: observed.httpStatus,
      code: null,
      metadata: { name, latest: pkg.latest },
    }
  }
  return {
    status: "PRESENT",
    operation,
    httpStatus: observed.httpStatus,
    code: null,
    package: pkg.candidate,
  }
}

async function observeFirstPublicationPackage({ registry, http, name, version, signal }) {
  const encodedName = encodeURIComponent(name)
  const packumentResponse = await http.getJson({
    url: new URL(encodedName, registry),
    headers: { Accept: "application/vnd.npm.install-v1+json" },
    ...(signal === undefined ? {} : { signal }),
  })
  const packument = classifyFirstPublicationResponse(packumentResponse)
  if (packument.status === "not-found") {
    const versionResponse = await http.getJson({
      url: new URL(`${encodedName}/${encodeURIComponent(version)}`, registry),
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    })
    const exact = classifyFirstPublicationResponse(versionResponse)
    if (exact.status === "not-found") {
      return failure("ABSENT", FIRST_PUBLICATION_OPERATION, 404, "E404")
    }
    if (exact.status === "failure" && exact.envelope.httpStatus !== 404) return exact.envelope
    // A present version document, or a 404 whose body is not npm's whole-package not-found
    // (for example "version not found: <version>"), contradicts the packument-level absence.
    return failure("AMBIGUOUS", FIRST_PUBLICATION_OPERATION, 404, "REGISTRY_ABSENCE_CONFLICT")
  }
  if (packument.status === "failure") return packument.envelope

  const document = normalizePackument(packumentResponse.body, name)
  const versions = normalizePackumentVersions(document?.versions, name)
  const distTags = document === null ? null : normalizeDistTags(document["dist-tags"])
  if (versions === null || distTags === null) {
    return failure(
      "ERROR",
      FIRST_PUBLICATION_OPERATION,
      packumentResponse.httpStatus,
      "MALFORMED_SCHEMA",
    )
  }
  // Exact candidate evidence is only meaningful for the one admissible prior state: the
  // candidate version alone. Foreign version sets are reported without extra registry reads.
  let candidate = null
  if (versions.size === 1 && versions.has(version)) {
    const exact = await observePackageVersion({ registry, http, name, version, signal })
    if (exact.status !== "PRESENT") {
      return failure(exact.status, FIRST_PUBLICATION_OPERATION, exact.httpStatus, exact.code)
    }
    candidate = exact.package
  }
  return {
    status: "PRESENT",
    operation: FIRST_PUBLICATION_OPERATION,
    httpStatus: packumentResponse.httpStatus,
    code: null,
    package: {
      name,
      versions: [...versions].sort(compareStrings),
      latest: distTags.latest ?? null,
      candidate,
    },
  }
}

function classifyFirstPublicationResponse(response) {
  if (response.status !== "OK" && response.status !== "HTTP_ERROR") {
    return {
      status: "failure",
      envelope: failure(
        transportFailureStatus(response),
        FIRST_PUBLICATION_OPERATION,
        response.httpStatus,
        response.code,
      ),
    }
  }
  if (response.httpStatus >= 200 && response.httpStatus < 300) return { status: "present" }
  if (response.httpStatus === 404 && isRegistryNotFoundBody(response.body)) {
    return { status: "not-found" }
  }
  return {
    status: "failure",
    envelope: failure(
      "AMBIGUOUS",
      FIRST_PUBLICATION_OPERATION,
      response.httpStatus,
      safeRegistryCode(response.body?.code) ?? `HTTP_${response.httpStatus}`,
    ),
  }
}

function isRegistryNotFoundBody(body) {
  if (typeof body === "string") return REGISTRY_NOT_FOUND_TEXT.test(body)
  return (
    isObject(body) &&
    Object.keys(body).length === 1 &&
    typeof body.error === "string" &&
    REGISTRY_NOT_FOUND_TEXT.test(body.error)
  )
}

function createRegistryContext({
  registryUrl = "https://registry.npmjs.org",
  fetchImpl = fetch,
  timeoutMs,
  maxResponseBytes,
  trustedRegistryOrigins,
} = {}) {
  assertInputByteLength(registryUrl, MAX_REGISTRY_URL_BYTES, "npm registry URL")
  const registry = normalizeRegistryUrl(registryUrl)
  const trustedOrigins = normalizeTrustedRegistryOrigins(trustedRegistryOrigins)
  if (!trustedOrigins.has(registry.origin)) {
    throw npmInputError("npm registry origin is not trusted", "UNTRUSTED_REGISTRY_ORIGIN")
  }
  const http = createHttpGet({
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    maxResponseBytes: maxResponseBytes ?? RELEASE_PAYLOAD_LIMITS.tarballBytes,
  })
  return { registry, http }
}

function assertExactVersion(version) {
  assertInputByteLength(version, MAX_VERSION_BYTES, "exact SemVer")
  if (!isExactSemver(version)) {
    throw new TypeError("Invalid exact SemVer")
  }
}

async function downloadRegistryTarball({ registry, http, tarballUrl, signal }) {
  assertInputByteLength(tarballUrl, MAX_REGISTRY_URL_BYTES, "npm registry tarball URL")
  const url = sameOriginUrl(tarballUrl, registry)
  if (url === null) {
    throw npmInputError("npm registry tarball URL must be exact and same-origin", "UNSAFE_URL")
  }
  const response = await http.getBinary({
    url,
    headers: { Accept: "application/octet-stream" },
    ...(signal === undefined ? {} : { signal }),
  })
  if (response.status !== "OK" && response.status !== "HTTP_ERROR") {
    return failure(
      transportFailureStatus(response),
      "package-tarball",
      response.httpStatus,
      response.code,
    )
  }
  const classification = classifyRegistryResponse({
    operation: "package-tarball",
    response: { status: response.httpStatus },
  })
  if (classification.status !== "PRESENT") return classification
  if (
    !Number.isSafeInteger(response.bodyBytes) ||
    response.bodyBytes < 1 ||
    response.bodyBytes > RELEASE_PAYLOAD_LIMITS.tarballBytes ||
    typeof response.contentBase64 !== "string"
  ) {
    return failure("ERROR", "package-tarball", response.httpStatus, "MALFORMED_SCHEMA")
  }
  const bytes = Buffer.from(response.contentBase64, "base64")
  if (bytes.length !== response.bodyBytes || bytes.toString("base64") !== response.contentBase64) {
    return failure("ERROR", "package-tarball", response.httpStatus, "MALFORMED_SCHEMA")
  }
  return {
    status: "PRESENT",
    operation: "package-tarball",
    httpStatus: response.httpStatus,
    code: null,
    tarball: {
      url,
      size: bytes.length,
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
      contentBase64: response.contentBase64,
    },
  }
}

async function observePackageMetadata({ registry, http, name, signal }) {
  const result = await getJson({
    http,
    url: new URL(encodeURIComponent(name), registry),
    operation: "package-metadata",
    accept: "application/vnd.npm.install-v1+json",
    signal,
  })
  if (result.status !== "PRESENT") return withoutBody(result)
  const packument = normalizePackument(result.body, name)
  if (packument === null) {
    return failure("ERROR", "package-metadata", result.httpStatus, "MALFORMED_SCHEMA")
  }
  const distTags = normalizeDistTags(packument["dist-tags"])
  if (distTags === null) {
    return failure("ERROR", "package-metadata", result.httpStatus, "MALFORMED_SCHEMA")
  }
  return {
    status: "PRESENT",
    operation: "package-metadata",
    httpStatus: result.httpStatus,
    code: null,
    metadata: { name, latest: distTags.latest ?? null },
  }
}

export function classifyRegistryResponse({ operation, response, body }) {
  if (!OPERATIONS.has(operation)) {
    throw new TypeError("Unknown npm registry operation")
  }
  const httpStatus = response?.status
  if (!Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) {
    return failure("ERROR", operation, null, "MALFORMED_RESPONSE")
  }
  if (httpStatus >= 200 && httpStatus < 300) {
    return failure("PRESENT", operation, httpStatus, null)
  }

  const registryCode = safeRegistryCode(body?.code) ?? `HTTP_${httpStatus}`
  if (operation === "package-version" && httpStatus === 404 && registryCode === "E404") {
    return failure("ABSENT", operation, httpStatus, registryCode)
  }
  return failure("AMBIGUOUS", operation, httpStatus, registryCode)
}

async function observePackageVersion({ registry, http, name, version, signal }) {
  const encodedName = encodeURIComponent(name)
  const encodedVersion = encodeURIComponent(version)
  const versionResult = await getJson({
    http,
    url: new URL(`${encodedName}/${encodedVersion}`, registry),
    operation: "package-version",
    accept: "application/json",
    signal,
  })
  if (versionResult.status !== "PRESENT") {
    if (versionResult.httpStatus === 404) {
      return confirmPackageVersionAbsent({ registry, http, name, version, signal })
    }
    return versionResult
  }

  const versionDocument = normalizeVersionDocument(versionResult.body, {
    registry,
    name,
    version,
  })
  if (versionDocument === null) {
    return failure("ERROR", "package-version", versionResult.httpStatus, "MALFORMED_SCHEMA")
  }
  if (versionDocument.unsafeUrl === true) {
    return failure("ERROR", "package-version", versionResult.httpStatus, "UNSAFE_REGISTRY_URL")
  }

  const metadataResult = await getJson({
    http,
    url: new URL(encodedName, registry),
    operation: "package-metadata",
    accept: "application/vnd.npm.install-v1+json",
    signal,
  })
  if (metadataResult.status !== "PRESENT") {
    return withoutBody(metadataResult)
  }
  const packument = normalizePackument(metadataResult.body, name)
  if (packument === null) {
    return failure("ERROR", "package-metadata", metadataResult.httpStatus, "MALFORMED_SCHEMA")
  }
  const distTags = normalizeDistTags(packument["dist-tags"])
  if (distTags === null) {
    return failure("ERROR", "package-metadata", metadataResult.httpStatus, "MALFORMED_SCHEMA")
  }

  return {
    status: "PRESENT",
    operation: "package-version",
    httpStatus: versionResult.httpStatus,
    code: null,
    package: {
      name,
      version,
      tarballUrl: versionDocument.tarballUrl,
      shasum: versionDocument.shasum,
      integrity: versionDocument.integrity,
      distTags,
      latest: distTags.latest ?? null,
    },
  }
}

async function confirmPackageVersionAbsent({ registry, http, name, version, signal }) {
  const metadataResult = await getJson({
    http,
    url: new URL(encodeURIComponent(name), registry),
    operation: "package-metadata",
    accept: "application/vnd.npm.install-v1+json",
    signal,
  })
  if (metadataResult.status !== "PRESENT") {
    return failure(
      metadataResult.status,
      "package-version",
      metadataResult.httpStatus,
      metadataResult.code,
    )
  }
  const packument = normalizePackument(metadataResult.body, name)
  const versions = normalizePackumentVersions(packument?.versions, name)
  if (versions === null) {
    return failure("ERROR", "package-version", metadataResult.httpStatus, "MALFORMED_SCHEMA")
  }
  if (versions.has(version)) {
    return failure("AMBIGUOUS", "package-version", 404, "REGISTRY_VERSION_CONFLICT")
  }
  return failure("ABSENT", "package-version", 404, "E404")
}

async function getJson({ http, url, operation, accept, signal }) {
  const response = await http.getJson({
    url,
    headers: { Accept: accept },
    ...(signal === undefined ? {} : { signal }),
  })
  if (response.status !== "OK" && response.status !== "HTTP_ERROR") {
    return failure(transportFailureStatus(response), operation, response.httpStatus, response.code)
  }

  const httpClassification = classifyRegistryResponse({
    operation,
    response: { status: response.httpStatus },
    body: response.body,
  })
  if (httpClassification.status !== "PRESENT") {
    return httpClassification
  }
  return { ...httpClassification, body: response.body }
}

function normalizeVersionDocument(value, { registry, name, version }) {
  if (
    !isObject(value) ||
    value.name !== name ||
    value.version !== version ||
    !isObject(value.dist)
  ) {
    return null
  }
  const { tarball, shasum, integrity } = value.dist
  const tarballUrl = sameOriginUrl(tarball, registry)
  if (tarballUrl === null) {
    return { unsafeUrl: true }
  }
  if (
    typeof shasum !== "string" ||
    !SHA_PATTERN.test(shasum) ||
    canonicalIntegritySha512(integrity) === null
  ) {
    return null
  }
  return { tarballUrl, shasum, integrity }
}

function normalizeDistTags(value) {
  if (!isObject(value)) {
    return null
  }
  const entries = []
  for (const [tag, version] of Object.entries(value)) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(tag) || !isExactSemver(version)) {
      return null
    }
    entries.push([tag, version])
  }
  return Object.fromEntries(entries.sort(([left], [right]) => compareStrings(left, right)))
}

function normalizePackument(value, expectedName) {
  let snapshot
  try {
    snapshot = snapshotJson(value)
  } catch {
    return null
  }
  if (!isObject(snapshot)) return null
  const name = Object.getOwnPropertyDescriptor(snapshot, "name")
  return name?.enumerable === true && "value" in name && name.value === expectedName
    ? snapshot
    : null
}

function normalizePackumentVersions(value, expectedName) {
  if (!isObject(value)) return null
  const versions = new Set()
  for (const [version, document] of Object.entries(value)) {
    if (
      !isExactSemver(version) ||
      !isObject(document) ||
      document.name !== expectedName ||
      document.version !== version
    ) {
      return null
    }
    versions.add(version)
  }
  return versions
}

function normalizeRegistryUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new TypeError("Invalid npm registry URL")
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Invalid npm registry URL")
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`
  return url
}

function sameOriginUrl(value, registry) {
  if (typeof value !== "string") {
    return null
  }
  try {
    const url = new URL(value)
    return url.origin === registry.origin &&
      ["http:", "https:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
      ? url.href
      : null
  } catch {
    return null
  }
}

function canonicalIntegritySha512(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value)) {
    return null
  }
  const encoded = value.slice("sha512-".length)
  const bytes = Buffer.from(encoded, "base64")
  return bytes.length === 64 && bytes.toString("base64") === encoded ? bytes : null
}

function assertPackageName(value) {
  assertInputByteLength(value, MAX_PACKAGE_NAME_BYTES, "npm package name")
  if (typeof value !== "string" || !PACKAGE_NAME_PATTERN.test(value)) {
    throw new TypeError("Invalid npm package name")
  }
}

function normalizeTrustedRegistryOrigins(value) {
  if (value === undefined) {
    return new Set([DEFAULT_REGISTRY_ORIGIN])
  }
  if (!Array.isArray(value)) {
    throw new TypeError("Invalid trusted npm registry origins")
  }
  const origins = new Set([DEFAULT_REGISTRY_ORIGIN])
  for (const origin of value) {
    assertInputByteLength(origin, MAX_REGISTRY_URL_BYTES, "trusted npm registry origin")
    let url
    try {
      url = new URL(origin)
    } catch {
      throw new TypeError("Invalid trusted npm registry origin")
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    if (
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
      url.username !== "" ||
      url.password !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.origin !== origin
    ) {
      throw new TypeError("Invalid trusted npm registry origin")
    }
    origins.add(origin)
  }
  return origins
}

function assertInputByteLength(value, maximum, label) {
  if (typeof value === "string" && Buffer.byteLength(value, "utf8") > maximum) {
    throw npmInputError(`${label} exceeds byte limit`, "INPUT_TOO_LONG")
  }
}

function npmInputError(message, code) {
  const error = new TypeError(message)
  error.code = code
  return error
}

function safeRegistryCode(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9_-]{0,63}$/u.test(value) ? value : null
}

function failure(status, operation, httpStatus, code) {
  return { status, operation, httpStatus, code }
}

function transportFailureStatus(result) {
  if (result.code === "MALFORMED_RESPONSE") {
    return "ERROR"
  }
  if (["ABORTED", "NETWORK_ERROR", "TIMEOUT"].includes(result.code)) {
    return "AMBIGUOUS"
  }
  if (
    result.code !== "REDIRECT" &&
    result.httpStatus !== null &&
    (result.httpStatus < 200 || result.httpStatus >= 300)
  ) {
    return "AMBIGUOUS"
  }
  return "ERROR"
}

function withoutBody(result) {
  return failure(result.status, result.operation, result.httpStatus, result.code)
}

function isObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object"
}

function compareStrings(left, right) {
  return left === right ? 0 : left < right ? -1 : 1
}

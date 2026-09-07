import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  adaptFirstPublicationNpmReader,
  classifyRegistryResponse,
  createFirstPublicationNpmReader,
  createNpmReader,
} from "../adapters/npm.mjs"

const NAME = "@b4run/sdk"
const VERSION = "0.8.21"
const REGISTRY = "https://registry.npmjs.org"
const INTEGRITY = `sha512-${"A".repeat(86)}==`

test("createNpmReader exposes only bounded metadata and tarball reads without interpreting trust evidence", async () => {
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse(versionDocument()),
    jsonResponse({ name: NAME, "dist-tags": { next: "0.9.0-beta.1", latest: VERSION } }),
  ])
  const npm = createNpmReader({ fetchImpl })

  assert.deepEqual(Object.keys(npm), [
    "observePackageMetadata",
    "observePackageVersion",
    "downloadRegistryTarball",
  ])
  const result = await npm.observePackageVersion({ name: NAME, version: VERSION })

  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      redirect: init.redirect,
      accept: init.headers.Accept,
    })),
    [
      {
        url: `${REGISTRY}/%40b4run%2Fsdk/0.8.21`,
        method: "GET",
        redirect: "manual",
        accept: "application/json",
      },
      {
        url: `${REGISTRY}/%40b4run%2Fsdk`,
        method: "GET",
        redirect: "manual",
        accept: "application/vnd.npm.install-v1+json",
      },
    ],
  )
  assert.deepEqual(result, {
    status: "PRESENT",
    operation: "package-version",
    httpStatus: 200,
    code: null,
    package: {
      name: NAME,
      version: VERSION,
      tarballUrl: `${REGISTRY}/@b4run/sdk/-/sdk-${VERSION}.tgz`,
      shasum: "a".repeat(40),
      integrity: INTEGRITY,
      distTags: { latest: VERSION, next: "0.9.0-beta.1" },
      latest: VERSION,
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test("downloads an exact same-origin registry tarball with bounded canonical bytes and digests", async () => {
  const bytes = Buffer.from("exact registry tarball bytes")
  const tarballUrl = `${REGISTRY}/@b4run/sdk/-/sdk-${VERSION}.tgz`
  const { fetchImpl, calls } = recordingFetch([
    new Response(bytes, { headers: { "content-type": "application/octet-stream" } }),
  ])

  const result = await createNpmReader({ fetchImpl }).downloadRegistryTarball({ tarballUrl })

  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      redirect: init.redirect,
      accept: init.headers.Accept,
    })),
    [
      {
        url: tarballUrl,
        method: "GET",
        redirect: "manual",
        accept: "application/octet-stream",
      },
    ],
  )
  assert.deepEqual(result, {
    status: "PRESENT",
    operation: "package-tarball",
    httpStatus: 200,
    code: null,
    tarball: {
      url: tarballUrl,
      size: bytes.length,
      sha1: createHash("sha1").update(bytes).digest("hex"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha512: createHash("sha512").update(bytes).digest("hex"),
      contentBase64: bytes.toString("base64"),
    },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)
})

test("registry tarball auth, redirect, oversized, malformed, and cross-origin results are never absence", async () => {
  const tarballUrl = `${REGISTRY}/@b4run/sdk/-/sdk-${VERSION}.tgz`
  const responses = [
    new Response("denied", {
      status: 401,
      headers: { "content-type": "application/octet-stream" },
    }),
    new Response(null, {
      status: 302,
      headers: {
        "content-type": "application/octet-stream",
        location: "https://cdn.example.test/package.tgz",
      },
    }),
    new Response(Buffer.alloc(6), {
      headers: { "content-length": "6", "content-type": "application/octet-stream" },
    }),
    responseLike({
      status: 200,
      ok: true,
      body: "bytes",
      headers: { "content-type": "text/plain" },
    }),
  ]
  for (let index = 0; index < responses.length; index += 1) {
    const npm = createNpmReader({
      fetchImpl: async () => responses[index],
      ...(index === 2 ? { maxResponseBytes: 5 } : {}),
    })
    const result = await npm.downloadRegistryTarball({ tarballUrl })
    assert.notEqual(result.status, "ABSENT")
    assert.equal(result.operation, "package-tarball")
  }

  let fetches = 0
  const npm = createNpmReader({
    fetchImpl: async () => {
      fetches += 1
      throw new Error("must not fetch")
    },
  })
  await assert.rejects(
    npm.downloadRegistryTarball({
      tarballUrl: `https://registry.example.test/sdk-${VERSION}.tgz`,
    }),
    /registry tarball URL|same-origin|unsafe/iu,
  )
  assert.equal(fetches, 0)
})

test("observePackageMetadata reads only bounded public dist-tags independently", async () => {
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse({ name: NAME, "dist-tags": { next: "0.9.0-beta.1", latest: "0.8.22" } }),
  ])
  const result = await createNpmReader({ fetchImpl }).observePackageMetadata({ name: NAME })
  assert.deepEqual(
    calls.map(({ url, init }) => ({ url, method: init.method, accept: init.headers.Accept })),
    [
      {
        url: `${REGISTRY}/%40b4run%2Fsdk`,
        method: "GET",
        accept: "application/vnd.npm.install-v1+json",
      },
    ],
  )
  assert.deepEqual(result, {
    status: "PRESENT",
    operation: "package-metadata",
    httpStatus: 200,
    code: null,
    metadata: { name: NAME, latest: "0.8.22" },
  })
})

test("npm packuments require an exact own package name before retaining dist-tags", async (t) => {
  const cases = [
    ["missing", { "dist-tags": { latest: VERSION } }],
    ["wrong", { name: "npm_secret-package-name", "dist-tags": { latest: VERSION } }],
    ["number", { name: 7, "dist-tags": { latest: VERSION } }],
    ["object", { name: { value: NAME }, "dist-tags": { latest: VERSION } }],
    ["array", { name: [NAME], "dist-tags": { latest: VERSION } }],
    ["null", { name: null, "dist-tags": { latest: VERSION } }],
  ]
  for (const [label, packument] of cases) {
    await t.test(label, async () => {
      const metadata = await createNpmReader({
        fetchImpl: async () => jsonResponse(packument),
      }).observePackageMetadata({ name: NAME })
      assert.deepEqual(metadata, {
        status: "ERROR",
        operation: "package-metadata",
        httpStatus: 200,
        code: "MALFORMED_SCHEMA",
      })
      assert.doesNotMatch(JSON.stringify(metadata), /latest|distTags|npm_secret/u)

      const recording = recordingFetch([jsonResponse(versionDocument()), jsonResponse(packument)])
      const version = await createNpmReader({
        fetchImpl: recording.fetchImpl,
      }).observePackageVersion({ name: NAME, version: VERSION })
      assert.deepEqual(version, {
        status: "ERROR",
        operation: "package-metadata",
        httpStatus: 200,
        code: "MALFORMED_SCHEMA",
      })
      assert.equal(recording.calls.length, 2)
      assert.doesNotMatch(JSON.stringify(version), /latest|distTags|npm_secret/u)
    })
  }

  const inheritedName = await createNpmReader({
    fetchImpl: async () =>
      rawJsonResponse(`{"__proto__":{"name":"${NAME}"},"dist-tags":{"latest":"${VERSION}"}}`),
  }).observePackageMetadata({ name: NAME })
  assert.deepEqual(inheritedName, {
    status: "ERROR",
    operation: "package-metadata",
    httpStatus: 200,
    code: "MALFORMED_SCHEMA",
  })
})

test("observePackageMetadata never classifies package-level 404 as exact-version absence", async () => {
  const result = await createNpmReader({
    fetchImpl: async () => jsonResponse({ code: "E404" }, 404),
  }).observePackageMetadata({ name: NAME })
  assert.deepEqual(result, {
    status: "AMBIGUOUS",
    operation: "package-metadata",
    httpStatus: 404,
    code: "E404",
  })
})

test("confirms npm's string-body exact-version 404 against the structured packument", async () => {
  const previousVersion = "0.8.20"
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse(`version not found: ${VERSION}`, 404),
    jsonResponse({
      name: NAME,
      "dist-tags": { latest: previousVersion },
      versions: {
        [previousVersion]: { name: NAME, version: previousVersion },
      },
    }),
  ])

  const result = await createNpmReader({ fetchImpl }).observePackageVersion({
    name: NAME,
    version: VERSION,
  })

  assert.deepEqual(
    calls.map(({ url, init }) => ({ url, accept: init.headers.Accept })),
    [
      { url: `${REGISTRY}/%40b4run%2Fsdk/0.8.21`, accept: "application/json" },
      {
        url: `${REGISTRY}/%40b4run%2Fsdk`,
        accept: "application/vnd.npm.install-v1+json",
      },
    ],
  )
  assert.deepEqual(result, {
    status: "ABSENT",
    operation: "package-version",
    httpStatus: 404,
    code: "E404",
  })
})

test("keeps exact-version 404 ambiguous when package metadata is also unavailable", async () => {
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse(`version not found: ${VERSION}`, 404),
    jsonResponse({ code: "E404" }, 404),
  ])

  const result = await createNpmReader({ fetchImpl }).observePackageVersion({
    name: NAME,
    version: VERSION,
  })

  assert.equal(calls.length, 2)
  assert.deepEqual(result, {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: 404,
    code: "E404",
  })
})

test("rejects a malformed packument used to confirm exact-version absence", async () => {
  const previousVersion = "0.8.20"
  const { fetchImpl } = recordingFetch([
    jsonResponse(`version not found: ${VERSION}`, 404),
    jsonResponse({
      name: NAME,
      "dist-tags": { latest: previousVersion },
      versions: {
        [previousVersion]: { name: "@b4run/wrong", version: previousVersion },
      },
    }),
  ])

  const result = await createNpmReader({ fetchImpl }).observePackageVersion({
    name: NAME,
    version: VERSION,
  })

  assert.deepEqual(result, {
    status: "ERROR",
    operation: "package-version",
    httpStatus: 200,
    code: "MALFORMED_SCHEMA",
  })
})

test("blocks when the exact-version 404 conflicts with the package version map", async () => {
  const { fetchImpl } = recordingFetch([
    jsonResponse(`version not found: ${VERSION}`, 404),
    jsonResponse({
      name: NAME,
      "dist-tags": { latest: VERSION },
      versions: {
        [VERSION]: { name: NAME, version: VERSION },
      },
    }),
  ])

  const result = await createNpmReader({ fetchImpl }).observePackageVersion({
    name: NAME,
    version: VERSION,
  })

  assert.deepEqual(result, {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: 404,
    code: "REGISTRY_VERSION_CONFLICT",
  })
})

test("classifyRegistryResponse treats only exact-version E404 as absence", () => {
  const rows = [
    {
      name: "exact version E404",
      operation: "package-version",
      response: responseMeta(404),
      body: { code: "E404" },
      status: "ABSENT",
      code: "E404",
    },
    {
      name: "package metadata E404",
      operation: "package-metadata",
      response: responseMeta(404),
      body: { code: "E404" },
      status: "AMBIGUOUS",
      code: "E404",
    },
    ...[401, 403, 408, 429, 500, 503].map((httpStatus) => ({
      name: `HTTP ${httpStatus}`,
      operation: "package-version",
      response: responseMeta(httpStatus),
      body: { code: `E${httpStatus}`, error: "secret-bearing registry detail" },
      status: "AMBIGUOUS",
      code: `E${httpStatus}`,
    })),
  ]

  for (const row of rows) {
    assert.deepEqual(
      classifyRegistryResponse(row),
      {
        status: row.status,
        operation: row.operation,
        httpStatus: row.response.status,
        code: row.code,
      },
      row.name,
    )
  }

  assert.deepEqual(
    classifyRegistryResponse({
      operation: "package-version",
      response: { status: 404, ok: true },
      body: { code: "E404" },
    }),
    {
      status: "ABSENT",
      operation: "package-version",
      httpStatus: 404,
      code: "E404",
    },
  )
  assert.equal(
    classifyRegistryResponse({
      operation: "package-version",
      response: { status: 200, ok: false },
      body: {},
    }).status,
    "PRESENT",
  )
})

test("npm network, timeout, parse, content-type, and schema failures never become absence", async () => {
  const cases = [
    {
      name: "abort",
      fetchImpl: async () => {
        throw new DOMException("token=npm_secret", "AbortError")
      },
      code: "ABORTED",
      status: "AMBIGUOUS",
    },
    {
      name: "network",
      fetchImpl: async () => {
        throw new Error("https://user:npm_secret@example.invalid")
      },
      code: "NETWORK_ERROR",
      status: "AMBIGUOUS",
    },
    {
      name: "malformed JSON",
      fetchImpl: async () => new Response("{", { headers: { "content-type": "application/json" } }),
      code: "MALFORMED_JSON",
      status: "ERROR",
      httpStatus: 200,
    },
    {
      name: "wrong content type",
      fetchImpl: async () => new Response("{}", { headers: { "content-type": "text/html" } }),
      code: "UNEXPECTED_CONTENT_TYPE",
      status: "ERROR",
      httpStatus: 200,
    },
    {
      name: "malformed schema",
      fetchImpl: async () => jsonResponse({ name: NAME, version: VERSION, dist: null }),
      code: "MALFORMED_SCHEMA",
      status: "ERROR",
      httpStatus: 200,
    },
  ]

  for (const row of cases) {
    const npm = createNpmReader({ fetchImpl: row.fetchImpl })
    const result = await npm.observePackageVersion({ name: NAME, version: VERSION })
    assert.deepEqual(result, {
      status: row.status,
      operation: "package-version",
      httpStatus: row.httpStatus ?? null,
      code: row.code,
    })
    assert.doesNotMatch(JSON.stringify(result), /npm_secret|authorization/iu)
  }
})

test("npm HTTP failures retain safe operation/status/code without registry error text", async () => {
  const npm = createNpmReader({
    fetchImpl: async () =>
      jsonResponse({ code: "E403", error: "token=npm_secret Authorization: bearer hidden" }, 403),
  })

  const result = await npm.observePackageVersion({ name: NAME, version: VERSION })

  assert.deepEqual(result, {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: 403,
    code: "E403",
  })
  assert.doesNotMatch(JSON.stringify(result), /npm_secret|authorization|bearer/iu)
})

test("npm refuses unsafe identities and registry URLs before fetching", () => {
  const npm = createNpmReader({ registryUrl: `${REGISTRY}/`, fetchImpl: assert.fail })
  for (const name of ["", "../sdk", "@b4run", "@b4run/sdk/extra", "b4 sdk", "--help"]) {
    assert.throws(() => npm.observePackageVersion({ name, version: VERSION }), /package name/u)
  }
  for (const version of ["", "v0.8.21", "latest", "0.8", "0.8.21 || 1.0.0"]) {
    assert.throws(() => npm.observePackageVersion({ name: NAME, version }), /exact SemVer/u)
  }
  for (const registryUrl of [
    "http://registry.npmjs.org",
    "https://user:secret@example.com",
    "not a url",
  ]) {
    assert.throws(() => createNpmReader({ registryUrl, fetchImpl: assert.fail }), /registry URL/u)
  }
})

test("npm rejects oversized inputs with a stable non-echoing code before parsing", () => {
  const npm = createNpmReader({ fetchImpl: assert.fail })
  for (const [name, version] of [
    [`@scope/${"a".repeat(300)}`, VERSION],
    [NAME, `1.0.0-${"a".repeat(300)}`],
  ]) {
    assert.throws(
      () => npm.observePackageVersion({ name, version }),
      (error) => error?.code === "INPUT_TOO_LONG" && !error.message.includes("a".repeat(100)),
    )
  }
  assert.throws(
    () => createNpmReader({ registryUrl: `https://${"a".repeat(2_100)}.test` }),
    (error) => error?.code === "INPUT_TOO_LONG" && !error.message.includes("a".repeat(100)),
  )
})

test("npm validation errors never echo control characters", () => {
  const npm = createNpmReader({ fetchImpl: assert.fail })
  for (const invoke of [
    () => npm.observePackageVersion({ name: "sdk\nforged", version: VERSION }),
    () => npm.observePackageVersion({ name: NAME, version: "1.0.0\rforged" }),
  ]) {
    assert.throws(invoke, errorWithoutControls)
  }
})

test("npm requires an explicit exact trust grant for non-default registry origins", () => {
  assert.throws(
    () => createNpmReader({ registryUrl: "https://registry.example.test/npm/" }),
    (error) => error?.code === "UNTRUSTED_REGISTRY_ORIGIN",
  )
  assert.doesNotThrow(() =>
    createNpmReader({
      registryUrl: "https://registry.example.test/npm/",
      trustedRegistryOrigins: ["https://registry.example.test"],
      fetchImpl: assert.fail,
    }),
  )
  assert.doesNotThrow(() =>
    createNpmReader({
      registryUrl: "http://[::1]:4873/",
      trustedRegistryOrigins: ["http://[::1]:4873"],
      fetchImpl: assert.fail,
    }),
  )
  assert.throws(
    () =>
      createNpmReader({
        registryUrl: "https://registry.example.test/npm/",
        trustedRegistryOrigins: ["https://registry.example.test.evil.test"],
      }),
    (error) => error?.code === "UNTRUSTED_REGISTRY_ORIGIN",
  )
})

test("npm refuses malformed or cross-origin tarball URLs", async () => {
  for (const mutate of [
    (document) => {
      document.dist.tarball = "https://evil.example/sdk.tgz"
    },
    (document) => {
      document.dist.tarball = "not a URL"
    },
    (document) => {
      document.dist.tarball = "https://user:secret@registry.npmjs.org/sdk.tgz"
    },
  ]) {
    const document = versionDocument()
    mutate(document)
    const { fetchImpl, calls } = recordingFetch([jsonResponse(document)])
    const result = await createNpmReader({ fetchImpl }).observePackageVersion({
      name: NAME,
      version: VERSION,
    })

    assert.equal(result.status, "ERROR")
    assert.equal(result.code, "UNSAFE_REGISTRY_URL")
    assert.equal(calls.length, 1)
  }
})

test("npm binds custom-registry metadata and tarballs to the exact trusted origin", async () => {
  const customRegistry = "https://registry.example.test/npm/"
  const document = versionDocument()
  document.dist.tarball = `https://registry.example.test/@b4run/sdk/-/sdk-${VERSION}.tgz`
  const recording = recordingFetch([
    jsonResponse(document),
    jsonResponse({ name: NAME, "dist-tags": { latest: VERSION } }),
  ])

  const result = await createNpmReader({
    registryUrl: customRegistry,
    trustedRegistryOrigins: ["https://registry.example.test"],
    fetchImpl: recording.fetchImpl,
  }).observePackageVersion({ name: NAME, version: VERSION })

  assert.equal(result.status, "PRESENT")
  assert.equal(recording.calls.length, 2)
})

test("npm requires a canonical padded base64 encoding of exactly 64 integrity bytes", async () => {
  for (const integrity of [
    "sha512-A",
    "sha512-AA==",
    `sha512-${"A".repeat(86)}`,
    `sha512-${"A".repeat(85)}B==`,
  ]) {
    const document = versionDocument()
    document.dist.integrity = integrity
    const recording = recordingFetch([jsonResponse(document)])

    assert.deepEqual(
      await createNpmReader({ fetchImpl: recording.fetchImpl }).observePackageVersion({
        name: NAME,
        version: VERSION,
      }),
      {
        status: "ERROR",
        operation: "package-version",
        httpStatus: 200,
        code: "MALFORMED_SCHEMA",
      },
    )
    assert.equal(recording.calls.length, 1)
  }
})

test("npm applies bounded deadlines and response limits through the named observer", async () => {
  const timeout = createNpmReader({
    timeoutMs: 5,
    fetchImpl: async (_url, init) => {
      if (!(init.signal instanceof AbortSignal)) {
        throw new Error("missing bounded signal")
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(new DOMException("deadline", "AbortError")),
          { once: true },
        )
      })
    },
  })
  assert.deepEqual(await timeout.observePackageVersion({ name: NAME, version: VERSION }), {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: null,
    code: "TIMEOUT",
  })

  const oversized = createNpmReader({
    maxResponseBytes: 4,
    fetchImpl: async () => jsonResponse(versionDocument()),
  })
  assert.deepEqual(await oversized.observePackageVersion({ name: NAME, version: VERSION }), {
    status: "ERROR",
    operation: "package-version",
    httpStatus: 200,
    code: "RESPONSE_TOO_LARGE",
  })
})

test("npm rejects malformed injected status and does not trust response ok", async () => {
  for (const response of [
    responseLike({ status: 99, ok: true, body: "{}" }),
    responseLike({ status: 600, ok: true, body: "{}" }),
  ]) {
    const result = await createNpmReader({ fetchImpl: async () => response }).observePackageVersion(
      {
        name: NAME,
        version: VERSION,
      },
    )
    assert.equal(result.status, "ERROR")
    assert.equal(result.code, "MALFORMED_RESPONSE")
  }

  const previousVersion = "0.8.20"
  const concealedResponses = recordingFetch([
    responseLike({
      status: 404,
      ok: true,
      body: JSON.stringify({ code: "E404" }),
      headers: { "content-type": "application/json" },
    }),
    jsonResponse({
      name: NAME,
      "dist-tags": { latest: previousVersion },
      versions: { [previousVersion]: { name: NAME, version: previousVersion } },
    }),
  ])
  const concealed = createNpmReader({ fetchImpl: concealedResponses.fetchImpl })
  assert.equal(
    (await concealed.observePackageVersion({ name: NAME, version: VERSION })).status,
    "ABSENT",
  )
  assert.equal(concealedResponses.calls.length, 2)
})

// npm's actual public not-found bodies (captured 2026-09-07 with unauthenticated GETs):
// the packument endpoint answers 404 {"error":"Not found"} and the exact-version endpoint of an
// absent package answers 404 "Not Found"; an existing package's absent version answers
// 404 "version not found: <version>". Nothing here carries the CLI's E404 code.
const PACKUMENT_NOT_FOUND = { error: "Not found" }
const VERSION_NOT_FOUND = "Not Found"

test("default readers keep npm's real whole-package not-found bodies ambiguous", async () => {
  const version = await createNpmReader({
    fetchImpl: recordingFetch([
      jsonResponse(VERSION_NOT_FOUND, 404),
      jsonResponse(PACKUMENT_NOT_FOUND, 404),
    ]).fetchImpl,
  }).observePackageVersion({ name: NAME, version: VERSION })
  assert.deepEqual(version, {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: 404,
    code: "HTTP_404",
  })
  const metadata = await createNpmReader({
    fetchImpl: async () => jsonResponse(PACKUMENT_NOT_FOUND, 404),
  }).observePackageMetadata({ name: NAME })
  assert.deepEqual(metadata, {
    status: "AMBIGUOUS",
    operation: "package-metadata",
    httpStatus: 404,
    code: "HTTP_404",
  })
  assert.deepEqual(Object.keys(createNpmReader({ fetchImpl: async () => jsonResponse({}) })), [
    "observePackageMetadata",
    "observePackageVersion",
    "downloadRegistryTarball",
  ])
})

test("first-publication reader classifies whole-package absence only from both trusted not-found endpoints", async () => {
  const { fetchImpl, calls } = recordingFetch([
    jsonResponse(PACKUMENT_NOT_FOUND, 404),
    jsonResponse(VERSION_NOT_FOUND, 404),
  ])
  const npm = createFirstPublicationNpmReader({ fetchImpl })
  assert.deepEqual(Object.keys(npm), [
    "observePackageMetadata",
    "observePackageVersion",
    "downloadRegistryTarball",
    "observeFirstPublicationPackage",
  ])

  const result = await npm.observeFirstPublicationPackage({ name: NAME, version: VERSION })
  assert.deepEqual(
    calls.map(({ url, init }) => ({
      url,
      method: init.method,
      redirect: init.redirect,
      accept: init.headers.Accept,
      authorization: init.headers.Authorization ?? null,
    })),
    [
      {
        url: `${REGISTRY}/%40b4run%2Fsdk`,
        method: "GET",
        redirect: "manual",
        accept: "application/vnd.npm.install-v1+json",
        authorization: null,
      },
      {
        url: `${REGISTRY}/%40b4run%2Fsdk/0.8.21`,
        method: "GET",
        redirect: "manual",
        accept: "application/json",
        authorization: null,
      },
    ],
  )
  assert.deepEqual(result, {
    status: "ABSENT",
    operation: "first-publication-package",
    httpStatus: 404,
    code: "E404",
  })
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result)

  const unscoped = createFirstPublicationNpmReader({
    fetchImpl: recordingFetch([
      jsonResponse({ error: "not found" }, 404),
      jsonResponse("not found", 404),
    ]).fetchImpl,
  })
  assert.equal(
    (await unscoped.observeFirstPublicationPackage({ name: "create-b4-app", version: VERSION }))
      .status,
    "ABSENT",
  )
})

test("first-publication absence is adapted to the publisher's internal absent representation", async () => {
  const responses = () =>
    recordingFetch([jsonResponse(PACKUMENT_NOT_FOUND, 404), jsonResponse(VERSION_NOT_FOUND, 404)])
      .fetchImpl
  const npm = createFirstPublicationNpmReader({ fetchImpl: responses() })
  assert.deepEqual(await npm.observePackageVersion({ name: NAME, version: VERSION }), {
    status: "ABSENT",
    operation: "package-version",
    httpStatus: 404,
    code: "E404",
  })
  const metadataReader = createFirstPublicationNpmReader({ fetchImpl: responses() })
  assert.deepEqual(await metadataReader.observePackageMetadata({ name: NAME, version: VERSION }), {
    status: "ABSENT",
    operation: "package-metadata",
    httpStatus: 404,
    code: "E404",
  })
  assert.throws(
    () => metadataReader.observePackageMetadata({ name: NAME }),
    /exact SemVer|version/iu,
    "the adapted metadata read needs the candidate version to select the first-publication path",
  )

  const raw = {
    async observeFirstPublicationPackage() {
      return {
        status: "ABSENT",
        operation: "first-publication-package",
        httpStatus: 404,
        code: "E404",
      }
    },
    async downloadRegistryTarball() {
      throw new Error("no tarball")
    },
  }
  const adapted = adaptFirstPublicationNpmReader(raw)
  assert.deepEqual(Object.keys(adapted), [
    "observePackageMetadata",
    "observePackageVersion",
    "downloadRegistryTarball",
  ])
  assert.equal(
    (await adapted.observePackageVersion({ name: NAME, version: VERSION })).status,
    "ABSENT",
  )
  assert.throws(() => adaptFirstPublicationNpmReader({}), TypeError)
  assert.throws(
    () =>
      adaptFirstPublicationNpmReader(createNpmReader({ fetchImpl: async () => jsonResponse({}) })),
    TypeError,
  )
})

test("first-publication reader never treats proxy, auth, redirect, malformed, or conflicting 404s as absence", async () => {
  const cases = [
    ["CLI-style code body", [jsonResponse({ code: "E404" }, 404)], "E404"],
    ["empty object body", [jsonResponse({}, 404)], "HTTP_404"],
    ["other error body", [jsonResponse({ error: "Rate limited" }, 404)], "HTTP_404"],
    [
      "html proxy body",
      [new Response("<html>404</html>", { status: 404, headers: { "content-type": "text/html" } })],
      "UNEXPECTED_CONTENT_TYPE",
    ],
    ["malformed json body", [rawJsonResponse("{", 404)], "MALFORMED_JSON"],
    ["auth failure", [jsonResponse({ error: "unauthorized" }, 401)], "HTTP_401"],
    [
      "redirect",
      [new Response(null, { status: 302, headers: { location: "https://cdn.example.test/x" } })],
      "REDIRECT",
    ],
    ["server error", [jsonResponse({ error: "Not found" }, 503)], "HTTP_503"],
    [
      "version endpoint present",
      [jsonResponse(PACKUMENT_NOT_FOUND, 404), jsonResponse(versionDocument())],
      "REGISTRY_ABSENCE_CONFLICT",
    ],
    [
      "version endpoint knows the package",
      [jsonResponse(PACKUMENT_NOT_FOUND, 404), jsonResponse(`version not found: ${VERSION}`, 404)],
      "REGISTRY_ABSENCE_CONFLICT",
    ],
    [
      "version endpoint code body",
      [jsonResponse(PACKUMENT_NOT_FOUND, 404), jsonResponse({ code: "E404" }, 404)],
      "REGISTRY_ABSENCE_CONFLICT",
    ],
    [
      "version endpoint auth failure",
      [jsonResponse(PACKUMENT_NOT_FOUND, 404), jsonResponse({ error: "unauthorized" }, 401)],
      "HTTP_401",
    ],
    [
      "version endpoint network failure",
      [jsonResponse(PACKUMENT_NOT_FOUND, 404), new Error("socket hang up")],
      "NETWORK_ERROR",
    ],
    ["packument network failure", [new Error("socket hang up")], "NETWORK_ERROR"],
  ]
  for (const [name, responses, code] of cases) {
    const npm = createFirstPublicationNpmReader({
      async fetchImpl() {
        const next = responses.shift()
        if (next instanceof Error) throw next
        return next
      },
    })
    const result = await npm.observeFirstPublicationPackage({ name: NAME, version: VERSION })
    assert.notEqual(result.status, "ABSENT", name)
    assert.notEqual(result.status, "PRESENT", name)
    assert.equal(result.operation, "first-publication-package", name)
    assert.equal(result.code, code, name)
    assert.deepEqual(
      Object.keys(result).sort(),
      ["code", "httpStatus", "operation", "status"],
      name,
    )
  }

  const adapted = createFirstPublicationNpmReader({
    fetchImpl: async () => jsonResponse({ code: "E404" }, 404),
  })
  const version = await adapted.observePackageVersion({ name: NAME, version: VERSION })
  assert.deepEqual(version, {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: 404,
    code: "E404",
  })
  const metadata = await adapted.observePackageMetadata({ name: NAME, version: VERSION })
  assert.deepEqual(metadata, {
    status: "AMBIGUOUS",
    operation: "package-metadata",
    httpStatus: 404,
    code: "E404",
  })
})

test("first-publication reader exposes the complete version set and rejects unrelated versions", async () => {
  const foreign = createFirstPublicationNpmReader({
    fetchImpl: async () =>
      jsonResponse({
        name: NAME,
        "dist-tags": { latest: "0.8.20" },
        versions: { "0.8.20": { name: NAME, version: "0.8.20" } },
      }),
  })
  assert.deepEqual(await foreign.observeFirstPublicationPackage({ name: NAME, version: VERSION }), {
    status: "PRESENT",
    operation: "first-publication-package",
    httpStatus: 200,
    code: null,
    package: { name: NAME, versions: ["0.8.20"], latest: "0.8.20", candidate: null },
  })
  assert.deepEqual(await foreign.observePackageVersion({ name: NAME, version: VERSION }), {
    status: "AMBIGUOUS",
    operation: "package-version",
    httpStatus: 200,
    code: "FIRST_PUBLICATION_FOREIGN_VERSION",
  })
  assert.deepEqual(await foreign.observePackageMetadata({ name: NAME, version: VERSION }), {
    status: "AMBIGUOUS",
    operation: "package-metadata",
    httpStatus: 200,
    code: "FIRST_PUBLICATION_FOREIGN_VERSION",
  })

  const mixed = createFirstPublicationNpmReader({
    fetchImpl: async () =>
      jsonResponse({
        name: NAME,
        "dist-tags": { latest: VERSION },
        versions: {
          "0.8.20": { name: NAME, version: "0.8.20" },
          [VERSION]: { name: NAME, version: VERSION },
        },
      }),
  })
  assert.equal(
    (await mixed.observePackageVersion({ name: NAME, version: VERSION })).code,
    "FIRST_PUBLICATION_FOREIGN_VERSION",
  )

  const emptyShell = createFirstPublicationNpmReader({
    fetchImpl: async () => jsonResponse({ name: NAME, "dist-tags": {}, versions: {} }),
  })
  assert.deepEqual(
    await emptyShell.observeFirstPublicationPackage({ name: NAME, version: VERSION }),
    {
      status: "PRESENT",
      operation: "first-publication-package",
      httpStatus: 200,
      code: null,
      package: { name: NAME, versions: [], latest: null, candidate: null },
    },
  )
  assert.equal(
    (await emptyShell.observePackageVersion({ name: NAME, version: VERSION })).code,
    "FIRST_PUBLICATION_FOREIGN_VERSION",
  )

  const malformed = createFirstPublicationNpmReader({
    fetchImpl: async () =>
      jsonResponse({
        name: NAME,
        "dist-tags": {},
        versions: { [VERSION]: { name: "@b4run/other" } },
      }),
  })
  assert.equal(
    (await malformed.observeFirstPublicationPackage({ name: NAME, version: VERSION })).code,
    "MALFORMED_SCHEMA",
  )
})

test("first-publication reader returns exact candidate-version evidence identical to the default reader", async () => {
  const packument = {
    name: NAME,
    "dist-tags": { latest: VERSION },
    versions: { [VERSION]: { name: NAME, version: VERSION } },
  }
  const expected = await createNpmReader({
    fetchImpl: recordingFetch([jsonResponse(versionDocument()), jsonResponse(packument)]).fetchImpl,
  }).observePackageVersion({ name: NAME, version: VERSION })

  const { fetchImpl, calls } = recordingFetch([
    jsonResponse(packument),
    jsonResponse(versionDocument()),
    jsonResponse(packument),
  ])
  const npm = createFirstPublicationNpmReader({ fetchImpl })
  const observed = await npm.observeFirstPublicationPackage({ name: NAME, version: VERSION })
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      `${REGISTRY}/%40b4run%2Fsdk`,
      `${REGISTRY}/%40b4run%2Fsdk/0.8.21`,
      `${REGISTRY}/%40b4run%2Fsdk`,
    ],
  )
  assert.deepEqual(observed, {
    status: "PRESENT",
    operation: "first-publication-package",
    httpStatus: 200,
    code: null,
    package: { name: NAME, versions: [VERSION], latest: VERSION, candidate: expected.package },
  })

  const again = createFirstPublicationNpmReader({
    fetchImpl: recordingFetch([
      jsonResponse(packument),
      jsonResponse(versionDocument()),
      jsonResponse(packument),
    ]).fetchImpl,
  })
  assert.deepEqual(await again.observePackageVersion({ name: NAME, version: VERSION }), expected)
  const metadata = createFirstPublicationNpmReader({
    fetchImpl: recordingFetch([
      jsonResponse(packument),
      jsonResponse(versionDocument()),
      jsonResponse(packument),
    ]).fetchImpl,
  })
  assert.deepEqual(await metadata.observePackageMetadata({ name: NAME, version: VERSION }), {
    status: "PRESENT",
    operation: "package-metadata",
    httpStatus: 200,
    code: null,
    metadata: { name: NAME, latest: VERSION },
  })

  const unsafe = createFirstPublicationNpmReader({
    fetchImpl: recordingFetch([
      jsonResponse(packument),
      jsonResponse({
        ...versionDocument(),
        dist: { ...versionDocument().dist, tarball: "https://cdn.example.test/sdk.tgz" },
      }),
    ]).fetchImpl,
  })
  const unsafeResult = await unsafe.observeFirstPublicationPackage({ name: NAME, version: VERSION })
  assert.equal(unsafeResult.status, "ERROR")
  assert.equal(unsafeResult.code, "UNSAFE_REGISTRY_URL")
})

function versionDocument() {
  return {
    name: NAME,
    version: VERSION,
    dist: {
      tarball: `${REGISTRY}/@b4run/sdk/-/sdk-${VERSION}.tgz`,
      shasum: "a".repeat(40),
      integrity: INTEGRITY,
      signatures: [
        { keyid: "SHA256:key-b", sig: "signature-b" },
        { keyid: "SHA256:key-a", sig: "signature-a" },
      ],
      attestations: {
        url: `${REGISTRY}/-/npm/v1/attestations/@b4run%2fsdk@0.8.21`,
      },
    },
  }
}

function recordingFetch(responses) {
  const calls = []
  return {
    calls,
    async fetchImpl(url, init) {
      calls.push({ url: String(url), init })
      return responses.shift()
    },
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function rawJsonResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  })
}

function responseMeta(status) {
  return { status, ok: status >= 200 && status < 300 }
}

function responseLike({ status, ok, body, headers = { "content-type": "application/json" } }) {
  const bytes = new TextEncoder().encode(body)
  return {
    status,
    ok,
    headers: new Headers(headers),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    }),
  }
}

function errorWithoutControls(error) {
  return ![...(error?.message ?? "")].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint <= 31 || codePoint === 127
  })
}

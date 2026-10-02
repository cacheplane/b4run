import { createPublicKey, generateKeyPairSync, verify } from "node:crypto"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { createGitHubAdapter } from "../src/lib/delivery/github/adapter.ts"
import { loadAppPrivateKey } from "../src/lib/delivery/github/jwt.ts"
import { runKeyFile, writeRunKey } from "../src/lib/operator/up.ts"
import { createControllerRuntime } from "../src/lib/runtime.ts"
import { type FakeGitHubServer, startFakeGitHubServer } from "./fake-github-server.ts"
import { createFakeVerifier } from "./fake-verifier.ts"
import {
  BASELINE_TEXT,
  ISSUE,
  type IssueHarness,
  issueHarness,
  ORIGIN,
  PIN,
  SOURCE,
} from "./issue-work-order.ts"
import { staticImageRegistry } from "./static-images.ts"
import { TEST_WORKER_TOKEN } from "./worker-token-fixture.ts"

/**
 * A delivery through the REAL adapter, end to end: a generated key on disk, loaded the way the
 * controller loads it, a JWT that verifies against the public key, an installation token minted
 * by the fake GitHub over loopback, and the factory's approval landing `delivered`. Key material
 * is only ever asserted as booleans.
 */

const APP_ID = 7
const REPOSITORY = "cacheplane/b4run"
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
const PEM = pair.privateKey.export({ type: "pkcs1", format: "pem" }).toString()
const publicKey = createPublicKey(pair.privateKey)
const keyDir = mkdtempSync(join(tmpdir(), "e2e-key-"))
const keyPath = join(keyDir, "app.pem")
writeFileSync(keyPath, PEM, { mode: 0o600 })
chmodSync(keyPath, 0o600)

let server: FakeGitHubServer | undefined
let harness: IssueHarness | undefined
let stateDir: string | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
  await server?.close()
  server = undefined
  if (stateDir) rmSync(stateDir, { recursive: true, force: true })
  stateDir = undefined
})
afterAll(() => rmSync(keyDir, { recursive: true, force: true }))

/** Every JWT the adapter sent, and whether each one verified with the claims GitHub wants. */
const jwts: string[] = []
const jwtChecks: boolean[] = []
const verifyingFetch: typeof fetch = async (input, init) => {
  const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "")
  if (auth.startsWith("Bearer ")) {
    const jwt = auth.slice("Bearer ".length)
    jwts.push(jwt)
    const [header, payload, signature] = jwt.split(".") as [string, string, string]
    const signed = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    )
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      number
    >
    jwtChecks.push(
      signed && claims.iss === APP_ID && (claims.exp as number) - (claims.iat as number) <= 600,
    )
  }
  return fetch(input, init)
}

async function deliveringHarness(log?: (event: string, payload: unknown) => void) {
  server = await startFakeGitHubServer()
  server.repo.seed(
    {
      "README.md": "# b4\n",
      [SOURCE]: BASELINE_TEXT,
      "packages/devkit/test/process.test.ts": "spec\n",
      ".github/workflows/ci.yml": "name: CI\n",
    },
    PIN,
  )
  const adapter = createGitHubAdapter({
    repository: REPOSITORY,
    appId: APP_ID,
    privateKey: loadAppPrivateKey(keyPath),
    baseBranch: "main",
    baseUrl: server.url,
    fetch: verifyingFetch,
  })
  harness = await issueHarness({
    delivery: {
      draftPr: { repository: REPOSITORY, baseBranch: "main", adapter },
      sleep: async () => {},
    },
    ...(log !== undefined ? { log } : {}),
  })
  return { server, harness }
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

describe("a delivery through the real GitHub adapter", () => {
  it("loads the key, signs a verifying JWT, mints a token, and delivers over loopback", async () => {
    jwts.length = 0
    jwtChecks.length = 0
    const logs: string[] = []
    const { server, harness } = await deliveringHarness((event, payload) =>
      logs.push(JSON.stringify({ event, payload })),
    )
    const row = await harness.toBundle({ deliver: { kind: "draft-pr", issueState: "open" } })
    const outcome = await harness.factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
    })
    expect(outcome).toMatchObject({ ok: true, state: "delivered" })
    expect(jwts.length > 0).toBe(true)
    expect(jwtChecks.every(Boolean)).toBe(true)
    expect(server.tokens.length > 0).toBe(true)
    expect(server.requests.every((r) => r.method === "GET" || r.method === "POST")).toBe(true)
    expect(server.repo.writes().length > 0).toBe(true)

    // Nothing the factory keeps holds a token, a JWT or a line of the key.
    const secrets = [
      ...server.tokens,
      ...jwts,
      ...PEM.split("\n").filter((line) => line.length > 20 && !line.startsWith("-----")),
    ]
    const events = JSON.stringify(
      harness.factory.list().flatMap((r) => harness.factory.events(r.id)),
    )
    const blobs = filesUnder(harness.dir).map((file) => readFileSync(file).toString("latin1"))
    const joinedLogs = logs.join("\n")
    const leaked = secrets.some(
      (secret) =>
        events.includes(secret) ||
        joinedLogs.includes(secret) ||
        blobs.some((blob) => blob.includes(secret)),
    )
    expect(leaked).toBe(false)
  }, 60_000)

  it("refuses at the gate when the app is not installed or grants less, writing nothing", async () => {
    const { server, harness } = await deliveringHarness()
    const row = await harness.toBundle({ deliver: { kind: "draft-pr", issueState: "open" } })

    server.installed = false
    const uninstalled = await harness.factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
    })
    expect(uninstalled).toMatchObject({ ok: false, state: "awaiting_approval" })

    server.installed = true
    server.granted = { contents: "read", pull_requests: "write", metadata: "read", issues: "read" }
    const narrower = await harness.factory.approve(row.id, {
      revision: row.revision,
      bundleDigest: row.bundleDigest,
      operationKey: "again",
    })
    expect(narrower).toMatchObject({ ok: false, state: "awaiting_approval" })

    // A repository that would copy the description, quoted spec included, into main.
    server.granted = { contents: "write", pull_requests: "write", metadata: "read", issues: "read" }
    for (const [mergeMessages, field] of [
      [{ squash: "PR_BODY", merge: "PR_TITLE" }, "squash_merge_commit_message"],
      [{ squash: "COMMIT_MESSAGES", merge: "PR_BODY" }, "merge_commit_message"],
    ] as const) {
      server.repo.mergeMessages = mergeMessages
      const body = await harness.factory.approve(row.id, {
        revision: row.revision,
        bundleDigest: row.bundleDigest,
        operationKey: `body-${field}`,
      })
      expect(body).toMatchObject({
        ok: false,
        state: "awaiting_approval",
        message: expect.stringContaining(
          `Delivery preflight: the repository's ${field} is PR_BODY`,
        ),
      })
    }
    // A repository answer without them (GitHub shows them only to some tokens): refused too.
    for (const [mergeMessages, field] of [
      [{ squash: null, merge: "PR_TITLE" }, "squash_merge_commit_message"],
      [{ squash: "COMMIT_MESSAGES", merge: null }, "merge_commit_message"],
    ] as const) {
      server.repo.mergeMessages = mergeMessages
      const hidden = await harness.factory.approve(row.id, {
        revision: row.revision,
        bundleDigest: row.bundleDigest,
        operationKey: `hidden-${field}`,
      })
      expect(hidden).toMatchObject({
        ok: false,
        state: "awaiting_approval",
        message: expect.stringContaining(
          "GitHub did not show the app the repository's merge-commit settings",
        ),
      })
      expect(JSON.stringify(hidden)).toContain(field)
    }
    const read = server.requests.filter(
      (r) => r.method === "GET" && r.path === `/repos/${REPOSITORY}`,
    )
    expect(read.length > 0).toBe(true)

    expect(server.repo.writes()).toEqual([])
    expect(server.requests.some((r) => r.method === "POST" && r.path.includes("/git/"))).toBe(false)
    const events = JSON.stringify(harness.factory.events(row.id))
    expect(server.tokens.some((token) => events.includes(token))).toBe(false)
  }, 60_000)
})

describe("the runtime's delivery configuration", () => {
  const env = (state: string) => ({
    FACTORY_WORKER_URL: "http://127.0.0.1:4100",
    FACTORY_STATE_DIR: state,
    FACTORY_WORKER_TOKEN: TEST_WORKER_TOKEN,
    FACTORY_GITHUB_APP_ID: String(APP_ID),
    FACTORY_GITHUB_APP_PRIVATE_KEY_FILE: runKeyFile(state),
    FACTORY_DELIVERY_REPOSITORY: REPOSITORY,
    FACTORY_DELIVERY_BASE_BRANCH: "main",
  })
  const overrides = () => ({
    images: staticImageRegistry(),
    verifier: createFakeVerifier({ independent: "fail" }),
  })

  it("opens with up's copy of the key and binds new issue rows to the configured repository", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "e2e-state-"))
    expect(writeRunKey(stateDir, PEM)).toBeUndefined()
    expect(loadAppPrivateKey(runKeyFile(stateDir)).asymmetricKeyType === "rsa").toBe(true)

    const runtime = createControllerRuntime(env(stateDir), overrides())
    try {
      const factory = await runtime.factory()
      const created = await factory.createFromIssue({
        origin: ORIGIN,
        pin: PIN,
        issue: ISSUE,
        deliver: { kind: "draft-pr", issueState: "open" },
        operationKey: "e2e-runtime",
      })
      expect(created.delivery).toMatchObject({
        kind: "draft-pr",
        repository: REPOSITORY,
        baseBranch: "main",
      })
    } finally {
      await runtime.dispose()
    }
  }, 60_000)

  it("will not open when the key file is readable by its group", async () => {
    stateDir = mkdtempSync(join(tmpdir(), "e2e-state-"))
    expect(writeRunKey(stateDir, PEM)).toBeUndefined()
    chmodSync(runKeyFile(stateDir), 0o640)
    const runtime = createControllerRuntime(env(stateDir), overrides())
    try {
      await expect(runtime.factory()).rejects.toThrow(/readable by group or other/)
    } finally {
      await runtime.dispose()
    }
  }, 60_000)
})

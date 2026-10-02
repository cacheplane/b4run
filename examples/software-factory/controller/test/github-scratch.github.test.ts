import { randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import { createGitHubAdapter } from "../src/lib/delivery/github/adapter.ts"
import { loadAppPrivateKey } from "../src/lib/delivery/github/jwt.ts"
import { closeHarness, harness } from "./delivery-harness.ts"
import { type ContractEntry, recordingFetch } from "./github-contract.ts"

/**
 * The opt-in lane against a scratch repository Brian owns (rung 4 spec §14). Never in CI:
 * it needs FACTORY_TEST_GITHUB_SCRATCH=<owner/name>, FACTORY_TEST_GITHUB_APP_ID and
 * FACTORY_TEST_GITHUB_APP_KEY_FILE (a 0600 PEM), and the scratch repository prepared by the
 * operator setup task: `main` holding packages/devkit/src/testing/process.ts as
 * "export const deadline = 'leaks'\n", issue #1 open, the app installed with the delivery
 * permissions and no `workflows`, and the three rulesets. Each run creates a branch and a
 * draft PR per case and leaves them for the operator to inspect and delete.
 *
 * The negative probes (a branch outside factory/, a tag, an update to its own branch, a
 * workflow change) are sent with raw fetch and the installation token: the adapter refuses to
 * send them at all, which is the point, so only a raw request can show GitHub refuses them too.
 */
const scratch = process.env.FACTORY_TEST_GITHUB_SCRATCH
const appId = Number(process.env.FACTORY_TEST_GITHUB_APP_ID)
const keyFile = process.env.FACTORY_TEST_GITHUB_APP_KEY_FILE
const enabled = scratch !== undefined && Number.isInteger(appId) && keyFile !== undefined
const API = "https://api.github.com"
const contract: ContractEntry[] = []

const freshId = () => `wo-${randomBytes(8).toString("hex")}`

afterEach(() => closeHarness())
afterAll(() => {
  if (!enabled || process.env.FACTORY_TEST_GITHUB_RECORD !== "1") return
  const dir = join(import.meta.dirname, "fixtures")
  mkdirSync(dir, { recursive: true })
  const unique = new Map(contract.map((e) => [`${e.method} ${e.path} ${e.status}`, e]))
  writeFileSync(
    join(dir, "github-contract.json"),
    `${JSON.stringify([...unique.values()], null, 2)}\n`,
  )
})

describe.skipIf(!enabled)("delivery against a real scratch repository", () => {
  const adapter = () =>
    createGitHubAdapter({
      repository: scratch as string,
      appId,
      privateKey: loadAppPrivateKey(keyFile as string),
      baseBranch: "main",
      fetch: recordingFetch(contract),
    })
  const mainTip = async (token: string) => {
    const response = await fetch(`${API}/repos/${scratch}/git/ref/heads/main`, {
      headers: { authorization: `token ${token}`, accept: "application/vnd.github+json" },
    })
    return ((await response.json()) as { object: { sha: string } }).object.sha
  }
  /** A session's token, for the raw probes only. */
  const tokenOf = async (a: ReturnType<typeof adapter>) => {
    await a.open(scratch as string, new AbortController().signal)
    return a.secrets()[0] as string
  }

  it("delivers a change as one draft pull request, and reads it back", async () => {
    const a = adapter()
    const pin = await mainTip(await tokenOf(a))
    const h = await harness({
      adapter: a,
      remote: { repository: scratch as string, pin, id: freshId(), issue: 1 },
    })
    const row = await h.deliver()
    expect(row.state, h.journal()).toBe("delivered")
    expect(h.store.delivery(row.id)?.pullRequest?.url).toMatch(/\/pull\/\d+$/)
  }, 120_000)

  it("converges after a lost response to the ref create", async () => {
    let dropped = false
    const lossy: typeof fetch = async (input, init) => {
      const response = await recordingFetch(contract)(input, init)
      if (!dropped && init?.method === "POST" && String(input).endsWith("/git/refs")) {
        dropped = true
        throw new TypeError("fetch failed (dropped by the test)")
      }
      return response
    }
    const a = createGitHubAdapter({
      repository: scratch as string,
      appId,
      privateKey: loadAppPrivateKey(keyFile as string),
      baseBranch: "main",
      fetch: lossy,
    })
    const pin = await mainTip(await tokenOf(a))
    const h = await harness({
      adapter: a,
      remote: { repository: scratch as string, pin, id: freshId(), issue: 1 },
    })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
    expect(dropped).toBe(true)
  }, 120_000)

  it("is refused by the rulesets outside factory/, on a tag, and on moving its own branch", async () => {
    const a = adapter()
    const token = await tokenOf(a)
    const sha = await mainTip(token)
    const post = (path: string, body: unknown, method = "POST") =>
      fetch(`${API}/repos/${scratch}${path}`, {
        method,
        headers: { authorization: `token ${token}`, accept: "application/vnd.github+json" },
        body: JSON.stringify(body),
      })
    const outside = await post("/git/refs", { ref: `refs/heads/not-factory-${freshId()}`, sha })
    expect(outside.status, await outside.text()).toBeGreaterThanOrEqual(400)
    const tag = await post("/git/refs", { ref: `refs/tags/factory-${freshId()}`, sha })
    expect(tag.status, await tag.text()).toBeGreaterThanOrEqual(400)
    const own = freshId()
    const made = await post("/git/refs", { ref: `refs/heads/factory/${own}`, sha })
    expect(made.status, await made.text()).toBe(201)
    const session = await a.open(scratch as string, new AbortController().signal)
    const child = await session.createCommit({
      message: "probe",
      tree: (await session.commit(sha)).tree,
      parents: [sha],
      author: { ...session.identity, date: new Date().toISOString() },
      committer: { ...session.identity, date: new Date().toISOString() },
    })
    // Fast-forward, not even a force: "restrict updates" refuses the app any move.
    const moved = await post(`/git/refs/heads/factory/${own}`, { sha: child }, "PATCH")
    expect(moved.status, await moved.text()).toBeGreaterThanOrEqual(400)
  }, 120_000)

  it("cannot create a branch whose commit changes .github/workflows without the workflows permission", async () => {
    const a = adapter()
    const session = await a.open(scratch as string, new AbortController().signal)
    const pin = (await session.commit(await mainTip(a.secrets()[0] as string))).sha
    const pinTree = (await session.commit(pin)).tree
    const blob = await session.createBlob("name: injected\non: push\njobs: {}\n")
    const tree = await session.createTree(pinTree, [
      { path: ".github/workflows/injected.yml", mode: "100644", sha: blob },
    ])
    const commit = await session.createCommit({
      message: "probe",
      tree,
      parents: [pin],
      author: { ...session.identity, date: new Date().toISOString() },
      committer: { ...session.identity, date: new Date().toISOString() },
    })
    await expect(session.createBranch(`factory/${freshId()}`, commit)).rejects.toBeInstanceOf(
      DeliveryError,
    )
  }, 120_000)

  it("links no issue from a closing keyword inside the spec's fence", async () => {
    const a = adapter()
    const pin = await mainTip(await tokenOf(a))
    const id = freshId()
    const h = await harness({
      adapter: a,
      remote: { repository: scratch as string, pin, id, issue: 1 },
      specText: "# Probe\n\n```\nFixes #1\n```\n\nCloses #1\n",
    })
    expect((await h.deliver()).state, h.journal()).toBe("delivered")
  }, 120_000)
})

import { generateKeyPairSync } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createGitHubAdapter } from "../src/lib/delivery/github/adapter.ts"
import { closeHarness, harness } from "./delivery-harness.ts"
import { type FakeGitHubServer, startFakeGitHubServer } from "./fake-github-server.ts"
import { type ContractEntry, pathTemplate, recordingFetch } from "./github-contract.ts"

const RECORDED = join(import.meta.dirname, "fixtures", "github-contract.json")
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })

let server: FakeGitHubServer | undefined
afterEach(async () => {
  closeHarness()
  await server?.close()
  server = undefined
})

describe("the fake GitHub against what GitHub answered", () => {
  it("names paths by template, never by value", () => {
    expect(pathTemplate(`/repos/o/r/git/commits/${"a".repeat(40)}`)).toBe(
      "/repos/{o}/{r}/git/commits/{sha}",
    )
    expect(
      pathTemplate(
        "/repos/o/r/pulls?head=o%3Afactory%2Fwo-0123456789abcdef&state=all&per_page=100",
      ),
    ).toBe("/repos/{o}/{r}/pulls?head={head}&state=all&per_page=100")
    expect(pathTemplate("/app/installations/42/access_tokens")).toBe(
      "/app/installations/{n}/access_tokens",
    )
  })

  it.skipIf(!existsSync(RECORDED))(
    "answers every request the scratch lane recorded with GitHub's status and at least its keys",
    async () => {
      const recorded = JSON.parse(readFileSync(RECORDED, "utf8")) as ContractEntry[]
      server = await startFakeGitHubServer()
      const seen: ContractEntry[] = []
      const adapter = createGitHubAdapter({
        repository: "cacheplane/b4run",
        appId: 1,
        privateKey,
        baseBranch: "main",
        baseUrl: server.url,
        fetch: recordingFetch(seen),
      })
      const h = await harness({ github: server.repo, adapter })
      expect((await h.deliver()).state).toBe("delivered")
      // One template can be answered more than once, and differently: the branch's ref is a 404
      // before the create and a 200 after it. Each recorded success needs an exchange of ours
      // with the same status and at least its keys, not merely the first of that template.
      for (const entry of recorded.filter((e) => e.status < 300)) {
        const same = seen.filter((s) => s.method === entry.method && s.path === entry.path)
        expect(same.length, `${entry.method} ${entry.path}`).toBeGreaterThan(0)
        const answered = same.filter((s) => s.status === entry.status)
        expect(
          answered.map((s) => s.status),
          `${entry.method} ${entry.path} answered ${same.map((s) => s.status).join(", ")}`,
        ).toContain(entry.status)
        const fewest = answered
          .map((s) => entry.keys.filter((key) => !s.keys.includes(key)))
          .sort((a, b) => a.length - b.length)[0]
        expect(fewest, `${entry.method} ${entry.path} lacks GitHub's keys`).toEqual([])
      }
    },
  )
})

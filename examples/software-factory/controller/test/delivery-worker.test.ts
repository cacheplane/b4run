import { afterEach, describe, expect, it } from "vitest"
import { DeliveryError, type RemoteCommit, type RemotePull } from "../src/lib/delivery/adapter.ts"
import { blobId } from "../src/lib/delivery/git-objects.ts"
import type { WorkOrderRow } from "../src/lib/domain/work-order.ts"
import {
  BASELINE,
  BRANCH,
  closeHarness,
  harness,
  ID,
  REPAIRED,
  SOURCE,
  TOKEN,
  transient,
} from "./delivery-harness.ts"
import { BOT } from "./fake-delivery-adapter.ts"

afterEach(closeHarness)

describe("the delivery worker", () => {
  it("publishes exactly the approved bytes as one draft pull request, then reads it back", async () => {
    const h = await harness()
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "delivered", blockedReason: null })
    const head = h.github.refs.get(BRANCH) as string
    expect(h.github.commits.get(head)?.parents).toEqual([h.pin])
    expect(h.github.filesAt(head)[SOURCE]).toBe(REPAIRED)
    expect(h.github.filesAt(head)["README.md"]).toBe("# b4\n")
    expect(h.github.pulls).toHaveLength(1)
    expect(h.github.pulls[0]).toMatchObject({
      draft: true,
      baseRef: "main",
      headRef: BRANCH,
      author: BOT,
    })
    const receipt = h.store.delivery(ID)
    expect(receipt).toMatchObject({
      receiptPath: h.github.pulls[0]?.url,
      pullRequest: { number: 1000, headSha: head, treeSha: h.github.commits.get(head)?.tree },
    })
    expect(h.outbox.get(ID)?.step).toBe("confirmed")
    expect(h.events()).toEqual([
      "delivery_checked",
      "delivery_committed",
      "delivery_branched",
      "delivery_opened",
      "transition",
    ])
    // The only writes are the ones the approval authorized: one blob, one tree, one commit,
    // one ref, one pull request.
    expect(h.github.writes()).toEqual([
      "createBlob",
      "createTree",
      "createCommit",
      "createBranch",
      "createDraftPull",
    ])
  })

  it.each(["createBlob", "createTree", "createCommit", "createBranch", "createDraftPull"] as const)(
    "converges on one branch and one pull request when %s's response is lost",
    async (method) => {
      const h = await harness()
      h.github.fail(method, transient(), { after: true })
      expect((await h.deliver()).state).toBe("delivered")
      expect([...h.github.refs.keys()].filter((r) => r.startsWith("factory/"))).toEqual([BRANCH])
      expect(h.github.pulls).toHaveLength(1)
      expect(h.waits).toEqual([2_000])
    },
  )

  it.each(["delivery_checked", "delivery_committed", "delivery_branched", "delivery_opened"])(
    "resumes after a controller stop at %s and creates nothing twice",
    async (boundary) => {
      const h = await harness()
      const stopped = await h.deliver({ onEvent: (type, abort) => type === boundary && abort() })
      expect(stopped.state).toBe("delivering")
      const writesBefore = h.github.writes().length
      expect((await h.deliver()).state).toBe("delivered")
      expect(h.github.pulls).toHaveLength(1)
      // A resumed run reads first: each write it repeats is idempotent, and the ref and the
      // pull request were each created once.
      expect(h.github.writes().filter((w) => w === "createBranch").length).toBeLessThanOrEqual(1)
      expect(h.github.writes().filter((w) => w === "createDraftPull")).toHaveLength(1)
      expect(h.github.writes().length).toBeGreaterThanOrEqual(writesBefore)
    },
  )

  it("adopts a branch a lost response created, when its commit is this change on the pin", async () => {
    const h = await harness()
    // A first run died after creating the ref: the ref is there, at an equivalent commit.
    await h.deliver({ onEvent: (type, abort) => type === "delivery_committed" && abort() })
    const commit = h.outbox.get(ID)?.remote.commit?.sha as string
    h.github.refs.set(BRANCH, commit)
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.github.writes().filter((w) => w === "createBranch")).toHaveLength(0)
  })

  it("refuses a branch that holds another commit, and never moves it", async () => {
    const h = await harness()
    h.github.refs.set(BRANCH, h.pin)
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_branch_conflict" })
    expect(h.github.refs.get(BRANCH)).toBe(h.pin)
    expect(h.github.pulls).toHaveLength(0)
  })

  it("refuses when a person closed the factory's pull request, and never reopens it", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_opened" && abort() })
    const pull = h.github.pulls[0] as (typeof h.github.pulls)[number]
    h.github.pulls[0] = { ...pull, state: "closed" }
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_branch_conflict" })
    expect(h.github.pulls).toHaveLength(1)
  })

  it("blocks unauthorized at once on a 401, a 403 or a refused mint", async () => {
    for (const method of ["open", "compare", "createBranch"] as const) {
      const h = await harness()
      h.github.fail(
        method,
        new DeliveryError("unauthorized", "HTTP 401 Bad credentials", undefined, 401),
      )
      expect(await h.deliver()).toMatchObject({
        state: "blocked",
        blockedReason: "delivery_unauthorized",
      })
      expect(h.waits).toEqual([])
      closeHarness()
    }
  })

  it("waits out a rate limit inside the bound, and blocks rate-limited past it", async () => {
    const limited = new DeliveryError("rate_limited", "HTTP 429", 30_000, 429)
    const inside = await harness()
    inside.github.fail("createTree", limited, { times: 2 })
    expect((await inside.deliver()).state).toBe("delivered")
    expect(inside.waits).toEqual([30_000, 30_000])
    closeHarness()

    const past = await harness()
    past.github.fail("compare", new DeliveryError("rate_limited", "HTTP 403", 3_600_000, 403), {
      times: 9,
    })
    expect(await past.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_rate_limited",
    })
    // Each wait is capped at a minute, and five attempts is the step's bound.
    expect(past.waits).toEqual([60_000, 60_000, 60_000, 60_000])
  })

  it("backs off from 2 s on a 5xx and blocks unconfirmed past the bound", async () => {
    const h = await harness()
    h.github.fail("pullsByHead", transient(503), { times: 9 })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.waits).toEqual([2_000, 4_000, 8_000, 16_000])
  })

  it("stops at the run's bound, whatever the step's attempts", async () => {
    const h = await harness()
    h.github.fail("compare", transient(), { times: 9 })
    const row = await h.deliver({ limits: { runMs: 5_000 } })
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_unconfirmed" })
    expect(h.waits).toEqual([2_000])
  })

  it.each([
    ["a touched file", [{ filename: SOURCE }], "ahead", true],
    [
      "a renamed-away touched file",
      [{ filename: "x.ts", previousFilename: SOURCE }],
      "ahead",
      true,
    ],
    [
      "the Vercel ignore script, which the branch's own build runs",
      [{ filename: "apps/web/scripts/vercel-ignore-build.sh" }],
      "ahead",
      true,
    ],
    ["a pin that left main", [{ filename: "README.md" }], "diverged", true],
    ["a comparison too large to read", [{ filename: "README.md" }], "ahead", false],
  ] as const)(
    "refuses base drift: %s, writing nothing",
    async (_label, files, status, complete) => {
      const h = await harness()
      h.github.comparison = { status, aheadBy: 7, files, complete }
      expect(await h.deliver()).toMatchObject({
        state: "blocked",
        blockedReason: "delivery_base_conflict",
      })
      expect(h.github.writes()).toEqual([])
      expect(h.store.events(ID).find((e) => e.type === "delivery_refused")?.payload).toMatchObject({
        reason: "delivery_base_conflict",
      })
    },
  )

  it("delivers although main changed .github since the pin: the PR runs main's workflows", async () => {
    const h = await harness()
    h.github.comparison = {
      status: "ahead",
      aheadBy: 41,
      files: [{ filename: ".github/workflows/ci.yml" }, { filename: ".github/CODEOWNERS" }],
      complete: true,
    }
    expect((await h.deliver()).state).toBe("delivered")
  })

  it("refuses a change to a protected path at delivery, whatever approval saw", async () => {
    const h = await harness({ source: ".github/workflows/ci.yml" })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_base_conflict",
    })
    // Asked before the session opens: no request at all.
    expect(h.github.calls).toEqual([])
  })

  it("stays delivering when the controller closes mid-request, and resumes after", async () => {
    const h = await harness()
    const stopped = await h.deliver({
      onCall: (method, abort) => {
        if (method !== "createBranch") return
        abort()
        throw new DOMException("This operation was aborted", "AbortError")
      },
    })
    expect(stopped).toMatchObject({ state: "delivering", blockedReason: null })
    expect(h.store.events(ID).find((e) => e.type === "delivery_stopped")?.payload).toMatchObject({
      step: "committed",
      reason: "the controller is closing",
    })
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.github.pulls).toHaveLength(1)
  })

  it("stays delivering when the controller closes during a backoff wait, and resumes after", async () => {
    const h = await harness()
    h.github.fail("createTree", transient())
    const stopped = await h.deliver({
      onEvent: (type, abort) => type === "delivery_retry" && abort(),
    })
    expect(stopped).toMatchObject({ state: "delivering", blockedReason: null })
    expect(h.waits).toEqual([2_000])
    expect(h.store.events(ID).find((e) => e.type === "delivery_stopped")?.payload).toMatchObject({
      step: "checked",
      reason: "the controller is closing",
    })
    expect(h.events()).not.toContain("delivery_refused")
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.github.pulls).toHaveLength(1)
  })

  it("opens no pull request on a branch pushed to after it was branched", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_branched" && abort() })
    const ours = h.github.refs.get(BRANCH) as string
    // A commit pushed on top of ours, even one keeping its tree, is not this change on the pin.
    const pushed = "a".repeat(40)
    h.github.commits.set(pushed, {
      sha: pushed,
      tree: h.github.commits.get(ours)?.tree as string,
      parents: [ours],
    })
    h.github.refs.set(BRANCH, pushed)
    const row = await h.deliver()
    expect(row).toMatchObject({ state: "blocked", blockedReason: "delivery_branch_conflict" })
    expect(h.github.pulls.length).toBe(0)
    expect(h.store.delivery(ID)).toBeNull()
    expect(JSON.stringify(h.store.events(ID).at(-2)?.payload)).toContain(pushed)
  })

  it("opens the pull request on a branch that moved to another commit of exactly this change", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_branched" && abort() })
    const ours = h.github.refs.get(BRANCH) as string
    const twin = "e".repeat(40)
    h.github.commits.set(twin, { ...(h.github.commits.get(ours) as RemoteCommit), sha: twin })
    h.github.refs.set(BRANCH, twin)
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.github.pulls).toHaveLength(1)
    expect(h.store.delivery(ID)?.pullRequest?.headSha).toBe(twin)
  })

  it("refuses a pull request whose head moved off this change after it was opened, and records no receipt", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_opened" && abort() })
    const pull = h.github.pulls[0] as (typeof h.github.pulls)[number]
    h.github.pulls[0] = { ...pull, headSha: "a".repeat(40) }
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_branch_conflict",
    })
    expect(h.store.delivery(ID)).toBeNull()
    expect(h.outbox.get(ID)?.step).toBe("opened")
  })

  it("confirms a pull request whose head moved to another commit of exactly this change", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_opened" && abort() })
    const pull = h.github.pulls[0] as (typeof h.github.pulls)[number]
    const twin = "e".repeat(40)
    h.github.commits.set(twin, {
      ...(h.github.commits.get(pull.headSha) as RemoteCommit),
      sha: twin,
    })
    h.github.pulls[0] = { ...pull, headSha: twin }
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.store.delivery(ID)?.pullRequest?.headSha).toBe(twin)
  })

  it("does not confirm a head whose commit reads back as another tree", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_opened" && abort() })
    const head = h.github.pulls[0]?.headSha as string
    const commit = h.github.commits.get(head) as RemoteCommit
    h.github.commits.set(head, { ...commit, tree: h.github.commits.get(h.pin)?.tree as string })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.store.delivery(ID)).toBeNull()
  })

  it.each([
    ["its head is in another repository", { headRepository: "someone/fork" }],
    ["its head is another branch", { headRef: "factory/other" }],
  ] as const)("refuses to confirm a pull request when %s", async (_label, change) => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_opened" && abort() })
    h.github.pulls[0] = { ...(h.github.pulls[0] as RemotePull), ...change }
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_branch_conflict",
    })
    expect(h.store.delivery(ID)).toBeNull()
  })

  it("leaves a pull request retargeted to another base redeliverable, unconfirmed", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_opened" && abort() })
    h.github.pulls[0] = { ...(h.github.pulls[0] as RemotePull), baseRef: "release" }
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.store.delivery(ID)).toBeNull()
  })

  it("refuses when the pin's bytes are not the baseline the candidate was diffed against", async () => {
    const h = await harness({
      pinFiles: { "README.md": "# b4\n", [SOURCE]: "export const deadline = 'other'\n" },
    })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_baseline_mismatch",
    })
    expect(h.github.writes()).toEqual([])
    expect(JSON.stringify(h.store.events(ID).at(-2)?.payload)).toContain(blobId(BASELINE))
  })

  it("refuses when GitHub stores the bytes under another id", async () => {
    const h = await harness()
    h.github.corruptBlob = "f".repeat(40)
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.github.writes()).toEqual(["createBlob"])
  })

  it("blocks when the pull request would close an issue, and leaves it for a person", async () => {
    const h = await harness()
    h.github.closing = [912]
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.github.pulls).toHaveLength(1)
    expect(h.store.delivery(ID)).toBeNull()
  })

  it("does not call a pull request another author opened on the branch delivered", async () => {
    const h = await harness()
    h.github.author = "blove"
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_branch_conflict",
    })
  })

  it.each([
    ["an app the guard does not skip", "other-app[bot]", "other-app[bot]"],
    ["the guarded bot, when the session is another app's", "other-app[bot]", BOT],
  ])("does not confirm as the factory's a pull request by %s", async (_label, login, author) => {
    const h = await harness()
    h.github.botLogin = login
    h.github.author = author
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_branch_conflict",
    })
    expect(h.store.delivery(ID)).toBeNull()
  })

  it("refuses at step (d) when a person closed a pull request on the branch, opening none", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_branched" && abort() })
    h.github.pulls.push({
      number: 5,
      url: "https://github.com/cacheplane/b4run/pull/5",
      nodeId: "PR_5",
      state: "closed",
      draft: true,
      merged: false,
      author: BOT,
      headRef: BRANCH,
      headRepository: "cacheplane/b4run",
      headSha: h.github.refs.get(BRANCH) as string,
      baseRef: "main",
    })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_branch_conflict",
    })
    expect(h.github.pulls).toHaveLength(1)
  })

  it("ignores a fork's pull request on the same branch name, and opens its own", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_branched" && abort() })
    h.github.pulls.push({
      number: 7,
      url: "https://github.com/someone/fork/pull/7",
      nodeId: "PR_7",
      state: "open",
      draft: false,
      merged: false,
      author: "someone",
      headRef: BRANCH,
      headRepository: "someone/fork",
      headSha: h.github.refs.get(BRANCH) as string,
      baseRef: "main",
    })
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.store.delivery(ID)?.pullRequest?.number).toBe(1001)
  })

  it("refuses when GitHub builds another tree than the approved change, before any commit", async () => {
    const h = await harness()
    h.github.corruptTree = "f".repeat(40)
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.github.writes()).toEqual(["createBlob", "createTree"])
  })

  it("refuses a commit that reads back off the pin, journals both, and creates no branch", async () => {
    const h = await harness()
    h.github.rewriteCommit = (commit) => ({ ...commit, parents: [] })
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.github.writes()).not.toContain("createBranch")
    const refused = h.store.events(ID).find((e) => e.type === "delivery_refused")?.payload
    expect(refused).toMatchObject({
      expected: { parents: [h.pin] },
      returned: { parents: [] },
    })
  })

  it("refuses a pull request GitHub created ready rather than draft", async () => {
    const h = await harness()
    h.github.createReady = true
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.store.delivery(ID)).toBeNull()
  })

  it("keeps the pin's executable bit on the changed file", async () => {
    const h = await harness({ executable: [SOURCE] })
    expect((await h.deliver()).state).toBe("delivered")
    expect(h.outbox.get(ID)?.remote.check?.modes).toEqual({ [SOURCE]: "100755" })
  })

  it("writes no blob when the work order is cancelled while the approved bytes are read", async () => {
    const h = await harness()
    const row = await h.deliver({
      onArtifactRead: () => {
        const current = h.store.get(ID) as WorkOrderRow
        h.store.update(
          ID,
          current.revision,
          { state: "cancel_requested" },
          new Date().toISOString(),
        )
      },
    })
    expect(row.state).toBe("cancel_requested")
    expect(h.github.writes()).toEqual([])
    expect(h.events()).toContain("delivery_stopped")
  })

  it.each([
    ["another base", { baseRef: "release" }],
    ["another head", { headSha: "a".repeat(40) }],
  ] as const)(
    "refuses at step (d) an open pull request on the branch with %s, opening none",
    async (_label, change) => {
      const h = await harness()
      await h.deliver({ onEvent: (type, abort) => type === "delivery_branched" && abort() })
      h.github.pulls.push({
        number: 6,
        url: "https://github.com/cacheplane/b4run/pull/6",
        nodeId: "PR_6",
        state: "open",
        draft: true,
        merged: false,
        author: BOT,
        headRef: BRANCH,
        headRepository: "cacheplane/b4run",
        headSha: h.github.refs.get(BRANCH) as string,
        baseRef: "main",
        ...change,
      })
      expect(await h.deliver()).toMatchObject({
        state: "blocked",
        blockedReason: "delivery_branch_conflict",
      })
      expect(h.github.pulls).toHaveLength(1)
      expect(h.outbox.get(ID)?.step).toBe("branched")
    },
  )

  it("ends two concurrent workers with one pull request and no refusal", async () => {
    const h = await harness()
    await Promise.all([h.deliver(), h.deliver()])
    expect(h.store.get(ID)).toMatchObject({ state: "delivered", blockedReason: null })
    expect(h.github.pulls).toHaveLength(1)
    expect(h.events()).not.toContain("delivery_refused")
    expect(h.events()).toContain("delivery_stopped")
  })

  it("ends two concurrent confirmations with one receipt and no refusal", async () => {
    const h = await harness()
    await h.deliver({ onEvent: (type, abort) => type === "delivery_opened" && abort() })
    await Promise.all([h.deliver(), h.deliver()])
    expect(h.store.get(ID)).toMatchObject({ state: "delivered", blockedReason: null })
    expect(h.events()).not.toContain("delivery_refused")
    expect(h.store.delivery(ID)?.pullRequest?.number).toBe(1000)
  })

  it("blocks, rather than throws, on an outbox row that does not parse", async () => {
    const h = await harness()
    h.db.prepare("UPDATE delivery_outbox SET intent = ? WHERE work_order_id = ?").run("{", ID)
    expect(await h.deliver()).toMatchObject({
      state: "blocked",
      blockedReason: "delivery_unconfirmed",
    })
    expect(h.github.calls).toEqual([])
  })

  it.each([
    ["createBranch", "committed", "branchHead"],
    ["createDraftPull", "branched", "pullsByHead"],
  ] as const)(
    "writes no %s when the work order is cancelled while the step reads",
    async (write, step, read) => {
      const h = await harness()
      const row = await h.deliver({
        onCall: (method) => {
          if (method !== read || h.outbox.get(ID)?.step !== step) return
          const current = h.store.get(ID) as WorkOrderRow
          h.store.update(
            ID,
            current.revision,
            { state: "cancel_requested" },
            new Date().toISOString(),
          )
        },
      })
      expect(row.state).toBe("cancel_requested")
      expect(h.github.writes()).not.toContain(write)
      expect(h.events()).toContain("delivery_stopped")
    },
  )

  it("refuses an issue closed since create, and delivers a replay of one closed at create", async () => {
    const reopened = await harness()
    reopened.github.issues.set(912, "closed")
    expect(await reopened.deliver()).toMatchObject({ blockedReason: "delivery_issue_closed" })
    closeHarness()
    const replay = await harness({ stateAtCreate: "closed" })
    replay.github.issues.set(912, "closed")
    expect((await replay.deliver()).state).toBe("delivered")
    expect(replay.github.calls).not.toContain("issueState")
  })

  it("stops before its next write when the work order is cancelled, naming what exists", async () => {
    const h = await harness()
    const row = await h.deliver({
      onEvent: (type) => {
        if (type !== "delivery_branched") return
        const current = h.store.get(ID) as WorkOrderRow
        h.store.update(
          ID,
          current.revision,
          { state: "cancel_requested" },
          new Date().toISOString(),
        )
      },
    })
    expect(row.state).toBe("cancel_requested")
    expect(h.github.pulls).toHaveLength(0)
    const stopped = h.store.events(ID).find((e) => e.type === "delivery_stopped")
    expect(stopped?.payload).toMatchObject({ step: "branched" })
    expect(JSON.stringify(stopped?.payload)).toContain(h.github.refs.get(BRANCH) as string)
  })

  it("journals no token, JWT, PEM or Authorization header, whatever GitHub's errors say", async () => {
    const h = await harness()
    h.github.fail(
      "compare",
      new DeliveryError(
        "unexpected",
        `HTTP 500 with ${TOKEN} and Authorization: token ${TOKEN} and eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjF9.c2lnbmF0dXJlc2ln -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----`,
      ),
    )
    await h.deliver()
    const everything = `${h.journal()}${JSON.stringify(h.outbox.get(ID))}`
    expect(everything).not.toContain(TOKEN)
    expect(everything).not.toMatch(/eyJhbGciOiJSUzI1NiJ9\./)
    expect(everything).not.toContain("BEGIN RSA PRIVATE KEY")
    expect(everything).toContain("[REDACTED")
  })
})

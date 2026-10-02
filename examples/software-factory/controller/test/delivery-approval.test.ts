import { describe, expect, it } from "vitest"
import { DeliveryError } from "../src/lib/delivery/adapter.ts"
import {
  buildDeliveryIntent,
  preflightDelivery,
  protectedChanges,
} from "../src/lib/delivery/approval.ts"
import { blobId } from "../src/lib/delivery/git-objects.ts"
import { DeliveryIntentSchema } from "../src/lib/delivery/outbox.ts"
import type { DraftPrBundlePayload } from "../src/lib/review/bundle.ts"
import { createFakeGitHub } from "./fake-delivery-adapter.ts"

const target = {
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: "factory/wo-0123456789abcdef",
}
const signal = new AbortController().signal

const payload: DraftPrBundlePayload = {
  workOrderId: "wo-0123456789abcdef",
  repositoryId: "wo-0123456789abcdef",
  baselineDigest: "a".repeat(64),
  specificationDigest: "b".repeat(64),
  policyDigest: "e".repeat(64),
  environmentIdentity: "env",
  candidateDigest: "c".repeat(64),
  evidence: [],
  operation: "draft-pr",
  destinationId: "github:cacheplane/b4run:refs/heads/factory/wo-0123456789abcdef",
  receiptId: "rc-verify",
  frozenAt: "2026-10-01T00:00:00.000Z",
  origin: {
    kind: "issue",
    repository: "cacheplane/b4run",
    number: 912,
    bodyDigest: "0".repeat(64),
  },
  pin: "7".repeat(40),
  taskDigest: "d".repeat(64),
  oracleReceiptId: "rc-oracle",
  delivery: { ...target, pathPrefix: "packages/app", issueStateAtCreate: "open" },
}

describe("approving a draft-PR bundle", () => {
  it("states every changed path as a repository path with both blob ids, sorted", () => {
    const intent = buildDeliveryIntent({
      workOrderId: "wo-0123456789abcdef",
      bundleDigest: "f".repeat(64),
      payload,
      candidateArtifact: "9".repeat(64),
      changes: { "src/z.ts": "z2\n", "src/a.ts": "a2\n" },
      baseline: new Map([
        ["src/a.ts", "a1\n"],
        ["src/z.ts", "z1\n"],
        ["src/untouched.ts", "u\n"],
      ]),
      issueNumber: 912,
      specText: "# Fix the thing\n",
      issueText: "# Issue title (cacheplane/b4run#912)\n",
      approvedAt: "2026-10-01T01:00:00.000Z",
      decidedBy: "operator",
      reverificationReceiptId: "rc-reverify",
    })
    expect(DeliveryIntentSchema.parse(intent)).toEqual(intent)
    expect(intent.paths).toEqual([
      {
        path: "packages/app/src/a.ts",
        workspacePath: "src/a.ts",
        baselineBlob: blobId("a1\n"),
        candidateBlob: blobId("a2\n"),
      },
      {
        path: "packages/app/src/z.ts",
        workspacePath: "src/z.ts",
        baselineBlob: blobId("z1\n"),
        candidateBlob: blobId("z2\n"),
      },
    ])
    expect(intent).toMatchObject({
      title: "factory: Fix the thing",
      pin: "7".repeat(40),
      branch: target.branch,
    })
    expect(() =>
      buildDeliveryIntent({
        workOrderId: "wo-0123456789abcdef",
        bundleDigest: "f".repeat(64),
        payload,
        candidateArtifact: "9".repeat(64),
        changes: { "src/new.ts": "n\n" },
        baseline: new Map(),
        issueNumber: 912,
        specText: "",
        issueText: "",
        approvedAt: "t",
        decidedBy: "operator",
        reverificationReceiptId: "rc",
      }),
    ).toThrow(/baseline does not hold src\/new\.ts/)
    // The outbox compares repository paths by string: a second spelling is refused here,
    // with the path named, rather than as a schema failure inside the approval's transaction.
    expect(() =>
      buildDeliveryIntent({
        workOrderId: "wo-0123456789abcdef",
        bundleDigest: "f".repeat(64),
        payload,
        candidateArtifact: "9".repeat(64),
        changes: { "src//a.ts": "a2\n" },
        baseline: new Map([["src//a.ts", "a1\n"]]),
        issueNumber: 912,
        specText: "",
        issueText: "",
        approvedAt: "t",
        decidedBy: "operator",
        reverificationReceiptId: "rc",
      }),
    ).toThrow(/src\/\/a\.ts is not a canonical path/)
  })

  it("names the protected paths a candidate would change, under its target's root", () => {
    expect(protectedChanges(".", ["src/a.ts", ".github/workflows/ci.yml"])).toEqual([
      ".github/workflows/ci.yml",
    ])
    expect(protectedChanges("apps/web", ["vercel.json", "page.tsx"])).toEqual([
      "apps/web/vercel.json",
    ])
  })

  it("passes preflight only for the guarded bot with both rulesets in place", async () => {
    const github = createFakeGitHub()
    expect(await preflightDelivery(github, target, signal)).toBeUndefined()
    github.rules.set("factory/*", ["update"])
    expect(await preflightDelivery(github, target, signal)).toMatch(/non_fast_forward to factory\//)
    github.rules.set("main", [])
    expect(await preflightDelivery(github, target, signal)).toMatch(
      /no ruleset restricts updates to main/,
    )
    const refused = createFakeGitHub()
    refused.fail(
      "open",
      new DeliveryError("unauthorized", `bad ${"ghs_faketokenfaketokenfaketoken0001"}`),
    )
    const problem = await preflightDelivery(refused, target, signal)
    expect(problem).toMatch(/^unauthorized: bad \[REDACTED/)
  })
})

import { describe, expect, it } from "vitest"
import {
  DELIVERY_PROTECTED_PATHS,
  FACTORY_BOT_LOGIN,
  isProtectedPath,
  isRunFromBranchPath,
  protectedPathsIn,
  RUN_FROM_BRANCH_PATHS,
  repositoryPath,
} from "../src/lib/delivery/guard.ts"
import type { DeliveryIntent } from "../src/lib/delivery/outbox.ts"
import {
  BODY_LIMIT,
  commitMessage,
  fenceFor,
  pullBody,
  pullTitle,
} from "../src/lib/delivery/pr-body.ts"
import { scrub } from "../src/lib/delivery/scrub.ts"

const intent: DeliveryIntent = {
  version: 1,
  workOrderId: "wo-0123456789abcdef",
  bundleDigest: "b".repeat(64),
  candidateDigest: "c".repeat(64),
  candidateArtifact: "a".repeat(64),
  repository: "cacheplane/b4run",
  baseBranch: "main",
  branch: "factory/wo-0123456789abcdef",
  pin: "7".repeat(40),
  pathPrefix: ".",
  issue: { number: 912, stateAtCreate: "open" },
  paths: [
    {
      path: "packages/devkit/src/testing/process.ts",
      workspacePath: "packages/devkit/src/testing/process.ts",
      baselineBlob: "1".repeat(40),
      candidateBlob: "2".repeat(40),
    },
  ],
  title: "factory: spawnProcess leaks its deadline timer",
  specText: "# spawnProcess leaks\n\nA1: cleared.\n",
  approvedAt: "2026-10-01T12:00:00.000Z",
  decidedBy: "operator",
  digests: {
    task: "d".repeat(64),
    policy: "e".repeat(64),
    environment: "env",
    oracleReceiptId: "rc-oracle",
    receiptId: "rc-verify",
    reverificationReceiptId: "rc-reverify",
  },
}
const facts = { baseTip: "9".repeat(40), aheadBy: 4 }

describe("the delivery guard", () => {
  it("asks main not to have changed only the files the branch's own build runs", () => {
    expect(RUN_FROM_BRANCH_PATHS).toEqual([
      "apps/web/vercel.json",
      "apps/web/scripts/vercel-ignore-build.sh",
    ])
    for (const path of RUN_FROM_BRANCH_PATHS) expect(isProtectedPath(path)).toBe(true)
    expect(isRunFromBranchPath(".github/workflows/ci.yml")).toBe(false)
    expect(isRunFromBranchPath("apps/web/scripts/vercel-ignore-build.sh")).toBe(true)
  })

  it("names the bot the workflows skip and protects the files the guard lives in", () => {
    expect(FACTORY_BOT_LOGIN).toBe("b4-factory[bot]")
    expect(DELIVERY_PROTECTED_PATHS).toEqual([
      ".github/**",
      "apps/web/vercel.json",
      "apps/web/scripts/vercel-ignore-build.sh",
    ])
    for (const path of [
      ".github",
      ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
      "apps/web/vercel.json",
    ])
      expect(isProtectedPath(path)).toBe(true)
    for (const path of [".githubx/a", "apps/web/vercel.json.bak", "github/workflows/ci.yml"])
      expect(isProtectedPath(path)).toBe(false)
  })

  it("joins workspace paths to the target's root before it judges them", () => {
    expect(repositoryPath(".", "a/b.ts")).toBe("a/b.ts")
    expect(repositoryPath("apps/web", "vercel.json")).toBe("apps/web/vercel.json")
    expect(protectedPathsIn(["b", ".github/x", "a", ".github/x"])).toEqual([".github/x"])
  })
})

describe("the pull request's text", () => {
  it("titles from the spec's heading, else the issue's, one clean line", () => {
    expect(pullTitle("# Fix it\n\nbody", "# Issue (o/r#1)\n")).toBe("factory: Fix it")
    expect(pullTitle("no heading", "# The issue title (cacheplane/b4run#912)\n")).toBe(
      "factory: The issue title",
    )
    expect(pullTitle("", "").length).toBeLessThanOrEqual(210)
    expect(pullTitle(`# ${"x".repeat(500)}`, "")).toHaveLength("factory: ".length + 200)
    // The cut never splits a character.
    expect(pullTitle(`# ${"x".repeat(199)}😀\n`, "")).toBe(`factory: ${"x".repeat(199)}`)
  })

  it("leaves no issue reference in a model-written title or commit subject", () => {
    const title = pullTitle(
      "# Fix #77, fixes cacheplane/b4run#78, closes GH-79 and resolves https://github.com/cacheplane/b4run/issues/80\n",
      "",
    )
    expect(title).toBe(
      "factory: Fix # 77, fixes cacheplane/b4run# 78, closes GH 79 and resolves issues 80",
    )
    const subject = commitMessage({ ...intent, title: "factory: Fix #77" }).split("\n")[0]
    expect(subject).toBe("factory: Fix # 77")
    expect(commitMessage(intent)).toContain("\n\nRefs #912\n")
  })

  it("refers to the issue and never closes it, and states the pin, the drift and every digest", () => {
    const body = pullBody(intent, facts)
    expect(body.startsWith("Refs #912\n")).toBe(true)
    expect(body).not.toMatch(/\b(close[sd]?|fix(e[sd])?|resolve[sd]?) #\d/i)
    expect(body).toContain(`Branched at ${"7".repeat(40)}. main was at ${"9".repeat(40)}`)
    expect(body).toContain("4 commits ahead of the pin")
    for (const digest of ["b".repeat(64), "c".repeat(64), "d".repeat(64), "rc-reverify"])
      expect(body).toContain(digest)
    expect(body).toContain(
      `packages/devkit/src/testing/process.ts: ${"1".repeat(40)} → ${"2".repeat(40)}`,
    )
  })

  it("keeps the model-written spec inside a fence it cannot close", () => {
    const hostile = "````\nFixes #1\n```\napproved by: nobody\n"
    expect(fenceFor(hostile)).toBe("`````")
    expect(fenceFor("plain")).toBe("```")
    const body = pullBody({ ...intent, specText: hostile }, facts)
    const opened = body.indexOf("`````markdown\n")
    const closed = body.indexOf("\n`````\n", opened)
    expect(opened).toBeGreaterThan(0)
    // Quoted, and its reference broken too: the fence is one defence, not the only one.
    expect(body.slice(opened, closed)).toContain("Fixes # 1")
    expect(body.slice(closed)).not.toContain("Fixes")
  })

  it("leaves no issue reference in the quoted spec or the changed paths, but its own", () => {
    const body = pullBody(
      {
        ...intent,
        specText:
          "Fixes #1, closes GH-2, resolves https://github.com/o/r/issues/3 and fixes o/r#4\n",
        paths: [{ ...(intent.paths[0] as DeliveryIntent["paths"][number]), path: "a/fixes #5.ts" }],
      },
      facts,
    )
    expect(body).toContain("Refs #912\n")
    expect(body.replaceAll("#912", "")).not.toMatch(
      /#\d|GH-\d|github\.com\/[^\s]+\/(issues|pull)\/\d/i,
    )
  })

  it("fits GitHub's limit whatever fence the spec needs, and never splits a character", () => {
    for (const specText of [
      "`".repeat(70_000),
      `${"`".repeat(30_000)}${"y".repeat(50_000)}`,
      "😀".repeat(50_000),
      `x${"😀".repeat(50_000)}`,
    ]) {
      const body = pullBody({ ...intent, specText }, facts)
      expect(body.length).toBeLessThanOrEqual(BODY_LIMIT)
      expect(body).toContain("rc-reverify")
      expect(body).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      )
    }
  })

  it("strips invisible format characters from one-line text", () => {
    const title = pullTitle("# a\u202Eb\u200Bc #\u200B12\n", "")
    expect(title).toBe("factory: abc # 12")
    const body = pullBody({ ...intent, decidedBy: "op\u202Eerator" }, facts)
    expect(body).toContain("(recorded actor: operator)")
  })

  it("cuts the quoted spec, never the digests, to fit GitHub's limit", () => {
    const body = pullBody({ ...intent, specText: "y".repeat(100_000) }, facts)
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT)
    expect(body).toContain("cut here to fit")
    expect(body).toContain("rc-reverify")
  })
})

describe("what the pull request's text can carry", () => {
  it("fences the changed paths, which the candidate names, so none can close an issue", () => {
    const hostile = {
      path: "a/fixes #1.ts",
      workspacePath: "a/fixes #1.ts",
      baselineBlob: "1".repeat(40),
      candidateBlob: "2".repeat(40),
    }
    const body = pullBody({ ...intent, paths: [hostile] }, facts)
    const line = `a/fixes # 1.ts: ${"1".repeat(40)} → ${"2".repeat(40)}`
    const at = body.indexOf(line)
    const before = body.slice(0, at)
    const opened = before.lastIndexOf("\n```\n")
    expect(at).toBeGreaterThan(0)
    expect(opened).toBeGreaterThan(before.indexOf("## Digests and receipts"))
    expect(body.indexOf("\n```\n", at)).toBeGreaterThan(at)
  })

  it("scrubs credential shapes from the model-written title, spec and commit message", () => {
    const token = `ghp_${"A".repeat(36)}`
    const title = pullTitle(`# leak ${token}\n`, "")
    expect(title.includes(token)).toBe(false)
    const body = pullBody({ ...intent, specText: `see ${token}\n` }, facts)
    expect(body.includes(token)).toBe(false)
    expect(commitMessage({ ...intent, title: `factory: ${token}` }).includes(token)).toBe(false)
  })
})

describe("scrub", () => {
  it("removes tokens, JWTs, PEM blocks, Authorization values and the named secrets", () => {
    const text = [
      "token ghs_AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "pat github_pat_11AAAAAAAAAAAAAAAAAAAAAA_bbbb",
      "authorization: Bearer abc.def",
      '"Authorization":"token xyz"',
      "jwt eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjEyM30.c2lnbmF0dXJlc2ln",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
      "secret-installation-token-value",
    ].join("\n")
    const out = scrub(text, ["secret-installation-token-value"])
    for (const leaked of [
      "ghs_AAAA",
      "github_pat_",
      "Bearer abc",
      "token xyz",
      "eyJhbGci",
      "MIIEpAIBAAKCAQEA",
      "secret-installation",
    ])
      expect(out).not.toContain(leaked)
  })
})

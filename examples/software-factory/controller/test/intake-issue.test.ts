import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { REPOSITORY_PATTERN } from "../src/lib/domain/work-order.ts"
import {
  type Exec,
  failureText,
  fetchIssue,
  issueText,
  repositoryFromRemoteUrl,
  resolvePin,
} from "../src/lib/intake/issue.ts"

const run = promisify(execFile)

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

/** An exec that records every call and answers each from `answers`, in order. */
function scripted(answers: readonly (string | Error)[]) {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  let index = 0
  const exec: Exec = async (file, args) => {
    calls.push({ file, args })
    const answer = answers[index++]
    if (answer === undefined) throw new Error(`unscripted call ${file} ${args.join(" ")}`)
    if (answer instanceof Error) throw answer
    return { stdout: answer }
  }
  return { exec, calls }
}

const ISSUE = {
  title: "Fix the flag",
  body: "The `--out` flag is ignored.\n",
  url: "https://x/778",
}

describe("fetchIssue", () => {
  it("asks gh for the issue and digests title and body", async () => {
    const { exec, calls } = scripted([JSON.stringify(ISSUE)])
    const issue = await fetchIssue({ repository: "cacheplane/b4run", number: 778, exec })
    expect(issue).toEqual({
      title: ISSUE.title,
      body: ISSUE.body,
      url: ISSUE.url,
      bodyDigest: sha256(`${ISSUE.title}\n${ISSUE.body}`),
    })
    expect(calls).toEqual([
      {
        file: "gh",
        args: ["issue", "view", "778", "--repo", "cacheplane/b4run", "--json", "title,body,url"],
      },
    ])
  })

  it("runs the gh the caller names", async () => {
    const { exec, calls } = scripted([JSON.stringify(ISSUE)])
    await fetchIssue({ repository: "cacheplane/b4run", number: 778, gh: "/opt/bin/gh", exec })
    expect(calls[0]?.file).toBe("/opt/bin/gh")
  })

  it("strips keys it did not ask for", async () => {
    const { exec } = scripted([JSON.stringify({ ...ISSUE, number: 778, state: "OPEN" })])
    const issue = await fetchIssue({ repository: "cacheplane/b4run", number: 778, exec })
    expect(Object.keys(issue).sort()).toEqual(["body", "bodyDigest", "title", "url"])
  })

  it("rejects output that is not JSON", async () => {
    const { exec } = scripted(["not json"])
    await expect(fetchIssue({ repository: "cacheplane/b4run", number: 778, exec })).rejects.toThrow(
      /not JSON/,
    )
  })

  it("rejects JSON without a title and a body", async () => {
    const { exec } = scripted([JSON.stringify({ title: "T", url: "u" })])
    await expect(fetchIssue({ repository: "cacheplane/b4run", number: 778, exec })).rejects.toThrow(
      /body/,
    )
    const { exec: numeric } = scripted([JSON.stringify({ title: 1, body: "B", url: "u" })])
    await expect(
      fetchIssue({ repository: "cacheplane/b4run", number: 778, exec: numeric }),
    ).rejects.toThrow(/title/)
  })

  it("propagates a gh failure with its stderr", async () => {
    const failure = Object.assign(new Error("Command failed: gh"), {
      stderr: "GraphQL: Could not resolve to an Issue (repository.issue)\n",
    })
    const { exec } = scripted([failure])
    await expect(fetchIssue({ repository: "cacheplane/b4run", number: 778, exec })).rejects.toThrow(
      /gh issue view failed for cacheplane\/b4run#778: .*Could not resolve/s,
    )
  })

  it("refuses a repository that is not owner/name before running anything", async () => {
    const { exec, calls } = scripted([])
    for (const repository of ["b4run", "owner/..", "../x", ".github/x", "owner/.hidden"])
      await expect(fetchIssue({ repository, number: 1, exec })).rejects.toThrow(/repository/)
    expect(REPOSITORY_PATTERN.test("cacheplane/b4run")).toBe(true)
    expect(REPOSITORY_PATTERN.test("o.w-n_er/na.me.git")).toBe(true)
    await expect(fetchIssue({ repository: "cacheplane/b4run", number: 0, exec })).rejects.toThrow(
      /number/,
    )
    expect(calls).toEqual([])
  })
})

describe("resolvePin", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567"

  it("fetches main and reads origin/main", async () => {
    const { exec, calls } = scripted(["", `${SHA}\n`])
    expect(await resolvePin({ repositoryRoot: "/repo", exec })).toBe(SHA)
    expect(calls).toEqual([
      { file: "git", args: ["-C", "/repo", "fetch", "origin", "main"] },
      { file: "git", args: ["-C", "/repo", "rev-parse", "origin/main"] },
    ])
  })

  it("pins the branch it is given", async () => {
    const { exec, calls } = scripted(["", `${SHA}\n`])
    expect(await resolvePin({ repositoryRoot: "/repo", branch: "release", exec })).toBe(SHA)
    expect(calls.map((c) => c.args.at(-1))).toEqual(["release", "origin/release"])
  })

  describe("against a real clone", () => {
    let dir: string
    afterEach(() => rmSync(dir, { recursive: true, force: true }))

    it("never leaves the operator's full clone shallow", async () => {
      dir = mkdtempSync(join(tmpdir(), "factory-pin-"))
      const root = join(dir, "repo")
      const git = (...args: string[]) =>
        run("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", ...args])
      await run("git", ["init", "-q", "-b", "main", root])
      // Two commits: a depth-1 fetch of a one-commit history has nothing to cut off, and would
      // pass this test whether or not the fetch was shallow.
      writeFileSync(join(root, "a"), "a\n")
      await git("add", "a")
      await git("commit", "-q", "-m", "a")
      writeFileSync(join(root, "b"), "b\n")
      await git("add", "b")
      await git("commit", "-q", "-m", "b")
      await git("remote", "add", "origin", root)
      const head = (await git("rev-parse", "HEAD")).stdout.trim()

      expect(await resolvePin({ repositoryRoot: root })).toBe(head)
      expect((await git("rev-parse", "--is-shallow-repository")).stdout.trim()).toBe("false")
      expect((await git("rev-list", "--count", "origin/main")).stdout.trim()).toBe("2")
    })
  })

  it("skips the fetch when told to", async () => {
    const { exec, calls } = scripted([`${SHA}\n`])
    expect(await resolvePin({ repositoryRoot: "/repo", fetch: false, exec })).toBe(SHA)
    expect(calls).toEqual([{ file: "git", args: ["-C", "/repo", "rev-parse", "origin/main"] }])
  })

  it("rejects a rev-parse answer that is not a commit sha", async () => {
    const { exec } = scripted(["", "origin/main\n"])
    await expect(resolvePin({ repositoryRoot: "/repo", exec })).rejects.toThrow(/origin\/main/)
  })

  it("propagates a fetch failure with its stderr", async () => {
    const failure = Object.assign(new Error("Command failed"), {
      stderr: "fatal: could not read from remote repository\n",
    })
    const { exec } = scripted([failure])
    await expect(resolvePin({ repositoryRoot: "/repo", exec })).rejects.toThrow(
      /git fetch failed.*could not read from remote/s,
    )
  })
})

describe("issueText", () => {
  const input = {
    title: "Fix the flag",
    body: "Body\n\n\n",
    repository: "cacheplane/b4run",
    number: 778,
  }

  it("renders the title, the reference and the body with one trailing newline", () => {
    expect(issueText(input)).toBe("# Fix the flag (cacheplane/b4run#778)\n\nBody\n")
    expect(issueText(input)).toBe(issueText({ ...input }))
    expect(issueText({ ...input, body: "Body" })).toBe(issueText(input))
  })

  it("normalises a CRLF body to LF", () => {
    expect(issueText({ ...input, body: "Body\r\nmore\r\n" })).toBe(
      "# Fix the flag (cacheplane/b4run#778)\n\nBody\nmore\n",
    )
    expect(issueText({ ...input, body: "Body\rmore\r\n\r\n" })).toBe(
      "# Fix the flag (cacheplane/b4run#778)\n\nBody\nmore\n",
    )
  })

  it("renders an empty body as the heading alone", () => {
    expect(issueText({ ...input, body: "" })).toBe("# Fix the flag (cacheplane/b4run#778)\n")
    expect(issueText({ ...input, body: "\r\n\n" })).toBe("# Fix the flag (cacheplane/b4run#778)\n")
  })
})

describe("failureText", () => {
  const failed = (fields: Record<string, unknown>) =>
    Object.assign(new Error("Command failed: gh issue view\nsome stderr"), fields)

  it("says a timeout is a timeout", () => {
    expect(failureText(failed({ killed: true, signal: "SIGTERM", code: null, stderr: "" }))).toBe(
      "timed out after 30s (SIGTERM)",
    )
  })

  it("includes stderr once, never the message that already embeds it", () => {
    expect(failureText(failed({ code: 1, stderr: "some stderr\n" }))).toBe("exited 1: some stderr")
    expect(failureText(failed({ code: 1, stderr: "" }))).toBe("exited 1")
  })

  it("falls back to the message when nothing else says why", () => {
    expect(failureText(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }))).toBe(
      "spawn gh ENOENT",
    )
    expect(failureText("boom")).toBe("boom")
  })

  it("names an overflowed buffer", () => {
    expect(failureText(failed({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }))).toBe(
      "output exceeded 1024 KiB",
    )
  })
})

describe("repositoryFromRemoteUrl", () => {
  it("reads owner/name from the GitHub remote forms", () => {
    expect(repositoryFromRemoteUrl("git@github.com:cacheplane/b4run.git\n")).toBe(
      "cacheplane/b4run",
    )
    expect(repositoryFromRemoteUrl("https://github.com/cacheplane/b4run.git")).toBe(
      "cacheplane/b4run",
    )
    expect(repositoryFromRemoteUrl("https://github.com/cacheplane/b4run")).toBe("cacheplane/b4run")
    expect(repositoryFromRemoteUrl("ssh://git@github.com/cacheplane/b4run.git")).toBe(
      "cacheplane/b4run",
    )
  })

  it("is null for anything else", () => {
    expect(repositoryFromRemoteUrl("/tmp/some/local/repo")).toBeNull()
    expect(repositoryFromRemoteUrl("https://gitlab.com/cacheplane/b4run.git")).toBeNull()
    expect(repositoryFromRemoteUrl("")).toBeNull()
  })
})

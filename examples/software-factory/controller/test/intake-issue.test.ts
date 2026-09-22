import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { REPOSITORY_PATTERN } from "../src/lib/domain/work-order.ts"
import {
  type Exec,
  fetchIssue,
  issueText,
  repositoryFromRemoteUrl,
  resolvePin,
} from "../src/lib/intake/issue.ts"

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

  it("fetches main shallowly and reads origin/main", async () => {
    const { exec, calls } = scripted(["", `${SHA}\n`])
    expect(await resolvePin({ repositoryRoot: "/repo", exec })).toBe(SHA)
    expect(calls).toEqual([
      { file: "git", args: ["-C", "/repo", "fetch", "--depth=1", "origin", "main"] },
      { file: "git", args: ["-C", "/repo", "rev-parse", "origin/main"] },
    ])
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
  it("renders the title, the reference and the body with one trailing newline", () => {
    const input = {
      title: "Fix the flag",
      body: "Body\n\n\n",
      repository: "cacheplane/b4run",
      number: 778,
    }
    expect(issueText(input)).toBe("# Fix the flag (cacheplane/b4run#778)\n\nBody\n")
    expect(issueText(input)).toBe(issueText({ ...input }))
    expect(issueText({ ...input, body: "Body" })).toBe(issueText(input))
    expect(issueText({ ...input, body: "" })).toBe("# Fix the flag (cacheplane/b4run#778)\n\n\n")
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

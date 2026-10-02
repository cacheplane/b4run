import { createHash } from "node:crypto"
import {
  type Comparison,
  type DeliveryAdapter,
  DeliveryError,
  type DeliverySession,
  type RemoteCommit,
  type RemotePull,
} from "../src/lib/delivery/adapter.ts"
import { blobId, type GitTreeEntry, treeId } from "../src/lib/delivery/git-objects.ts"

/**
 * An in-memory GitHub repository behind the `DeliveryAdapter` interface: real git object ids
 * (so the worker's local hashes are checked against something that computes them the same
 * way), refs that are created once and never moved, pull requests found by head, and a fault
 * script per method. A fault either fails a call before it does anything, or does it and then
 * loses the response, which is the case the outbox exists for.
 */

export type FakeMethod =
  | Exclude<keyof DeliverySession, "botLogin" | "identity" | "mergeMessages">
  | "open"

interface Fault {
  readonly method: FakeMethod
  readonly error: DeliveryError
  /** Perform the call, then throw: the write landed and its answer was lost. */
  readonly after: boolean
  remaining: number
}

export const BOT = "b4-factory[bot]"
export const REPOSITORY = "cacheplane/b4run"

export interface FakeGitHub extends DeliveryAdapter {
  readonly calls: FakeMethod[]
  readonly refs: Map<string, string>
  readonly pulls: RemotePull[]
  readonly issues: Map<number, "open" | "closed">
  readonly commits: Map<string, RemoteCommit>
  readonly rules: Map<string, readonly string[]>
  comparison: Comparison
  closing: readonly number[]
  /** Who `pull` reports as the author; the bot unless a test says otherwise. */
  author: string
  /** The login the session reports for the app; the guarded bot unless a test says otherwise. */
  botLogin: string
  /**
   * The repository's `squash_merge_commit_message` and `merge_commit_message`; GitHub's
   * defaults (`COMMIT_MESSAGES`, `PR_TITLE`) unless a test says otherwise; null when GitHub did
   * not show them.
   */
  mergeMessages: { squash: string | null; merge: string | null }
  /** Store each blob under this id instead of its own: GitHub disagreeing with the bytes. */
  corruptBlob: string | undefined
  /** Answer `createTree` with this id instead of the tree built: GitHub disagreeing with the change. */
  corruptTree: string | undefined
  /** Store each created commit as this returns it: GitHub reading back another commit. */
  rewriteCommit: ((commit: RemoteCommit) => RemoteCommit) | undefined
  /** Create pull requests ready for review rather than draft: GitHub ignoring `draft: true`. */
  createReady: boolean
  /** Called before each call, with its method: a test aborts or throws mid-request here. */
  onCall: ((method: FakeMethod) => void) | undefined
  /** Fail or lose the next `times` calls of `method`. */
  fail(
    method: FakeMethod,
    error: DeliveryError,
    options?: { after?: boolean; times?: number },
  ): void
  /**
   * Seed `main` with one commit holding `files`; its id is `pin` when given (a test that
   * drives a real work order names the pin the row was created at).
   */
  seed(
    files: Readonly<Record<string, string>>,
    pin?: string,
    executable?: readonly string[],
  ): { readonly pin: string; readonly tree: string }
  /** Advance `main` by one commit changing `files` (repository paths). */
  advanceMain(files: Readonly<Record<string, string>>): string
  /** The files at a commit, flattened, for assertions. */
  filesAt(commit: string): Record<string, string>
  writes(): FakeMethod[]
}

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex")
const WRITES: ReadonlySet<FakeMethod> = new Set<FakeMethod>([
  "createBlob",
  "createTree",
  "createCommit",
  "createBranch",
  "createDraftPull",
])

export function createFakeGitHub(): FakeGitHub {
  const blobs = new Map<string, string>()
  const trees = new Map<string, GitTreeEntry[]>()
  const commits = new Map<string, RemoteCommit>()
  const refs = new Map<string, string>()
  const pulls: RemotePull[] = []
  const issues = new Map<number, "open" | "closed">()
  const rules = new Map<string, readonly string[]>([
    ["main", ["update", "deletion"]],
    ["factory/*", ["update", "non_fast_forward"]],
  ])
  const faults: Fault[] = []
  const calls: FakeMethod[] = []

  /** Store `files` (path → text) as nested trees; returns the root tree id. */
  function build(files: ReadonlyMap<string, { mode: string; sha: string }>): string {
    const children = new Map<string, Map<string, { mode: string; sha: string }>>()
    const own: GitTreeEntry[] = []
    for (const [path, entry] of files) {
      const slash = path.indexOf("/")
      if (slash === -1) own.push({ name: path, mode: entry.mode, type: "blob", sha: entry.sha })
      else {
        const dir = path.slice(0, slash)
        const inner = children.get(dir) ?? new Map()
        inner.set(path.slice(slash + 1), entry)
        children.set(dir, inner)
      }
    }
    for (const [dir, inner] of children)
      own.push({ name: dir, mode: "040000", type: "tree", sha: build(inner) })
    const sha = treeId(own)
    trees.set(sha, own)
    return sha
  }
  function flatten(tree: string, prefix = ""): Map<string, { mode: string; sha: string }> {
    const out = new Map<string, { mode: string; sha: string }>()
    for (const entry of trees.get(tree) ?? []) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`
      if (entry.type === "tree") for (const [p, e] of flatten(entry.sha, path)) out.set(p, e)
      else out.set(path, { mode: entry.mode, sha: entry.sha })
    }
    return out
  }
  function putCommit(tree: string, parents: readonly string[], message: string): string {
    const sha = sha1(JSON.stringify({ tree, parents, message }))
    commits.set(sha, { sha, tree, parents: [...parents] })
    return sha
  }

  const fake: FakeGitHub = {
    calls,
    refs,
    pulls,
    issues,
    commits,
    rules,
    comparison: { status: "ahead", aheadBy: 3, files: [{ filename: "README.md" }], complete: true },
    closing: [],
    author: BOT,
    botLogin: BOT,
    mergeMessages: { squash: "COMMIT_MESSAGES", merge: "PR_TITLE" },
    corruptBlob: undefined,
    corruptTree: undefined,
    rewriteCommit: undefined,
    createReady: false,
    onCall: undefined,
    fail(method, error, { after = false, times = 1 } = {}) {
      faults.push({ method, error, after, remaining: times })
    },
    seed(files, pinId, executable = []) {
      const blobsOf = new Map(
        Object.entries(files).map(([path, text]) => {
          const sha = blobId(text)
          blobs.set(sha, text)
          return [path, { mode: executable.includes(path) ? "100755" : "100644", sha }] as const
        }),
      )
      const tree = build(blobsOf)
      const pin = pinId ?? putCommit(tree, [], "pin")
      commits.set(pin, { sha: pin, tree, parents: [] })
      refs.set("main", pin)
      return { pin, tree }
    },
    advanceMain(files) {
      const head = refs.get("main") as string
      const flat = flatten((commits.get(head) as RemoteCommit).tree)
      for (const [path, text] of Object.entries(files)) {
        blobs.set(blobId(text), text)
        flat.set(path, { mode: flat.get(path)?.mode ?? "100644", sha: blobId(text) })
      }
      const next = putCommit(build(flat), [head], "main moves")
      refs.set("main", next)
      return next
    },
    filesAt(commit) {
      const flat = flatten((commits.get(commit) as RemoteCommit).tree)
      return Object.fromEntries([...flat].map(([path, e]) => [path, blobs.get(e.sha) ?? "?"]))
    },
    writes: () => calls.filter((c) => WRITES.has(c)),
    secrets: () => ["ghs_faketokenfaketokenfaketoken0001"],
    async open() {
      return run("open", () => session)
    },
  }

  /** Apply the fault script around one call. */
  async function run<T>(method: FakeMethod, perform: () => T): Promise<T> {
    calls.push(method)
    fake.onCall?.(method)
    const fault = faults.find((f) => f.method === method && f.remaining > 0)
    if (fault !== undefined) {
      fault.remaining -= 1
      if (fault.after) perform()
      throw fault.error
    }
    return perform()
  }
  const notFound = (what: string) =>
    new DeliveryError("not_found", `${what} not found`, undefined, 404)

  const session: DeliverySession = {
    get botLogin() {
      return fake.botLogin
    },
    identity: { name: BOT, email: `123+${BOT}@users.noreply.github.com` },
    get mergeMessages() {
      return { ...fake.mergeMessages }
    },
    branchRules: (branch) =>
      run(
        "branchRules",
        () => rules.get(branch.startsWith("factory/") ? "factory/*" : branch) ?? [],
      ),
    issueState: (number) => run("issueState", () => issues.get(number) ?? "open"),
    branchHead: (branch) => run("branchHead", () => refs.get(branch) ?? null),
    compare: () => run("compare", () => fake.comparison),
    commit: (sha) =>
      run("commit", () => {
        const found = commits.get(sha)
        if (!found) throw notFound(`commit ${sha}`)
        return found
      }),
    tree: (sha) =>
      run("tree", () => {
        const found = trees.get(sha)
        if (!found) throw notFound(`tree ${sha}`)
        return found
      }),
    createBlob: (text) =>
      run("createBlob", () => {
        const sha = fake.corruptBlob ?? blobId(text)
        blobs.set(sha, text)
        return sha
      }),
    createTree: (baseTree, entries) =>
      run("createTree", () => {
        const flat = flatten(baseTree)
        for (const entry of entries) flat.set(entry.path, { mode: entry.mode, sha: entry.sha })
        const built = build(flat)
        return fake.corruptTree ?? built
      }),
    createCommit: (input) =>
      run("createCommit", () => {
        const sha = putCommit(input.tree, input.parents, `${input.message}${input.author.date}`)
        const stored = commits.get(sha) as RemoteCommit
        if (fake.rewriteCommit !== undefined) commits.set(sha, fake.rewriteCommit(stored))
        return sha
      }),
    createBranch: (branch, sha) =>
      run("createBranch", () => {
        if (refs.has(branch)) return "exists" as const
        if (!commits.has(sha))
          throw new DeliveryError("conflict", "Object does not exist", undefined, 422)
        refs.set(branch, sha)
        return "created" as const
      }),
    pullsByHead: (branch) => run("pullsByHead", () => pulls.filter((p) => p.headRef === branch)),
    createDraftPull: (input) =>
      run("createDraftPull", () => {
        // GitHub's head is `<owner>:<branch>`: a fork's pull request on the same branch name
        // is another head.
        if (
          pulls.some(
            (p) =>
              p.headRef === input.head && p.headRepository === REPOSITORY && p.state === "open",
          )
        )
          return "exists" as const
        const head = refs.get(input.head)
        if (head === undefined)
          throw new DeliveryError("conflict", "head does not exist", undefined, 422)
        const number = 1000 + pulls.length
        const pull: RemotePull = {
          number,
          url: `https://github.com/${REPOSITORY}/pull/${number}`,
          nodeId: `PR_${number}`,
          state: "open",
          draft: !fake.createReady,
          merged: false,
          author: fake.author,
          headRef: input.head,
          headRepository: REPOSITORY,
          headSha: head,
          baseRef: input.base,
        }
        pulls.push(pull)
        return pull
      }),
    pull: (number) =>
      run("pull", () => {
        const found = pulls.find((p) => p.number === number)
        if (!found) throw notFound(`pull ${number}`)
        return { ...found, author: fake.author }
      }),
    closingIssues: () => run("closingIssues", () => fake.closing),
  }
  return fake
}

import { readFileSync } from "node:fs"
import { ThreadWorkspaceReadError } from "@b4run/cli/workspace"
import { describe, expect, it } from "vitest"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { targetInspectionOptions } from "../src/lib/targets/workspace.ts"
import {
  createHttpThreadWorkspaceReader,
  InvalidWorkspaceRootError,
  WORKSPACE_READ_NOT_SERVED_HINT,
  type WorkspaceReadOptions,
  WorkspaceRootMissingError,
  workspaceReadFailure,
} from "../src/lib/worker/workspace-reader.ts"
import { createFakeWorkspaceReader } from "./fake-workspace-reader.ts"

const DIGEST = "d".repeat(64)

/** Every read names the thread, the task (inspection options are per task) and the handed digest. */
const target = (threadId: string, taskId = "cli-flags") => ({
  threadId,
  taskId,
  sourceDigest: DIGEST,
})

describe("fake workspace reader", () => {
  it("returns the scripted bytes for a thread and rejects an unknown one", async () => {
    const reader = createFakeWorkspaceReader({ "t-1": { "src/cli.ts": "fixed\n" } })
    expect(await reader.read(target("t-1"), AbortSignal.timeout(1_000))).toEqual(
      new Map([["src/cli.ts", "fixed\n"]]),
    )
    await expect(reader.read(target("t-2"), AbortSignal.timeout(1_000))).rejects.toThrow(/t-2/)
  })

  it("records every thread it was asked to read", async () => {
    const reader = createFakeWorkspaceReader({ "t-1": {} })
    await reader.read(target("t-1"), AbortSignal.timeout(1_000))
    expect(reader.reads).toEqual(["t-1"])
  })
})

/**
 * The real reader is `POST /threads/:id/workspace/inspect` on the worker that holds the
 * thread. What the worker does with the request (the managed reader, `inspectWorkspace`, the
 * root, the limits) is the framework's and is proved there; what is proved here is the
 * controller's half: what it sends, what it accepts, and how each refusal reaches the phases
 * that journal it.
 */
describe("the HTTP thread workspace reader", () => {
  const answer = (files: Record<string, string>, extra: Record<string, unknown> = {}) => ({
    threadId: "t-1",
    sourceDigest: DIGEST,
    intentDigest: "e".repeat(64),
    inspection: { files, symlinks: {}, totalBytes: 1, entries: 1 },
    ...extra,
  })
  const scripted =
    (status: number, body: unknown, seen: Request[] = []) =>
    async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init))
      return Response.json(body, { status })
    }
  const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    scripted(status, {
      error: { kind: "request_error", message: code, details: { code, ...extra } },
    })
  const options = (root?: string): WorkspaceReadOptions => ({
    excludeRootDirectories: [],
    expectedRootSymlinks: {},
    ...(root === undefined ? {} : { root }),
  })

  it("sends the token and the task's options, and re-prefixes keys with the root", async () => {
    const seen: Request[] = []
    const reader = createHttpThreadWorkspaceReader(
      {
        url: "http://drafter:4200/",
        token: "tok",
        fetch: scripted(200, answer({ "task.json": "{}" }, { root: "draft" }), seen),
      },
      () => options("draft"),
    )
    const files = await reader.read(
      { threadId: "t-1", sourceDigest: DIGEST },
      AbortSignal.timeout(1_000),
    )
    expect(files).toEqual(new Map([["draft/task.json", "{}"]]))
    expect(seen).toHaveLength(1)
    expect(seen[0]?.method).toBe("POST")
    expect(seen[0]?.url).toBe("http://drafter:4200/threads/t-1/workspace/inspect")
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok")
    expect(await seen[0]?.json()).toEqual({
      root: "draft",
      excludeRootDirectories: [],
      expectedRootSymlinks: {},
      maxEntries: 10_000,
      maxFileBytes: 2 * 1024 * 1024,
      maxTotalBytes: 16 * 1024 * 1024,
    })
  })

  it("sends the builder task's own inspection options whole", async () => {
    const seen: Request[] = []
    const reader = createHttpThreadWorkspaceReader(
      { url: "http://builder:4100", token: "tok", fetch: scripted(200, answer({}), seen) },
      (taskId) => targetInspectionOptions(loadTask(taskId as string)),
    )
    await reader.read(target("t-1"), AbortSignal.timeout(1_000))
    const task = targetInspectionOptions(loadTask("cli-flags"))
    expect(await seen[0]?.json()).toMatchObject({
      excludeRootDirectories: [".git"],
      expectedRootSymlinks: task.expectedRootSymlinks,
      ignorePrefixes: task.ignorePrefixes,
    })
    expect(Object.keys(task.expectedRootSymlinks)).toContain("node_modules")
  })

  it("drops paths under ignorePrefixes even from a worker that did not", async () => {
    const reader = createHttpThreadWorkspaceReader(
      {
        url: "http://builder:4100",
        token: "tok",
        fetch: scripted(
          200,
          answer({
            "src/a.ts": "source\n",
            "packages/x/dist/a.js": "built\n",
            "packages/x/dist-notes.ts": "not build output\n",
          }),
        ),
      },
      () => ({ ...options(), ignorePrefixes: ["packages/x/dist/"] }),
    )
    // A prefix match, not a path-segment one by accident: `dist-notes.ts` shares the first
    // characters of the directory prefix and is NOT build output, so it survives.
    expect(
      [...(await reader.read(target("t-1"), AbortSignal.timeout(1_000))).keys()].sort(),
    ).toEqual(["packages/x/dist-notes.ts", "src/a.ts"])
  })

  it("maps the worker's missing-root refusal to WorkspaceRootMissingError, with its kind", async () => {
    for (const kind of ["absent", "not_directory"] as const) {
      const reader = createHttpThreadWorkspaceReader(
        {
          url: "http://drafter:4200",
          token: "tok",
          fetch: refusal(422, "workspace_root_missing", { root: "draft", kind }),
        },
        () => options("draft"),
      )
      const error = await reader
        .read({ threadId: "t-1", sourceDigest: DIGEST }, AbortSignal.timeout(1_000))
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(WorkspaceRootMissingError)
      expect(error).toMatchObject({ root: "draft", kind })
    }
  })

  it("is a missing-root verdict only for a 422 naming the requested root", async () => {
    // Each of these carries the code, but not the whole of the worker's refusal: a code on
    // another status, a refusal about another root, or one naming no root is a read the
    // controller could not make, never a verdict that spends an attempt.
    for (const [status, extra] of [
      [409, { root: "draft", kind: "absent" }],
      [500, { root: "draft", kind: "absent" }],
      [422, { root: "other", kind: "absent" }],
      [422, { root: "draft/nested", kind: "absent" }],
      [422, { kind: "absent" }],
    ] as const) {
      const reader = createHttpThreadWorkspaceReader(
        {
          url: "http://drafter:4200",
          token: "tok",
          fetch: refusal(status, "workspace_root_missing", extra),
        },
        () => options("draft"),
      )
      const error = await reader
        .read({ threadId: "t-1", sourceDigest: DIGEST }, AbortSignal.timeout(1_000))
        .catch((e: unknown) => e)
      expect(error).not.toBeInstanceOf(WorkspaceRootMissingError)
      expect(error).toMatchObject({ status, code: "workspace_root_missing" })
    }
    // A read with no root asked for cannot have a missing one, whatever the worker says.
    const rootless = createHttpThreadWorkspaceReader(
      {
        url: "http://builder:4100",
        token: "tok",
        fetch: refusal(422, "workspace_root_missing", { root: "draft", kind: "absent" }),
      },
      () => options(),
    )
    await expect(
      rootless.read(target("t-1"), AbortSignal.timeout(1_000)),
    ).rejects.not.toBeInstanceOf(WorkspaceRootMissingError)
  })

  it("journals a bare 404 with a hint that the worker may not serve the read", async () => {
    const bare = createHttpThreadWorkspaceReader(
      {
        url: "http://builder:4100",
        token: "tok",
        fetch: scripted(404, { error: { kind: "request_error", message: "Not found" } }),
      },
      () => options(),
    )
    const error = await bare.read(target("t-1"), AbortSignal.timeout(1_000)).catch((e) => e)
    expect(workspaceReadFailure(error)).toEqual({
      status: 404,
      hint: WORKSPACE_READ_NOT_SERVED_HINT,
    })
    expect(WORKSPACE_READ_NOT_SERVED_HINT).toContain('sandbox.workspaceRead: "http"')
    // A 404 that names its code is the worker's answer about the thread, not the route.
    for (const code of ["thread_not_found", "workspace_lost", "workspace_not_found"]) {
      const named = createHttpThreadWorkspaceReader(
        { url: "http://builder:4100", token: "tok", fetch: refusal(404, code) },
        () => options(),
      )
      const refused = await named.read(target("t-1"), AbortSignal.timeout(1_000)).catch((e) => e)
      expect(workspaceReadFailure(refused)).toEqual({ status: 404, code })
    }
    // Anything that is not the client's error carries nothing extra.
    expect(workspaceReadFailure(new Error("boom"))).toEqual({})
  })

  it("refuses an answer about another source", async () => {
    const reader = createHttpThreadWorkspaceReader(
      { url: "http://builder:4100", token: "tok", fetch: scripted(200, answer({ "a.ts": "" })) },
      () => options(),
    )
    await expect(
      reader.read(
        { threadId: "t-1", taskId: "cli-flags", sourceDigest: "f".repeat(64) },
        AbortSignal.timeout(1_000),
      ),
    ).rejects.toMatchObject({ name: "ThreadWorkspaceReadError", code: "source_mismatch" })
  })

  it("refuses an answer about another thread", async () => {
    const reader = createHttpThreadWorkspaceReader(
      {
        url: "http://builder:4100",
        token: "tok",
        fetch: scripted(200, answer({ "a.ts": "" }, { threadId: "t-2" })),
      },
      () => options(),
    )
    await expect(reader.read(target("t-1"), AbortSignal.timeout(1_000))).rejects.toMatchObject({
      code: "thread_mismatch",
    })
  })

  it("keeps every other refusal the worker's own, code and status intact", async () => {
    for (const [status, code] of [
      [403, "forbidden"],
      [404, "thread_not_found"],
      [404, "workspace_lost"],
      [409, "run_in_flight"],
      [409, "workspace_changed"],
      [410, "workspace_expired"],
      [422, "workspace_inspection_refused"],
      [503, "workspace_unavailable"],
      [504, "workspace_read_timeout"],
    ] as const) {
      const reader = createHttpThreadWorkspaceReader(
        { url: "http://builder:4100", token: "tok", fetch: refusal(status, code) },
        () => options("draft"),
      )
      const error = await reader.read(target("t-1"), AbortSignal.timeout(1_000)).catch((e) => e)
      expect(error).toBeInstanceOf(ThreadWorkspaceReadError)
      expect(error).not.toBeInstanceOf(WorkspaceRootMissingError)
      expect(error).toMatchObject({ status, code })
    }
  })

  it("refuses a malformed root before any request", async () => {
    const seen: Request[] = []
    for (const root of ["..", "draft/..", "/draft", "draft\0", "", "draft/", "./draft", "a\\b"]) {
      const reader = createHttpThreadWorkspaceReader(
        { url: "http://w", token: "tok", fetch: scripted(200, answer({}), seen) },
        () => options(root),
      )
      await expect(
        reader.read({ threadId: "t-1", sourceDigest: DIGEST }, AbortSignal.timeout(1_000)),
      ).rejects.toBeInstanceOf(InvalidWorkspaceRootError)
    }
    expect(seen).toEqual([])
  })

  it("refuses an unknown task before any request", async () => {
    const seen: Request[] = []
    const reader = createHttpThreadWorkspaceReader(
      { url: "http://w", token: "tok", fetch: scripted(200, answer({}), seen) },
      (taskId) => targetInspectionOptions(loadTask(taskId as string)),
    )
    await expect(
      reader.read(target("t-1", "no-such-task"), AbortSignal.timeout(1_000)),
    ).rejects.toThrow(/Unknown task/)
    expect(seen).toEqual([])
  })
})

/**
 * The two structural inspection options are required rather than defaulted-absent: the
 * workspace has a git baseline and a dependency symlink, so a reader without them throws on
 * the symlink or reports the git directory as added paths — a scope violation on every run.
 * They are derived from the workspace definition rather than restated by each caller.
 */
describe("inspection options travel with the reader", () => {
  it("is described in the README by the options the replacement must carry", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8")
    expect(readme).toMatch(/excludeRootDirectories/)
    expect(readme).toMatch(/expectedRootSymlinks/)
    expect(readme).toMatch(/WorkspaceInspectionOptions/)
  })
})

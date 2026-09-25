import { randomUUID } from "node:crypto"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { withWorkspace } from "@b4run/cli"
import type { SandboxProvider } from "@b4run/workspace"
import { inspectWorkspace } from "@b4run/workspace"
import { captureDirectory } from "../targets/archive.js"
import type { Task } from "../targets/catalog.js"
import {
  targetInspectionOptions,
  targetSandboxPolicy,
  targetWorkspace,
} from "../targets/workspace.js"
import { runBuild, runSuite, type SuiteResult } from "./checks-runner.js"

/** Which of a task's two suites a session exists to grade. */
export type SuiteKind = "visible" | "independent"

/** What one container session found out. `result` is null only when the build failed. */
export interface SuiteSession {
  readonly build: { ok: boolean; output: string }
  readonly tampered: boolean
  readonly result: SuiteResult | null
}

export interface GradeSuiteInput {
  readonly task: Task
  readonly kind: SuiteKind
  /** The candidate's changed files, written into this session's own capture. */
  readonly changes: Readonly<Record<string, string>>
  /** The verifier's provider, shared only so both sessions report one identity. */
  readonly provider: SandboxProvider
  /** The verifier's composed deadline-and-caller signal; it bounds every session. */
  readonly signal: AbortSignal
  /**
   * Where the session's capture (`captures/verifier/...`) and its workspace state root
   * (`verifiers/<uuid>`) are staged: the controller's `FACTORY_STATE_DIR`, never its app
   * root, which `b4 dev` watches (see `CaptureTargetOptions.captureRoot`).
   */
  readonly stagingRoot: string
}

/**
 * Grade one suite in a container that only that suite ran in.
 *
 * Each call is a whole verification of its own: its own capture instance, its own state root,
 * its own container, its own build. Nothing is carried between calls but the candidate's
 * bytes, which the controller holds.
 *
 * That is the point, and it is the RFC's own recommendation (§9.3, "place the oracle and
 * result collection in a separate trusted process"). The candidate's source is imported by
 * the visible suite, so module-level code in it runs inside the visible session's container
 * and can leave a detached, unref'd process behind; `--init` reaps zombies, not live detached
 * children. When the two suites shared a container that process could act on the oracle's
 * input later — in the gap between the visible post-snapshot and the independent
 * pre-snapshot, a gap that could not be closed because the check file had to be written in
 * it. With a container per suite there is no later: the independent session is a fresh
 * container in which the visible suite's test code has never run, and its build does not
 * execute candidate code (`tsc -b` compiles, it does not run) — which holds only because the
 * controller's assembly rule confines `changes` to the task's `allowedSourcePaths`, with the
 * tsconfig and the vitest config among the immutable paths. This function writes whatever it
 * is handed, so that precondition lives in the caller, not here.
 *
 * What the independent session does NOT remove is candidate code as such. Its check imports
 * the BUILT artifact, and for devkit that artifact re-exports the allowed source path, so the
 * candidate's module-level code runs in this session too. What is gone is the visible suite's
 * long-running test code; whatever the artifact itself does is bounded by this session's own
 * before-and-after snapshot.
 *
 * The independent session writes its check file BEFORE its first snapshot, so the file is
 * present in both snapshots of the window and the two snapshots collapse into one continuous
 * observation. The visible session never sees that file at all, so the checks a candidate is
 * graded against remain out of its reach for the same structural reason as before.
 */
export async function gradeSuite(input: GradeSuiteInput): Promise<SuiteSession> {
  const { task, kind, provider, signal, stagingRoot } = input
  const target = task.target
  // Per-session, not per-verification: two sessions that shared a capture directory would
  // rebuild it under each other, and the isolation is the whole point.
  const instance = randomUUID()
  const stateRoot = join(stagingRoot, "verifiers", randomUUID())
  const inspection = targetInspectionOptions(task)

  try {
    return await withWorkspace(
      {
        appRoot: stagingRoot,
        stateRoot,
        provider,
        workspace: targetWorkspace(task, "verifier", { instance, captureRoot: stagingRoot }),
        policy: targetSandboxPolicy(target),
        signal,
      },
      async (handle) => {
        const snapshot = async () =>
          (
            await inspectWorkspace(handle, {
              signal,
              // The framework's defaults, restated so a change there is visible here; the
              // reader's options spread after them so a target that raises the reader's
              // limits raises these too.
              maxEntries: 10_000,
              maxFileBytes: 2 * 1024 * 1024,
              maxTotalBytes: 16 * 1024 * 1024,
              // The reader's own options, spread whole rather than picked apart: a new one
              // must not be silently dropped here. `ignorePrefixes`
              // rides along and is deliberately NOT honoured by this snapshot: it is
              // reader-side, where build output must not read as an added candidate path,
              // whereas the tamper comparison wants to see everything the walk found. The
              // framework ignores keys it does not know, so passing it here is inert rather
              // than wrong.
              ...inspection,
            })
          ).files

        for (const [path, content] of Object.entries(input.changes))
          await handle.filesystem.writeFile(join(handle.workspaceRoot, path), content, {
            workspaceRoot: handle.workspaceRoot,
            signal,
          })

        const build = await runBuild(handle, target, signal)
        if (!build.ok) return { build, tampered: false, result: null }

        // Written before the first snapshot, from the controller's own copy, and only in the
        // session that grades it: the visible suite runs in another container and never sees
        // this file, so it can neither read, edit nor delete the checks it is graded against.
        if (kind === "independent") {
          const name = task.checks.independent.file.replace(/^checks\//, "")
          await handle.filesystem.writeFile(
            join(handle.workspaceRoot, "checks", name),
            await readFile(join(task.directory, "checks", name), "utf8"),
            { workspaceRoot: handle.workspaceRoot, signal },
          )
        }

        const before = await snapshot()
        const result = await runSuite(handle, target, task.checks[kind], signal)
        return { build, tampered: changedDuringSuite(before, await snapshot()), result }
      },
    )
  } finally {
    // `allSettled`, and neither awaited alone: a cleanup that fails must not replace the
    // verdict (or the caller's own cancellation) with its own error. The capture is removed
    // only once `withWorkspace` has returned, because the framework captures the source at
    // workspace preparation and does not read it after the callback ends.
    await Promise.allSettled([
      rm(stateRoot, { recursive: true, force: true }),
      rm(join(stagingRoot, captureDirectory(task.id, "verifier", instance)), {
        recursive: true,
        force: true,
      }),
    ])
  }
}

/**
 * Any persistent difference at all between two snapshots, compared over sorted entries.
 *
 * Nothing is excluded, and the target's `snapshotIgnore` in particular is not consulted here.
 * The build completes before the first snapshot is taken, so any change under the target's
 * build output while a suite runs is a suite writing where it must not — and the independent
 * oracle reads that very directory (for `devkit`, the built
 * `packages/devkit/dist/testing/index.js`). An exclusion here would therefore blind the tamper
 * check to exactly the bytes it exists to protect.
 *
 * `snapshotIgnore` keeps its other two consumers — the workspace's `.gitignore` and the
 * reader's `ignorePrefixes`, where build output legitimately must not read as a candidate path.
 */
export function changedDuringSuite(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): boolean {
  const sorted = (files: Readonly<Record<string, string>>): [string, string][] =>
    Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return JSON.stringify(sorted(before)) !== JSON.stringify(sorted(after))
}

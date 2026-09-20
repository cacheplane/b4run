import { dockerSandbox } from "@b4run/sandbox"
import type { SandboxPolicy, SandboxProvider, WorkspaceDefinition } from "@b4run/workspace"
import type { WorkspaceReadOptions } from "../worker/workspace-reader.js"
import { type CaptureRole, type CaptureTargetOptions, captureTarget } from "./archive.js"
import { imageTag, type Target, type Task } from "./catalog.js"

/**
 * Storage identity for the builder's sandboxes. Both the builder's own configuration and the
 * controller's reader construct a provider from this, in different processes: the scope and
 * the image are what address a thread's workspace, so a reader built with either different
 * would open a different (or no) workspace. One constructor, so they cannot drift apart.
 */
export const builderSandboxScope = "software-factory-builder"

/** The builder's sandbox provider for a target. Construct one per process; it holds no shared state. */
export function builderSandboxProvider(target: Target): SandboxProvider {
  return dockerSandbox({ scope: builderSandboxScope, image: imageTag(target) })
}

/** Denied network, and the target's measured CPU, memory and per-command ceiling. */
export function targetSandboxPolicy(target: Target): SandboxPolicy {
  return {
    network: { mode: "deny" },
    env: { npm_config_cache: "/tmp/npm-cache", npm_config_update_notifier: "false" },
    resources: {
      memoryMb: target.resources.memoryMb,
      cpus: target.resources.cpus,
      timeoutMs: target.resources.commandTimeoutMs,
    },
  }
}

/**
 * Pure declaration of what the workspace contains: the role's archive of the pinned subtree
 * with the defect applied, the task spec as TASK.md, and the image's dependency tree linked
 * at the root. The independent checks are not in the capture at all: the verifier writes
 * them into its own container after the visible suite has run.
 */
export function targetWorkspace(
  task: Task,
  role: CaptureRole,
  options: CaptureTargetOptions = {},
): WorkspaceDefinition {
  const captured = captureTarget(task, role, options)
  return {
    source: {
      directory: captured.directory,
      include: [...task.target.capture.include],
      files: [
        { path: "TASK.md", text: task.specText },
        { path: ".gitignore", text: "node_modules/\n" },
      ],
    },
    environmentLinks: task.target.environmentLinks.map((link) => ({ ...link })),
    baseline: "git",
  }
}

/**
 * How a workspace built from {@link targetWorkspace} must be inspected, derived from the
 * target rather than restated by each caller: `baseline: "git"` puts a `.git` directory in the
 * workspace that is not part of the capture, and each environment link is a root symlink
 * inspection refuses to walk unless told its exact target. The reader and the verifier share
 * this so they cannot drift apart. Limits are the reader's: a monorepo capture is larger than
 * a fixture.
 */
export function targetInspectionOptions(task: Task): WorkspaceReadOptions {
  const expectedRootSymlinks: Record<string, string> = {}
  for (const link of task.target.environmentLinks) expectedRootSymlinks[link.path] = link.target
  const policy = targetSandboxPolicy(task.target)
  return {
    excludeRootDirectories: [".git"],
    expectedRootSymlinks,
    maxEntries: 10_000,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    ...(policy.security?.runAsNonRoot === undefined
      ? {}
      : { runAsNonRoot: policy.security.runAsNonRoot }),
  }
}

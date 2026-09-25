import { readdirSync } from "node:fs"
import { dockerSandbox } from "@b4run/sandbox"
import type { SandboxPolicy, SandboxProvider, WorkspaceDefinition } from "@b4run/workspace"
import { isFactoryImage } from "../builder-manifest.js"
import type { WorkspaceReadOptions } from "../worker/workspace-reader.js"
import { type CaptureRole, type CaptureTargetOptions, captureTarget } from "./archive.js"
import type { Target, Task } from "./catalog.js"

/**
 * Every regular file under `absolute`, relative to it, forward-slash, sorted.
 *
 * The framework's own source capture requires `source.include` to name every file the
 * capture will contain, exactly: it walks the whole directory and rejects anything the list
 * does not name one-for-one. The target's own `capture.include` (used for `git archive` and
 * for the environment identity) is not that list — a directory entry like `src` is shorthand
 * there for everything under it — so the flat inventory is derived here from what the archive
 * actually extracted, rather than restating the target's directory-shaped list.
 */
function capturedFiles(absolute: string): string[] {
  const found: string[] = []
  const stack: string[] = [""]
  while (stack.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: stack.length > 0 guards this pop
    const relative = stack.pop()!
    const directory = relative ? `${absolute}/${relative}` : absolute
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile()) found.push(child)
      else throw new Error(`Unsupported entry in capture: ${child}`)
    }
  }
  return found.sort()
}

/** Names {@link targetWorkspace} injects itself; a captured file cannot also claim one. */
const RESERVED_CAPTURE_PATHS = ["TASK.md", ".gitignore"]

/**
 * Storage identity for the builder's sandboxes: the builder's `b4.config.ts` and the
 * controller's reader both use it, in different processes. A managed workspace is addressed
 * by this scope, the daemon and the thread's recorded operation; its image is in its record.
 */
export const builderSandboxScope = "software-factory-builder"

/**
 * The builder's sandbox provider, as the controller's reader constructs it. The scope is the
 * whole of the address a managed workspace needs: the image is read from the thread's own
 * record (proved in @b4run/sandbox's managed-workspace test "the image is the intent's"), so
 * this provider has no default image and serves every target's threads. It allows only the
 * factory's own images, as the builder's does.
 */
export function builderSandboxProvider(): SandboxProvider {
  return dockerSandbox({ scope: builderSandboxScope, images: isFactoryImage })
}

/**
 * The drafter's sandbox provider. The scope and the image MUST equal the drafter app's own
 * config (`drafter/b4.config.ts`: scope `software-factory-drafter`, image `DRAFTER_IMAGE`
 * unless `FACTORY_DRAFTER_IMAGE` overrides it) because the two values are the whole of the
 * provider's identity: they are what address a drafter thread's workspace, and a reader
 * built with either different would open a different (or no) workspace. The image reaches
 * the controller through its configuration, never by importing the drafter's source.
 */
export function drafterSandboxProvider(image: string): SandboxProvider {
  return dockerSandbox({ scope: "software-factory-drafter", image })
}

/**
 * How a drafter thread is inspected. These bounds apply to the re-rooted `draft/` read
 * (the reader's `root` option, Task 3) and never to `repo/`: the wide capture holds
 * executables and more bytes than an inspection allows, and is never read back.
 * Four small text files is the whole of what the drafter is expected to write; a `draft/`
 * that is larger than this is refused rather than read. No environment links and no
 * baseline, so no root symlinks and no `.git` to exclude.
 */
export function drafterInspectionOptions(): WorkspaceReadOptions {
  return {
    excludeRootDirectories: [],
    expectedRootSymlinks: {},
    maxEntries: 200,
    maxFileBytes: 512 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
  }
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
 * at the root. The independent checks are not in the capture at all: the verifier writes them
 * into the container of the session that grades them, which is not the one the visible suite
 * ran in.
 */
export function targetWorkspace(
  task: Task,
  role: CaptureRole,
  options: CaptureTargetOptions,
): WorkspaceDefinition {
  const captured = captureTarget(task, role, options)
  const include = capturedFiles(captured.absolute)
  for (const path of RESERVED_CAPTURE_PATHS)
    if (include.includes(path))
      throw new Error(`Task ${task.id}: the capture must not contain ${path}; it is reserved`)
  return {
    source: {
      directory: captured.directory,
      include,
      files: [
        { path: "TASK.md", text: task.specText },
        // Build output the target declares as `snapshotIgnore` is also ignored in the
        // workspace's own git repo, so the builder's `git status` is not noise. The baseline
        // commit is unaffected: the prepare step force-adds sources and links.
        {
          path: ".gitignore",
          text: `${["node_modules/", ...task.target.snapshotIgnore].join("\n")}\n`,
        },
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
 * this so they cannot drift apart.
 *
 * Inspection can exclude root directories only, so build output under a package (e.g.
 * `packages/devkit/dist`) is walked and counts toward the reader's entry and byte limits.
 * `snapshotIgnore` has two consumers: the workspace's `.gitignore` (above) and the reader's
 * observed set (via `ignorePrefixes`), because a builder that runs the target's build writes
 * there legitimately and the assembly rule rejects any path the baseline lacks. The verifier's
 * tamper comparison deliberately does NOT consult it: the build completes before the first
 * snapshot, so a change under the build output while a suite runs is a tamper — and it is the
 * directory the independent oracle reads. A target whose build output is large must still raise the reader's
 * limits rather than expect exclusion — the filter is applied after the walk.
 */
export function targetInspectionOptions(task: Task): WorkspaceReadOptions {
  const expectedRootSymlinks: Record<string, string> = {}
  for (const link of task.target.environmentLinks) expectedRootSymlinks[link.path] = link.target
  const policy = targetSandboxPolicy(task.target)
  return {
    excludeRootDirectories: [".git"],
    expectedRootSymlinks,
    ignorePrefixes: [...task.target.snapshotIgnore],
    // Mirrors the builder's own policy rather than trusting the reader's default to keep
    // matching it: relax `security.runAsNonRoot` for the builder and its files change
    // owner, and a reader still running as the secure default cannot read them. Inert today
    // by construction (the policy sets no `security`), kept because the derivation is the
    // point.
    ...(policy.security?.runAsNonRoot === undefined
      ? {}
      : { runAsNonRoot: policy.security.runAsNonRoot }),
  }
}

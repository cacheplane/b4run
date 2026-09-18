import type { SandboxPolicy, WorkspaceDefinition } from "@b4run/workspace"
import type { HandleReaderOptions } from "../worker/workspace-reader.js"
import { loadFixture } from "./catalog.js"

/**
 * The image both the builder and the verifier run, and the environment identity every
 * bundle binds — the verifier records this value verbatim.
 *
 * It is a mutable TAG, and the spec requires a pinned image digest. Rung 1 does not meet
 * that requirement: two different images can carry `b4-code-fixer:fixture-v1`, and a bundle
 * frozen under one cannot tell it apart from the other. Resolving the tag to a digest means
 * asking Docker on a path that must not make a Docker call — the value is read at module
 * load, by the command line and by every layer-1 test — so the honest tag is recorded rather
 * than a fabricated pin. Approval does compare this against the frozen bundle, so CHANGING
 * the variable invalidates consent; what it cannot detect is the same tag pointing somewhere
 * new. The README's environment table says so in the same words.
 */
export const sandboxImage = process.env.FACTORY_SANDBOX_IMAGE ?? "b4-code-fixer:fixture-v1"

/** Denied network, bounded CPU, memory and wall clock. Shared by both containers. */
export const sandboxPolicy: SandboxPolicy = {
  network: { mode: "deny" },
  env: { npm_config_cache: "/tmp/npm-cache", npm_config_update_notifier: "false" },
  resources: { memoryMb: 1024, cpus: 1, timeoutMs: 120_000 },
}

/**
 * Pure declaration of what the workspace contains. The independent checks are a
 * sibling of `project/`, so they are structurally absent from this capture rather
 * than merely excluded from it.
 */
export function fixtureWorkspace(id: string): WorkspaceDefinition {
  const { manifest } = loadFixture(id)
  return {
    source: {
      directory: `fixtures/${id}/project`,
      include: [...manifest.allowedSourcePaths, ...manifest.immutablePaths],
      files: [
        { path: "TASK.md", file: `fixtures/${id}/task.md` },
        { path: ".gitignore", text: "node_modules/\n" },
      ],
    },
    environmentLinks: [{ path: "node_modules", target: `/opt/fixtures/${id}/node_modules` }],
    baseline: "git",
  }
}

/**
 * How a workspace built from {@link fixtureWorkspace} must be inspected, derived from the
 * definition itself rather than restated by each caller.
 *
 * Both entries are consequences of the definition and not preferences: `baseline: "git"`
 * puts a `.git` directory in the workspace that is not part of the capture, and
 * `environmentLinks` puts a symlink in the root that inspection refuses to walk unless it is
 * told the exact target to expect. The verifier and the thread reader share this so they
 * cannot drift apart, and so whoever swaps in the real reader cannot omit them.
 */
export function workspaceInspectionOptions(taskId: string): HandleReaderOptions {
  const definition = fixtureWorkspace(taskId)
  const expectedRootSymlinks: Record<string, string> = {}
  for (const link of definition.environmentLinks ?? [])
    expectedRootSymlinks[link.path] = link.target
  return {
    excludeRootDirectories: definition.baseline === "git" ? [".git"] : [],
    expectedRootSymlinks,
  }
}

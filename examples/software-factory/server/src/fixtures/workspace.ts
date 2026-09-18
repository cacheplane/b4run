import type { SandboxPolicy, WorkspaceDefinition } from "@b4run/workspace"
import { loadFixture } from "./catalog.js"

/**
 * The image both the builder and the verifier run. A digest pin belongs here once
 * the fixture image is published; until then the tag is the identity and the
 * verifier records what it actually ran.
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

import { fileURLToPath } from "node:url"
import type { WorkspaceDefinition } from "@b4run/workspace"
import { projectManifest } from "./catalog.js"

export const appRoot = fileURLToPath(new URL("../../", import.meta.url))
export const sandboxImage = "b4-code-fixer:fixture-v1"
export const sandboxPolicy = {
  network: { mode: "deny" as const },
  env: { npm_config_cache: "/tmp/npm-cache", npm_config_update_notifier: "false" },
  resources: { memoryMb: 1024, cpus: 1, timeoutMs: 120_000 },
}

/** Pure source declaration: B4 captures and owns initialization and recovery. */
export function projectWorkspace(id: string): WorkspaceDefinition {
  const manifest = projectManifest(id)
  return {
    source: {
      directory: "sample/project",
      include: [...manifest.allowedSourcePaths, ...manifest.immutablePaths],
      files: [
        { path: "TASK.md", file: "sample/task.md" },
        { path: ".gitignore", text: "node_modules/\n" },
        { path: "project.json", text: JSON.stringify({ id: manifest.id }) },
      ],
    },
    environmentLinks: [
      { path: "node_modules", target: `/opt/fixtures/${manifest.id}/node_modules` },
    ],
    baseline: "git",
  }
}

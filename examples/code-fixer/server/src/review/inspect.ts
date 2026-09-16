import type { B4ToolContext } from "@b4run/sdk"
import { inspectWorkspace } from "@b4run/workspace"
import { createSourceBundle } from "@b4run/workspace/node"
import { projectManifest } from "../project/catalog.js"
import { candidateDigest, type ReviewCandidate } from "./candidate.js"
import { collectChanges } from "./patch.js"

function decode(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error("Binary workspace files are not supported")
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** Snapshot through permission-bound author APIs, using only captured source as authority. */
export async function inspectCandidate(ctx: B4ToolContext) {
  const workspace = ctx.workspace
  if (!workspace) throw new Error("Managed workspace provenance is required")
  const identity = JSON.parse(decode(await workspace.readInitialFile("project.json"))) as {
    id?: unknown
  }
  if (typeof identity.id !== "string") throw new Error("Invalid captured project identity")
  const manifest = projectManifest(identity.id)
  const baseline: Record<string, string> = {}
  const sourceFiles = []
  for (const path of [
    ...manifest.allowedSourcePaths,
    ...manifest.immutablePaths,
    "TASK.md",
    ".gitignore",
    "project.json",
  ]) {
    const bytes = await workspace.readInitialFile(path)
    baseline[path] = decode(bytes)
    sourceFiles.push({ path, bytes, executable: false })
  }
  const { files: current } = await inspectWorkspace(ctx.fs, {
    signal: ctx.signal,
    maxEntries: 1000,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 2 * 1024 * 1024,
    excludeRootDirectories: [".git"],
    expectedRootSymlinks: { node_modules: `/opt/fixtures/${manifest.id}/node_modules` },
  })
  const changes = collectChanges(baseline, current, manifest.allowedSourcePaths)
  if (!Object.keys(changes).length) throw new Error("No source changes to review")
  const candidateBase = {
    version: 1 as const,
    workspaceId: workspace.id,
    sourceDigest: workspace.sourceDigest,
    changes,
  }
  const candidate: ReviewCandidate = {
    ...candidateBase,
    receiptDigest: candidateDigest(candidateBase),
  }
  return {
    candidate,
    baseline,
    manifest,
    initial: {
      image: workspace.environment.identity,
      workspaceId: workspace.id,
      workspace: {
        version: 1 as const,
        source: createSourceBundle(sourceFiles),
        environmentLinks: [
          { path: "node_modules", target: `/opt/fixtures/${manifest.id}/node_modules` },
        ],
      },
    },
  }
}

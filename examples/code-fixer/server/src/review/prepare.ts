import type { B4ToolContext } from "@b4run/sdk"
import { createSourceBundle } from "@b4run/workspace/node"
import { fixtureManifest } from "../fixtures/catalog.js"
import { candidateDigest, type ReviewCandidate } from "./candidate.js"
import { collectChanges, renderReviewDiff } from "./patch.js"
import { verifyChanges } from "./verifier.js"

function decode(bytes: Uint8Array): string {
  if (bytes.includes(0)) throw new Error("Binary workspace files are not supported")
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
}

/** Snapshot through permission-bound author APIs, using only captured source as authority. */
export async function inspectCandidate(ctx: B4ToolContext) {
  const workspace = ctx.workspace
  const metadataReader = ctx.fs.stat?.bind(ctx.fs)
  if (!workspace || !metadataReader)
    throw new Error("Managed workspace provenance and file metadata are required")
  const stat = metadataReader
  const identity = JSON.parse(decode(await workspace.readInitialFile("fixture.json"))) as {
    id?: unknown
  }
  if (typeof identity.id !== "string") throw new Error("Invalid captured fixture identity")
  const manifest = fixtureManifest(identity.id)
  const baseline: Record<string, string> = {}
  const sourceFiles = []
  for (const path of [
    ...manifest.allowedSourcePaths,
    ...manifest.immutablePaths,
    "TASK.md",
    ".gitignore",
    "fixture.json",
  ]) {
    const bytes = await workspace.readInitialFile(path)
    baseline[path] = decode(bytes)
    sourceFiles.push({ path, bytes, executable: false })
  }
  const current: Record<string, string> = {}
  let entries = 0
  let bytes = 0
  async function walk(directory = ""): Promise<void> {
    for (const name of await ctx.fs.listDir(directory)) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === "." || name === "..")
        throw new Error("Invalid workspace entry")
      const path = directory ? `${directory}/${name}` : name
      if (++entries > 1000) throw new Error("Too many workspace entries")
      const metadata = await stat(path)
      if (!directory && name === ".git") {
        if (metadata.kind !== "directory") throw new Error("Invalid Git directory")
        continue
      }
      if (!directory && name === "node_modules") {
        if (
          metadata.kind !== "symlink" ||
          metadata.target !== `/opt/fixtures/${manifest.id}/node_modules`
        )
          throw new Error("Unexpected dependency link")
        continue
      }
      if (metadata.kind === "directory") await walk(path)
      else {
        if (metadata.kind !== "file" || metadata.executable)
          throw new Error(`Not a regular source file: ${path}`)
        bytes += metadata.size
        if (bytes > 2 * 1024 * 1024) throw new Error("Workspace snapshot exceeds 2 MiB")
        const content = await ctx.fs.readBinaryFile(path, { maxBytes: 2 * 1024 * 1024 })
        current[path] = decode(content)
      }
    }
  }
  await walk()
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
export async function prepareReview(ctx: B4ToolContext) {
  const inspected = await inspectCandidate(ctx)
  const verification = await verifyChanges(
    inspected.manifest.id,
    inspected.candidate.changes,
    ctx.signal,
    inspected.initial,
  )
  if (!verification.passed) throw new Error("Independent verification failed")
  return {
    task: inspected.manifest.id,
    candidate: inspected.candidate,
    diff: renderReviewDiff(inspected.baseline, inspected.candidate.changes),
    verification,
  }
}

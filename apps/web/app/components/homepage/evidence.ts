import "server-only"
import { createHash } from "node:crypto"
import data from "./evidence.json"

export type HomeEvidence = typeof data
export type SourceKey = keyof HomeEvidence["sources"]
export type CapabilityKey = keyof HomeEvidence["snippets"]
const hash = (text: string) => createHash("sha256").update(text).digest("hex")

export function sourceExcerpt(value: HomeEvidence, key: CapabilityKey): string {
  const snippet = value.snippets[key]
  const source = value.sources[snippet.source as SourceKey]
  return source.text
    .trimEnd()
    .split("\n")
    .slice(snippet.start - 1, snippet.end)
    .join("\n")
}

export function validateEvidence(value: HomeEvidence): void {
  // Independently pin the reviewed document; embedded hashes alone are self-attested.
  if (
    hash(JSON.stringify(value)) !==
    "039ea922f7b63332650f609bc86d7e9c55a6fd5637b9d4e38d6b3d376a50fe45"
  )
    throw new Error("Homepage evidence differs from the reviewed snapshot")
  if (
    value.schemaVersion !== 1 ||
    value.id !== "90532f93-a8b9-43ff-9d94-b664a37af813" ||
    value.recordingSha256 !== "1a1dd2187554737ef3401e4c63fcd5d4e746c3506b9dc01eb9dfaa3db57c95db" ||
    value.mode !== "live" ||
    value.dirty ||
    value.status !== "approval-pending" ||
    value.model !== "gpt-5" ||
    value.durationMs !== 113145 ||
    value.agentCommit !== "cbe93c9b53ac6981436b20814b544aa4ce38f4b5" ||
    value.sourceCommit !== "91619fa68522079087f09e9ead792b30a09bd6de" ||
    !Object.values(value.criteria).every((passed) => passed === true)
  )
    throw new Error("Invalid homepage recording provenance or outcome")
  const expected = [
    "documented dry-run flag reaches the handler",
    "forwards cap and memory-level cwd",
    "rejects unknown and incomplete arguments",
    "dry-run preserves memory state and creates no files",
  ]
  if (JSON.stringify([...value.visible, ...value.independent]) !== JSON.stringify(expected))
    throw new Error("Incomplete named verification receipts")
  for (const source of Object.values(value.sources))
    if (hash(source.text) !== source.sha256) throw new Error("Changed source snapshot")
  for (const key of Object.keys(value.snippets) as CapabilityKey[])
    if (hash(sourceExcerpt(value, key)) !== value.snippets[key].sha256)
      throw new Error("Changed source excerpt")
  if (hash(`${value.patch.original}\0${value.patch.repaired}`) !== value.patch.sha256)
    throw new Error("Changed recorded patch")
}

validateEvidence(data)
export const evidence = data
export const blueprintUrl =
  "https://github.com/cacheplane/b4run/tree/main/examples/code-fixer/server"
export const reportUrl =
  "https://github.com/cacheplane/b4run/blob/main/docs/superpowers/runbooks/2026-09-13-code-fixer-live-evaluations.md"
export const sourceUrl = (path: string) =>
  `https://github.com/cacheplane/b4run/blob/${data.sourceCommit}/examples/code-fixer/server/${path}`

export const curatedEvidenceUrl =
  "https://github.com/cacheplane/b4run/blob/c8c0d4b4a31b4da51ee98fc5d50aafbe968e304e/apps/web/app/components/homepage/evidence.json"

import "server-only"
import { createHash } from "node:crypto"
import data from "./evidence.json"

export type HomeEvidence = typeof data
export type SourceKey = keyof HomeEvidence["sources"]
export type CapabilityKey = keyof HomeEvidence["snippets"]
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const requiredCriteria = [
  "reproduced",
  "verified",
  "approval",
  "visible",
  "independent",
  "scope",
] as const satisfies readonly (keyof HomeEvidence["criteria"])[]

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
    "c74c2fb36190f4afcc55e61f834ec7a08fed9edbf7749dd3e4e218e67b0dc58a"
  )
    throw new Error("Homepage evidence differs from the reviewed snapshot")
  if (
    value.schemaVersion !== 1 ||
    value.id !== "de4487ee-d4c9-443b-be34-70afcafcb203" ||
    value.recordingSha256 !== "cbfc5455b732051b53a93399c6e3f7c926271e543f8e17ace1d03303b2a99c13" ||
    value.mode !== "live" ||
    value.dirty ||
    value.status !== "approval-pending" ||
    value.model !== "gpt-5" ||
    value.durationMs !== 374150 ||
    value.agentCommit !== "d6a2dc01ebf4f605fc089131557f735f2a6ccf4e" ||
    value.sourceCommit !== "bfaf0c2b3030eebb572703c8f70f0e063593b1fa" ||
    !requiredCriteria.every((key) => value.criteria[key] === true)
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

export const curatedEvidenceUrl =
  "https://github.com/cacheplane/b4run/blob/c8c0d4b4a31b4da51ee98fc5d50aafbe968e304e/apps/web/app/components/homepage/evidence.json"

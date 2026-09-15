import { createHash } from "node:crypto"
import { z } from "zod"

const schema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1).max(200),
    sourceDigest: z.string().min(1).max(200),
    changes: z.record(z.string(), z.string()),
    receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export type ReviewCandidate = z.infer<typeof schema>
export function candidateDigest(candidate: Omit<ReviewCandidate, "receiptDigest">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: candidate.version,
        workspaceId: candidate.workspaceId,
        sourceDigest: candidate.sourceDigest,
        changes: Object.fromEntries(
          Object.entries(candidate.changes).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }),
    )
    .digest("hex")
}
export function validateCandidate(value: unknown): ReviewCandidate {
  const candidate = schema.parse(value)
  if (candidateDigest(candidate) !== candidate.receiptDigest)
    throw new Error("Candidate digest mismatch")
  return candidate
}

import {
  authorizePostpublicationExecutor,
  postpublicationExecutorIdentity,
} from "./postpublication-executor.mjs"

export const auditExecutorIdentity = postpublicationExecutorIdentity

// Main audit runs share the reviewed source and CI authority of postpublication
// work. Their workflow remains dispatch-only; legacy candidate/tag runs stay exact.
export function authorizeAuditExecutor(options) {
  return authorizePostpublicationExecutor({
    ...options,
    workflow: ".github/workflows/published-artifact-verify.yml",
  })
}

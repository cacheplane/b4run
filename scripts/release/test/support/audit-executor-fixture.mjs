import { postpublicationExecutorFixture } from "./postpublication-executor-fixture.mjs"

export function auditExecutorFixture() {
  return postpublicationExecutorFixture({
    workflow: ".github/workflows/published-artifact-verify.yml",
  })
}

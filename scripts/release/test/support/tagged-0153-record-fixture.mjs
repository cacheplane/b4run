import { CANONICAL_RELEASE_PACKAGE_ORDER } from "../../manifest.mjs"

export const TAGGED_VERSION = "0.15.3"
export const TAGGED_COMMIT = "2ef24c2453b031e068e99ced4cc57355f49e63d6"
export const TAGGED_OBJECT = "8221db88b2936394254847bcf220bcacb474cff7"

export function tagged0153Record(overrides = {}) {
  return {
    schemaVersion: 2,
    kind: "abandoned-prepublication",
    version: TAGGED_VERSION,
    commitSha: TAGGED_COMMIT,
    tag: { name: "v0.15.3", objectSha: TAGGED_OBJECT, commitSha: TAGGED_COMMIT },
    reason: "Immutable 0.15.3 preparation fails its consumer install; superseded by 0.15.4.",
    predecessor: {
      state: "CANDIDATE_TAGGED",
      releaseId: null,
      releaseStatus: "absent",
      bodySha256: null,
      marker: null,
      artifact: null,
    },
    evidence: {
      escrowAssets: [],
      npm: {
        observations: ["2026-10-25T16:00:00.000Z", "2026-10-25T16:01:00.000Z"].map(
          (observedAt) => ({
            observedAt,
            packages: [...CANONICAL_RELEASE_PACKAGE_ORDER].sort().map((name) => ({
              name,
              version: TAGGED_VERSION,
              status: "ABSENT",
              httpStatus: 404,
              code: "E404",
            })),
          }),
        ),
      },
      releaseRuns: [
        {
          workflowRunId: 40195141825,
          runAttempt: 1,
          status: "completed",
          publishJobStarted: false,
        },
      ],
      duplicateRecovery: null,
    },
    authority: {
      mode: "operator-recovery",
      operator: "blove",
      capturedAt: "2026-10-25T16:01:01.000Z",
      reviewedCommit: "4".repeat(40),
    },
    ...overrides,
  }
}

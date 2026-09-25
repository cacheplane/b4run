import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createArtifactStore } from "../src/lib/storage/artifacts.ts"
import { loadTask } from "../src/lib/targets/catalog.ts"
import { createDockerVerifier, ImageGoneError } from "../src/lib/verification/docker-verifier.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the verifier's image", () => {
  it("refuses, before any container, a bound image the daemon no longer holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "factory-verifier-unit-"))
    dirs.push(dir)
    const asked: string[] = []
    const verifier = createDockerVerifier(createArtifactStore(join(dir, "artifacts")), {
      stagingRoot: dir,
      present: async (localId) => {
        asked.push(localId)
        return false
      },
    })
    const image = { ...loadTask("cli-flags").target.image, localId: `sha256:${"7".repeat(64)}` }
    const verifying = verifier.verify(
      {
        workOrderId: "wo-1",
        taskId: "cli-flags",
        candidateDigest: "a".repeat(64),
        changes: {},
        policyDigest: "b".repeat(64),
        image,
      },
      AbortSignal.timeout(5_000),
    )
    await expect(verifying).rejects.toThrow(ImageGoneError)
    await expect(verifying).rejects.toThrow(
      `The work order is bound to image ${image.localId} (target cli-flags), which this host no longer holds: its verdict cannot be earned in the environment it is bound to`,
    )
    expect(asked).toEqual([image.localId])
  })
})

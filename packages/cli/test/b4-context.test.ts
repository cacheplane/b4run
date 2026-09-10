import type { WorkspaceFs } from "@b4run/sdk"
import { describe, expect, it } from "vitest"

import { createB4Context } from "../src/lib/runtime/b4-context.js"

const fakeFs: WorkspaceFs = {
  readFile: async () => "content",
  readBinaryFile: async () => Uint8Array.from([1]),
  writeFile: async () => ({ bytesWritten: 1 }),
  listDir: async () => [],
}

describe("createB4Context fs threading", () => {
  it("exposes fs on the route context", () => {
    const context = createB4Context({ tools: [], fs: fakeFs })
    expect(context.fs).toBe(fakeFs)
  })

  it("passes fs to tool run contexts", async () => {
    let seenFs: WorkspaceFs | undefined
    const context = createB4Context({
      fs: fakeFs,
      tools: [
        {
          filePath: "/x/tools/probe.ts",
          name: "probe",
          scope: "route-local",
          run: (_input, ctx) => {
            seenFs = ctx.fs
            return "ok"
          },
        },
      ],
    })
    await context.tools.probe?.({})
    expect(seenFs).toBe(fakeFs)
  })
})

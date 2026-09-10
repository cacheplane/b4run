import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createThreadsStore } from "@b4run/sqlite-storage"
import { afterAll, describe } from "vitest"
import { runThreadsStoreConformance } from "../src/threads-conformance.js"

// The kit lives here rather than in @b4run/sqlite-storage/test because
// sqlite-storage is an (indirect) dependency of @b4run/testing — depending
// back on testing makes the turbo build graph cyclic.
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

runThreadsStoreConformance({
  name: "createThreadsStore (sqlite)",
  makeStore: () => {
    const dir = mkdtempSync(join(tmpdir(), "b4-threads-conf-"))
    dirs.push(dir)
    return createThreadsStore({ path: join(dir, "threads.sqlite") })
  },
  describe,
})

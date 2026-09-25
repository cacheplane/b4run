import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createThreadPermissionsStore } from "@b4run/permissions"
import { createPermissionsStore } from "@b4run/permissions/node"
import { afterAll, describe } from "vitest"
import { runPermissionsStoreConformance } from "../src/permissions-conformance.js"

// Co-located with the kit rather than in @b4run/permissions/test: that
// package is an (indirect) dependency of @b4run/testing, so depending back on
// testing would make the turbo build graph cyclic.
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

runPermissionsStoreConformance({
  name: "createPermissionsStore (file)",
  makeStore: (init) => {
    // A fresh appRoot per store: the file backend keeps runtime grants in
    // <appRoot>/.b4/permissions.json, and the kit requires an empty store.
    const appRoot = mkdtempSync(join(tmpdir(), "b4-perms-conf-"))
    dirs.push(appRoot)
    return createPermissionsStore({ appRoot, config: init.config, mode: init.mode })
  },
  describe,
})

runPermissionsStoreConformance({
  name: "createThreadPermissionsStore (thread record over an empty app store)",
  makeStore: (init) => {
    // The thread's lists play the config's part; the app store denies nothing and must
    // never receive a thread's grant.
    const stored: Record<string, string[]> = {}
    return createThreadPermissionsStore({
      base: {
        mode: init.mode,
        async load() {},
        match: () => "unknown",
        async addAllow() {
          throw new Error("a thread's grant reached the app's store")
        },
      },
      permissions: { allow: init.config?.allow ?? {}, deny: init.config?.deny ?? {} },
      grants: {
        list: () => stored,
        add(tool, pattern) {
          const list = stored[tool] ?? []
          if (!list.includes(pattern)) list.push(pattern)
          stored[tool] = list
        },
      },
    })
  },
  describe,
})

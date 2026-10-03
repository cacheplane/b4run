import { describe, expect, it, vi } from "vitest"
import {
  createThreadPermissionsStore,
  MAX_THREAD_GRANT_LENGTH,
  type PermissionMode,
  type PermissionsStore,
  type ThreadPermissionGrants,
} from "../src/index.ts"

/** An app store with fixed verdicts that records any grant handed to it. */
function appStore(
  mode: PermissionMode,
  verdicts: Readonly<Record<string, "allow" | "deny">> = {},
): PermissionsStore & { readonly granted: string[] } {
  const granted: string[] = []
  return {
    mode,
    granted,
    async load() {},
    match: (tool, candidate) => verdicts[`${tool} ${candidate}`] ?? "unknown",
    async addAllow(tool, pattern) {
      granted.push(`${tool} ${pattern}`)
    },
  }
}
function recordGrants(
  initial: Record<string, string[]> = {},
): ThreadPermissionGrants & { readonly stored: Record<string, string[]> } {
  const stored = structuredClone(initial)
  return {
    stored,
    list: () => stored,
    add(tool, pattern) {
      const list = stored[tool] ?? []
      if (!list.includes(pattern)) list.push(pattern)
      stored[tool] = list
    },
  }
}

describe("createThreadPermissionsStore", () => {
  it("allows what the thread allows, and nothing the app alone allows", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("non-interactive", { "bash npm test": "allow" }),
      permissions: { allow: { bash: ["ls"] } },
      grants: recordGrants(),
    })
    await store.load()
    expect(store.match("bash", "ls -la")).toBe("allow")
    expect(store.match("bash", "npm test")).toBe("unknown")
  })
  it("denies what the thread or the app denies, over any allow", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("interactive", { "bash rm ./secret": "deny" }),
      permissions: { allow: { bash: ["rm"] }, deny: { bash: ["rm -rf"] } },
      grants: recordGrants(),
    })
    await store.load()
    expect(store.match("bash", "rm -rf /tmp")).toBe("deny")
    expect(store.match("bash", "rm ./secret")).toBe("deny")
    expect(store.match("bash", "rm ./file")).toBe("allow")
  })
  it("keeps the app's mode, and ignores the thread's grants outside interactive mode", async () => {
    const grants = recordGrants({ bash: ["make"] })
    const store = createThreadPermissionsStore({
      base: appStore("non-interactive"),
      permissions: {},
      grants,
    })
    await store.load()
    expect(store.mode).toBe("non-interactive")
    expect(store.match("bash", "make all")).toBe("unknown")
  })
  it("keeps an Always grant in the thread's record, never in the app's store", async () => {
    const app = appStore("interactive")
    const grants = recordGrants()
    const store = createThreadPermissionsStore({ base: app, permissions: {}, grants })
    await store.load()
    await store.addAllow("bash", "npm install")
    expect(app.granted).toEqual([])
    expect(grants.stored).toEqual({ bash: ["npm install"] })
    expect(store.match("bash", "npm install react")).toBe("allow")
  })
  it("reads grants an earlier store recorded for the same thread", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("interactive"),
      permissions: {},
      grants: recordGrants({ bash: ["make"] }),
    })
    await store.load()
    expect(store.match("bash", "make all")).toBe("allow")
  })
  it("answers unknown for everything in bypass mode, as every store does", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("bypass", { "bash rm": "deny" }),
      permissions: { allow: { bash: ["ls"] }, deny: { bash: ["rm"] } },
      grants: recordGrants(),
    })
    await store.load()
    expect(store.match("bash", "ls")).toBe("unknown")
    expect(store.match("bash", "rm")).toBe("unknown")
  })
  it("answers unknown for a tool named like an Object.prototype member", async () => {
    const store = createThreadPermissionsStore({
      base: appStore("interactive"),
      permissions: { allow: { bash: ["ls"] } },
      grants: recordGrants(),
    })
    await store.load()
    expect(store.match("constructor", "x")).toBe("unknown")
    expect(store.match("__proto__", "x")).toBe("unknown")
  })
  it.each([
    ["an over-long", "x".repeat(MAX_THREAD_GRANT_LENGTH + 1)],
    ["an empty", ""],
    ["a whitespace-only", "  "],
  ])("degrades Always to once for %s pattern: allowed now, never recorded", async (_, pattern) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const app = appStore("interactive")
      const grants = recordGrants()
      const store = createThreadPermissionsStore({ base: app, permissions: {}, grants })
      await store.load()
      await expect(store.addAllow("bash", pattern)).resolves.toBeUndefined()
      expect(grants.stored).toEqual({})
      expect(app.granted).toEqual([])
      expect(store.match("bash", `${pattern} more`)).toBe("unknown")
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/allowed once and not recorded/))
    } finally {
      warn.mockRestore()
    }
  })
})

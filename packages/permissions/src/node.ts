/**
 * The NODE layer of `@b4run/permissions`: the disk-backed store that reads
 * and writes `.b4/permissions.json`.
 *
 * It lives behind the explicitly node-only "@b4run/permissions/node" subpath
 * (NOT the "." barrel) so `node:fs` / `node:path` stay out of the default
 * import graph — edge entries import the barrel for `matchPermission`, the
 * suggested-pattern helpers and the `PermissionsStore` interface, and inject
 * their own store implementation.
 */

import { existsSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { readPermissionFile, withPermissionFile, writePermissionFile } from "./file-coordinator.js"
import { matchPermission } from "./pattern-matching.js"
import { existingRuleReceipt, readRuleCoordinator, withRuleReceipt } from "./rule-coordinator.js"
import { type RememberedRuleIntent, ruleDenied } from "./rule-intents.js"
import type { PermissionMode, PermissionsFile, PermissionsStore } from "./types.js"

const PERMISSIONS_DIR = ".b4"
const PERMISSIONS_FILE = "permissions.json"

interface CreateOptions {
  readonly appRoot: string
  readonly config: PermissionsFile | undefined
  readonly mode: PermissionMode
}

type MutableMap = Record<string, string[]>

interface State {
  configAllow: MutableMap
  configDeny: MutableMap
  runtimeAllow: MutableMap
  runtimeDeny: MutableMap
}

function emptyState(): State {
  return { configAllow: {}, configDeny: {}, runtimeAllow: {}, runtimeDeny: {} }
}

function cloneMap(src: Readonly<Record<string, readonly string[]>>): MutableMap {
  const out: MutableMap = {}
  for (const [k, v] of Object.entries(src)) out[k] = [...v]
  return out
}

function effectiveAllow(state: State, mode: PermissionMode): Record<string, string[]> {
  if (mode === "bypass") return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(state.configAllow)) out[k] = [...v]
  if (mode === "interactive") {
    for (const [k, v] of Object.entries(state.runtimeAllow)) {
      out[k] = [...(out[k] ?? []), ...v]
    }
  }
  return out
}

function effectiveDeny(state: State, mode: PermissionMode): Record<string, string[]> {
  if (mode === "bypass") return {}
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(state.configDeny)) out[k] = [...v]
  if (mode === "interactive") {
    for (const [k, v] of Object.entries(state.runtimeDeny)) {
      out[k] = [...(out[k] ?? []), ...v]
    }
  }
  return out
}

export function createPermissionsStore(opts: CreateOptions): PermissionsStore {
  const { appRoot, config, mode } = opts
  const state = emptyState()
  if (config) {
    state.configAllow = cloneMap(config.allow)
    state.configDeny = cloneMap(config.deny)
  }

  function maps(document: Record<string, unknown>) {
    const allow = document.allow ?? {},
      deny = document.deny ?? {}
    for (const map of [allow, deny]) {
      if (
        !map ||
        typeof map !== "object" ||
        Array.isArray(map) ||
        Object.values(map).some(
          (value) => !Array.isArray(value) || value.some((item) => typeof item !== "string"),
        )
      )
        throw new Error("Malformed permissions.json rule map")
    }
    return {
      allow: cloneMap(allow as Record<string, readonly string[]>),
      deny: cloneMap(deny as Record<string, readonly string[]>),
    }
  }
  function publish(document: Record<string, unknown>) {
    const current = maps(document)
    state.runtimeAllow = current.allow
    state.runtimeDeny = current.deny
  }
  async function loadRuntimeFile(): Promise<void> {
    publish(await readPermissionFile(join(appRoot, PERMISSIONS_DIR, PERMISSIONS_FILE)))
  }
  async function persist(path: string, document: Record<string, unknown>) {
    await ensureGitignoreEntry()
    await writePermissionFile(path, document)
    publish(document)
  }
  async function ensureGitignoreEntry(): Promise<void> {
    const gitignorePath = join(appRoot, ".gitignore")
    let content = ""
    if (existsSync(gitignorePath)) {
      content = await readFile(gitignorePath, "utf8")
      if (content.split("\n").some((line) => line.trim() === ".b4/")) return
      if (!content.endsWith("\n") && content.length > 0) content += "\n"
      content += ".b4/\n"
    } else {
      content = ".b4/\n"
    }
    await writeFile(gitignorePath, content, "utf8")
  }

  const store: PermissionsStore = {
    mode,
    rememberedRules: {
      async prepare(operationId, rules) {
        return withPermissionFile(appRoot, async (path) => {
          const document = await readPermissionFile(path),
            current = maps(document)
          const coordinator = readRuleCoordinator(document._b4RuleCoordinator, current)
          publish(document)
          const intent: RememberedRuleIntent = {
            operationId,
            scopeId: coordinator.scopeId,
            revision: String(coordinator.revision),
            rules,
          }
          // Validate the same private payload that apply and native stores use.
          withRuleReceipt(coordinator, intent, "superseded", current)
          if (mode !== "interactive" || ruleDenied(store, rules))
            throw new Error("Permission rule cannot be remembered")
          await persist(path, { ...document, _b4RuleCoordinator: coordinator })
          return intent
        })
      },
      async apply(intent) {
        return withPermissionFile(appRoot, async (path) => {
          const document = await readPermissionFile(path),
            current = maps(document)
          const coordinator = readRuleCoordinator(document._b4RuleCoordinator, current)
          const existing = existingRuleReceipt(coordinator, intent)
          if (existing) {
            publish(document)
            return existing
          }
          publish(document)
          const outcome =
            coordinator.scopeId === intent.scopeId &&
            String(coordinator.revision) === intent.revision &&
            mode === "interactive" &&
            !ruleDenied(store, intent.rules)
              ? "applied"
              : "superseded"
          if (outcome === "applied")
            for (const rule of intent.rules) {
              const list = current.allow[rule.tool] ?? []
              if (!list.includes(rule.pattern)) current.allow[rule.tool] = [...list, rule.pattern]
            }
          const updated = {
            ...document,
            ...current,
            _b4RuleCoordinator: withRuleReceipt(coordinator, intent, outcome, current),
          }
          await persist(path, updated)
          return outcome
        })
      },
    },
    match(tool: string, candidate: string) {
      return matchPermission(
        tool,
        candidate,
        effectiveAllow(state, mode),
        effectiveDeny(state, mode),
      )
    },
    async load() {
      if (mode === "interactive") {
        await loadRuntimeFile()
      }
    },
    async addAllow(tool: string, pattern: string) {
      await withPermissionFile(appRoot, async (path) => {
        const document = await readPermissionFile(path),
          current = maps(document)
        const coordinator = readRuleCoordinator(document._b4RuleCoordinator, current)
        const intent = {
          operationId: crypto.randomUUID(),
          scopeId: coordinator.scopeId,
          revision: String(coordinator.revision),
          rules: [{ tool, pattern }],
        }
        const list = current.allow[tool] ?? []
        if (!list.includes(pattern)) current.allow[tool] = [...list, pattern]
        await persist(path, {
          ...document,
          ...current,
          _b4RuleCoordinator: withRuleReceipt(coordinator, intent, "applied", current),
        })
      })
    },
  }
  return store
}

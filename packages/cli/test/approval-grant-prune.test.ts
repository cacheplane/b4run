import { createMemoryInterruptGrantStore } from "@b4run/sdk"
import { describe, expect, it } from "vitest"
import {
  ApprovalGrantConfigError,
  DEFAULT_APPROVAL_GRANT_RETENTION_MS,
  resolveApprovalGrantRetentionMs,
  validateInterruptGrantStore,
} from "../src/lib/dev/approval-grants.ts"
import { MAX_CLIENT_TOOL_TTL_MS } from "../src/lib/dev/client-tool-runtime.ts"

describe("approval grant retention settings", () => {
  it("grantRetentionMs defaults to 7 days, and a mistyped value fails the boot", () => {
    expect(resolveApprovalGrantRetentionMs(undefined)).toBe(DEFAULT_APPROVAL_GRANT_RETENTION_MS)
    expect(DEFAULT_APPROVAL_GRANT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
    expect(resolveApprovalGrantRetentionMs(1)).toBe(1)
    expect(resolveApprovalGrantRetentionMs(MAX_CLIENT_TOOL_TTL_MS)).toBe(MAX_CLIENT_TOOL_TTL_MS)
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "604800000", null]) {
      expect(() => resolveApprovalGrantRetentionMs(bad)).toThrow(ApprovalGrantConfigError)
    }
    expect(() => resolveApprovalGrantRetentionMs(MAX_CLIENT_TOOL_TTL_MS + 1)).toThrow(
      /approvals\.grantRetentionMs/,
    )
  })

  it("a configured grantStore must implement every method, prune included", () => {
    expect(validateInterruptGrantStore(undefined)).toBeUndefined()
    const store = createMemoryInterruptGrantStore()
    expect(validateInterruptGrantStore(store)).toBe(store)
    const { prune: _omitted, ...withoutPrune } = store
    expect(() => validateInterruptGrantStore(withoutPrune)).toThrow(/missing prune/)
    expect(() => validateInterruptGrantStore({ issue() {} })).toThrow(ApprovalGrantConfigError)
    expect(() => validateInterruptGrantStore("sqlite")).toThrow(/approvals\.grantStore/)
  })
})

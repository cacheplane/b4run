import { describe, expect, it } from "vitest"

import {
  B4_ERRORS,
  type B4ErrorCode,
  type B4ErrorDescriptor,
  describeError,
  errorDocsUrl,
} from "../src/errors.js"

const CODE_RE = /^B4_E\d{4}$/
const DOCS_PATH_RE = /^\/docs\/[a-z0-9-]+(#[a-z0-9-]+)?$/

describe("B4_ERRORS registry", () => {
  const entries: Array<[string, B4ErrorDescriptor]> = Object.entries(B4_ERRORS)

  it("has at least the wired families", () => {
    expect(entries.length).toBeGreaterThanOrEqual(10)
  })

  it("every descriptor code matches B4_E\\d{4} and equals its key", () => {
    for (const [key, descriptor] of entries) {
      expect(descriptor.code).toMatch(CODE_RE)
      expect(descriptor.code).toBe(key)
    }
  })

  it("codes are unique", () => {
    const codes = entries.map(([, d]) => d.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it("every descriptor has a non-empty title", () => {
    for (const [, descriptor] of entries) {
      expect(descriptor.title.length).toBeGreaterThan(0)
    }
  })

  it("every docsPath (when present) matches the /docs/<slug>#<anchor> shape", () => {
    for (const [, descriptor] of entries) {
      if (descriptor.docsPath !== undefined) {
        expect(descriptor.docsPath).toMatch(DOCS_PATH_RE)
      }
    }
  })

  it("registers delegation policy, denial, and dispatch failure errors", () => {
    expect(B4_ERRORS.B4_E1004).toEqual({
      code: "B4_E1004",
      title: "Invalid delegation policy",
      docsPath: "/docs/subagents#delegation-policy",
    })
    expect(B4_ERRORS.B4_E3002).toEqual({
      code: "B4_E3002",
      title: "Subagent dispatch denied",
      docsPath: "/docs/subagents#delegation-policy",
    })
    expect(B4_ERRORS.B4_E5003).toEqual({
      code: "B4_E5003",
      title: "Subagent unavailable or dispatch failed",
      docsPath: "/docs/subagents#dispatch-failures",
    })
    expect(errorDocsUrl("B4_E1004")).toBe("https://b4.run/docs/subagents#delegation-policy")
    expect(errorDocsUrl("B4_E3002")).toBe("https://b4.run/docs/subagents#delegation-policy")
    expect(errorDocsUrl("B4_E5003")).toBe("https://b4.run/docs/subagents#dispatch-failures")
  })

  it("registers the thread access load failure in the permissions band", () => {
    expect(B4_ERRORS.B4_E3003).toEqual({
      code: "B4_E3003",
      title: "Thread access policy failed to load",
      docsPath: "/docs/thread-access#load-failures",
    })
    expect(errorDocsUrl("B4_E3003")).toBe("https://b4.run/docs/thread-access#load-failures")
  })
})

describe("describeError", () => {
  it("returns the descriptor for a code", () => {
    expect(describeError("B4_E2001")).toBe(B4_ERRORS.B4_E2001)
  })
})

describe("errorDocsUrl", () => {
  it("returns the canonical URL when the code has a docsPath", () => {
    const url = errorDocsUrl("B4_E2001")
    expect(url).toBe("https://b4.run/docs/sandbox#what-it-is--and-isnt")
  })

  it("returns undefined for a code without a docsPath", () => {
    const codeWithoutDocs = Object.values(B4_ERRORS).find(
      (d: B4ErrorDescriptor) => d.docsPath === undefined,
    )
    expect(codeWithoutDocs).toBeDefined()
    if (codeWithoutDocs) {
      expect(errorDocsUrl(codeWithoutDocs.code as B4ErrorCode)).toBeUndefined()
    }
  })

  it("honors a custom base", () => {
    expect(errorDocsUrl("B4_E2001", "https://example.test")).toBe(
      "https://example.test/docs/sandbox#what-it-is--and-isnt",
    )
  })
})

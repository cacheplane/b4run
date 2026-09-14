import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { evidence, sourceExcerpt, validateEvidence } from "./evidence"

describe("published homepage evidence", () => {
  it("retains the selected live outcome and exact source", () => {
    expect(() => validateEvidence(evidence)).not.toThrow()
    expect(evidence.id).toBe("90532f93-a8b9-43ff-9d94-b664a37af813")
    expect(evidence.durationMs).toBe(113145)
    expect(evidence.visible).toHaveLength(1)
    expect(evidence.independent).toHaveLength(3)
    expect(sourceExcerpt(evidence, "sandbox")).toContain('mode: "deny"')
  })

  it.each(["mode", "dirty", "criteria", "checks", "source", "patch", "status", "snippet"])(
    "rejects altered %s evidence",
    (field) => {
      const changed = structuredClone(evidence)
      if (field === "mode") changed.mode = "replay"
      if (field === "dirty") changed.dirty = true
      if (field === "criteria") changed.criteria.independent = false
      if (field === "checks") changed.independent.pop()
      if (field === "source") changed.sources.agent.text += "edited"
      if (field === "patch") changed.patch.repaired += "edited"
      if (field === "status") changed.status = "approved"
      if (field === "snippet") changed.snippets.sandbox.start += 1
      expect(() => validateEvidence(changed)).toThrow()
    },
  )

  it("publishes no conversations, environment, or host paths", () => {
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toMatch(/\/Users\/|\/home\/|sk-proj-|"messages":|"systemPrompt":|"env":/)
    expect(evidence.failure).toContain("unknown option '--dry-run'")
    expect(evidence.patch.repaired).toContain(".allowUnknownOption(true)")
  })
  it.each(["rehash", "empty", "suite", "identity"])(
    "rejects self-consistent forged %s evidence",
    (kind) => {
      const changed = structuredClone(evidence)
      if (kind === "rehash") {
        changed.patch.repaired = "forged source"
        changed.patch.sha256 = createHash("sha256")
          .update(`${changed.patch.original}\0${changed.patch.repaired}`)
          .digest("hex")
      }
      if (kind === "empty")
        Object.keys(changed.criteria).forEach((key) => {
          Reflect.deleteProperty(changed.criteria, key)
        })
      if (kind === "suite") {
        changed.visible.push(...changed.independent)
        changed.independent = []
      }
      if (kind === "identity") changed.image = "sha256:invented"
      expect(() => validateEvidence(changed)).toThrow()
    },
  )
})

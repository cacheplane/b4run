import { describe, expect, it } from "vitest"
import { loadBlueprints, validateBlueprints } from "../../lib/blueprints"

describe("shipped blueprint catalog", () => {
  it("passes validation", () => {
    expect(validateBlueprints()).toEqual([])
  })

  it("ships the exemplars and code-fixer agent across four categories", () => {
    const all = loadBlueprints()
    expect(all.map((e) => e.meta.name).sort()).toEqual([
      "code-fixer",
      "docker",
      "opentelemetry",
      "pgvector",
      "pinecone",
    ])
    expect(new Set(all.map((e) => e.meta.category))).toEqual(
      new Set(["agents", "observability", "retrieval", "deploy"]),
    )
  })

  it("marks the primary file in every guide", () => {
    for (const { meta, body } of loadBlueprints()) {
      expect(body, `${meta.name} should contain its b4-blueprint marker`).toContain(
        `b4-blueprint: ${meta.name}@`,
      )
    }
  })
})

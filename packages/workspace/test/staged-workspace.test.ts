import { describe, expect, it } from "vitest"
import {
  createSourceBundle,
  stagedWorkspaceDefinition,
  verifyCapturedWorkspaceDefinition,
  verifyStagedWorkspaceReference,
} from "../src/node.ts"

const bundle = createSourceBundle([
  { path: "src/a.ts", bytes: new TextEncoder().encode("a"), executable: false },
])

describe("verifyStagedWorkspaceReference", () => {
  it("accepts a digest alone and normalizes the links", () => {
    expect(verifyStagedWorkspaceReference({ sourceDigest: bundle.digest })).toEqual({
      sourceDigest: bundle.digest,
      environmentLinks: [],
    })
    expect(
      verifyStagedWorkspaceReference({
        sourceDigest: bundle.digest,
        environmentLinks: [
          { path: "z", target: "/opt/z" },
          { path: "node_modules", target: "/opt/deps" },
        ],
        baseline: "git",
      }),
    ).toEqual({
      sourceDigest: bundle.digest,
      environmentLinks: [
        { path: "node_modules", target: "/opt/deps" },
        { path: "z", target: "/opt/z" },
      ],
      baseline: "git",
    })
  })

  for (const [label, value] of Object.entries({
    "an unknown key": { sourceDigest: bundle.digest, extra: 1 },
    "a prefixed digest": { sourceDigest: `sha256:${bundle.digest}` },
    "an uppercase digest": { sourceDigest: bundle.digest.toUpperCase() },
    "a relative link target": {
      sourceDigest: bundle.digest,
      environmentLinks: [{ path: "a", target: "rel" }],
    },
    "a link escaping the workspace": {
      sourceDigest: bundle.digest,
      environmentLinks: [{ path: "../a", target: "/x" }],
    },
    "a link over .git with a git baseline": {
      sourceDigest: bundle.digest,
      environmentLinks: [{ path: ".git", target: "/x" }],
      baseline: "git",
    },
    "another baseline": { sourceDigest: bundle.digest, baseline: "svn" },
    "no digest": {},
    "an array": [bundle.digest],
    null: null,
  }))
    it(`refuses ${label}`, () => {
      expect(() => verifyStagedWorkspaceReference(value)).toThrow()
    })
})

describe("stagedWorkspaceDefinition", () => {
  it("is the captured definition of the held source with the reference's links", () => {
    const definition = stagedWorkspaceDefinition(
      {
        sourceDigest: bundle.digest,
        environmentLinks: [{ path: "node_modules", target: "/opt/deps" }],
      },
      bundle,
    )
    expect(definition).toEqual(
      verifyCapturedWorkspaceDefinition({
        version: 1,
        source: bundle,
        environmentLinks: [{ path: "node_modules", target: "/opt/deps" }],
      }),
    )
  })

  it("carries the baseline", () => {
    expect(
      stagedWorkspaceDefinition({ sourceDigest: bundle.digest, baseline: "git" }, bundle).baseline,
    ).toBe("git")
  })

  it("refuses a source that is not the one named", () => {
    const other = createSourceBundle([
      { path: "b", bytes: new TextEncoder().encode("b"), executable: false },
    ])
    expect(() => stagedWorkspaceDefinition({ sourceDigest: bundle.digest }, other)).toThrow(
      /does not match/,
    )
  })

  it("refuses a link that collides with a file", () => {
    expect(() =>
      stagedWorkspaceDefinition(
        { sourceDigest: bundle.digest, environmentLinks: [{ path: "src/a.ts", target: "/x" }] },
        bundle,
      ),
    ).toThrow()
  })
})

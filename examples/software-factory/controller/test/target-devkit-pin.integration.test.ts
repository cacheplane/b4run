import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  environmentIdentity,
  ImageUnpreparedError,
  imageTag,
  loadTarget,
  repositoryRoot,
  TargetSchema,
  targetsDir,
} from "../src/lib/targets/catalog.ts"
import { prepareDevkitSecondPin, SECOND_PIN } from "./devkit-second-pin.ts"

/**
 * A target prepared at a SECOND pin: `target:prepare devkit --pin <sha>` builds an image
 * from that commit's tree and records it beside the default pin's, and `loadTarget` at that
 * pin selects it. The preparation is `prepareDevkitSecondPin` (shared with the builder lane),
 * over a copy of `targets/devkit`, so the working tree is never written.
 *
 * Requires Docker. Runs only under `test:sandbox`.
 */
const shippedPath = join(targetsDir, "devkit", "target.json")
let original: string
let prepared: ReturnType<typeof prepareDevkitSecondPin> | undefined
let copy: string
let manifestPath: string

beforeAll(() => {
  // The copy starts equal to the shipped file.
  original = readFileSync(shippedPath, "utf8")
  prepared = prepareDevkitSecondPin()
  copy = prepared.targetsDir
  manifestPath = join(copy, "devkit", "target.json")
}, 1_200_000)

afterAll(() => prepared?.cleanup())

describe("a target prepared at a second pin", () => {
  it("records the image beside the default pin's and loads it at that pin", () => {
    const manifest = TargetSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
    const before = TargetSchema.parse(JSON.parse(original))
    // The default pin's entry is kept byte for byte; the second pin's is added.
    expect(manifest.images?.[before.pin]).toEqual(before.images?.[before.pin])
    expect(Object.keys(manifest.images ?? {}).sort()).toEqual([before.pin, SECOND_PIN].sort())

    // The shipped manifest was never written.
    expect(readFileSync(shippedPath, "utf8")).toBe(original)
    const atSecond = loadTarget("devkit", { targetsDir: copy, pin: SECOND_PIN })
    const atDefault = loadTarget("devkit", { targetsDir: copy })
    expect(atSecond.pin).toBe(SECOND_PIN)
    expect(atDefault.pin).toBe(before.pin)
    const tag = imageTag(atSecond)
    expect(tag).toContain(`:${SECOND_PIN.slice(0, 12)}-`)
    expect(tag).not.toBe(imageTag(atDefault))
    const localId = execFileSync("docker", ["image", "inspect", tag, "--format", "{{.Id}}"], {
      encoding: "utf8",
    }).trim()
    expect(localId).toBe(atSecond.image.localId)
    expect(environmentIdentity(atSecond)).not.toBe(environmentIdentity(atDefault))
    // The image really holds the second pin's install: the lockfile hash is that commit's.
    const lockfile = execFileSync(
      "git",
      ["-C", repositoryRoot(), "show", `${SECOND_PIN}:pnpm-lock.yaml`],
      { maxBuffer: 256 * 1024 * 1024 },
    )
    expect(atSecond.image.lockfileSha256).toBe(createHash("sha256").update(lockfile).digest("hex"))
  })

  it("still refuses a pin nobody prepared", () => {
    expect(() => loadTarget("devkit", { targetsDir: copy, pin: "1".repeat(40) })).toThrow(
      ImageUnpreparedError,
    )
  })
})

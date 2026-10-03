import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  environmentIdentity,
  ImageNotBuiltError,
  loadTarget,
  repositoryRoot,
  targetsDir,
} from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.ts"
import { imageTag, openImageRegistry } from "../src/lib/targets/images.ts"
import { prepareDevkitSecondPin, SECOND_PIN } from "./devkit-second-pin.ts"
import { useImages } from "./static-images.ts"

/**
 * A target warmed at a SECOND pin by hand: `target:prepare devkit --pin <sha>` builds an image
 * from that commit's tree into the registry of the state directory it is given, exactly as the
 * controller would the first time a work order needed it, and `loadTarget` at that pin selects
 * it. The script never writes the target: `target.json` records no image.
 *
 * Requires Docker. Runs only under `test:sandbox`.
 */
const shippedPath = join(targetsDir, "devkit", "target.json")
let original: string
let prepared: ReturnType<typeof prepareDevkitSecondPin>

beforeAll(() => {
  original = readFileSync(shippedPath, "utf8")
  prepared = prepareDevkitSecondPin()
}, 1_200_000)

afterAll(() => prepared?.cleanup())

describe("a target warmed at a second pin", () => {
  it("records the image in the script's registry, never in the target, and loadTarget at that pin selects it", () => {
    expect(readFileSync(shippedPath, "utf8")).toBe(original)
    const registry = openImageRegistry({
      path: join(prepared.stateDir, "images.sqlite"),
      builder: dockerImageBuilder(),
    })
    const restore = useImages(registry)
    try {
      const atSecond = loadTarget("devkit", { pin: SECOND_PIN })
      expect(atSecond.image.localId).toBe(prepared.printed.localId)
      expect(environmentIdentity(atSecond)).toBe(prepared.printed.identity)
      expect(imageTag(atSecond)).toBe(prepared.printed.tag)
      const localId = execFileSync(
        "docker",
        ["image", "inspect", prepared.printed.tag, "--format", "{{.Id}}"],
        {
          encoding: "utf8",
        },
      ).trim()
      expect(localId).toBe(atSecond.image.localId)
      const lockfile = execFileSync(
        "git",
        ["-C", repositoryRoot(), "show", `${SECOND_PIN}:pnpm-lock.yaml`],
        {
          maxBuffer: 256 * 1024 * 1024,
        },
      )
      expect(atSecond.image.lockfileSha256).toBe(
        createHash("sha256").update(lockfile).digest("hex"),
      )
      // The script's registry holds only what it built: the default pin is not in it.
      expect(() => loadTarget("devkit")).toThrow(ImageNotBuiltError)
    } finally {
      restore()
      registry.close()
    }
  })
})

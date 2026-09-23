import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  appRoot,
  environmentIdentity,
  ImageUnpreparedError,
  imageTag,
  loadTarget,
  repositoryRoot,
  TargetSchema,
  targetsDir,
} from "../src/lib/targets/catalog.ts"

/**
 * A target prepared at a SECOND pin: `target:prepare devkit --pin <sha>` builds an image
 * from that commit's tree and records it beside the default pin's, and `loadTarget` at that
 * pin selects it. The second pin is `Release 0.10.0 (#782)` on main, after the devkit target
 * was introduced and with every devkit path the target names present; in a shallow checkout
 * `ensurePin` fetches it by sha.
 *
 * The prepare runs over a COPY of `targets/devkit` (`FACTORY_TARGETS_DIR`), so the working
 * tree is never written; the image stays, and the next run's build is served from Docker's
 * layer cache.
 *
 * Requires Docker. Runs only under `test:sandbox`.
 */
const SECOND_PIN = "bfaf0c2b3030eebb572703c8f70f0e063593b1fa"
const copy = mkdtempSync(join(tmpdir(), "factory-devkit-pin-targets-"))
const manifestPath = join(copy, "devkit", "target.json")
const shippedPath = join(targetsDir, "devkit", "target.json")
let original: string
let prepareMs = 0

beforeAll(() => {
  cpSync(join(targetsDir, "devkit"), join(copy, "devkit"), { recursive: true })
  original = readFileSync(manifestPath, "utf8")
  const started = Date.now()
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/prepare-target.ts", "devkit", "--pin", SECOND_PIN],
    {
      cwd: appRoot,
      env: { ...process.env, FACTORY_TARGETS_DIR: copy },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 1_140_000,
    },
  )
  prepareMs = Date.now() - started
  process.stderr.write(`target:prepare devkit --pin ${SECOND_PIN}: ${prepareMs} ms\n`)
}, 1_200_000)

afterAll(() => {
  rmSync(copy, { recursive: true, force: true })
})

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

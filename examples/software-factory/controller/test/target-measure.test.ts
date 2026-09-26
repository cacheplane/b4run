import { execFile, execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { appRoot, TargetSchema } from "../src/lib/targets/catalog.ts"
import { ImagePrepareError, type ImageRegistry } from "../src/lib/targets/images.ts"
import {
  EXPECTED_MARKER,
  expectedPromotedOf,
  PROMOTED_MARKER,
} from "../src/lib/targets/init/dockerfile.ts"
import { initTarget } from "../src/lib/targets/init/init.ts"
import { MeasureError } from "../src/lib/targets/measure/classify.ts"
import { measureTarget, parseMeasureArgs } from "../src/lib/targets/measure/measure.ts"
import { formatManifest, writeProposal } from "../src/lib/targets/proposal.ts"
import { fakeSessions } from "./fake-measure-session.ts"
import { cleanupPinRepos, MINI, pinRepo } from "./pin-repo.ts"

const dirs: string[] = []
afterEach(() => {
  cleanupPinRepos()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "factory-measure-"))
  dirs.push(dir)
  return dir
}
const IMAGE = {
  localId: `sha256:${"a".repeat(64)}`,
  platform: "linux/arm64",
  baseManifestDigest: `sha256:${"b".repeat(64)}`,
  dockerfileSha256: "c".repeat(64),
  lockfileSha256: "d".repeat(64),
  pnpmVersion: "10.33.0",
}
const registry = (ensure: ImageRegistry["ensure"]): ImageRegistry => ({
  recorded: () => undefined,
  ensure,
  present: async () => true,
  close: () => {},
})
const built = registry(async () => ({
  key: "k".repeat(64),
  tag: "b4-factory-app:x-y",
  image: IMAGE,
}))
/** MINI's `@m/app` generated into a temporary targets directory. */
function generated() {
  const { root, pin } = pinRepo(MINI)
  const targets = temp()
  writeProposal(
    initTarget({ packageRef: "@m/app", pin, repositoryRoot: root, targetsDir: targets }).files,
  )
  return { root, pin, targets }
}
const options = (root: string, targets: string) => {
  let t = 0
  return {
    id: "app",
    targetsDir: targets,
    repositoryRoot: root,
    stagingRoot: temp(),
    signal: AbortSignal.timeout(60_000),
    fileTimeoutMs: 180_000,
    memoryMb: 4096,
    runs: 1,
    allowDecrease: false,
    now: () => {
      t += 30_000
      return t
    },
  }
}

describe("measureTarget", () => {
  it("proposes the promotion set a failed build printed, and writes nothing", async () => {
    const { root, targets } = generated()
    const dockerfile = readFileSync(join(targets, "app", "Dockerfile"), "utf8")
    const log = `#9 0.4 ${PROMOTED_MARKER} commander hono \n#9 0.4 ${EXPECTED_MARKER}  \n`
    const outcome = await measureTarget({
      ...options(root, targets),
      registry: registry(async () => {
        throw new ImagePrepareError("docker build failed", "k".repeat(64), log)
      }),
    })
    if (outcome.kind !== "promotion") throw new Error(`expected a promotion, got ${outcome.kind}`)
    expect(outcome.promoted).toEqual(["commander", "hono"])
    expect(outcome.files).toHaveLength(1)
    expect(outcome.files[0]?.before).toBe(dockerfile)
    expect(expectedPromotedOf(outcome.files[0]?.after ?? "")).toEqual(["commander", "hono"])
    expect(readFileSync(join(targets, "app", "Dockerfile"), "utf8")).toBe(dockerfile)
  })

  it("rethrows a build that failed anywhere else", async () => {
    const { root, targets } = generated()
    await expect(
      measureTarget({
        ...options(root, targets),
        registry: registry(async () => {
          throw new ImagePrepareError("docker build failed", "k".repeat(64), "#7 ERROR: apt-get\n")
        }),
      }),
    ).rejects.toThrow(ImagePrepareError)
  })

  it("rethrows a promotion failure whose printed set the Dockerfile already declares", async () => {
    const { root, targets } = generated()
    // The Dockerfile init wrote declares the empty set; a log printing it proposes nothing new.
    const log = `#9 0.4 ${PROMOTED_MARKER} \n#9 0.4 ${EXPECTED_MARKER}  \n`
    await expect(
      measureTarget({
        ...options(root, targets),
        registry: registry(async () => {
          throw new ImagePrepareError("docker build failed", "k".repeat(64), log)
        }),
      }),
    ).rejects.toThrow(ImagePrepareError)
  })

  it("proposes the measured test command and resources, formatted, with a record and a report", async () => {
    const { root, pin, targets } = generated()
    const fake = fakeSessions({ files: { "test/app.test.ts": {} } })
    const outcome = await measureTarget({
      ...options(root, targets),
      registry: built,
      sessions: () => fake.open,
    })
    if (outcome.kind !== "measured") throw new Error(`expected a measurement, got ${outcome.kind}`)
    const after = outcome.files[0]?.after ?? ""
    expect(formatManifest(after)).toBe(after)
    const proposed = TargetSchema.parse(JSON.parse(after))
    expect(proposed.commands.test).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "--run",
      "--no-cache",
      "--config",
      "vitest.config.ts",
    ])
    // The placeholders are no prior: the measurement is proposed as it is.
    expect(proposed.resources).toEqual({
      memoryMb: 1024,
      cpus: 2,
      commandTimeoutMs: 80_000,
      verifierDeadlineMs: 180_000,
    })
    expect(proposed.pin).toBe(pin)
    expect(outcome.files[1]?.path).toBe(join(targets, "app", "measurement.md"))
    expect(outcome.files[1]?.before).toBeNull()
    expect(outcome.files[1]?.after).toContain("No file is excluded: every file passed run alone.")
    expect(outcome.report).toContain(`# target:measure app at ${pin}`)
    // The target on disk is untouched: only --write writes.
    expect(readFileSync(join(targets, "app", "target.json"), "utf8")).toBe(outcome.files[0]?.before)
  })

  it("keeps measured resources at or above the target's own", async () => {
    const { root, targets } = generated()
    const path = join(targets, "app", "target.json")
    const text = readFileSync(path, "utf8")
    const current = TargetSchema.parse(JSON.parse(text))
    const own = { memoryMb: 1536, cpus: 2, commandTimeoutMs: 60_000, verifierDeadlineMs: 240_000 }
    writeProposal([
      {
        path,
        before: text,
        after: formatManifest(`${JSON.stringify({ ...current, resources: own }, null, 2)}\n`),
      },
    ])
    const fake = fakeSessions({ files: { "test/app.test.ts": {} } })
    const outcome = await measureTarget({
      ...options(root, targets),
      registry: built,
      sessions: () => fake.open,
    })
    if (outcome.kind !== "measured") throw new Error(`expected a measurement, got ${outcome.kind}`)
    expect(outcome.measurement.resources).toEqual({
      memoryMb: 1536,
      cpus: 2,
      commandTimeoutMs: 80_000,
      verifierDeadlineMs: 240_000,
    })
    expect(outcome.report).toContain("| memoryMb | 1536 | 1024 | 1536 |")
  })

  it("names a capture omission from what exists at the measured pin", async () => {
    const { root, targets } = generated()
    const output = [
      "Error: ENOENT: no such file or directory, open '/workspace/packages/util/src/index.ts'",
      "Error: ENOENT: no such file or directory, open '/workspace/packages/app/nowhere.ts'",
    ].join("\n")
    const fake = fakeSessions({
      files: { "test/a.test.ts": {}, "test/b.test.ts": { exitCode: 1, output } },
    })
    const outcome = await measureTarget({
      ...options(root, targets),
      registry: built,
      sessions: () => fake.open,
    })
    if (outcome.kind !== "measured") throw new Error(`expected a measurement, got ${outcome.kind}`)
    const failed = outcome.measurement.files.find((f) => f.file === "test/b.test.ts")
    expect(failed?.verdict).toBe("fail")
    expect(failed?.omissions).toEqual(["packages/util/src/index.ts"])
  })

  it("says so in the log and the report when it measures at a pin other than the target's", async () => {
    const { root, pin, targets } = generated()
    writeFileSync(join(root, "README.md"), "mono, later\n")
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
    git("commit", "-q", "-am", "later")
    const later = git("rev-parse", "HEAD")
    const lines: string[] = []
    const fake = fakeSessions({ files: { "test/app.test.ts": {} } })
    const outcome = await measureTarget({
      ...options(root, targets),
      pin: later,
      registry: built,
      sessions: () => fake.open,
      log: (line) => lines.push(line),
    })
    if (outcome.kind !== "measured") throw new Error(`expected a measurement, got ${outcome.kind}`)
    expect(outcome.pin).toBe(later)
    const note = `Measured at ${later}, not the target's default pin ${pin}; the proposal keeps the default pin.`
    expect(lines).toContain(note)
    expect(outcome.report).toContain(`> ${note}`)
    expect(TargetSchema.parse(JSON.parse(outcome.files[0]?.after ?? "")).pin).toBe(pin)
  })

  it("leaves a partial report on a stop after the per-file phase", async () => {
    const { root, targets } = generated()
    const fake = fakeSessions({ files: { "test/app.test.ts": {} }, suite: { exitCode: 1 } })
    const error = await measureTarget({
      ...options(root, targets),
      registry: built,
      sessions: () => fake.open,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(MeasureError)
    expect((error as MeasureError).report).toContain("- `test/app.test.ts`: pass")
  })
})

describe("target:measure's arguments", () => {
  it("takes a target, and optionally a pin, a catalog, --write, --allow-decrease and the measurement's limits", () => {
    expect(parseMeasureArgs(["devkit"])).toEqual({
      id: "devkit",
      write: false,
      allowDecrease: false,
      runs: 3,
      fileTimeoutMs: 180_000,
      memoryMb: 4096,
    })
    expect(
      parseMeasureArgs([
        "cli",
        "--pin",
        "a".repeat(40),
        "--targets-dir",
        "/tmp/t",
        "--write",
        "--allow-decrease",
        "--runs",
        "1",
        "--file-timeout-ms",
        "120000",
        "--memory-mb",
        "2048",
        "--cpus",
        "1.5",
      ]),
    ).toEqual({
      id: "cli",
      pin: "a".repeat(40),
      targetsDir: "/tmp/t",
      write: true,
      allowDecrease: true,
      runs: 1,
      fileTimeoutMs: 120_000,
      memoryMb: 2048,
      cpus: 1.5,
    })
    expect(() => parseMeasureArgs([])).toThrow(/usage: target-measure.ts/)
    expect(() => parseMeasureArgs(["a", "--runs", "0"])).toThrow(
      /--runs must be a positive integer/,
    )
    expect(() => parseMeasureArgs(["a", "--runs", "1.5"])).toThrow(
      /--runs must be a positive integer/,
    )
    expect(() => parseMeasureArgs(["a", "--cpus", "0"])).toThrow(/--cpus must be a positive number/)
    expect(() => parseMeasureArgs(["a", "--pin", "abc"])).toThrow(/full lowercase commit sha/)
  })
})

const run = promisify(execFile)
// `.bin/tsx` is a shell shim `execFile(process.execPath, ...)` cannot run: tsx's own entry.
const tsxBin = join(import.meta.dirname, "../node_modules/tsx/dist/cli.mjs")
const script = (argv: readonly string[], env: Readonly<Record<string, string>>) =>
  run(process.execPath, [tsxBin, "scripts/target-measure.ts", ...argv], {
    cwd: appRoot,
    env: { ...process.env, FACTORY_NO_FETCH: "1", ...env },
  }).catch((error: { code: number; stdout: string; stderr: string }) => error)

describe("target-measure.ts", () => {
  it("prints a refusal as one line and exits 1", async () => {
    const { FACTORY_STATE_DIR: _, ...env } = process.env
    const missing = await run(process.execPath, [tsxBin, "scripts/target-measure.ts", "app"], {
      cwd: appRoot,
      env,
    }).catch((error: { code: number; stderr: string }) => error)
    expect("code" in missing && missing.code).toBe(1)
    expect(missing.stderr).toMatch(/^target:measure: FACTORY_STATE_DIR is required[^\n]*\n$/)

    const usage = await script(["app", "--runs", "0"], { FACTORY_STATE_DIR: temp() })
    expect("code" in usage && usage.code).toBe(1)
    expect(usage.stderr).toBe('target:measure: --runs must be a positive integer, got "0"\n')
  })

  it("reads a relative catalog resolved against pnpm's invoking directory", async () => {
    const { root } = pinRepo(MINI)
    const invoked = temp()
    const unknown = await script(["app", "--targets-dir", "t"], {
      FACTORY_STATE_DIR: temp(),
      FACTORY_REPO_ROOT: root,
      INIT_CWD: invoked,
    })
    expect("code" in unknown && unknown.code).toBe(1)
    expect(unknown.stderr.trimEnd().split("\n")).toHaveLength(1)
    // The catalog was resolved against INIT_CWD, not the controller's directory.
    expect(unknown.stderr).toBe(`target:measure: No target catalog at ${join(invoked, "t")}\n`)
  })
})

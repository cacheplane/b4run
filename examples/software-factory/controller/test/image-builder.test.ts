import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { idTagFor, tagFor } from "../src/lib/targets/catalog.ts"
import { dockerImageBuilder, type Run, spawnRun } from "../src/lib/targets/image-builder.ts"
import { dockerfileSha256Of, recipeKey } from "../src/lib/targets/images.ts"
import { recipeProblem } from "../src/lib/targets/prepare.ts"
import { cleanupRecipeFixtures, recipeFixture } from "./recipe-fixture.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cleanupRecipeFixtures()
})
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

const BASE = `node:24-slim@sha256:${"e".repeat(64)}`
const LOCAL_ID = `sha256:${"1".repeat(64)}`
const LOCK = "lockfileVersion: '9.0'\n"

/** A repository with the three files the recipe below names, committed once. */
function repo(): { root: string; pin: string } {
  const root = temp("factory-builder-repo-")
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()
  git("init", "-q")
  git("config", "user.email", "t@example.com")
  git("config", "user.name", "t")
  writeFileSync(join(root, "package.json"), '{"packageManager":"pnpm@10.33.0"}\n')
  writeFileSync(join(root, "pnpm-lock.yaml"), LOCK)
  mkdirSync(join(root, "packages", "devkit"), { recursive: true })
  writeFileSync(join(root, "packages", "devkit", "package.json"), "{}\n")
  git("add", ".")
  git("commit", "-q", "-m", "one")
  return { root, pin: git("rev-parse", "HEAD") }
}

function recipeAt(pin: string, overrides: Parameters<typeof recipeFixture>[0] = {}) {
  return recipeFixture({
    pin,
    root: ".",
    baseImage: BASE,
    imageContext: ["package.json", "pnpm-lock.yaml"],
    lockfile: "pnpm-lock.yaml",
    capture: { include: ["package.json", "packages/devkit/package.json"] },
    runnerConfig: ["package.json"],
    commands: { cwd: ".", build: [], test: ["true"], nodeTestExecArgv: [] },
    imageAssertResolves: ["vitest"],
    ...overrides,
  })
}

/** git and tar for real; docker scripted, every call recorded. */
function scriptedDocker(options: { readonly basePresent: boolean }) {
  const calls: string[][] = []
  let context: string[] = []
  const run: Run = async (command, args, runOptions) => {
    if (command !== "docker") return spawnRun(command, args, runOptions)
    calls.push([...args])
    const [verb, ...rest] = args
    if (verb === "image" && rest.at(-1) === BASE) {
      if (!options.basePresent)
        throw new Error(
          `docker image failed (exit 1): Error response from daemon: No such image: ${BASE}`,
        )
      return "sha256:base\n"
    }
    if (verb === "pull") {
      runOptions.onOutput?.("pulled\n")
      return ""
    }
    if (verb === "build") {
      context = readdirSync(args.at(-1) as string).sort()
      // What BuildKit does with --iidfile: this build's id, whatever the tag names.
      writeFileSync(args[args.indexOf("--iidfile") + 1] as string, LOCAL_ID)
      runOptions.onOutput?.("#5 DONE 0.1s\n")
      return ""
    }
    if (verb === "tag" || verb === "run") return ""
    throw new Error(`unscripted: docker ${args.join(" ")}`)
  }
  return { run, calls, context: () => context }
}

describe("dockerImageBuilder", () => {
  it("pulls an absent base, builds the pin's archive with the recipe's arguments, and checks the modules by id", async () => {
    const { root, pin } = repo()
    const recipe = recipeAt(pin)
    const docker = scriptedDocker({ basePresent: false })
    const tmp = temp("factory-builder-tmp-")
    const key = recipeKey(recipe, "linux/arm64")
    const tag = tagFor(recipe.id, pin, key)
    const log: string[] = []
    const image = await dockerImageBuilder({ run: docker.run, tmp }).build(
      { recipe, platform: "linux/arm64", key, tag, repositoryRoot: root },
      (chunk) => log.push(chunk),
      AbortSignal.timeout(30_000),
    )
    expect(image).toEqual({
      localId: LOCAL_ID,
      platform: "linux/arm64",
      baseManifestDigest: `sha256:${"e".repeat(64)}`,
      dockerfileSha256: dockerfileSha256Of(recipe),
      lockfileSha256: createHash("sha256").update(LOCK).digest("hex"),
      pnpmVersion: "10.33.0",
    })
    const build = docker.calls.find((call) => call[0] === "build") ?? []
    expect(docker.calls.map((call) => call.slice(0, 2))).toEqual([
      ["image", "inspect"],
      ["pull", "--platform"],
      ["build", "--platform"],
      ["tag", LOCAL_ID],
      ["run", "--rm"],
    ])
    expect(docker.calls[1]).toEqual(["pull", "--platform", "linux/arm64", BASE])
    expect(build).toEqual(
      expect.arrayContaining([
        `BASE_IMAGE=${BASE}`,
        "PLATFORM=linux/arm64",
        "PNPM_VERSION=10.33.0",
        "b4.factory.target=devkit",
        `b4.factory.pin=${pin}`,
        `b4.factory.key=${key}`,
        "--iidfile",
        "-t",
        tag,
      ]),
    )
    // The id file lives beside the context, never inside it (it would enter the build).
    expect(build[build.indexOf("--iidfile") + 1]).not.toContain(build.at(-1) as string)
    // The context is the pin's archive of imageContext plus the Dockerfile, and nothing else.
    expect(docker.context()).toEqual(["Dockerfile", "package.json", "pnpm-lock.yaml"])
    expect(existsSync(build.at(-1) as string)).toBe(false)
    expect(readdirSync(tmp)).toEqual([])
    // The id is the build's own (--iidfile), never a tag's: no `image inspect <tag>` after it.
    expect(docker.calls[3]).toEqual(["tag", LOCAL_ID, idTagFor("devkit", pin, key, LOCAL_ID)])
    expect(docker.calls[4]).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "-w",
      "/opt/targets/devkit",
      LOCAL_ID,
      "node",
      "-e",
      'require.resolve("vitest")',
    ])
    expect(log.join("")).toContain("pulling")
    expect(log.join("")).toContain("pulled")
    expect(log.join("")).toContain("#5 DONE")
  })

  it("does not pull a base the daemon already holds", async () => {
    const { root, pin } = repo()
    const docker = scriptedDocker({ basePresent: true })
    await dockerImageBuilder({ run: docker.run }).build(
      {
        recipe: recipeAt(pin),
        platform: "linux/arm64",
        key: "k".repeat(64),
        tag: "b4-factory-devkit:x",
        repositoryRoot: root,
      },
      () => {},
      AbortSignal.timeout(30_000),
    )
    expect(docker.calls.some((call) => call[0] === "pull")).toBe(false)
  })

  it("never pulls under FACTORY_SKIP_BASE_PULL, and says so when the base is absent", async () => {
    const { root, pin } = repo()
    const docker = scriptedDocker({ basePresent: false })
    process.env.FACTORY_SKIP_BASE_PULL = "1"
    try {
      await expect(
        dockerImageBuilder({ run: docker.run }).build(
          {
            recipe: recipeAt(pin),
            platform: "linux/arm64",
            key: "k".repeat(64),
            tag: "t",
            repositoryRoot: root,
          },
          () => {},
          AbortSignal.timeout(30_000),
        ),
      ).rejects.toThrow(
        `base image ${BASE} is not on the daemon and FACTORY_SKIP_BASE_PULL=1 forbids pulling it`,
      )
    } finally {
      delete process.env.FACTORY_SKIP_BASE_PULL
    }
    expect(docker.calls.some((call) => call[0] === "pull")).toBe(false)
  })

  it("refuses a recipe that does not apply at the pin before any Docker call", async () => {
    const { root, pin } = repo()
    const docker = scriptedDocker({ basePresent: true })
    const recipe = recipeAt(pin, {
      imageContext: ["package.json", "pnpm-lock.yaml", "missing.txt"],
    })
    expect(recipeProblem(recipe, root)).toBe(
      `Target "devkit" names missing.txt, which does not exist at ${pin}: it cannot be prepared at that pin`,
    )
    await expect(
      dockerImageBuilder({ run: docker.run }).build(
        { recipe, platform: "linux/arm64", key: "k".repeat(64), tag: "t", repositoryRoot: root },
        () => {},
        AbortSignal.timeout(30_000),
      ),
    ).rejects.toThrow("names missing.txt, which does not exist at")
    expect(docker.calls).toEqual([])
    expect(recipeProblem(recipeAt(pin, { imageContext: ["package.json"] }), root)).toBe(
      'Target "devkit" records lockfile "pnpm-lock.yaml", which its imageContext does not cover',
    )
    expect(recipeProblem(recipeAt(pin), root)).toBeUndefined()
  })

  it("reads an image the daemon does not hold as missing, and any other failure as a failure", async () => {
    const answers: Record<string, Error | string> = {
      gone: new Error(
        "docker image failed (exit 1): Error response from daemon: No such image: gone",
      ),
      down: new Error("docker image failed (exit 1): Cannot connect to the Docker daemon"),
      here: '["b4-factory-devkit:x"]\n',
    }
    const run: Run = async (_command, args) => {
      const answer = answers[args.at(-1) as string]
      if (answer instanceof Error) throw answer
      return answer ?? ""
    }
    const builder = dockerImageBuilder({ run })
    const signal = AbortSignal.timeout(5_000)
    expect(await builder.inspect("gone", signal)).toBeNull()
    expect(await builder.inspect("here", signal)).toEqual({ tags: ["b4-factory-devkit:x"] })
    await expect(builder.inspect("down", signal)).rejects.toThrow(/Cannot connect/)
  })

  it("kills a command when its signal aborts", async () => {
    const controller = new AbortController()
    const running = spawnRun("sleep", ["30"], { signal: controller.signal })
    controller.abort(new Error("cancelled"))
    await expect(running).rejects.toThrow()
  })
})

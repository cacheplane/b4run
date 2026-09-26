import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  repositoryRoot,
  type TargetManifest,
  TargetSchema,
  targetsDir,
} from "../src/lib/targets/catalog.ts"
import { PLACEHOLDER_RESOURCES } from "../src/lib/targets/init/derive.ts"
import { expectedPromotedOf } from "../src/lib/targets/init/dockerfile.ts"
import { initTarget } from "../src/lib/targets/init/init.ts"
import { dockerfileCapturedPackages } from "../src/lib/targets/prepare.ts"
import { parseVitestCommand } from "../src/lib/targets/vitest-command.ts"

/** Several hundred git reads and a Biome format per generation: over vitest's 10 s hook default. */
const GENERATE_MS = 120_000

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const committed = (id: string): TargetManifest =>
  TargetSchema.parse(JSON.parse(readFileSync(join(targetsDir, id, "target.json"), "utf8")))
const committedDockerfile = (id: string) => readFileSync(join(targetsDir, id, "Dockerfile"), "utf8")

/** `init` of `packageRef` at `pin` into `into` (an empty directory unless given): nothing carried. */
function generate(packageRef: string, pin: string, into?: string) {
  const dir = into ?? mkdtempSync(join(tmpdir(), "factory-init-repro-"))
  if (into === undefined) dirs.push(dir)
  const result = initTarget({ packageRef, pin, repositoryRoot: repositoryRoot(), targetsDir: dir })
  const [manifest, dockerfile] = result.files
  return {
    manifest: TargetSchema.parse(JSON.parse(manifest?.after ?? "")) as TargetManifest,
    dockerfile: dockerfile?.after ?? "",
    notes: result.notes,
  }
}
const sorted = (paths: readonly string[]) => [...paths].sort()
/** Order-free lists sorted: init's order is canonical, a hand-written target's is not. */
const normalise = (m: TargetManifest): TargetManifest => ({
  ...m,
  capture: { include: sorted(m.capture.include) },
  imageContext: sorted(m.imageContext),
  runnerConfig: sorted(m.runnerConfig),
})

const CLI_BUILD = [
  "pnpm",
  "exec",
  "tsc",
  "-b",
  "--builders",
  "1",
  "../ag-ui",
  "../sdk",
  "../langgraph",
  "../permissions",
  "../workspace",
  "../sqlite-storage",
  "../core",
  "../langchain",
  "../memory",
  "tsconfig.build.json",
]

describe("target:init reproduces the hand-written devkit target", () => {
  const want = committed("devkit")
  let got: ReturnType<typeof generate>
  beforeAll(() => {
    got = generate("@b4run/devkit", want.pin)
  }, GENERATE_MS)

  it("is the committed target with exactly the named differences applied", () => {
    const committedCommand = parseVitestCommand(want.commands.test)
    // 1. The nine excludes are target:measure's to propose (Task 17 proves it proposes them).
    expect(committedCommand.files).toEqual([])
    expect(committedCommand.excludes).toHaveLength(9)
    expect(normalise(got.manifest)).toEqual(
      normalise({
        ...want,
        commands: { ...want.commands, test: [...committedCommand.base] },
        // 2. runnerConfig gains the root manifests: the rule the cli target's review adopted.
        //    The devkit task already keeps them immutable.
        runnerConfig: [...want.runnerConfig, "package.json", "pnpm-workspace.yaml", ".npmrc"],
        // 3. Resources are placeholders until target:measure proposes them.
        resources: PLACEHOLDER_RESOURCES,
      }),
    )
  })

  it("writes the template Dockerfile, and names what the capture leaves out", () => {
    // 4. The Dockerfile is the one template: both captured packages relinked, nothing to
    //    promote until a build says otherwise.
    expect(got.dockerfile).not.toBe(committedDockerfile("devkit"))
    expect(dockerfileCapturedPackages(got.dockerfile)).toEqual(["config-typescript", "devkit"])
    expect(got.dockerfile).toContain(
      "--filter @b4run/devkit... --ignore-scripts --config.node-linker=hoisted",
    )
    expect(expectedPromotedOf(got.dockerfile)).toEqual([])
    expect(got.notes).toContainEqual(
      expect.stringMatching(/^packages\/devkit: not captured: templates\/ \(\d+ files\)$/),
    )
    expect(got.notes).toContain("packages/devkit: files not captured: CHANGELOG.md, README.md")
  })

  it(
    "carries everything decided when it regenerates the committed target in place",
    () => {
      const again = generate("@b4run/devkit", want.pin, targetsDir)
      expect(normalise(again.manifest)).toEqual(
        normalise({
          ...want,
          runnerConfig: [...want.runnerConfig, "package.json", "pnpm-workspace.yaml", ".npmrc"],
        }),
      )
    },
    GENERATE_MS,
  )
})

describe("target:init reproduces the hand-written cli target", () => {
  const want = committed("cli")
  let got: ReturnType<typeof generate>
  beforeAll(() => {
    got = generate("@b4run/cli", want.pin)
  }, GENERATE_MS)

  it("is the committed target with exactly the named differences applied", () => {
    const scoped = want.capture.include.filter((path) => path.startsWith("packages/cli/test/"))
    const committedCommand = parseVitestCommand(want.commands.test)
    expect(scoped).toHaveLength(9)
    expect(committedCommand.files).toHaveLength(8)
    // Two hand-picked module assertions (commander checks the promotion), a build that
    // disables declaration maps (a snapshot-cost mitigation #826 and #829 made unnecessary),
    // and eight hand-verified drafting notes.
    expect(want.imageAssertResolves.slice(3)).toEqual(["@langchain/langgraph", "commander"])
    expect(want.commands.build).toContain("--declarationMap")
    expect(want.draftingNotes).toHaveLength(8)
    const { draftingNotes: _notes, ...undecided } = want
    expect(normalise(got.manifest)).toEqual(
      normalise({
        ...undecided,
        // 1. Scope: the whole test directory, not eight files and their helper (plan D4).
        capture: {
          include: [
            ...want.capture.include.filter((path) => !scoped.includes(path)),
            "packages/cli/test",
          ],
        },
        // 2. The derived module assertions only.
        imageAssertResolves: want.imageAssertResolves.slice(0, 3),
        // 3. The same ten projects in another topological order; the base test command.
        commands: { ...want.commands, build: CLI_BUILD, test: [...committedCommand.base] },
        // 4. Resources are placeholders until target:measure proposes them.
        resources: PLACEHOLDER_RESOURCES,
      }),
    )
  })

  it("relinks the same packages, learns its promotion set later, and names what it omits", () => {
    expect(dockerfileCapturedPackages(got.dockerfile)).toEqual(
      dockerfileCapturedPackages(committedDockerfile("cli")),
    )
    expect(expectedPromotedOf(got.dockerfile)).toEqual([])
    expect(expectedPromotedOf(committedDockerfile("cli"))).toEqual([
      "@hono/node-server",
      "commander",
      "hono",
      "typescript",
    ])
    expect(got.notes).toContain(
      "@b4run/sandbox (packages/sandbox) is installed, not captured: a test importing it resolves the image's manifest-only copy and fails, and target:measure proposes excluding that test (or pass --with-dev-builds)",
    )
    expect(got.notes).toContain(
      "packages/cli/vitest.config.ts reads ../sandbox/ (packages/sandbox), which the capture omits: a test that reaches it fails, and target:measure proposes excluding it",
    )
    expect(got.notes).toContainEqual(
      expect.stringMatching(
        /^packages\/cli: not captured: bin\/ \(\d+ files?\), scripts\/ \(\d+ files?\)$/,
      ),
    )
    expect(got.notes).toContain(
      "packages/cli: files not captured: CHANGELOG.md, README.md, SKILL.md",
    )
  })

  it(
    "carries everything decided when it regenerates the committed target in place",
    () => {
      const again = generate("@b4run/cli", want.pin, targetsDir)
      // Scope, capture, module assertions, runner configuration, resources, drafting notes and
      // the promotion set all carried; only the build is regenerated.
      expect(normalise(again.manifest)).toEqual(
        normalise({ ...want, commands: { ...want.commands, build: CLI_BUILD } }),
      )
      expect(again.manifest.imageAssertResolves).toEqual(want.imageAssertResolves)
      expect(sorted(again.manifest.capture.include)).toEqual(sorted(want.capture.include))
      expect(expectedPromotedOf(again.dockerfile)).toEqual(
        expectedPromotedOf(committedDockerfile("cli")),
      )
    },
    GENERATE_MS,
  )
})

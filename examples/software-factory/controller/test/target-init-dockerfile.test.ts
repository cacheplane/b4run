import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  type DockerfileSpec,
  EXPECTED_MARKER,
  expectedPromotedOf,
  PROMOTED_MARKER,
  promotionMismatch,
  renderDockerfile,
  withExpectedPromoted,
} from "../src/lib/targets/init/dockerfile.ts"
import { capturedListMismatch, dockerfileCapturedPackages } from "../src/lib/targets/prepare.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const SPEC: DockerfileSpec = {
  id: "app",
  filter: "@m/app",
  captured: [
    { dir: "app", name: "@m/app" },
    { dir: "config", name: "@m/config" },
    { dir: "core", name: "@m/core" },
    { dir: "util", name: "@m/util" },
  ],
  expectedPromoted: [],
  npmrc: true,
}

/** The promotion RUN's shell as the image's /bin/sh receives it: continuations joined. */
function promotionStep(dockerfile: string): string {
  const lines = dockerfile.split("\n")
  const start = lines.findIndex((line) => line.startsWith("RUN set -eu"))
  const body: string[] = []
  for (let i = start; ; i++) {
    const line = lines[i] as string
    body.push(line.endsWith("\\") ? line.slice(0, -1) : line)
    if (!line.endsWith("\\")) break
  }
  return body.join("").replace(/^RUN /, "")
}

const file = (root: string, path: string, text: string) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** `/opt/targets/<id>` after a hoisted install: root packages, and what hoisting nested. */
function installed(nested: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "factory-dockerfile-"))
  dirs.push(root)
  file(root, "node_modules/typescript/package.json", "root-ts")
  file(root, "node_modules/.bin/tsc", "root tsc")
  file(root, "node_modules/commander/package.json", "root-commander")
  mkdirSync(join(root, "node_modules/@m"), { recursive: true })
  symlinkSync("../../packages/app", join(root, "node_modules/@m/app"))
  for (const [path, text] of Object.entries(nested)) file(root, path, text)
  // A workspace link hoisting nested: a symlink, never promoted.
  mkdirSync(join(root, "packages/app/node_modules/@m"), { recursive: true })
  symlinkSync("../../../core", join(root, "packages/app/node_modules/@m/core"))
  file(root, "packages/app/node_modules/.bin/x", "bin")
  return root
}

/** The image's /bin/sh is dash; run under it where the host has one, so its rules apply. */
const SHELL = spawnSync("dash", ["-c", "true"]).status === 0 ? "dash" : "sh"

const run = (dockerfile: string, cwd: string) =>
  spawnSync(SHELL, ["-c", promotionStep(dockerfile)], { cwd, encoding: "utf8" })

const NESTED = {
  "packages/app/node_modules/commander/package.json": "app-commander",
  "packages/app/node_modules/typescript/package.json": "app-ts",
  "packages/core/node_modules/@scope/pkg/package.json": "core-scoped",
}

describe("the generated Dockerfile", () => {
  it("keeps every trap the hand-written Dockerfiles learned", () => {
    const text = renderDockerfile(SPEC)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the Dockerfile's own build args
    expect(text).toContain("FROM --platform=${PLATFORM} ${BASE_IMAGE}")
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the Dockerfile's own build arg
    expect(text).toContain("npm install -g pnpm@${PNPM_VERSION}")
    expect(text).toContain("COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./")
    expect(text).toContain(
      "RUN pnpm install --frozen-lockfile --filter @m/app... --ignore-scripts --config.node-linker=hoisted \\\n && chmod -R a+rX /opt/targets/app\n",
    )
    expect(text).toContain("RUN ln -s /tmp /opt/targets/app/node_modules/.vite-temp\n")
    expect(text.endsWith("USER node\nWORKDIR /workspace\n")).toBe(true)
    expect(renderDockerfile({ ...SPEC, npmrc: false })).toContain(
      "COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./",
    )
  })

  it("declares its captured packages as target:prepare checks them", () => {
    const text = renderDockerfile(SPEC)
    expect(dockerfileCapturedPackages(text)).toEqual(["app", "config", "core", "util"])
    const capture = {
      include: ["packages/app/src", "packages/config", "packages/core/src", "packages/util/src"],
    }
    expect(capturedListMismatch({ id: "app", capture }, text)).toBeUndefined()
  })

  it("promotes what hoisting nested, shims the root's tsc, and relinks the workspace", () => {
    const root = installed(NESTED)
    const text = renderDockerfile({
      ...SPEC,
      expectedPromoted: ["typescript", "commander", "@scope/pkg"],
    })
    const result = run(text, root)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`${PROMOTED_MARKER} @scope/pkg commander typescript \n`)
    expect(readFileSync(join(root, "tools/node_modules/typescript/package.json"), "utf8")).toBe(
      "root-ts",
    )
    expect(readFileSync(join(root, "node_modules/typescript/package.json"), "utf8")).toBe("app-ts")
    expect(readFileSync(join(root, "node_modules/commander/package.json"), "utf8")).toBe(
      "app-commander",
    )
    expect(readFileSync(join(root, "node_modules/@scope/pkg/package.json"), "utf8")).toBe(
      "core-scoped",
    )
    expect(readFileSync(join(root, "node_modules/.bin/tsc"), "utf8")).toBe(
      '#!/bin/sh\nexec node /opt/targets/app/tools/node_modules/typescript/bin/tsc "$@"\n',
    )
    expect(existsSync(join(root, "packages/app/node_modules"))).toBe(false)
    for (const { dir, name } of SPEC.captured)
      expect(readlinkSync(join(root, "node_modules", name))).toBe(`/workspace/packages/${dir}`)
  })

  it("leaves the root's typescript alone when nothing nests one", () => {
    const root = installed({ "packages/core/node_modules/hono/package.json": "core-hono" })
    const result = run(renderDockerfile({ ...SPEC, expectedPromoted: ["hono"] }), root)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(root, "tools"))).toBe(false)
    expect(readFileSync(join(root, "node_modules/.bin/tsc"), "utf8")).toBe("root tsc")
  })

  it("fails the build, printing both sets, when the promotion differs from the reviewed set", () => {
    const result = run(renderDockerfile(SPEC), installed(NESTED))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`${PROMOTED_MARKER} @scope/pkg commander typescript `)
    expect(result.stderr).toContain(`${EXPECTED_MARKER}  `)
  })

  it("fails the build when two captured packages nest one name", () => {
    const root = installed({
      "packages/app/node_modules/hono/package.json": "app-hono",
      "packages/core/node_modules/hono/package.json": "core-hono",
    })
    const result = run(renderDockerfile({ ...SPEC, expectedPromoted: ["hono"] }), root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("promoted twice: hono (again from packages/core)")
  })

  it("fails the build when a promotion's move fails inside the loop", () => {
    const root = installed(NESTED)
    // `mkdir -p node_modules/@scope` cannot make a directory where a file stands.
    file(root, "node_modules/@scope", "not a directory")
    const text = renderDockerfile({
      ...SPEC,
      expectedPromoted: ["typescript", "commander", "@scope/pkg"],
    })
    const result = run(text, root)
    expect(result.status, result.stdout).not.toBe(0)
    expect(result.stdout).not.toContain(PROMOTED_MARKER)
  })

  it("fails the build when a workspace relink fails inside the loop", () => {
    // Not the last link: the loop's own status is its last iteration's.
    const root = installed({})
    file(root, "node_modules/@x", "not a directory")
    const captured = [{ dir: "a", name: "@x/a" }, ...SPEC.captured]
    const result = run(renderDockerfile({ ...SPEC, captured }), root)
    expect(result.status, result.stdout).not.toBe(0)
    // It stopped at the failed link, before relinking the rest.
    expect(() => readlinkSync(join(root, "node_modules/@m/core"))).toThrow()
  })

  it("does not shim tsc for a nested typescript that is only a symlink", () => {
    const root = installed({})
    mkdirSync(join(root, "elsewhere/typescript"), { recursive: true })
    symlinkSync("../../../elsewhere/typescript", join(root, "packages/app/node_modules/typescript"))
    const result = run(renderDockerfile(SPEC), root)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(root, "tools"))).toBe(false)
    expect(readFileSync(join(root, "node_modules/.bin/tsc"), "utf8")).toBe("root tsc")
  })

  it("fails the build when it would promote a name the workspace relinks", () => {
    const root = installed({ "packages/app/node_modules/@m/util/package.json": "nested-util" })
    const result = run(renderDockerfile({ ...SPEC, expectedPromoted: ["@m/util"] }), root)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      "promoted @m/util is a workspace package the image relinks to /workspace/packages/util",
    )
  })

  it("declares its captured packages sorted by directory, whatever order it is given", () => {
    const text = renderDockerfile({ ...SPEC, captured: [...SPEC.captured].reverse() })
    expect(text).toBe(renderDockerfile(SPEC))
    expect(text).toContain('CAPTURED="app config core util"')
  })

  it("refuses a promotion set that names a package twice", () => {
    expect(() =>
      renderDockerfile({ ...SPEC, expectedPromoted: ["hono", "commander", "hono"] }),
    ).toThrow(/names hono twice/)
    expect(() => withExpectedPromoted(renderDockerfile(SPEC), ["hono", "hono"])).toThrow(
      /names hono twice/,
    )
  })

  it("refuses a name that would start with a dash", () => {
    for (const name of ["-rf", "@-s/x", "@s/-x", "_x"]) {
      expect(() => renderDockerfile({ ...SPEC, filter: name }), name).toThrow(/will not write/)
      expect(() => withExpectedPromoted(renderDockerfile(SPEC), [name]), name).toThrow(
        /will not write/,
      )
    }
  })

  it("refuses to write a value the shell would read as syntax", () => {
    for (const bad of ["a b", "$(id)", "x;y", 'q"'])
      expect(() => renderDockerfile({ ...SPEC, expectedPromoted: [bad] }), bad).toThrow(
        /will not write/,
      )
  })

  it("refuses a name or directory that leaves its place in node_modules or packages/", () => {
    for (const name of ["@m/../..", "..", "@m/app/x", ".hidden", "@/x"]) {
      expect(() => renderDockerfile({ ...SPEC, expectedPromoted: [name] }), name).toThrow(
        /will not write/,
      )
      expect(() => renderDockerfile({ ...SPEC, captured: [{ dir: "app", name }] }), name).toThrow(
        /will not write/,
      )
      expect(() => withExpectedPromoted(renderDockerfile(SPEC), [name]), name).toThrow(
        /will not write/,
      )
    }
    for (const dir of ["..", ".", "a/b", "../app"])
      expect(() => renderDockerfile({ ...SPEC, captured: [{ dir, name: "@m/app" }] }), dir).toThrow(
        /will not write/,
      )
    expect(() => renderDockerfile({ ...SPEC, id: "../app" })).toThrow(/will not write/)
    expect(() => renderDockerfile({ ...SPEC, filter: "@m/.." })).toThrow(/will not write/)
  })
})

describe("the promotion set", () => {
  it("is read from and written into a Dockerfile", () => {
    const text = renderDockerfile({ ...SPEC, expectedPromoted: ["typescript", "commander"] })
    expect(expectedPromotedOf(text)).toEqual(["commander", "typescript"])
    expect(expectedPromotedOf(withExpectedPromoted(text, ["hono"]))).toEqual(["hono"])
    expect(expectedPromotedOf("FROM x\n")).toBeUndefined()
    expect(() => withExpectedPromoted("FROM x\n", ["hono"])).toThrow(
      /declares no EXPECTED_PROMOTED/,
    )
  })

  it("is learned from a failed build's log, never from BuildKit's echo of the RUN line", () => {
    const echoed = `#9 [6/7] RUN set -eu  && CAPTURED="app core"  && EXPECTED_PROMOTED=""  && echo "${PROMOTED_MARKER} $actual"  && if [ "$actual" != "$expected" ]; then echo "${EXPECTED_MARKER} $expected" >&2; exit 1; fi`
    const failed = [
      echoed,
      `#9 0.412 ${PROMOTED_MARKER} @hono/node-server commander hono typescript `,
      `#9 0.413 ${EXPECTED_MARKER}  `,
      `#9 ERROR: process "/bin/sh -c set -eu ... echo \\"${EXPECTED_MARKER} $expected\\"" did not complete successfully: exit code: 1`,
      "",
    ].join("\n")
    expect(promotionMismatch(failed)).toEqual([
      "@hono/node-server",
      "commander",
      "hono",
      "typescript",
    ])
    // The echo alone (a build that failed elsewhere, before the step printed anything).
    expect(promotionMismatch(`${echoed}\n#9 ERROR: exit code: 100\n`)).toBeUndefined()
    // A build that passed the check.
    expect(promotionMismatch(`${echoed}\n#9 0.4 ${PROMOTED_MARKER}  \n#10 DONE\n`)).toBeUndefined()
    // The two markers from different steps are not one failed check.
    expect(
      promotionMismatch(
        `#9 0.4 ${PROMOTED_MARKER} hono \n#9 DONE\n#12 0.1 ${EXPECTED_MARKER}  \n#12 ERROR: exit code: 1\n`,
      ),
    ).toBeUndefined()
    // BuildKit's error summary repeats the step's output without step numbers; only the step's
    // own numbered lines count.
    expect(
      promotionMismatch(
        `${failed}------\n > [6/7] RUN set -eu ...:\n0.412 ${PROMOTED_MARKER} bogus \n0.413 ${EXPECTED_MARKER}  \n------\n`,
      ),
    ).toEqual(["@hono/node-server", "commander", "hono", "typescript"])
  })
})

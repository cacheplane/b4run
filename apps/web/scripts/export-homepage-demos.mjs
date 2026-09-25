// Regenerates the data behind the homepage demos from the real framework.
//
// Re-record after any change to packages/cli/src/lib/build/targets/*,
// packages/cli/src/commands/{build,eval}.ts, or the app-basic template.
//
//   pnpm build   # every @b4run package and create-b4-app resolve to their dist/
//   node apps/web/scripts/export-homepage-demos.mjs                  # schema variants
//   node apps/web/scripts/export-homepage-demos.mjs --record-tests   # ship/test-replay.json
//   node apps/web/scripts/export-homepage-demos.mjs --record-builds  # ship/build-outputs.json
//
// Schema variants: runs @b4run/core's tool-schema extractor, the one `b4
// typegen` uses, on each playground variant of the scaffold's greet tool, and
// writes app/components/homepage/playground/schema-variants.json. The
// playground test runs the same extraction and expects this file exactly.
//
// Recordings: scaffolds the basic app into a temp directory with this
// checkout's create-b4-app (`--mode internal`, so every @b4run package is this
// checkout's), installs it, and runs the real commands in an allow-listed
// environment: no OPENAI_API_KEY, no other key or token. The transcripts lose
// ANSI codes, vitest's timings and the temp path, and nothing else. The install reads pnpm's store first and
// falls back to the npm registry for anything the store lacks. No model is
// called: the scaffold's test and eval replay script() fixtures.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { extractToolSchemasForRoute } from "@b4run/core/node"

const scriptFile = realpathSync(fileURLToPath(import.meta.url))
const webRoot = resolve(dirname(scriptFile), "..")
const repoRoot = resolve(webRoot, "..", "..")
export const playgroundRoot = join(webRoot, "app", "components", "homepage", "playground")
export const schemaVariantsFile = join(playgroundRoot, "schema-variants.json")
export const shipRoot = join(webRoot, "app", "components", "homepage", "ship")
export const testReplayFile = join(shipRoot, "test-replay.json")
export const buildOutputsFile = join(shipRoot, "build-outputs.json")
const templateRoot = join(repoRoot, "packages", "devkit", "templates", "app-basic")
// The compiler options a scaffolded app extends (@b4run/config-typescript/node).
const toolTsconfig = join(repoRoot, "packages", "config-typescript", "node.json")

/** The name the recordings give the scaffolded app, in place of its temp path. */
export const APP_NAME = "my-agent"
/** `npm test`, with vitest's verbose reporter so the transcript names each test. */
export const TEST_COMMAND = "npm test -- --reporter=verbose"
export const EVAL_COMMAND = "npx b4 eval"
export const BUILD_COMMAND = "npx b4 build"
/** `default` is the scaffold's own b4.config.ts; the rest set `build.targets`. */
export const BUILD_IDS = ["default", "node", "langsmith", "hono", "vercel"]
/**
 * The packages the hono and vercel targets' runtime imports that the scaffold
 * doesn't already declare (`/docs/deployment/edge#emitted-artifacts`,
 * `/docs/deployment/vercel`), then the model provider the scaffold's
 * gpt-5-mini route bundles. The page names each one in those targets' copy.
 */
export const EDGE_PACKAGES = [
  "@b4run/postgres-storage",
  "@neondatabase/serverless",
  "hono",
  "@langchain/openai",
]
/** What `pnpm add` gets: postgres storage from this checkout, like every other @b4run package. */
const EDGE_DEPENDENCIES = EDGE_PACKAGES.map((name) =>
  name === "@b4run/postgres-storage"
    ? `${name}@file:${join(repoRoot, "packages", "postgres-storage")}`
    : name,
)
/** Everything a build writes, cleared before each target runs. */
const BUILD_OUTPUTS = [".b4/build", ".vercel", "Dockerfile", "wrangler.toml", "vercel.json"]

/** `base` is the scaffold's own greet.ts; each flag names one change from it. */
export function variantId({ formal, language, jsdoc }) {
  const flags = [formal && "formal", language && "language", !jsdoc && "nodoc"].filter(Boolean)
  return flags.length === 0 ? "base" : flags.join("-")
}

/** Every combination of the playground's three toggles, in a fixed order. */
export function variantCombinations() {
  const combinations = []
  for (const formal of [false, true]) {
    for (const language of [false, true]) {
      for (const jsdoc of [true, false]) combinations.push({ formal, language, jsdoc })
    }
  }
  return combinations
}

export async function extractSchemaVariants() {
  const variants = []
  for (const flags of variantCombinations()) {
    const id = variantId(flags)
    // Each variant is its own route folder, so the tool is named greet in all of them.
    const routeDir = join(playgroundRoot, "variants", id)
    const schemas = await extractToolSchemasForRoute({
      routeDir,
      sharedToolsDir: undefined,
      tsconfig: toolTsconfig,
    })
    if (schemas.length !== 1 || schemas[0]?.name !== "greet") {
      throw new Error(`Expected exactly one greet tool in ${routeDir}`)
    }
    const source = readFileSync(join(routeDir, "tools", "greet.ts"), "utf8")
    variants.push({ id, ...flags, source, schema: schemas[0] })
  }
  return { tool: "greet", variants }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences start with ESC.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
/** vitest's result line for one test or file: a ✓ or × after the indent. */
const RESULT_LINE = /^\s*[✓×]\s/
/** The timing vitest ends a result line with ("246ms", "1.2s"). */
const TRAILING_TIMING = /\s+\d+(?:\.\d+)?m?s$/
/** vitest's wall-clock summary lines: an indented label, then two spaces. */
const TIMING_LINE = /^\s+(?:Start at|Duration)\s{2}/

/**
 * One command's output as the page shows it: no ANSI codes, no timings, and
 * the app's temp path (any of `roots`, longest first) written as `my-agent`.
 * Runs of blank lines collapse to one, and blank lines at either end go.
 */
export function normalizeTranscript(text, roots) {
  const byLength = [...roots].sort((a, b) => b.length - a.length)
  const lines = []
  for (const raw of text.replace(ANSI, "").replaceAll("\r", "").split("\n")) {
    if (TIMING_LINE.test(raw)) continue
    let line = raw
    for (const root of byLength) line = line.replaceAll(root, APP_NAME)
    if (RESULT_LINE.test(line)) line = line.replace(TRAILING_TIMING, "")
    line = line.trimEnd()
    if (line === "" && (lines.length === 0 || lines.at(-1) === "")) continue
    lines.push(line)
  }
  while (lines.at(-1) === "") lines.pop()
  return lines
}

/**
 * The variables a recorded command inherits: the shell's tools, the home and
 * temp directories (pnpm's store and cache live under them) and the locale.
 * Nothing else passes, so no model key, token or tracing setting reaches the
 * scaffold.
 */
const INHERITED_ENV = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TZ"]
/** Where pnpm and npm keep their store and cache when HOME isn't it. */
const INHERITED_ENV_PREFIXES = ["LC_", "XDG_"]
const INHERITED_TOOL_ENV = [
  "PNPM_HOME",
  "COREPACK_HOME",
  "npm_config_cache",
  "npm_config_store_dir",
]

/**
 * The environment every recorded command runs in: allow-listed, no colour.
 * @returns {Record<string, string>}
 */
export function recordingEnv() {
  /** @type {Record<string, string>} */
  const env = {}
  for (const [name, value] of Object.entries(process.env)) {
    const inherited =
      INHERITED_ENV.includes(name) ||
      INHERITED_TOOL_ENV.includes(name) ||
      INHERITED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
    if (inherited && value !== undefined) env[name] = value
  }
  return { ...env, FORCE_COLOR: "0", NO_COLOR: "1", npm_config_update_notifier: "false" }
}

/** Why a finished spawnSync failed, or undefined when it exited 0. */
export function describeFailure(result) {
  if (result.error) return `could not run: ${result.error.message}`
  if (result.signal) return `was killed by ${result.signal}`
  if (result.status !== 0) return `exited ${result.status}`
  return undefined
}

/** Runs `command` in `cwd` with stderr folded into stdout; throws unless it exits 0. */
function run(command, cwd) {
  const result = spawnSync("sh", ["-c", `${command} 2>&1`], {
    cwd,
    env: recordingEnv(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
  const failed = describeFailure(result)
  if (failed) throw new Error(`${command} ${failed} in ${cwd}:\n${result.stdout ?? ""}`)
  return result.stdout
}

/**
 * Scaffolds the basic app into a fresh temp directory and installs it. The
 * internal-mode `.npmrc` (`ignore-workspace=true`, for a scaffold inside a pnpm
 * workspace) goes, as an external scaffold's does; the temp directory is in
 * no workspace. If either step fails, the temp directory goes too.
 */
export function scaffoldBasicApp() {
  const tempRoot = mkdtempSync(join(tmpdir(), "b4-homepage-"))
  try {
    const appRoot = join(tempRoot, APP_NAME)
    const bin = join(repoRoot, "packages", "create-b4-app", "dist", "bin.js")
    const scaffold = spawnSync(process.execPath, [bin, appRoot, "--mode", "internal"], {
      env: recordingEnv(),
      encoding: "utf8",
    })
    const failed = describeFailure(scaffold)
    if (failed) {
      throw new Error(`create-b4-app ${failed}:\n${scaffold.stdout ?? ""}${scaffold.stderr ?? ""}`)
    }
    rmSync(join(appRoot, ".npmrc"), { force: true })
    run("pnpm install --prefer-offline", appRoot)
    return { tempRoot, appRoot, roots: [...new Set([appRoot, realpathSync(appRoot)])] }
  } catch (error) {
    rmSync(tempRoot, { recursive: true, force: true })
    throw error
  }
}

/** The scaffold's tests and evals, exactly as they print. */
export function recordTestReplay({ appRoot, roots }) {
  const record = (id, command) => ({
    id,
    command,
    lines: normalizeTranscript(run(command, appRoot), roots),
  })
  return { app: APP_NAME, runs: [record("test", TEST_COMMAND), record("eval", EVAL_COMMAND)] }
}

/**
 * `b4 build` under the scaffold's own config (the defaults), then under each
 * target's config from ship/fixtures/targets/, from a clean tree each time.
 */
export function recordBuilds({ appRoot, roots }) {
  const packages = EDGE_DEPENDENCIES.map((name) => `'${name}'`).join(" ")
  run(`pnpm add --prefer-offline ${packages}`, appRoot)
  const builds = []
  for (const id of BUILD_IDS) {
    const configFile =
      id === "default"
        ? join(templateRoot, "b4.config.ts")
        : join(shipRoot, "fixtures", "targets", `${id}.ts`)
    const config = readFileSync(configFile, "utf8")
    writeFileSync(join(appRoot, "b4.config.ts"), config)
    for (const output of BUILD_OUTPUTS) {
      rmSync(join(appRoot, output), { recursive: true, force: true })
    }
    builds.push({ id, config, lines: normalizeTranscript(run(BUILD_COMMAND, appRoot), roots) })
  }
  return { app: APP_NAME, command: BUILD_COMMAND, builds }
}

/** Writes `data` in the repository's JSON style, so lint passes on the committed file. */
function writeJson(file, data) {
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "format",
      "--write",
      "--config-path",
      join(repoRoot, "packages", "config-biome", "biome.json"),
      file,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  )
}

function isDirectExecution(invokedPath, modulePath) {
  return (
    invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(modulePath)
  )
}

if (isDirectExecution(process.argv[1], scriptFile)) {
  const flags = new Set(process.argv.slice(2))
  if (flags.has("--record-tests") || flags.has("--record-builds")) {
    const app = scaffoldBasicApp()
    try {
      if (flags.has("--record-tests")) {
        writeJson(testReplayFile, recordTestReplay(app))
        console.log(`Wrote ${testReplayFile}`)
      }
      if (flags.has("--record-builds")) {
        writeJson(buildOutputsFile, recordBuilds(app))
        console.log(`Wrote ${buildOutputsFile}`)
      }
    } finally {
      rmSync(app.tempRoot, { recursive: true, force: true })
    }
  } else {
    const data = await extractSchemaVariants()
    writeJson(schemaVariantsFile, data)
    console.log(`Wrote ${data.variants.length} schema variants to ${schemaVariantsFile}`)
  }
}

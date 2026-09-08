import { constants } from "node:fs"
import { access, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { resolveTemplateDir, writeTemplate } from "@b4run/devkit"

interface CliOptions {
  readonly distTag: string
  readonly mode: "external" | "internal"
  readonly targetDir: string
  readonly template: string
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(packageRoot, "../..")

/**
 * Minimum Node version for B4.run apps: the active LTS line. Node 24 bundles
 * npm ≥ 11 (npm 10's resolver cannot install the scaffold's dependency graph)
 * and ships `node:sqlite` unflagged. Checked up front so users fail fast with
 * a clear message instead of a broken install later.
 */
const NODE_FLOOR_MAJOR = 24

export function assertSupportedNode(version: string = process.version): void {
  const major = Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10)
  if (major < NODE_FLOOR_MAJOR) {
    throw new Error(
      `B4.run requires Node ${NODE_FLOOR_MAJOR}+ (current LTS); you are running ${version}.\n` +
        `Upgrade Node (e.g. \`nvm install ${NODE_FLOOR_MAJOR}\`) and re-run.`,
    )
  }
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  try {
    assertSupportedNode()
    const options = parseArgs(argv)
    await scaffoldApp(options)
    printNextSteps(options)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

function printNextSteps(options: CliOptions): void {
  const appName = basename(resolve(options.targetDir))
  const isWindows = process.platform === "win32"
  const targetDir = isWindows
    ? `'${options.targetDir.replaceAll("'", "''")}'`
    : `'${options.targetDir.replaceAll("'", "'\\''")}'`
  const changeDirectoryStep = isWindows
    ? `  Set-Location -LiteralPath ${targetDir}`
    : `  cd ${targetDir}`
  const researchSteps = [
    changeDirectoryStep,
    "  npm install",
    isWindows
      ? "  Copy-Item -LiteralPath server/.env.example -Destination server/.env"
      : "  cp server/.env.example server/.env",
    "  # add OPENAI_API_KEY",
    "  npm run verify",
    "",
    "Then start both processes, one per terminal:",
    "  npm run dev:server  # agent server on http://127.0.0.1:3002",
    "  npm run dev:web     # web UI on http://localhost:3010",
    "",
    "See your agent:",
    "  npx b4 inspect --cwd server  # memory Inspector (browser UI), in a third terminal",
  ]
  const basicSteps = [
    changeDirectoryStep,
    "  npm install",
    "  npm run check     # validate the app",
    "  npm test          # offline tests — no API key needed",
    "",
    "Run it live (needs an OpenAI key):",
    isWindows ? "  $env:OPENAI_API_KEY = 'sk-...'" : "  export OPENAI_API_KEY=sk-...",
    "  npm run dev       # B4.run dev server on http://127.0.0.1:3000",
  ]
  const lines = [
    "",
    `✔ Created ${appName} (${options.template} template)`,
    "",
    isWindows ? "Next steps (PowerShell):" : "Next steps:",
    ...(options.template === "research" ? researchSteps : basicSteps),
    "",
    options.template === "research"
      ? "See README.md for the full tour, or https://github.com/cacheplane/b4run"
      : "See AGENTS.md for the app's conventions, or https://b4.run/docs/getting-started",
    "",
  ]
  process.stdout.write(`${lines.join("\n")}\n`)
}

async function scaffoldApp(options: CliOptions): Promise<void> {
  const appRoot = resolve(options.targetDir)
  const templateDir = await resolveTemplateDir(options.template)
  const replacements = createTemplateReplacements(appRoot, options)

  await assertTargetDirIsWritable(appRoot)
  await assertInternalModeWorkspace(options.mode)

  await writeTemplate({
    replacements,
    targetDir: appRoot,
    templateDir,
  })

  if (options.mode === "internal") {
    await applyInternalModePackageOverrides(appRoot, replacements)
  } else {
    await rm(resolve(appRoot, ".npmrc"), { force: true })
  }
}

async function assertInternalModeWorkspace(mode: CliOptions["mode"]): Promise<void> {
  if (mode !== "internal") {
    return
  }

  const requiredPaths = [
    resolve(repoRoot, "pnpm-workspace.yaml"),
    resolve(repoRoot, "packages/ag-ui/package.json"),
    resolve(repoRoot, "packages/core/package.json"),
    resolve(repoRoot, "packages/cli/package.json"),
    resolve(repoRoot, "packages/langchain/package.json"),
    resolve(repoRoot, "packages/langgraph/package.json"),
    resolve(repoRoot, "packages/sandbox/package.json"),
    resolve(repoRoot, "packages/sdk/package.json"),
    resolve(repoRoot, "packages/config-typescript/package.json"),
  ]

  const isValidCheckout = await Promise.all(requiredPaths.map((path) => pathExists(path))).then(
    (results) => results.every(Boolean),
  )

  if (!isValidCheckout) {
    throw new Error(
      "Internal mode requires a B4.run monorepo checkout with local packages available.",
    )
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  const args = [...argv]
  let targetDir: string | undefined
  let template = "research"
  let mode: CliOptions["mode"] = "external"
  let distTag = "latest"

  while (args.length > 0) {
    const current = args.shift()

    if (!current) {
      continue
    }

    if (!current.startsWith("-")) {
      if (targetDir) {
        throw new Error(`Unknown argument "${current}"`)
      }

      targetDir = current
      continue
    }

    if (current === "--template") {
      const value = args.shift()

      if (!value) {
        throw new Error('Missing value for "--template"')
      }

      template = value
      continue
    }

    if (current === "--mode") {
      const value = args.shift()

      if (value !== "external" && value !== "internal") {
        throw new Error('Expected "--mode" to be one of: external, internal')
      }

      mode = value
      continue
    }

    if (current === "--dist-tag") {
      const value = args.shift()

      if (!value) {
        throw new Error('Missing value for "--dist-tag"')
      }

      distTag = value
      continue
    }

    throw new Error(`Unknown argument "${current}"`)
  }

  if (!targetDir) {
    throw new Error(
      "Usage: create-b4-app <target-directory> [--template basic] [--mode external|internal] [--dist-tag latest]",
    )
  }

  return {
    distTag,
    mode,
    targetDir,
    template,
  }
}

async function assertTargetDirIsWritable(targetDir: string): Promise<void> {
  try {
    await access(targetDir, constants.F_OK)
    const entries = await readdir(targetDir)

    if (entries.length > 0) {
      throw new Error(`Target directory already exists and is not empty: ${targetDir}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await mkdir(targetDir, { recursive: true })
      return
    }

    throw error
  }
}

function createAbsoluteFileSpecifier(path: string): string {
  return pathToFileURL(path).toString()
}

function createTemplateReplacements(
  appRoot: string,
  options: CliOptions,
): {
  readonly appName: string
  readonly b4AgUiSpecifier: string
  readonly b4CliSpecifier: string
  readonly b4ConfigTypescriptSpecifier: string
  readonly b4CoreSpecifier: string
  readonly b4EvalsSpecifier: string
  readonly b4InspectorSpecifier: string
  readonly b4LangchainSpecifier: string
  readonly b4LanggraphSpecifier: string
  readonly b4MemorySpecifier: string
  readonly b4PermissionsSpecifier: string
  readonly b4SandboxSpecifier: string
  readonly b4SdkSpecifier: string
  readonly b4SqliteStorageSpecifier: string
  readonly b4TestingSpecifier: string
  readonly b4WorkspaceSpecifier: string
} {
  if (options.mode === "internal") {
    return {
      appName: basename(appRoot),
      b4AgUiSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/ag-ui")),
      b4CliSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/cli")),
      b4ConfigTypescriptSpecifier: createAbsoluteFileSpecifier(
        resolve(repoRoot, "packages/config-typescript"),
      ),
      b4CoreSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/core")),
      b4EvalsSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/evals")),
      b4InspectorSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/inspector")),
      b4LangchainSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/langchain")),
      b4LanggraphSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/langgraph")),
      b4MemorySpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/memory")),
      b4PermissionsSpecifier: createAbsoluteFileSpecifier(
        resolve(repoRoot, "packages/permissions"),
      ),
      b4SandboxSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/sandbox")),
      b4SdkSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/sdk")),
      b4SqliteStorageSpecifier: createAbsoluteFileSpecifier(
        resolve(repoRoot, "packages/sqlite-storage"),
      ),
      b4TestingSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/testing")),
      b4WorkspaceSpecifier: createAbsoluteFileSpecifier(resolve(repoRoot, "packages/workspace")),
    }
  }

  return {
    appName: basename(appRoot),
    b4AgUiSpecifier: options.distTag,
    b4CliSpecifier: options.distTag,
    b4ConfigTypescriptSpecifier: options.distTag,
    b4CoreSpecifier: options.distTag,
    b4EvalsSpecifier: options.distTag,
    b4InspectorSpecifier: options.distTag,
    b4LangchainSpecifier: options.distTag,
    b4LanggraphSpecifier: options.distTag,
    b4MemorySpecifier: options.distTag,
    b4PermissionsSpecifier: options.distTag,
    b4SandboxSpecifier: options.distTag,
    b4SdkSpecifier: options.distTag,
    b4SqliteStorageSpecifier: options.distTag,
    b4TestingSpecifier: options.distTag,
    b4WorkspaceSpecifier: options.distTag,
  }
}

/**
 * Point every `@b4run/*` edge at the local checkout by APPENDING an
 * `overrides:` block to the `pnpm-workspace.yaml` the template just wrote.
 *
 * It reads and extends rather than emitting the whole file, because the
 * template owns `packages:` (the research app is a two-package npm workspace:
 * `server` and `web`) plus its build allowlist. Re-emitting from a literal here
 * silently replaced those members with a single `.`, leaving pnpm nothing to
 * install and the overrides applying to nothing.
 */
async function applyInternalModePackageOverrides(
  appRoot: string,
  replacements: ReturnType<typeof createTemplateReplacements>,
): Promise<void> {
  const overrides = {
    "@b4run/ag-ui": replacements.b4AgUiSpecifier,
    "@b4run/cli": replacements.b4CliSpecifier,
    "@b4run/config-typescript": replacements.b4ConfigTypescriptSpecifier,
    "@b4run/core": replacements.b4CoreSpecifier,
    "@b4run/evals": replacements.b4EvalsSpecifier,
    "@b4run/inspector": replacements.b4InspectorSpecifier,
    "@b4run/langchain": replacements.b4LangchainSpecifier,
    "@b4run/langgraph": replacements.b4LanggraphSpecifier,
    "@b4run/memory": replacements.b4MemorySpecifier,
    "@b4run/permissions": replacements.b4PermissionsSpecifier,
    "@b4run/sandbox": replacements.b4SandboxSpecifier,
    "@b4run/sdk": replacements.b4SdkSpecifier,
    "@b4run/sqlite-storage": replacements.b4SqliteStorageSpecifier,
    "@b4run/testing": replacements.b4TestingSpecifier,
    "@b4run/workspace": replacements.b4WorkspaceSpecifier,
  }
  const workspacePath = resolve(appRoot, "pnpm-workspace.yaml")
  const scaffolded = await readFile(workspacePath, "utf8")

  if (/^overrides:/m.test(scaffolded)) {
    throw new Error(
      `${workspacePath} already declares "overrides:" — internal mode would append a duplicate ` +
        "YAML key. Merge the override block into the template instead.",
    )
  }

  const overrideBlock = [
    "overrides:",
    ...Object.entries(overrides).map(([name, specifier]) => {
      return `  ${JSON.stringify(name)}: ${JSON.stringify(specifier)}`
    }),
    "",
  ].join("\n")

  await writeFile(workspacePath, `${scaffolded.trimEnd()}\n\n${overrideBlock}`, "utf8")
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

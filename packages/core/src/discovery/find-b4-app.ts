import { constants } from "node:fs"
import { access, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { B4_CONFIG_FILE, loadB4Config } from "../config.js"
import type { DiscoveredB4App, FindB4AppOptions } from "../types.js"
import { B4AppError } from "./b4-app-error.js"

const PACKAGE_JSON_FILE = "package.json"
const DEFAULT_APP_DIR = "src/app"
const B4_DIR = ".b4"

export async function findB4App(options: FindB4AppOptions = {}): Promise<DiscoveredB4App> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : await findAppRootFromCwd(options.cwd)
  await assertB4AppFiles(appRoot)
  await assertB4AppIsEsModule(appRoot)

  const loadedConfig = await loadB4Config({ appRoot })
  const routesDir = resolve(appRoot, loadedConfig.config.appDir ?? DEFAULT_APP_DIR)
  await assertB4RoutesDir(appRoot, routesDir)

  const b4Dir = join(appRoot, B4_DIR)

  return {
    appRoot,
    configPath: loadedConfig.configPath,
    b4Dir,
    routesDir,
  }
}

async function findAppRootFromCwd(cwd = process.cwd()): Promise<string> {
  let currentDir = resolve(cwd)

  while (true) {
    if (
      (await fileExists(join(currentDir, B4_CONFIG_FILE))) &&
      (await fileExists(join(currentDir, PACKAGE_JSON_FILE)))
    ) {
      return currentDir
    }

    const parentDir = dirname(currentDir)

    if (parentDir === currentDir) {
      throw new Error(`Could not find ${B4_CONFIG_FILE} from ${cwd}`)
    }

    currentDir = parentDir
  }
}

async function assertB4AppFiles(appRoot: string): Promise<void> {
  const missingPaths = await Promise.all(
    [join(appRoot, PACKAGE_JSON_FILE), join(appRoot, B4_CONFIG_FILE)].map(async (filePath) =>
      (await fileExists(filePath)) ? null : filePath,
    ),
  )

  throwIfMissing(appRoot, missingPaths)
}

/**
 * The app root's package.json must declare `"type": "module"`. Everything
 * B4.run loads from the app — `b4.config.ts` and every route `index.ts` — goes
 * through the tsx ESM loader, which picks the module format from the nearest
 * package.json exactly as Node does. Without the field the files compile as
 * CommonJS: `import()` then hands back `{ default: { __esModule, default } }`,
 * so a `export default agent(...)` route is not recognised and the config
 * object is the interop wrapper rather than the author's export. Before this
 * check that surfaced as a clean `0 routes discovered` (#685).
 */
async function assertB4AppIsEsModule(appRoot: string): Promise<void> {
  const packageJsonPath = join(appRoot, PACKAGE_JSON_FILE)
  let manifest: unknown

  try {
    // Strip a leading BOM: Node's own package.json reader tolerates one, so a
    // manifest it loads happily must not fail here. `JSON.parse` does not.
    manifest = JSON.parse((await readFile(packageJsonPath, "utf8")).replace(/^\uFEFF/, ""))
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause)
    throw new Error(
      `Invalid B4.run app at ${appRoot}: ${packageJsonPath} is not valid JSON: ${reason}`,
      { cause },
    )
  }

  const type =
    typeof manifest === "object" && manifest !== null && "type" in manifest
      ? (manifest as { readonly type?: unknown }).type
      : undefined

  if (type === "module") {
    return
  }

  const found = type === undefined ? 'no "type" field' : `"type": ${JSON.stringify(type)}`
  throw new B4AppError(
    `Invalid B4.run app at ${appRoot}: ${packageJsonPath} must set "type": "module" (found ${found}).\n` +
      'B4.run loads b4.config.ts and every route index.ts as ES modules. Without "type": "module" ' +
      "Node compiles them as CommonJS, and routes exported with `export default agent(...)` are not " +
      "recognised.\n" +
      `Add "type": "module" to ${packageJsonPath}.`,
    "B4_E1006",
  )
}

export async function assertB4RoutesDir(
  appRoot: string,
  routesDir = join(appRoot, DEFAULT_APP_DIR),
): Promise<void> {
  const missingPaths = await Promise.all(
    [routesDir].map(async (filePath) => ((await fileExists(filePath)) ? null : filePath)),
  )

  throwIfMissing(appRoot, missingPaths)
}

function throwIfMissing(appRoot: string, missingPaths: ReadonlyArray<string | null>): void {
  const missing = missingPaths.filter((value): value is string => value !== null)

  if (missing.length > 0) {
    throw new Error(`Invalid B4.run app at ${appRoot}. Missing: ${missing.join(", ")}`)
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

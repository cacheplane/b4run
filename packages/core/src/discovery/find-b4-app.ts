import { constants } from "node:fs"
import { access } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { B4_CONFIG_FILE, loadB4Config } from "../config.js"
import type { DiscoveredB4App, FindB4AppOptions } from "../types.js"

const PACKAGE_JSON_FILE = "package.json"
const DEFAULT_APP_DIR = "src/app"
const B4_DIR = ".b4"

export async function findB4App(options: FindB4AppOptions = {}): Promise<DiscoveredB4App> {
  const appRoot = options.appRoot ? resolve(options.appRoot) : await findAppRootFromCwd(options.cwd)
  await assertB4AppFiles(appRoot)

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

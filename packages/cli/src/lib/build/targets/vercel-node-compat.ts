import { readFile, realpath } from "node:fs/promises"
import { isBuiltin } from "node:module"
import { dirname, join, relative } from "node:path"

import type { Plugin } from "esbuild"

const BUILTIN_NAMESPACE = "b4-vercel-literal-node-builtin"
const PG_NATIVE_NAMESPACE = "b4-vercel-optional-pg-native"
const PG_NATIVE_CLIENT_PATH = join("lib", "native", "client.js")
const LANGCHAIN_UNIVERSAL_PATH = join("dist", "chat_models", "universal.js")
/**
 * The one non-literal dynamic import in `langchain`: `initChatModel` loads a
 * provider package named by a model-id string. `createAgent` imports it for
 * string model ids, which B4.run never passes (agent routes hand it a model
 * instance), so the self-contained bundle replaces the import with a clear
 * failure instead of shipping an import the function directory cannot satisfy.
 */
const LANGCHAIN_PROVIDER_IMPORT = "import(config.package)"
const LANGCHAIN_PROVIDER_IMPORT_REPLACEMENT =
  'Promise.reject(new Error("B4.run\'s Vercel bundle cannot load a chat model from a model-id string; pass a model instance."))'

interface PackageManifest {
  readonly name?: unknown
  readonly peerDependencies?: unknown
  readonly peerDependenciesMeta?: unknown
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined
}

function literalBuiltinSpecifier(specifier: string): string | undefined {
  if (!isBuiltin(specifier)) return undefined
  const bareSpecifier = specifier.startsWith("node:") ? specifier.slice("node:".length) : specifier
  if (bareSpecifier === "module") return undefined
  return `node:${bareSpecifier}`
}

async function isOptionalPgNativeImporter(importer: string): Promise<boolean> {
  let realImporter: string
  try {
    realImporter = await realpath(importer)
  } catch {
    return false
  }

  const packageRoot = dirname(dirname(dirname(realImporter)))
  if (relative(packageRoot, realImporter) !== PG_NATIVE_CLIENT_PATH) return false

  let manifest: PackageManifest
  try {
    manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
  } catch {
    return false
  }

  const peers = record(manifest.peerDependencies)
  const peerMetadata = record(manifest.peerDependenciesMeta)
  const pgNativeMetadata = record(peerMetadata?.["pg-native"])
  return (
    manifest.name === "pg" &&
    typeof peers?.["pg-native"] === "string" &&
    pgNativeMetadata?.optional === true
  )
}

async function isLangchainUniversalModule(path: string): Promise<boolean> {
  const packageRoot = dirname(dirname(dirname(path)))
  if (relative(packageRoot, path) !== LANGCHAIN_UNIVERSAL_PATH) return false
  try {
    const manifest: PackageManifest = JSON.parse(
      await readFile(join(packageRoot, "package.json"), "utf8"),
    )
    return manifest.name === "langchain"
  } catch {
    return false
  }
}

/** @internal Build-only compatibility for self-contained Node Vercel bundles. */
export function createVercelNodeCompatibilityPlugin(): Plugin {
  return {
    name: "b4-vercel-node-compatibility",
    setup(build) {
      build.onResolve({ filter: /^pg-native$/ }, async (args) => {
        if (args.kind !== "require-call" || !(await isOptionalPgNativeImporter(args.importer))) {
          return undefined
        }
        return { namespace: PG_NATIVE_NAMESPACE, path: args.path }
      })

      build.onLoad({ filter: /.*/, namespace: PG_NATIVE_NAMESPACE }, () => ({
        contents: `const error = new Error("Cannot find module 'pg-native'")
error.code = "MODULE_NOT_FOUND"
throw error
`,
        loader: "js",
      }))

      build.onLoad({ filter: /[\\/]chat_models[\\/]universal\.js$/ }, async (args) => {
        if (!(await isLangchainUniversalModule(args.path))) return undefined
        const source = await readFile(args.path, "utf8")
        const occurrences = source.split(LANGCHAIN_PROVIDER_IMPORT).length - 1
        if (occurrences !== 1) {
          throw new Error(
            `Expected exactly one ${LANGCHAIN_PROVIDER_IMPORT} in ${args.path}, found ${occurrences}; this langchain version needs a new Vercel bundle rewrite.`,
          )
        }
        return {
          contents: source.replace(
            LANGCHAIN_PROVIDER_IMPORT,
            LANGCHAIN_PROVIDER_IMPORT_REPLACEMENT,
          ),
          loader: "js",
        }
      })

      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind !== "require-call") return undefined
        const specifier = literalBuiltinSpecifier(args.path)
        if (!specifier) return undefined
        return { namespace: BUILTIN_NAMESPACE, path: specifier }
      })

      build.onLoad({ filter: /.*/, namespace: BUILTIN_NAMESPACE }, (args) => ({
        contents: `import builtin from ${JSON.stringify(args.path)}
module.exports = builtin
`,
        loader: "js",
      }))
    },
  }
}

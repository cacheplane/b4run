// Regenerates the data behind the homepage demos from the real framework.
//
//   pnpm build   # @b4run/core resolves to its built dist/
//   node apps/web/scripts/export-homepage-demos.mjs
//
// Schema variants: runs @b4run/core's tool-schema extractor, the one `b4
// typegen` uses, on each playground variant of the scaffold's greet tool, and
// writes app/components/homepage/playground/schema-variants.json. The
// playground test runs the same extraction and expects this file exactly.
import { execFileSync } from "node:child_process"
import { readFileSync, realpathSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { extractToolSchemasForRoute } from "@b4run/core/node"

const scriptFile = realpathSync(fileURLToPath(import.meta.url))
const webRoot = resolve(dirname(scriptFile), "..")
const repoRoot = resolve(webRoot, "..", "..")
export const playgroundRoot = join(webRoot, "app", "components", "homepage", "playground")
export const schemaVariantsFile = join(playgroundRoot, "schema-variants.json")
// The compiler options a scaffolded app extends (@b4run/config-typescript/node).
const toolTsconfig = join(repoRoot, "packages", "config-typescript", "node.json")

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

function isDirectExecution(invokedPath, modulePath) {
  return (
    invokedPath !== undefined && realpathSync(resolve(invokedPath)) === realpathSync(modulePath)
  )
}

if (isDirectExecution(process.argv[1], scriptFile)) {
  const data = await extractSchemaVariants()
  writeFileSync(schemaVariantsFile, `${JSON.stringify(data, null, 2)}\n`)
  // Write it in the repository's JSON style, so lint passes on the committed file.
  execFileSync(
    "pnpm",
    [
      "exec",
      "biome",
      "format",
      "--write",
      "--config-path",
      join(repoRoot, "packages", "config-biome", "biome.json"),
      schemaVariantsFile,
    ],
    { cwd: repoRoot, stdio: "inherit" },
  )
  console.log(`Wrote ${data.variants.length} schema variants to ${schemaVariantsFile}`)
}

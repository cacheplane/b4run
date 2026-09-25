import { join } from "node:path"
import { environmentIdentity, loadTargetRecipe } from "../src/lib/targets/catalog.js"
import { dockerImageBuilder } from "../src/lib/targets/image-builder.js"
import { ImagePrepareError, openImageRegistry } from "../src/lib/targets/images.js"
import { parsePrepareArgs } from "../src/lib/targets/prepare.js"

/**
 * Warm this host's image registry: build (or re-verify) a target's image at a pin, exactly as
 * the controller does the first time a work order needs it, into
 * `<FACTORY_STATE_DIR>/images.sqlite`. Optional: nothing requires it. Writes nothing under the
 * target; the image is recorded in the registry the controller reads, never in `target.json`.
 *
 * `prepare-target.ts <id> [--pin <sha>]`: the target's default pin unless `--pin` names another.
 * Prints the recorded image as JSON on stdout; the build's output goes to stderr.
 */
const RETIRED: Readonly<Record<string, string>> = {
  FACTORY_TARGETS_DIR: "the script writes no target file, so there is no copy to point it at",
}
for (const [name, why] of Object.entries(RETIRED))
  if (process.env[name] !== undefined) throw new Error(`${name} is retired: ${why}. Unset it`)
const stateDir = process.env.FACTORY_STATE_DIR
if (!stateDir)
  throw new Error(
    "FACTORY_STATE_DIR is required: the image is recorded in <FACTORY_STATE_DIR>/images.sqlite, the registry the controller with that state directory reads",
  )
const args = parsePrepareArgs(process.argv.slice(2))
const recipe = loadTargetRecipe(args.id, args.pin !== undefined ? { pin: args.pin } : {})
const registry = openImageRegistry({
  path: join(stateDir, "images.sqlite"),
  builder: dockerImageBuilder(),
})
const interrupted = new AbortController()
process.once("SIGINT", () => interrupted.abort(new Error("interrupted")))
try {
  const ensured = await registry.ensure(recipe, {
    signal: interrupted.signal,
    onMissing: ({ localId }) =>
      process.stderr.write(`recorded image ${localId} is gone from the daemon; rebuilding\n`),
    onBuild: () => process.stderr.write(`building ${recipe.id} at ${recipe.pin}\n`),
  })
  if (ensured.build) process.stderr.write(ensured.build.log)
  console.log(
    JSON.stringify(
      {
        key: ensured.key,
        tag: ensured.tag,
        pin: recipe.pin,
        built: ensured.build !== undefined,
        identity: environmentIdentity({ image: ensured.image, pin: recipe.pin }),
        ...ensured.image,
      },
      null,
      2,
    ),
  )
} catch (error) {
  if (error instanceof ImagePrepareError) process.stderr.write(error.log)
  throw error
} finally {
  registry.close()
}

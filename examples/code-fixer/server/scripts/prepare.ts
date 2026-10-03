import { type ExecFileSyncOptions, execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { baseImage, preparedImageTag } from "../src/project/image.js"

// The app directory defaults to this script's app; the repository suite passes others.
const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../", import.meta.url)))
const tag = preparedImageTag(root)
const inherit: ExecFileSyncOptions = { stdio: ["ignore", "inherit", "inherit"] }

function imageId(reference: string): string | undefined {
  try {
    return execFileSync("docker", ["image", "inspect", reference, "--format", "{{.Id}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

// The tag is derived from every build input, so an existing tag already holds this
// content. B4_CODE_FIXER_REBUILD=1 rebuilds it anyway, for example to refresh `git`.
let id = process.env.B4_CODE_FIXER_REBUILD === "1" ? undefined : imageId(tag)
if (id) {
  console.error(`Reusing prepared image ${tag}`)
} else {
  const base = baseImage(readFileSync(join(root, "Dockerfile"), "utf8"))
  // Pull only a missing base: the digest pin makes a held base exactly the pinned content.
  if (!imageId(base)) execFileSync("docker", ["pull", base], inherit)
  const project = JSON.parse(readFileSync(join(root, "sample/manifest.json"), "utf8")).id
  execFileSync(
    "docker",
    [
      "build",
      "--pull=false",
      "--label",
      `org.b4run.code-fixer.project=${project}`,
      "-t",
      tag,
      root,
    ],
    inherit,
  )
  id = imageId(tag)
  if (!id) throw new Error(`Prepared image ${tag} is missing after the build`)
}
console.log(`${tag} ${id}`)

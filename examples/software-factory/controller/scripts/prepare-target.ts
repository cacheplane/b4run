import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  appRoot,
  covers,
  ensurePin,
  imageTag,
  repositoryRoot,
  TargetSchema,
  targetsDir,
} from "../src/lib/targets/catalog.js"
import {
  firstMissingPath,
  parsePrepareArgs,
  pathExistsAtPin,
  pathsRequiredAtPin,
  withImageAt,
} from "../src/lib/targets/prepare.js"

/**
 * Build a target's image at a pin and record the inputs that produced it under that pin.
 *
 * `prepare-target.ts <id> [--pin <sha>]`: the pin is the manifest's default unless `--pin`
 * names another; the image is recorded as `images[<pin>]`, every other pin's entry kept.
 * The build context is a git archive of the target's `imageContext` at the pin plus the
 * Dockerfile, never the working tree. The recorded image object (with the pin) is what
 * `environmentIdentity` digests: a local image id is host-specific, so the inputs travel
 * with it.
 */
const args = parsePrepareArgs(process.argv.slice(2))
const { id } = args
const directory = join(targetsDir, id)
const manifestPath = join(directory, "target.json")
const manifest = TargetSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")))
const pin = args.pin ?? manifest.pin
const repo = repositoryRoot()
// This script parses the manifest itself (the pin may have no image yet, which `loadTarget`
// refuses), so it must make the pin present the same way `loadTarget` does: a shallow
// checkout has everything but the commit the archive below is taken from.
ensurePin(repo, id, pin)
// Every path the image is built from must exist at the pin: `git archive` of a missing path
// fails with a message naming nothing useful, and a target whose files moved since (the
// `cli-flags` fixture's historical paths) is refused here, by name, before any build.
const missing = firstMissingPath(pathsRequiredAtPin(manifest), (path) =>
  pathExistsAtPin(repo, pin, path),
)
if (missing !== undefined)
  throw new Error(
    `Target "${id}" names ${missing}, which does not exist at ${pin}: it cannot be prepared at that pin`,
  )
// The lockfile hash only means something if the lockfile was in the build context: a hash
// over a file the build never saw records an input that did not produce the image.
if (!covers(manifest.imageContext, manifest.lockfile))
  throw new Error(
    `Target "${id}" records lockfile "${manifest.lockfile}", which its imageContext does not cover`,
  )
/** Captured stdout, trimmed: for values a trailing newline would corrupt, use `bytes`. */
const sh = (cmd: string, args: string[], opts: { cwd?: string } = {}) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  }).trim()
/** Captured stdout, exact: a file's sha256 must be over the bytes, not a trimmed copy. */
const bytes = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 })
const sha = (content: Buffer) => createHash("sha256").update(content).digest("hex")

const platform =
  process.arch === "arm64"
    ? "linux/arm64"
    : process.arch === "x64"
      ? "linux/amd64"
      : (() => {
          throw new Error(`Unsupported host architecture ${process.arch}`)
        })()
// The pull refreshes the base tag before its digest is read. `FACTORY_SKIP_BASE_PULL=1` is for
// a host whose registry path is unreachable; the recorded digest is then whatever
// `node:24-slim` that host already holds, so it is an explicit opt-in and never a fallback.
if (process.env.FACTORY_SKIP_BASE_PULL !== "1")
  execFileSync("docker", ["pull", "--platform", platform, "node:24-slim"], { stdio: "inherit" })
const baseRef = JSON.parse(sh("docker", ["image", "inspect", "node:24-slim"]))[0].RepoDigests[0]
if (typeof baseRef !== "string" || !/^node@sha256:[a-f0-9]{64}$/.test(baseRef))
  throw new Error("Missing base image digest")
const baseManifestDigest = baseRef.slice("node@".length)

const context = mkdtempSync(join(tmpdir(), `factory-prepare-${id}-`))
try {
  const tar = join(context, "context.tar")
  execFileSync("git", [
    "-C",
    repo,
    "archive",
    "--format=tar",
    "-o",
    tar,
    pin,
    "--",
    ...manifest.imageContext,
  ])
  execFileSync("tar", ["-xf", tar, "-C", context])
  rmSync(tar)
  cpSync(join(directory, "Dockerfile"), join(context, "Dockerfile"))

  const rootPackage = JSON.parse(sh("git", ["-C", repo, "show", `${pin}:package.json`]))
  const pnpmVersion = String(rootPackage.packageManager ?? "").replace(/^pnpm@/, "")
  if (!/^\d+\.\d+\.\d+$/.test(pnpmVersion)) throw new Error(`No pnpm version at ${pin}`)

  const dockerfileSha256 = sha(readFileSync(join(directory, "Dockerfile")))
  const lockfileSha256 = sha(bytes("git", ["-C", repo, "show", `${pin}:${manifest.lockfile}`]))
  // The tag binds the pin and the Dockerfile (see `imageTag`), so it is computable before the
  // build from a provisional image object; `localId` is the only field the build supplies.
  const provisional = {
    localId: `sha256:${"0".repeat(64)}`,
    platform,
    baseManifestDigest,
    dockerfileSha256,
    lockfileSha256,
    pnpmVersion,
  }
  const tag = imageTag({ id: manifest.id, pin, image: provisional })
  execFileSync(
    "docker",
    [
      "build",
      "--platform",
      platform,
      "--build-arg",
      `BASE_IMAGE=${baseRef}`,
      "--build-arg",
      `PLATFORM=${platform}`,
      "--build-arg",
      `PNPM_VERSION=${pnpmVersion}`,
      "-t",
      tag,
      context,
    ],
    { stdio: "inherit" },
  )
  const localId = sh("docker", ["image", "inspect", tag, "--format", "{{.Id}}"])

  // The install must have produced what the commands need: a frozen install can silently
  // skip a platform-matched optional dependency, and the verifier would blame the builder.
  const cwd =
    manifest.commands.cwd === "."
      ? `/opt/targets/${id}`
      : `/opt/targets/${id}/${manifest.commands.cwd}`
  for (const specifier of manifest.imageAssertResolves)
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "-w",
        cwd,
        tag,
        "node",
        "-e",
        `require.resolve(${JSON.stringify(specifier)})`,
      ],
      { stdio: "inherit" },
    )

  const image = { ...provisional, localId }
  writeFileSync(manifestPath, `${JSON.stringify(withImageAt(manifest, pin, image), null, 2)}\n`)
  // The manifest is a checked-in source file, so the script leaves the tree lint-clean.
  execFileSync("npx", ["biome", "format", "--write", manifestPath], {
    stdio: "inherit",
    cwd: appRoot,
  })
  console.log(JSON.stringify({ tag, pin, ...image }, null, 2))
} finally {
  rmSync(context, { recursive: true, force: true })
}

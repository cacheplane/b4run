import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ImageSchema, idTagFor } from "./catalog.js"
import { baseDigestOf, type ImageBuilder } from "./images.js"
import { recipeProblem } from "./prepare.js"

/** Run a command to completion: its stdout, or an Error naming the exit and stderr's tail. */
export type Run = (
  command: string,
  args: readonly string[],
  options: { readonly signal: AbortSignal; readonly onOutput?: (chunk: string) => void },
) => Promise<string>

/** `Run` over `spawn`: output streamed to `onOutput` as it arrives, killed when `signal` aborts. */
export const spawnRun: Run = (command, args, { signal, onOutput }) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...args], { signal, stdio: ["ignore", "pipe", "pipe"] })
    const stdout: Buffer[] = []
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk)
      onOutput?.(chunk.toString("utf8"))
    })
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8")
      stderr = (stderr + text).slice(-8_192)
      onOutput?.(text)
    })
    child.on("error", reject)
    child.on("close", (code, killedBy) => {
      if (code === 0) return resolve(Buffer.concat(stdout).toString("utf8"))
      const tail = stderr.trim().split("\n").slice(-5).join("\n")
      reject(
        new Error(
          `${command} ${args[0] ?? ""} failed (${killedBy ?? `exit ${code}`})${tail ? `: ${tail}` : ""}`,
        ),
      )
    })
  })

export interface DockerImageBuilderOptions {
  /** Test seam: the process runner. `spawnRun` otherwise. */
  readonly run?: Run
  /** Where build contexts are staged. The OS temporary directory otherwise. */
  readonly tmp?: string
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const NO_SUCH_IMAGE = /No such image/i

/**
 * The real `ImageBuilder`: what `scripts/prepare-target.ts` did, as a function of a recipe. The
 * context is a git archive of the recipe's `imageContext` at its pin plus the committed
 * Dockerfile, never the working tree; the base is the recipe's, by digest; the modules the
 * commands need are asserted to resolve inside the built image, by its id.
 */
export function dockerImageBuilder(options: DockerImageBuilderOptions = {}): ImageBuilder {
  const run = options.run ?? spawnRun
  const present = async (reference: string, signal: AbortSignal): Promise<boolean> => {
    try {
      await run("docker", ["image", "inspect", "--format", "{{.Id}}", reference], { signal })
      return true
    } catch (error) {
      if (!signal.aborted && error instanceof Error && NO_SUCH_IMAGE.test(error.message))
        return false
      throw error
    }
  }
  return {
    async build({ recipe, platform, key, tag, repositoryRoot: repo }, log, signal) {
      const problem = recipeProblem(recipe, repo)
      if (problem !== undefined) throw new Error(problem)
      const base = recipe.baseImage
      // Pulled only when absent: pinned by digest, a present copy is the one the recipe names.
      // FACTORY_SKIP_BASE_PULL=1 never pulls (a host whose registry path wedges: Docker Desktop,
      // twice in the live run); an absent base then fails the build, naming the variable.
      if (!(await present(base, signal))) {
        if (process.env.FACTORY_SKIP_BASE_PULL === "1")
          throw new Error(
            `base image ${base} is not on the daemon and FACTORY_SKIP_BASE_PULL=1 forbids pulling it: pull it by hand (docker pull --platform ${platform} ${base}) or unset the variable`,
          )
        log(`pulling ${base} for ${platform}\n`)
        await run("docker", ["pull", "--platform", platform, base], { signal, onOutput: log })
      }
      // One directory per build: the context, and beside it (never inside it) the id file.
      const work = mkdtempSync(join(options.tmp ?? tmpdir(), `factory-image-${recipe.id}-`))
      try {
        const context = join(work, "context")
        const iidFile = join(work, "image.iid")
        mkdirSync(context)
        const tar = join(work, "context.tar")
        await run(
          "git",
          [
            "-C",
            repo,
            "archive",
            "--format=tar",
            "-o",
            tar,
            recipe.pin,
            "--",
            ...recipe.imageContext,
          ],
          { signal },
        )
        await run("tar", ["-xf", tar, "-C", context], { signal })
        rmSync(tar, { force: true })
        cpSync(join(recipe.directory, "Dockerfile"), join(context, "Dockerfile"))
        const rootPackage = JSON.parse(
          await run("git", ["-C", repo, "show", `${recipe.pin}:package.json`], { signal }),
        ) as { packageManager?: unknown }
        const pnpmVersion = String(rootPackage.packageManager ?? "").replace(/^pnpm@/, "")
        if (!/^\d+\.\d+\.\d+$/.test(pnpmVersion))
          throw new Error(`No pnpm version in package.json at ${recipe.pin}`)
        // Over the bytes the build saw: the Dockerfile copy in the context (the registry refuses
        // the image if it differs from the one the key was computed from), and the lockfile
        // `recipeProblem` proved is inside the context.
        const dockerfileSha256 = sha256(readFileSync(join(context, "Dockerfile")))
        const lockfileSha256 = sha256(readFileSync(join(context, recipe.lockfile)))
        await run(
          "docker",
          [
            "build",
            "--platform",
            platform,
            "--build-arg",
            `BASE_IMAGE=${base}`,
            "--build-arg",
            `PLATFORM=${platform}`,
            "--build-arg",
            `PNPM_VERSION=${pnpmVersion}`,
            // Part of the image config the id content-addresses: PR 2's builder checks them.
            "--label",
            `b4.factory.target=${recipe.id}`,
            "--label",
            `b4.factory.pin=${recipe.pin}`,
            "--label",
            `b4.factory.key=${key}`,
            // This build's own id, whatever any tag names by the time it is read (D10).
            "--iidfile",
            iidFile,
            "-t",
            tag,
            context,
          ],
          { signal, onOutput: log },
        )
        const localId = readFileSync(iidFile, "utf8").trim()
        if (!/^sha256:[0-9a-f]{64}$/.test(localId))
          throw new Error(`docker build wrote no image id to ${iidFile}`)
        // The tag that never moves: a bound image a later build of its key supersedes keeps it.
        await run("docker", ["tag", localId, idTagFor(recipe.id, recipe.pin, key, localId)], {
          signal,
        })
        // A frozen install can silently skip a platform-matched optional dependency, and the
        // verifier would blame the builder: the modules the commands need must resolve.
        const cwd =
          recipe.commands.cwd === "."
            ? `/opt/targets/${recipe.id}`
            : `/opt/targets/${recipe.id}/${recipe.commands.cwd}`
        for (const specifier of recipe.imageAssertResolves)
          await run(
            "docker",
            [
              "run",
              "--rm",
              "--network",
              "none",
              "-w",
              cwd,
              localId,
              "node",
              "-e",
              `require.resolve(${JSON.stringify(specifier)})`,
            ],
            { signal, onOutput: log },
          )
        return ImageSchema.parse({
          localId,
          platform,
          baseManifestDigest: baseDigestOf(base),
          dockerfileSha256,
          lockfileSha256,
          pnpmVersion,
        })
      } finally {
        rmSync(work, { recursive: true, force: true })
      }
    },
    async inspect(localId, signal) {
      try {
        const tags = JSON.parse(
          await run("docker", ["image", "inspect", "--format", "{{json .RepoTags}}", localId], {
            signal,
          }),
        ) as unknown
        return {
          tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
        }
      } catch (error) {
        if (!signal.aborted && error instanceof Error && NO_SUCH_IMAGE.test(error.message))
          return null
        throw error
      }
    },
    async tag(localId, tag, signal) {
      await run("docker", ["tag", localId, tag], { signal })
    },
  }
}

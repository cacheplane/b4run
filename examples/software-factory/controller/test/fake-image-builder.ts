import { createHash } from "node:crypto"
import type { Image } from "../src/lib/targets/catalog.ts"
import {
  type BuildRequest,
  baseDigestOf,
  dockerfileSha256Of,
  type ImageBuilder,
} from "../src/lib/targets/images.ts"

/**
 * The registry's Docker side, scripted: a daemon that is a Map, builds that can be held open
 * (to line concurrent callers up behind them), failed, and counted.
 */
export interface FakeImageBuilder extends ImageBuilder {
  /** Every build asked for, in order. */
  readonly requests: BuildRequest[]
  /** The fake daemon: image id to its tags. */
  readonly daemon: Map<string, string[]>
  /** Builds running now, and the most that ever ran at once. */
  readonly running: number
  readonly maxRunning: number
  /** Builds that ended because their signal aborted. */
  readonly aborted: number
  /** Hold every build that starts from now on until `release()`. */
  hold(): void
  release(): void
  /** The next build writes `log` and then fails with `message`. */
  failNext(message: string, log?: string): void
}

export function fakeImageBuilder(): FakeImageBuilder {
  let gate: Promise<void> | undefined
  let open: (() => void) | undefined
  const failures: { message: string; log: string }[] = []
  const requests: BuildRequest[] = []
  const daemon = new Map<string, string[]>()
  let serial = 0
  let running = 0
  let maxRunning = 0
  let aborted = 0
  const untag = (tag: string) => {
    for (const [id, tags] of daemon)
      daemon.set(
        id,
        tags.filter((t) => t !== tag),
      )
  }
  const waitGate = (held: Promise<void> | undefined, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (held === undefined) return resolve()
      signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      held.then(resolve)
    })
  return {
    requests,
    daemon,
    get running() {
      return running
    },
    get maxRunning() {
      return maxRunning
    },
    get aborted() {
      return aborted
    },
    hold() {
      gate = new Promise((resolve) => {
        open = resolve
      })
    },
    release() {
      open?.()
      gate = undefined
      open = undefined
    },
    failNext(message, log = "") {
      failures.push({ message, log })
    },
    async build(request, log, signal) {
      requests.push(request)
      running += 1
      maxRunning = Math.max(maxRunning, running)
      try {
        log(`building ${request.tag}\n`)
        await waitGate(gate, signal)
        signal.throwIfAborted()
        const failure = failures.shift()
        if (failure) {
          log(failure.log)
          throw new Error(failure.message)
        }
        serial += 1
        const localId = `sha256:${createHash("sha256").update(`${request.tag}#${serial}`).digest("hex")}`
        untag(request.tag)
        daemon.set(localId, [request.tag])
        const image: Image = {
          localId,
          platform: request.platform,
          baseManifestDigest: baseDigestOf(request.recipe.baseImage),
          dockerfileSha256: dockerfileSha256Of(request.recipe),
          lockfileSha256: "d".repeat(64),
          pnpmVersion: "10.33.0",
        }
        return image
      } catch (error) {
        if (signal.aborted) aborted += 1
        throw error
      } finally {
        running -= 1
      }
    },
    async inspect(localId) {
      const tags = daemon.get(localId)
      return tags === undefined ? null : { tags: [...tags] }
    },
    async tag(localId, tag) {
      untag(tag)
      daemon.get(localId)?.push(tag)
    },
  }
}

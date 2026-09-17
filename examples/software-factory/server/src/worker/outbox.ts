import { access } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

/**
 * code-fixer writes `<receiptDigest>.json` into its review outbox; that filename is the binding.
 *
 * `digest` is interpolated directly into a filesystem path: callers must pass an already-validated
 * sha256 hex digest. The factory validates with `DIGEST_PATTERN` from `src/domain/work-order.ts`
 * before calling this function.
 */
export function receiptPath(outboxDir: string, digest: string): string {
  return join(outboxDir, `${digest}.json`)
}

export async function receiptExists(outboxDir: string, digest: string): Promise<boolean> {
  try {
    await access(receiptPath(outboxDir, digest))
    return true
  } catch {
    return false
  }
}

export async function waitForReceipt(
  outboxDir: string,
  digest: string,
  options: {
    readonly timeoutMs: number
    readonly intervalMs?: number
    readonly signal?: AbortSignal
  },
): Promise<string | null> {
  const deadline = Date.now() + options.timeoutMs
  const interval = options.intervalMs ?? 250
  while (true) {
    if (await receiptExists(outboxDir, digest)) return receiptPath(outboxDir, digest)
    if (Date.now() >= deadline || options.signal?.aborted) return null
    try {
      await sleep(Math.min(interval, Math.max(1, deadline - Date.now())), undefined, {
        signal: options.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return null
      throw err
    }
  }
}

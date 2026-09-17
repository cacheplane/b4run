import { access } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

/** code-fixer writes `<receiptDigest>.json` into its review outbox; that filename is the binding. */
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
    await sleep(Math.min(interval, Math.max(1, deadline - Date.now())))
  }
}

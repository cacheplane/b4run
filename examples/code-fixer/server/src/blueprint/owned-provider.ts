import { appendFile } from "node:fs/promises"
import { join } from "node:path"
import type { SandboxProvider } from "@b4run/workspace"

/** Register before acquisition so the parent can clean up even a killed child. */
export function ownedProvider(base: SandboxProvider): SandboxProvider {
  return {
    ...base,
    async acquire(input) {
      const output = process.env.B4_CODE_FIXER_ATTEMPT_DIR
      if (output)
        await appendFile(join(output, "owned-threads.jsonl"), `${JSON.stringify(input.threadId)}\n`)
      return base.acquire(input)
    },
  }
}

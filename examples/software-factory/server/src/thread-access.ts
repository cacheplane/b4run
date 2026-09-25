import { createHash, timingSafeEqual } from "node:crypto"
import { defineThreadAccess, deny, permit, type ThreadAccessRequest } from "@b4run/sdk"

/**
 * This worker answers the factory's controller and nobody else. Every thread endpoint (create,
 * read, state, run, resume, cancel, delete, and later the workspace read and the source upload)
 * requires `authorization: Bearer <FACTORY_WORKER_TOKEN>`, the secret the operator gives the
 * controller and each worker; anything else is 403. `/healthz`, `/readyz` and the memory
 * endpoints are not thread endpoints and stay open: this app keeps no memory.
 *
 * The token is read when B4.run loads this module at boot, so a worker started without one
 * refuses to start (B4_E3003) instead of serving open endpoints. No message here ever contains
 * the token. Deliberately a copy in each worker app, pinned equal by
 * `controller/test/worker-token.test.ts`: the workers share no source with each other or with
 * the controller.
 */
const MIN_LENGTH = 32

export function workerToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = env.FACTORY_WORKER_TOKEN
  if (token === undefined || token === "")
    throw new Error(
      "FACTORY_WORKER_TOKEN is required: the secret the controller sends as `authorization: Bearer <token>` (generate one with `openssl rand -hex 32`)",
    )
  if (token.length < MIN_LENGTH)
    throw new Error(`FACTORY_WORKER_TOKEN must be at least ${MIN_LENGTH} characters`)
  if (/\s/.test(token)) throw new Error("FACTORY_WORKER_TOKEN must contain no whitespace")
  return token
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest()

/**
 * Strict equality in constant time. Both sides are hashed to 32 bytes first, so the comparison
 * takes the same time whatever the presented value's length and never exits early on a length
 * mismatch. Headers arrive lowercase with repeats joined by ", ", so a second `authorization`
 * header makes the value different and never equal.
 */
export function isController(
  request: Pick<ThreadAccessRequest, "headers">,
  token: string,
): boolean {
  const presented = request.headers.authorization
  if (presented === undefined) return false
  return timingSafeEqual(digest(presented), digest(`Bearer ${token}`))
}

const token = workerToken()

export default defineThreadAccess({
  fallback: (request) => (isController(request, token) ? permit() : deny({ status: 403 })),
})

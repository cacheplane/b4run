import { stopContact } from "../contacts"
import type { SqlExecutor } from "../database"
import { type GrowthEnv, loadGrowthEnv } from "../env"
import { verifyActionToken } from "../tokens"
import {
  renderConfirmPage,
  renderDonePage,
  renderFailurePage,
  UNSUBSCRIBE_CONFIRM,
  UNSUBSCRIBE_DONE,
} from "../unsubscribe-page"
import {
  declaresOversizeBody,
  getSharedExecutor,
  privateHtml,
  queryToken,
  readPostedToken,
} from "./shared"

export interface UnsubscribeRouteDeps {
  loadEnv(): GrowthEnv
  createExecutor(url: string): SqlExecutor
  now(): Date
}

const failure = () => privateHtml(400, renderFailurePage())

export async function handleUnsubscribeGet(
  request: Request,
  deps: UnsubscribeRouteDeps,
): Promise<Response> {
  const token = queryToken(request)
  if (token === undefined) return failure()
  try {
    const verified = verifyActionToken({
      token,
      keyring: deps.loadEnv().tokenKeyring,
      purpose: "unsubscribe",
      now: deps.now(),
    })
    if (!verified.ok) return failure()
    return privateHtml(200, renderConfirmPage({ token, ...UNSUBSCRIBE_CONFIRM }))
  } catch {
    return failure()
  }
}

export async function handleUnsubscribePost(
  request: Request,
  deps: UnsubscribeRouteDeps,
): Promise<Response> {
  if (declaresOversizeBody(request)) return failure()

  try {
    const token = await readPostedToken(request)
    if (token === undefined) return failure()

    const env = deps.loadEnv()
    const now = deps.now()
    const verified = verifyActionToken({
      token,
      keyring: env.tokenKeyring,
      purpose: "unsubscribe",
      now,
    })
    if (!verified.ok) return failure()
    await stopContact(deps.createExecutor(env.databaseUrl), {
      contactId: verified.contactId,
      reason: "unsubscribe",
      provenance: "unsubscribe_link",
      now,
    })
    // Already-stopped contacts get the same answer.
    return privateHtml(200, renderDonePage(UNSUBSCRIBE_DONE))
  } catch (error) {
    process.stderr.write(
      `unsubscribe failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
    )
    return privateHtml(503, renderFailurePage())
  }
}

export function defaultUnsubscribeDeps(): UnsubscribeRouteDeps {
  return {
    loadEnv: () => loadGrowthEnv(),
    createExecutor: getSharedExecutor,
    now: () => new Date(),
  }
}

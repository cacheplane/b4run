import { stopContact } from "../contacts"
import type { SqlExecutor } from "../database"
import { type GrowthEnv, loadGrowthEnv } from "../env"
import { errorLogCode } from "../errors"
import { verifyActionToken } from "../tokens"
import {
  FOUNDER_STOP_CONFIRM,
  FOUNDER_STOP_DONE,
  renderConfirmPage,
  renderDonePage,
  renderFailurePage,
} from "../unsubscribe-page"
import {
  declaresOversizeBody,
  getSharedExecutor,
  privateHtml,
  queryToken,
  readPostedToken,
} from "./shared"

export interface FounderStopRouteDeps {
  loadEnv(): GrowthEnv
  createExecutor(url: string): SqlExecutor
  now(): Date
}

const failure = () => privateHtml(400, renderFailurePage())

export async function handleFounderStopGet(
  request: Request,
  deps: FounderStopRouteDeps,
): Promise<Response> {
  const token = queryToken(request)
  if (token === undefined) return failure()
  try {
    const verified = verifyActionToken({
      token,
      keyring: deps.loadEnv().tokenKeyring,
      purpose: "founder_stop",
      now: deps.now(),
    })
    if (!verified.ok) return failure()
    return privateHtml(200, renderConfirmPage({ token, ...FOUNDER_STOP_CONFIRM }))
  } catch {
    return failure()
  }
}

export async function handleFounderStopPost(
  request: Request,
  deps: FounderStopRouteDeps,
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
      purpose: "founder_stop",
      now,
    })
    if (!verified.ok) return failure()
    await stopContact(deps.createExecutor(env.databaseUrl), {
      contactId: verified.contactId,
      reason: "reply_received",
      provenance: "founder_stop_link",
      now,
    })
    // Already-stopped contacts get the same answer.
    return privateHtml(200, renderDonePage(FOUNDER_STOP_DONE))
  } catch (error) {
    process.stderr.write(`founder stop failed: ${errorLogCode(error)}\n`)
    return privateHtml(503, renderFailurePage())
  }
}

export function defaultFounderStopDeps(): FounderStopRouteDeps {
  return {
    loadEnv: () => loadGrowthEnv(),
    createExecutor: getSharedExecutor,
    now: () => new Date(),
  }
}

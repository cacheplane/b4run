/**
 * The Workbench page seam: one fail-closed browser session, shared by every
 * journey that drives the scaffolded web client.
 *
 * `withWorkbenchPage` owns everything around a journey's own steps — the
 * Chromium launch, the abort wiring, console and page-error collection with
 * the hydrate-probe allowlist, the collected-errors backstop, the failure
 * screenshot, and the cleanup — so the journeys cannot drift apart on any of
 * it. `chromium` is injected, so this file's unit test never launches a
 * browser.
 *
 * Nothing here knows what a journey asserts; that belongs to the caller
 * (`workbench-browser.ts` and the suggestion journeys).
 */
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import type { Browser, BrowserContext, Page } from "@playwright/test"

export interface WorkbenchPageDeps {
  readonly chromium: { launch(options: { headless: true }): Promise<Browser> }
}

export interface WorkbenchPageOptions {
  /**
   * Written only when the body fails, next to the harness transcripts.
   *
   * A function is resolved at screenshot time, not when the page is opened, so
   * one options object can drive several journeys that each want their own
   * file name.
   */
  readonly screenshotPath: string | (() => string)
  /**
   * The harness lifecycle signal. Aborting closes the browser and rejects the
   * body, so a hung page cannot outlive the test's own deadline.
   */
  readonly signal?: AbortSignal
}

export const JOURNEY_ABORTED_MESSAGE = "Workbench browser gate aborted by the harness deadline"

export const COLLECTED_ERRORS_BACKSTOP_MESSAGE =
  "Workbench console errors collected during the browser session"

/**
 * Resolves a configured screenshot path, or `undefined` if a caller-supplied
 * resolver threw. Returning `undefined` rather than propagating is the point:
 * this runs inside the failure handler, where an escaping exception would
 * replace the real error — the Playwright timeout, its call log, the collected
 * console errors and the whole cause chain — with a bare `TypeError`.
 */
function resolveScreenshotPath(configured: string | (() => string)): string | undefined {
  if (typeof configured !== "function") return configured
  try {
    return configured()
  } catch {
    return undefined
  }
}

/**
 * The fail-closed scaffolding every Workbench browser journey shares: the
 * pre-launch abort check, the Chromium launch, the abort listener that closes
 * the browser, a fresh context/page with console and page-error collection,
 * the abort race around `body`, the collected-errors backstop, the failure
 * screenshot with the collected console errors appended, and the best-effort
 * cleanup.
 *
 * This is the SINGLE wrapping site for a journey's failure: it attaches the
 * console errors and the `cause`, and the activation test's `flattenCause`
 * prints every level of that chain. Do not wrap a `withWorkbenchPage` call
 * from outside — a journey that wants its own name on the failure applies
 * that prefix *inside* `body`, so CI shows the underlying Playwright error and
 * its call log once.
 *
 * `options.screenshotPath` is resolved at screenshot time (a function is
 * called then), so a caller driving several journeys through one options
 * object can vary the file name per journey.
 *
 * @param body Receives the page and the LIVE `errors` array — the collectors
 *   keep pushing into it while `body` runs, so read it late (at the point you
 *   want to decide) rather than snapshotting its contents or length early.
 */
export async function withWorkbenchPage<T>(
  options: WorkbenchPageOptions,
  deps: WorkbenchPageDeps,
  body: (page: Page, errors: readonly string[]) => Promise<T>,
): Promise<T> {
  const { signal } = options
  if (signal?.aborted === true) throw new Error(JOURNEY_ABORTED_MESSAGE)
  const browser = await deps.chromium.launch({ headless: true })
  let closeOnAbort: (() => void) | undefined
  let context: BrowserContext | undefined
  try {
    if (signal !== undefined) {
      // Closing the browser unblocks whatever Playwright call is in flight; the
      // race below is what turns that into the abort error.
      closeOnAbort = () => {
        void browser.close().catch(() => undefined)
      }
      signal.addEventListener("abort", closeOnAbort, { once: true })
    }
    context = await browser.newContext()
    const page = await context.newPage()
    const errors = collectPageErrors(page)
    try {
      const result = await raceAbort(signal, () => body(page, errors))
      // Backstop: a body that forgot to check still cannot pass with errors
      // collected. W7 checks first, so its own message is what it reports.
      if (errors.length > 0) throw new Error(COLLECTED_ERRORS_BACKSTOP_MESSAGE)
      return result
    } catch (error) {
      // Best effort: the rendered state is the one thing the transcript cannot
      // show, and its directory is a CI-uploaded path that may not exist yet.
      // The resolver is caller code, so a throw from it must not replace the
      // real failure — give up on the screenshot instead.
      const screenshotPath = resolveScreenshotPath(options.screenshotPath)
      if (screenshotPath !== undefined) {
        await mkdir(dirname(screenshotPath), { recursive: true }).catch(() => undefined)
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined)
      }
      if (errors.length > 0) {
        // The backstop IS the collected errors, so it takes them as its own
        // list rather than the "before the failure" heading, which would print
        // a second near-identical line (and a third through `flattenCause`).
        if (error instanceof Error && error.message === COLLECTED_ERRORS_BACKSTOP_MESSAGE) {
          throw new Error(`${COLLECTED_ERRORS_BACKSTOP_MESSAGE}:\n${errors.join("\n")}`)
        }
        const originalMessage = error instanceof Error ? error.message : String(error)
        throw new Error(
          `${originalMessage}\nWorkbench console errors before the failure:\n${errors.join("\n")}`,
          { cause: error },
        )
      }
      throw error
    }
  } finally {
    if (closeOnAbort !== undefined) signal?.removeEventListener("abort", closeOnAbort)
    await context?.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}

/**
 * Runs `work`, rejecting with {@link JOURNEY_ABORTED_MESSAGE} if `signal`
 * aborts first. The listener is always removed, and the rejection is always
 * observed, so an abort arriving after `work` settled is not an unhandled
 * rejection.
 */
async function raceAbort<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal === undefined) return work()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error(JOURNEY_ABORTED_MESSAGE))
    signal.addEventListener("abort", onAbort, { once: true })
  })
  aborted.catch(() => undefined)
  try {
    return await Promise.race([work(), aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort)
  }
}

/**
 * The Workbench hydrates a thread by probing its state and its pending
 * interrupts. On a brand-new thread the B4.run server answers both with 404 —
 * that is the designed "nothing recorded yet" answer, asserted directly over
 * HTTP by W2 of the activation harness — and the browser logs the failed fetch
 * as a console error. Tolerate exactly that: a 404 resource error on exactly
 * those two paths. A 500 on them, a 404 anywhere else, and every non-resource
 * console error still fail the gate.
 */
const HYDRATE_PROBE_404_PREFIX =
  "Failed to load resource: the server responded with a status of 404"
const HYDRATE_PROBE_PATHNAME = /^\/api\/b4\/threads\/[^/]+\/(state|pending_interrupts)$/

export function isExpectedHydrateProbeError(text: string, url: string): boolean {
  if (!text.startsWith(HYDRATE_PROBE_404_PREFIX)) return false
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return false
  }
  return HYDRATE_PROBE_PATHNAME.test(pathname)
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() !== "error") return
    const { url } = message.location()
    if (isExpectedHydrateProbeError(message.text(), url)) return
    errors.push(url === "" ? message.text() : `${message.text()} [${url}]`)
  })
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
  return errors
}

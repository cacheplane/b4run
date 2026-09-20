/**
 * The Workbench browser gate: drive the scaffolded web client in a real
 * browser, through the real CopilotKit runtime, to the real B4 server.
 *
 * This is the README recording's journey (docs/brand/demo/capture.mjs)
 * promoted to a CI assertion. The gate and the recording share the journey
 * functions; the Send click is the one step each inlines. `chromium` is
 * injected so this file has a unit test that never launches a browser.
 *
 * Fail closed: a missing browser, a missing persisted thread id, a console
 * error, or an uncaught page error each fail the journey. There is no skip.
 */
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import type { Browser, BrowserContext, Page } from "@playwright/test"

import {
  fillActiveWorkbenchComposer,
  openReadyWorkbench,
  restoreWorkbenchThread,
  waitForWorkbenchRunCompletion,
} from "../../docs/brand/demo/capture.mjs"

export interface WorkbenchBrowserJourney {
  readonly openReadyWorkbench: typeof openReadyWorkbench
  readonly fillActiveWorkbenchComposer: typeof fillActiveWorkbenchComposer
  readonly waitForWorkbenchRunCompletion: typeof waitForWorkbenchRunCompletion
  readonly restoreWorkbenchThread: typeof restoreWorkbenchThread
}

export interface WorkbenchBrowserDeps {
  readonly chromium: { launch(options: { headless: true }): Promise<Browser> }
  readonly journey?: WorkbenchBrowserJourney
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

export interface WorkbenchBrowserOptions extends WorkbenchPageOptions {
  /** The generated web client's base URL (the harness's `dev:web` session). */
  readonly webUrl: string
  /** The prompt to send; must match an aimock fixture's `userMessage`. */
  readonly prompt: string
  /** Tool names the fixture calls, in order — asserted as cards after reload. */
  readonly tools: readonly string[]
  /** The fixture's final reply — asserted on screen after reload. */
  readonly answer: string
}

const DEFAULT_JOURNEY: WorkbenchBrowserJourney = {
  openReadyWorkbench,
  fillActiveWorkbenchComposer,
  waitForWorkbenchRunCompletion,
  restoreWorkbenchThread,
}

/**
 * The key the Workbench persists its thread list under, and the title
 * truncation `touch()` applies before writing a title — see
 * packages/devkit/templates/app-research/web/app/lib/thread-source.ts
 * (STORAGE_KEY, MAX_TITLE_LENGTH ~ line 115). Nothing imports that file (it
 * ships inside the scaffolded app, not this repo's dependency graph), so keep
 * both constants and the normalisation rule in step with it by hand.
 */
const THREADS_STORAGE_KEY = "b4.workbench.threads"
const MAX_THREAD_TITLE_LENGTH = 80

export type PersistedThreadIdResult =
  | { readonly threadId: string }
  | { readonly threadId: undefined; readonly reason: string; readonly titles: readonly string[] }

/**
 * Pure classification of the Workbench's persisted thread list against the
 * expected (already-normalised) title. Kept separate from the `page.evaluate`
 * call so it has its own unit tests without a browser: `raw` is whatever
 * `localStorage.getItem(THREADS_STORAGE_KEY)` returned, read by a thin,
 * separately-tested inline callback (see `readPersistedThreadId`).
 */
export function findPersistedThreadId(
  raw: string | null,
  expectedTitle: string,
): PersistedThreadIdResult {
  if (raw === null) {
    return { threadId: undefined, reason: "storage key absent", titles: [] }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { threadId: undefined, reason: "storage value is not valid JSON", titles: [] }
  }
  if (!Array.isArray(parsed)) {
    return { threadId: undefined, reason: "storage value is not an array", titles: [] }
  }
  const titles: string[] = []
  let matched: Record<string, unknown> | undefined
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue
    const title = (entry as { title?: unknown }).title
    if (typeof title === "string") titles.push(title)
    // First match wins: thread-source.ts stores newest-first, so the first
    // entry with this title is the run we just made, not an older namesake.
    if (title === expectedTitle && matched === undefined) matched = entry as Record<string, unknown>
  }
  if (matched === undefined) {
    return {
      threadId: undefined,
      reason: `no thread found with that title; stored titles: ${JSON.stringify(titles)}`,
      titles,
    }
  }
  const id = matched.id
  if (typeof id !== "string") {
    return { threadId: undefined, reason: "entry has no string id", titles }
  }
  return { threadId: id }
}

export const JOURNEY_ABORTED_MESSAGE = "Workbench browser gate aborted by the harness deadline"

export const PROMPT_SHAPE_MESSAGE = `Workbench browser gate prompt must be trimmed and at most ${MAX_THREAD_TITLE_LENGTH} characters (the thread rail shows the truncated title)`

export const COLLECTED_ERRORS_BACKSTOP_MESSAGE =
  "Workbench console errors collected during the browser session"

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
  deps: Pick<WorkbenchBrowserDeps, "chromium">,
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
      const { screenshotPath: configured } = options
      const screenshotPath = typeof configured === "function" ? configured() : configured
      await mkdir(dirname(screenshotPath), { recursive: true }).catch(() => undefined)
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined)
      if (errors.length > 0) {
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

export async function runWorkbenchBrowserJourney(
  options: WorkbenchBrowserOptions,
  deps: WorkbenchBrowserDeps,
): Promise<{ readonly threadId: string }> {
  // `restoreWorkbenchThread` matches the prompt against BOTH the thread rail's
  // row (which shows the truncated, trimmed title) and the transcript's message
  // text (which shows the prompt verbatim). A prompt that does not survive
  // `touch()`'s normalisation unchanged can therefore never match both, so
  // reject it here rather than time out in the browser.
  if (options.prompt !== options.prompt.trim() || options.prompt.length > MAX_THREAD_TITLE_LENGTH) {
    throw new Error(PROMPT_SHAPE_MESSAGE)
  }
  const journey = deps.journey ?? DEFAULT_JOURNEY
  return withWorkbenchPage(options, deps, async (page, errors) => {
    await journey.openReadyWorkbench(page, options.webUrl)
    await journey.fillActiveWorkbenchComposer(page, options.prompt)
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await journey.waitForWorkbenchRunCompletion(page)

    const expectedTitle = options.prompt.slice(0, MAX_THREAD_TITLE_LENGTH)
    const raw = await readPersistedThreadsRaw(page)
    const found = findPersistedThreadId(raw, expectedTitle)
    if (found.threadId === undefined) {
      throw new Error(
        `Workbench did not persist the active thread id for "${expectedTitle}"; ${found.reason}`,
      )
    }
    const threadId = found.threadId
    await journey.restoreWorkbenchThread(page, {
      workbenchUrl: options.webUrl,
      threadId,
      prompt: options.prompt,
      tools: options.tools,
      answer: options.answer,
    })
    if (errors.length > 0) {
      throw new Error("Workbench console errors during the browser gate")
    }
    return { threadId }
  })
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

/**
 * Reads the raw persisted-threads JSON out of the browser. The callback is a
 * thin, self-contained wrapper around `localStorage.getItem`: Playwright
 * serialises it into the page, so it cannot close over module-scope symbols
 * like `THREADS_STORAGE_KEY` — the key travels in as an argument instead. All
 * the actual parsing/matching logic lives in `findPersistedThreadId`, on the
 * Node side, where it is unit-testable.
 */
async function readPersistedThreadsRaw(page: Page): Promise<string | null> {
  return page.evaluate((args) => localStorage.getItem(args.key), { key: THREADS_STORAGE_KEY })
}

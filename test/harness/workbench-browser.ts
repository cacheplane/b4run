/**
 * The Workbench browser gate: drive the scaffolded web client in a real
 * browser, through the real CopilotKit runtime, to the real B4 server.
 *
 * This is the README recording's journey (docs/brand/demo/capture.mjs)
 * promoted to a CI assertion. The journey functions are imported from there so
 * the gate and the recording cannot drift; `chromium` is injected so this file
 * has a unit test that never launches a browser.
 *
 * Fail closed: a missing browser, a missing persisted thread id, a console
 * error, or an uncaught page error each fail the journey. There is no skip.
 */
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

export interface WorkbenchBrowserOptions {
  /** The generated web client's base URL (the harness's `dev:web` session). */
  readonly webUrl: string
  /** The prompt to send; must match an aimock fixture's `userMessage`. */
  readonly prompt: string
  /** Tool names the fixture calls, in order — asserted as cards after reload. */
  readonly tools: readonly string[]
  /** The fixture's final reply — asserted on screen after reload. */
  readonly answer: string
  /** Written only when the journey fails, next to the harness transcripts. */
  readonly screenshotPath: string
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

export async function runWorkbenchBrowserJourney(
  options: WorkbenchBrowserOptions,
  deps: WorkbenchBrowserDeps,
): Promise<{ readonly threadId: string }> {
  const journey = deps.journey ?? DEFAULT_JOURNEY
  const browser = await deps.chromium.launch({ headless: true })
  let context: BrowserContext | undefined
  try {
    context = await browser.newContext()
    const page = await context.newPage()
    const errors = collectPageErrors(page)
    try {
      await journey.openReadyWorkbench(page, options.webUrl)
      await journey.fillActiveWorkbenchComposer(page, options.prompt)
      await page.getByRole("button", { name: "Send", exact: true }).click()
      await journey.waitForWorkbenchRunCompletion(page)

      const expectedTitle = options.prompt.trim().slice(0, MAX_THREAD_TITLE_LENGTH)
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
    } catch (error) {
      // Best effort: the rendered state is the one thing the transcript cannot show.
      await page.screenshot({ path: options.screenshotPath, fullPage: true }).catch(() => undefined)
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
    await context?.close().catch(() => undefined)
    await browser.close().catch(() => undefined)
  }
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() !== "error") return
    const { url } = message.location()
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

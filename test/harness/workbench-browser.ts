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

/** The key the Workbench persists its thread list under (AppShell / thread-source.ts). */
const THREADS_STORAGE_KEY = "b4.workbench.threads"

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

      const threadId = await readPersistedThreadId(page, options.prompt)
      if (threadId === undefined) {
        throw new Error("Workbench did not persist the active thread id")
      }
      await journey.restoreWorkbenchThread(page, {
        workbenchUrl: options.webUrl,
        threadId,
        prompt: options.prompt,
        tools: options.tools,
        answer: options.answer,
      })
      if (errors.length > 0) {
        throw new Error(`Workbench console errors during the browser gate:\n${errors.join("\n")}`)
      }
      return { threadId }
    } catch (error) {
      // Best effort: the rendered state is the one thing the transcript cannot show.
      await page.screenshot({ path: options.screenshotPath, fullPage: true }).catch(() => undefined)
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

async function readPersistedThreadId(page: Page, prompt: string): Promise<string | undefined> {
  return page.evaluate(
    ({ key, title }) => {
      const raw = localStorage.getItem(key)
      const threads: unknown = raw === null ? [] : JSON.parse(raw)
      if (!Array.isArray(threads)) return undefined
      const thread = threads.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { title?: unknown }).title === title,
      ) as { id?: unknown } | undefined
      return typeof thread?.id === "string" ? thread.id : undefined
    },
    { key: THREADS_STORAGE_KEY, title: prompt },
  )
}

/**
 * Types for the journey helpers `capture.mjs` exports. The README capture
 * script and the Workbench browser gate (test/harness/workbench-browser.ts)
 * share these; keep the signatures in step with the .mjs.
 */
import type { Page } from "@playwright/test"

export function openReadyWorkbench(page: Page, url: string): Promise<void>

export function fillActiveWorkbenchComposer(page: Page, prompt: string): Promise<void>

export function waitForWorkbenchRunCompletion(page: Page): Promise<void>

export function restoreWorkbenchThread(
  page: Page,
  options: {
    readonly workbenchUrl: string
    readonly threadId: string
    readonly prompt: string
    readonly tools: readonly string[]
    readonly answer: string
  },
): Promise<void>

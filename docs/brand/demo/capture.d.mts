/**
 * Types for the journey helpers `capture.mjs` exports. The README capture
 * script and the Workbench browser gate (test/harness/workbench-browser.ts)
 * share these; keep the signatures in step with the .mjs.
 *
 * Nothing type-checks this file against capture.mjs — there is no checkJs,
 * only biome lint — so a signature change in the .mjs (params, return shape)
 * must be mirrored here by hand, or these declarations silently drift stale.
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
): Promise<{ readonly stateUrl: string }>

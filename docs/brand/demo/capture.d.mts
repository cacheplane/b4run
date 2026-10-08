/**
 * Types for the journey helpers `capture.mjs` exports. The README capture
 * script and the Workbench browser gate (test/harness/workbench-browser.ts)
 * share these; keep the signatures in step with the .mjs.
 *
 * Nothing type-checks this file against capture.mjs — there is no checkJs,
 * only biome lint — so a signature change in the .mjs (params, return shape)
 * must be mirrored here by hand, or these declarations silently drift stale.
 */
import type { Locator, Page, Response } from "@playwright/test"

/** A root conversation turn (`section.b4-turn`), never a subagent's nested one. */
export const ROOT_TURN_SELECTOR: string

/** A root turn that has settled: done, failed or stopped. */
export const SETTLED_ROOT_TURN_SELECTOR: string

export function openReadyWorkbench(page: Page, url: string): Promise<void>

export function fillActiveWorkbenchComposer(page: Page, prompt: string): Promise<void>

export function waitForWorkbenchRunCompletion(
  page: Page,
  options?: { readonly turns?: number },
): Promise<void>

export function expandLatestTurn(
  page: Page,
  options?: { readonly timeout?: number },
): Promise<Locator>

export function isThreadConnectResponse(
  response: Response,
  target: { readonly origin: string; readonly threadId: string },
): boolean

export function restoreWorkbenchThread(
  page: Page,
  options: {
    readonly workbenchUrl: string
    readonly threadId: string
    readonly prompt: string
  } & (
    | {
        readonly tools: readonly string[]
        readonly answer: string
        readonly turns?: undefined
      }
    | {
        readonly turns: readonly {
          readonly prompt: string
          readonly tools: readonly string[]
          readonly answer: string
        }[]
      }
  ),
): Promise<{ readonly connectUrl: string }>

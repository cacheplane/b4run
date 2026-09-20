/**
 * W8, the Workbench suggestion journeys: click each of the three empty-state
 * suggestions in a real browser and assert what the scaffolded Workbench draws
 * back — the plan and subagent cards, the permission gate resolving through
 * `Allow once`, and a remembered preference appearing in the memory panel and
 * surviving approval.
 *
 * The browser session itself — launch, console-error collection, abort race,
 * screenshot, cleanup — is the shared seam in `workbench-page.ts`. W7 lives in
 * `workbench-browser.ts`; this file does not import it, and the two gates share
 * nothing but the seam and the journey helpers.
 *
 * Fail closed: every wait has a deadline, and a console error collected during
 * a journey fails THAT journey.
 */
import { join } from "node:path"

import type { Page } from "@playwright/test"

import {
  openReadyWorkbench,
  waitForWorkbenchRunCompletion,
} from "../../docs/brand/demo/capture.mjs"
import { type WorkbenchPageDeps, withWorkbenchPage } from "./workbench-page.ts"

export interface SuggestionJourneyOptions {
  readonly webUrl: string
  /** Directory for per-journey failure screenshots (`workbench-browser-<key>.png`). */
  readonly screenshotDir: string
  readonly fetchCommand: string
  readonly gatedReply: string
  readonly researchReply: string
  readonly teachContent: string
  readonly signal?: AbortSignal
}

export interface SuggestionJourneyDeps {
  readonly chromium: WorkbenchPageDeps["chromium"]
  readonly journey?: {
    readonly openReadyWorkbench: typeof openReadyWorkbench
    readonly waitForWorkbenchRunCompletion: typeof waitForWorkbenchRunCompletion
  }
}

type SuggestionJourneyHelpers = NonNullable<SuggestionJourneyDeps["journey"]>

const JOURNEYS = [
  { key: "research", title: "Research a topic" },
  { key: "gate", title: "Trigger a permission prompt" },
  { key: "teach", title: "Teach it a preference" },
] as const

const VISIBLE = { state: "visible", timeout: 120_000 } as const
const HIDDEN = { state: "hidden", timeout: 120_000 } as const

/**
 * Starts one suggestion from a clean slate. `New conversation` is what makes
 * each journey its own thread — without it the second journey would append to
 * the first one's transcript and the empty state would never be on screen.
 *
 * The button's accessible name is the suggestion's title followed by its
 * message (EmptyState.tsx), so match on the title as a prefix.
 */
async function startSuggestion(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New conversation", exact: true }).click()
  await page.getByRole("button", { name: new RegExp(`^${title}`) }).click()
}

async function researchJourney(
  page: Page,
  options: SuggestionJourneyOptions,
  journey: SuggestionJourneyHelpers,
): Promise<void> {
  await startSuggestion(page, "Research a topic")
  await journey.waitForWorkbenchRunCompletion(page)
  const main = page.getByRole("main")
  // Substring matches, never { exact: true }: every card summary begins with the
  // `▸` marker, a real aria-hidden element and therefore part of textContent.
  // The plan card stays expanded (open={hasActiveTodo}; the fixture leaves one
  // todo in_progress), so its checklist needs no click.
  await main.getByText("Plan · 1/4 complete").last().waitFor(VISIBLE)
  const subagentCard = main.locator("details").filter({ hasText: "researcher · completed" }).last()
  await subagentCard.locator("summary").waitFor(VISIBLE)
  await subagentCard.getByText(/researcher · completed · 2 tools/).waitFor(VISIBLE)
  // The subagent card collapses the moment its subagent finishes
  // (open={content.status === "running"}), so the tools list is in the DOM but
  // hidden. Expanding it is the only way to see the list — and is itself a real
  // user action worth gating.
  await subagentCard.locator("summary").click()
  const tools = subagentCard.getByLabel("Subagent tools")
  await tools.getByText("searchCorpus", { exact: true }).waitFor(VISIBLE)
  await tools.getByText("readDoc", { exact: true }).waitFor(VISIBLE)
  await main.getByText("writeFile", { exact: true }).last().waitFor(VISIBLE)
  await main.getByText(options.researchReply, { exact: true }).last().waitFor(VISIBLE)
}

async function gateJourney(
  page: Page,
  options: SuggestionJourneyOptions,
  journey: SuggestionJourneyHelpers,
): Promise<void> {
  await startSuggestion(page, "Trigger a permission prompt")
  // InterruptCard puts role="alert" on the wrapper and renders the command
  // inside it, so the filter matches the card that holds this command.
  const alert = page.getByRole("alert").filter({ hasText: options.fetchCommand })
  await alert.waitFor(VISIBLE)
  await alert.getByRole("button", { name: "Allow once", exact: true }).click()
  await alert.waitFor(HIDDEN)
  await journey.waitForWorkbenchRunCompletion(page)
  await page
    .getByRole("main")
    .getByText(options.gatedReply, { exact: true })
    .last()
    .waitFor(VISIBLE)
}

async function teachJourney(
  page: Page,
  options: SuggestionJourneyOptions,
  journey: SuggestionJourneyHelpers,
): Promise<void> {
  await startSuggestion(page, "Teach it a preference")
  await journey.waitForWorkbenchRunCompletion(page)
  // The panel reloads on the agent's onRunFinishedEvent, so no reload is needed;
  // it renders null when empty, so this locator resolves only once a candidate
  // exists (Playwright locators are lazy, which is why locating it is safe).
  const panel = page.getByLabel("Memory candidates")
  await panel.getByText(options.teachContent, { exact: true }).waitFor(VISIBLE)
  await panel.getByRole("button", { name: `Approve: ${options.teachContent}`, exact: true }).click()
  // After approving the only candidate the panel is replaced by its outcome
  // line, so the row is gone either way; waitFor(hidden) is correct for both.
  await panel.getByText(options.teachContent, { exact: true }).waitFor(HIDDEN)
  const response = await page.request.get(new URL("/api/b4/memory/candidates", options.webUrl).href)
  if (!response.ok())
    throw new Error(`memory candidates read failed with HTTP ${response.status()}`)
  const body = (await response.json()) as { candidates?: Array<{ content?: unknown }> }
  if ((body.candidates ?? []).some((c) => c.content === options.teachContent)) {
    throw new Error("approved candidate is still listed by /api/b4/memory/candidates")
  }
}

export async function runWorkbenchSuggestionJourneys(
  options: SuggestionJourneyOptions,
  deps: SuggestionJourneyDeps,
): Promise<void> {
  const journey = deps.journey ?? { openReadyWorkbench, waitForWorkbenchRunCompletion }
  let current: (typeof JOURNEYS)[number] = JOURNEYS[0]
  await withWorkbenchPage(
    {
      // A function, not a string: the seam resolves it at screenshot time, so
      // each journey's failure writes its own file instead of overwriting.
      screenshotPath: () => join(options.screenshotDir, `workbench-browser-${current.key}.png`),
      // Spread rather than assigned: under exactOptionalPropertyTypes an
      // explicit `signal: undefined` is not the same as an absent signal.
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    { chromium: deps.chromium },
    async (page, errors) => {
      await journey.openReadyWorkbench(page, options.webUrl)
      for (const next of JOURNEYS) {
        current = next
        try {
          if (next.key === "research") await researchJourney(page, options, journey)
          else if (next.key === "gate") await gateJourney(page, options, journey)
          else await teachJourney(page, options, journey)
          // Per journey, not once at the end: a console error from the research
          // journey must not be reported against "Teach it a preference" with a
          // screenshot of the memory panel.
          if (errors.length > 0) throw new Error(`Workbench console errors:\n${errors.join("\n")}`)
        } catch (error) {
          throw new Error(
            `${next.title}: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          )
        }
      }
    },
  )
}

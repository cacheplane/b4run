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
 * Fail closed: every wait THIS FILE arms has a deadline well inside the
 * harness's own, so a drifted locator is killed by Playwright (which names the
 * locator, prints the call log, and leaves a live page to screenshot) rather
 * than by the harness deadline (which rejects outside the body, so nothing
 * below ever runs). The imported `waitForWorkbenchRunCompletion` keeps its own
 * budget — three 120s waits, once per journey — so W8's worst single wait is
 * still 120s and comes from capture.mjs, not from here. A console error
 * collected during a journey fails THAT journey.
 */
import { join } from "node:path"

import type { Locator, Page } from "@playwright/test"

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

/**
 * The seam's deps plus this gate's own journey helpers. `chromium` is
 * inherited rather than restated, so the launch signature cannot drift from
 * the seam that actually calls it.
 */
export interface SuggestionJourneyDeps extends WorkbenchPageDeps {
  readonly journey?: {
    readonly openReadyWorkbench: typeof openReadyWorkbench
    readonly waitForWorkbenchRunCompletion: typeof waitForWorkbenchRunCompletion
  }
}

type SuggestionJourneyHelpers = NonNullable<SuggestionJourneyDeps["journey"]>

/**
 * The deadline, in ms, for every wait ARMED IN THIS FILE.
 *
 * It does not reach `waitForWorkbenchRunCompletion`, which comes from
 * capture.mjs with three 120s waits of its own and runs once per journey.
 *
 * Deliberately far below the harness's own deadline. `withWorkbenchPage`'s
 * abort race rejects from OUTSIDE `body`, so a harness abort skips this file's
 * per-journey catch entirely: no journey name, no Playwright call log, and a
 * screenshot that no-ops against a browser that is already closing. Losing
 * that race on purpose is the whole point of this number — a mocked run
 * finishes in seconds, so 45s only ever elapses when a locator has drifted,
 * which is exactly the failure Playwright reports best.
 */
const LOCATOR_TIMEOUT_MS = 45_000

const VISIBLE = { state: "visible", timeout: LOCATOR_TIMEOUT_MS } as const
const HIDDEN = { state: "hidden", timeout: LOCATOR_TIMEOUT_MS } as const

/**
 * Mirrors `LABEL_LIMIT` in
 * packages/devkit/templates/app-research/web/app/components/MemoryPanel.tsx,
 * where `shortLabel()` collapses whitespace runs and truncates past this many
 * characters with `…` before building `aria-label={`Approve: ${…}`}`. Nothing
 * imports that file (it ships inside the scaffolded app), so keep it in step
 * with the template by hand.
 */
export const MEMORY_LABEL_LIMIT = 60

export const TEACH_CONTENT_SHAPE_MESSAGE = `Workbench suggestion journey teachContent must survive MemoryPanel's shortLabel() unchanged: trimmed, no whitespace runs or newlines, and at most ${MEMORY_LABEL_LIMIT} characters (the Approve button is matched by its exact accessible name)`

/** The approve POST, as it appears on the wire through the app's proxy. */
const APPROVE_PATHNAME = /^\/api\/b4\/memory\/candidates\/[^/]+\/approve$/

/** `RegExp` metacharacters in a suggestion title must match literally. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Waits for `locator` to be visible and then insists there is EXACTLY one.
 *
 * `.first()`/`.last()` would hide a duplicate card, which is precisely the
 * regression the AG-UI suppression-ledger work fixed: within one fresh thread
 * there is one plan card and one card per subagent. Counting after the wait,
 * not before, so a card that has not rendered yet is a timeout rather than a
 * count of zero.
 *
 * The count is a ONE-SHOT SNAPSHOT taken at that moment, not a settled
 * invariant: a duplicate that renders later in the journey slips through. It
 * catches the duplicate that is already on screen when the assertion runs,
 * which is the shape every duplicate-emit bug so far has had.
 */
async function expectExactlyOne(locator: Locator, what: string): Promise<void> {
  await locator.first().waitFor(VISIBLE)
  const count = await locator.count()
  if (count !== 1) throw new Error(`expected exactly one ${what} in this thread, found ${count}`)
}

/** Insists nothing matches — used to prove where something is NOT rendered. */
async function expectNone(locator: Locator, what: string): Promise<void> {
  const count = await locator.count()
  if (count !== 0) throw new Error(`expected no ${what}, found ${count}`)
}

/**
 * Starts one suggestion from a clean slate. Creating a thread is what makes
 * each journey its own — without it the second journey would append to the
 * first one's transcript and the empty state would never be on screen.
 *
 * THE `+` IS LOAD-BEARING. The rail's create button renders the literal
 * `+ New conversation`, while an UNTITLED THREAD ROW renders exactly
 * `New conversation` (`UNTITLED_THREAD_LABEL`) — see ThreadRail.tsx. Matching
 * the bare string therefore finds the ROW, not the button: one element on a
 * fresh load (clicking it is a no-op, which is why journey 1 would still pass)
 * and ZERO once journey 1 has titled that thread, so journey 2 would retry
 * until it timed out. Do not "tidy" the plus away.
 *
 * `handleCreate` no-ops when the active thread is already untitled, so clicking
 * the real button on a fresh load behaves exactly as before.
 *
 * The suggestion button's accessible name is the title followed by its message
 * (EmptyState.tsx), so match on the escaped title as a prefix.
 */
async function startSuggestion(page: Page, title: string): Promise<void> {
  await page
    .getByRole("button", { name: "+ New conversation", exact: true })
    .click({ timeout: LOCATOR_TIMEOUT_MS })
  await page
    .getByRole("button", { name: new RegExp(`^${escapeRegExp(title)}`) })
    .click({ timeout: LOCATOR_TIMEOUT_MS })
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
  await expectExactlyOne(
    main.locator("details").filter({ hasText: "Plan · 1/4 complete" }),
    "plan card",
  )
  const subagentCard = main.locator("details").filter({ hasText: "researcher · completed" })
  await expectExactlyOne(subagentCard, "researcher subagent card")
  await subagentCard.getByText(/researcher · completed · 2 tools/).waitFor(VISIBLE)
  // The subagent card collapses the moment its subagent finishes
  // (open={content.status === "running"}), so the tools list is in the DOM but
  // hidden. Expanding it is the only way to see the list — and is itself a real
  // user action worth gating.
  await subagentCard.locator("summary").click({ timeout: LOCATOR_TIMEOUT_MS })
  // Assert the DISCLOSURE, not just its consequence. If the card ever ships
  // already-open, the click above collapses it and the tool waits below would
  // read as "the tools never rendered" instead of "the open state flipped".
  await main.locator("details[open]").filter({ hasText: "researcher · completed" }).waitFor(VISIBLE)
  const tools = subagentCard.getByLabel("Subagent tools")
  await tools.getByText("searchCorpus", { exact: true }).waitFor(VISIBLE)
  await tools.getByText("readDoc", { exact: true }).waitFor(VISIBLE)
  // `writeFile` is a ROOT tool call, so it renders as a plain ToolCallCard and
  // must NOT appear inside any activity card's <details>. Asserting both halves
  // is what distinguishes "the root ran writeFile" from "some subagent did".
  await expectExactlyOne(main.getByText("writeFile", { exact: true }), "writeFile tool card")
  await expectNone(
    main.locator("details").getByText("writeFile", { exact: true }),
    "writeFile inside an activity card",
  )
  // Exactly one, not `.last()`: Playwright's text engine drops an ancestor whose
  // child also matches, so ONE message — however deeply the markdown renderer
  // nests it — counts 1. A count of 2 therefore means two messages, which is
  // precisely the AG-UI duplicate-emit bug `.last()` would have hidden.
  await expectExactlyOne(main.getByText(options.researchReply, { exact: true }), "assistant reply")
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
  await expectExactlyOne(alert, "permission gate for this command")
  await alert
    .getByRole("button", { name: "Allow once", exact: true })
    .click({ timeout: LOCATOR_TIMEOUT_MS })
  await alert.waitFor(HIDDEN)
  await journey.waitForWorkbenchRunCompletion(page)
  // Exactly one: see the research journey's reply — a nested message still
  // counts 1, so 2 means the reply was emitted twice.
  await expectExactlyOne(
    page.getByRole("main").getByText(options.gatedReply, { exact: true }),
    "gated reply",
  )
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
  // Armed BEFORE the click, and the one assertion `Delete` cannot satisfy.
  // Every UI-visible consequence of Approve is shared with Delete: both remove
  // the row, both hard-delete the candidate from GET /memory/candidates, and
  // the role="status" outcome line is EMPTY for both here — `describeApprove`
  // returns null for a plain `activated`, and reject never sets an outcome at
  // all (MemoryPanel.tsx). Only approve POSTs this route, and only its body
  // carries the stored record; `{ ok: true }` is all reject returns.
  //
  // `APPROVE_PATHNAME` alone is what discriminates approve from reject — the
  // method check is belt-and-braces and removing it changes nothing. Do NOT
  // "simplify" this the other way round: a looser pathname with only the method
  // to lean on would match the reject POST.
  const approvePost = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      APPROVE_PATHNAME.test(new URL(response.url()).pathname),
    { timeout: LOCATOR_TIMEOUT_MS },
  )
  const approveButton = panel.getByRole("button", {
    name: `Approve: ${options.teachContent}`,
    exact: true,
  })
  // Playwright's documented pattern, and not cosmetic: awaiting the click on its
  // own leaves `approvePost` unhandled if the click throws, so the journey's
  // real (named, screenshotted) failure is followed moments later by an
  // unhandled waitForResponse timeout that can take the vitest worker down with
  // it. `Promise.all` attaches a handler to both before either can settle.
  const [approved] = await Promise.all([
    approvePost,
    approveButton.click({ timeout: LOCATOR_TIMEOUT_MS }),
  ])
  if (!approved.ok()) throw new Error(`approve failed with HTTP ${approved.status()}`)
  const approvedBody = (await approved.json()) as {
    record?: { content?: unknown; status?: unknown }
  }
  if (approvedBody.record?.content !== options.teachContent) {
    throw new Error(`approve returned a different record: ${JSON.stringify(approvedBody.record)}`)
  }
  if (approvedBody.record?.status !== "active") {
    throw new Error(`approved record is '${String(approvedBody.record?.status)}', not 'active'`)
  }
  // After approving the only candidate the panel is replaced by its outcome
  // line, so the row is gone either way; waitFor(hidden) is correct for both.
  await panel.getByText(options.teachContent, { exact: true }).waitFor(HIDDEN)
  // Kept alongside the POST assertion: a UI-only check would pass on an
  // optimistic removal whose write never landed.
  const response = await page.request.get(
    new URL("/api/b4/memory/candidates", options.webUrl).href,
    { timeout: LOCATOR_TIMEOUT_MS },
  )
  if (!response.ok())
    throw new Error(`memory candidates read failed with HTTP ${response.status()}`)
  const body = (await response.json()) as { candidates?: Array<{ content?: unknown }> }
  if ((body.candidates ?? []).some((c) => c.content === options.teachContent)) {
    throw new Error("approved candidate is still listed by /api/b4/memory/candidates")
  }
}

/**
 * The journeys, in order, each owning its own step function. The function
 * hangs off the entry rather than being selected by a chain of `if`s in the
 * loop, so a fourth suggestion cannot silently fall through to the last case.
 */
const JOURNEYS = [
  { key: "research", title: "Research a topic", run: researchJourney },
  { key: "gate", title: "Trigger a permission prompt", run: gateJourney },
  { key: "teach", title: "Teach it a preference", run: teachJourney },
] as const satisfies readonly {
  readonly key: string
  readonly title: string
  readonly run: (
    page: Page,
    options: SuggestionJourneyOptions,
    journey: SuggestionJourneyHelpers,
  ) => Promise<void>
}[]

export async function runWorkbenchSuggestionJourneys(
  options: SuggestionJourneyOptions,
  deps: SuggestionJourneyDeps,
): Promise<void> {
  // Reject before launching, the way W7 rejects a prompt the thread rail would
  // truncate: `shortLabel()` collapsing or truncating this content yields an
  // accessible name the exact-name Approve locator can never match, so it would
  // otherwise burn a full timeout on a button that is plainly on screen.
  if (
    options.teachContent.replace(/\s+/g, " ").trim() !== options.teachContent ||
    options.teachContent.length > MEMORY_LABEL_LIMIT
  ) {
    throw new Error(TEACH_CONTENT_SHAPE_MESSAGE)
  }
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
          await next.run(page, options, journey)
          // Per journey, not once at the end: a console error from the research
          // journey must not be reported against "Teach it a preference" with a
          // screenshot of the memory panel.
          if (errors.length > 0) throw new Error(`Workbench console errors:\n${errors.join("\n")}`)
        } catch (error) {
          throw new Error(
            `${next.title}: ${error instanceof Error ? error.message : String(error)}`,
            {
              cause: error,
            },
          )
        }
      }
    },
  )
}

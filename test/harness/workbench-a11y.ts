/**
 * Accessibility checks the Workbench browser journeys run on the real page:
 * an axe scan of the chat dock, and keyboard-only focus moves.
 *
 * `axe` is injectable, the same way `chromium` is in `workbench-page.ts`, so
 * this file's unit test never launches a browser.
 */
import { AxeBuilder } from "@axe-core/playwright"
import type { Locator, Page } from "@playwright/test"

/** The chat dock (`ChatDock.tsx`): the brand, the thread title, the activity and the input. */
export const CHAT_DOCK_SELECTOR = 'section[aria-label="Chat"]'

/** WCAG 2.0 and 2.1, levels A and AA. */
export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const

export interface AxeViolation {
  readonly id: string
  readonly impact?: string | null
  readonly help?: string
  readonly nodes: readonly { readonly target?: readonly unknown[] }[]
}

/** The part of `AxeBuilder` these checks use. */
export interface AxeScan {
  include(selector: string): AxeScan
  withTags(tags: string[]): AxeScan
  analyze(): Promise<{ readonly violations: readonly AxeViolation[] }>
}

export type AxeFactory = (page: Page) => AxeScan

export const defaultAxe: AxeFactory = (page) => new AxeBuilder({ page }) as unknown as AxeScan

/** The first few offending nodes per rule, so a CI failure names what to fix. */
const NODES_SHOWN = 3

function describeViolation(violation: AxeViolation): string {
  const targets = violation.nodes
    .slice(0, NODES_SHOWN)
    .map((node) => JSON.stringify(node.target ?? []))
    .join(", ")
  const more = violation.nodes.length > NODES_SHOWN ? ", …" : ""
  return `${violation.id} [${violation.impact}] (${violation.nodes.length}): ${targets}${more}`
}

/**
 * Scans `include` (the chat dock by default) for WCAG A/AA violations and
 * fails on any rated serious or critical. Minor and moderate findings pass:
 * the gate is for the ones that lock a person out.
 */
export async function assertNoSeriousAxeViolations(
  page: Page,
  options: { readonly include?: string; readonly axe?: AxeFactory; readonly when?: string } = {},
): Promise<void> {
  const include = options.include ?? CHAT_DOCK_SELECTOR
  const { violations } = await (options.axe ?? defaultAxe)(page)
    .include(include)
    .withTags([...AXE_TAGS])
    .analyze()
  const bad = violations.filter((v) => v.impact === "serious" || v.impact === "critical")
  if (bad.length > 0) {
    const where = options.when === undefined ? include : `${include} ${options.when}`
    throw new Error(
      `axe found serious violations in ${where}: ${bad.map(describeViolation).join("; ")}`,
    )
  }
}

/** Whether `target` is the focused element right now. */
export async function isFocused(target: Locator): Promise<boolean> {
  return target.evaluate((element) => element === element.ownerDocument.activeElement)
}

/**
 * Presses Tab (or Shift+Tab) until `target` has focus, the way a keyboard user
 * reaches a control. Fails after `maxTabs` presses: a control Tab never
 * reaches is not keyboard-operable, whatever a click would do.
 */
export async function tabUntilFocused(
  page: Page,
  target: Locator,
  options: { readonly maxTabs?: number; readonly backwards?: boolean; readonly what?: string } = {},
): Promise<void> {
  const maxTabs = options.maxTabs ?? 30
  const key = options.backwards === true ? "Shift+Tab" : "Tab"
  for (let presses = 0; presses <= maxTabs; presses += 1) {
    if (await isFocused(target)) return
    if (presses < maxTabs) await page.keyboard.press(key)
  }
  throw new Error(
    `${options.what ?? "The target"} never took focus after ${maxTabs} ${key} presses`,
  )
}

/** The deadline for each wait the keyboard pass arms; a mocked run is long settled by now. */
const KEYBOARD_TIMEOUT_MS = 15_000

/** Polls `aria-expanded` until it reads `value`; a keypress lands a React render later. */
async function waitForExpanded(
  button: Locator,
  value: "true" | "false",
  what: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await button.getAttribute("aria-expanded", { timeout: timeoutMs })
    if (current === value) return
    if (Date.now() > deadline) {
      throw new Error(
        `${what} stayed aria-expanded=${String(current)} after Enter, expected ${value}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/**
 * Presses Enter on the focused disclosure and waits for its `aria-expanded`
 * to flip; presses again if that closed it, so it ends open.
 */
async function openByKeyboard(
  page: Page,
  button: Locator,
  what: string,
  timeoutMs: number,
): Promise<void> {
  const before = await button.getAttribute("aria-expanded", { timeout: timeoutMs })
  if (before !== "true" && before !== "false") {
    throw new Error(`${what} is not a disclosure (aria-expanded=${String(before)})`)
  }
  const flipped = before === "true" ? "false" : "true"
  await page.keyboard.press("Enter")
  await waitForExpanded(button, flipped, what, timeoutMs)
  if (flipped === "true") return
  await page.keyboard.press("Enter")
  await waitForExpanded(button, "true", what, timeoutMs)
}

/**
 * W7's accessibility pass over a restored thread: an axe scan of the dock,
 * then the restored turn and its first step, driven by keyboard alone —
 * Shift+Tab from the message box back to the turn's summary, Enter flips it;
 * Tab on to the first step's line, Enter opens it.
 *
 * `turnSelector` is the restored root turn (capture.mjs's
 * `SETTLED_ROOT_TURN_SELECTOR`); the caller passes it so this file does not
 * import the journey helpers.
 */
export async function assertRestoredTurnAccessible(
  page: Page,
  options: {
    readonly turnSelector: string
    readonly axe?: AxeFactory
    /** Per wait; defaults to 15s. */
    readonly timeoutMs?: number
  },
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? KEYBOARD_TIMEOUT_MS
  await assertNoSeriousAxeViolations(page, {
    ...(options.axe === undefined ? {} : { axe: options.axe }),
    when: "after the restore",
  })
  const turn = page.getByRole("main").locator(options.turnSelector).last()
  const summary = turn.locator(":scope > button.b4-turn__summary")
  await page.getByRole("textbox", { name: "Message" }).focus({ timeout: timeoutMs })
  await tabUntilFocused(page, summary, { backwards: true, what: "The restored turn's summary" })
  await openByKeyboard(page, summary, "The restored turn's summary", timeoutMs)
  const firstLine = turn
    .locator(":scope > ol.b4-turn__steps > li.b4-step")
    .first()
    .locator(":scope > button.b4-step__line")
  await tabUntilFocused(page, firstLine, { what: "The restored turn's first step" })
  await openByKeyboard(page, firstLine, "The restored turn's first step", timeoutMs)
}

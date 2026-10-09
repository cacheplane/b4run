/**
 * Where the memory panel is, for the sidenav's "Memory" item.
 *
 * The panel stays inline above the conversation, because a proposed memory
 * should be in view without hunting for it; the sidenav only counts the
 * candidates and brings the panel into view. Its own module so the layout
 * can reach the panel without importing it (the panel needs CopilotKit).
 */
export const MEMORY_PANEL_ID = "wb-memory"

/** Scrolls the panel into view, opens its disclosure and focuses it. A no-op when nothing is waiting. */
export function revealMemoryPanel(): void {
  const panel = document.getElementById(MEMORY_PANEL_ID)
  if (panel === null) return
  const details = panel.querySelector("details")
  if (details !== null) details.open = true
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  panel.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" })
  panel.querySelector<HTMLElement>("summary")?.focus()
}

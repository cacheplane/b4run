// @vitest-environment jsdom
import { renderToString } from "react-dom/server"
import { expect, it } from "vitest"
import { FolderTour } from "./FolderTour"
import { prepareFolderTour } from "./prepare"
import { tourSources } from "./tour-sources"
import { tourStops } from "./tour-stops"

const data = await prepareFolderTour()
const render = () => {
  const container = document.createElement("div")
  container.innerHTML = renderToString(<FolderTour {...data} />)
  return container
}

it("server renders all seven stops in full, stacked and visible, before any script runs", () => {
  const section = render().querySelector("section#first-agent")
  expect(section?.querySelector("h2")?.textContent).toBe("An agent is a folder.")
  const cards = [...(section?.querySelectorAll<HTMLElement>("article[data-stop]") ?? [])]
  expect(cards.map((card) => card.id)).toEqual(tourStops.map((stop) => `tour-${stop.id}`))
  for (const [index, stop] of tourStops.entries()) {
    const card = cards[index]
    expect(card?.getAttribute("style"), stop.id).toBeNull()
    expect(card?.getAttribute("role"), stop.id).toBeNull()
    expect(card?.getAttribute("tabindex"), stop.id).toBe("-1")
    expect(card?.querySelector("code")?.textContent).toBe(`src/app/hello/${stop.file}`)
    expect(card?.querySelector("h3")?.textContent).toBe(stop.title)
    expect(card?.textContent).toContain(stop.copy)
    expect(card?.querySelector(`a[href="${stop.docsHref}"]`)?.textContent).toBe(
      `${stop.docsLabel} →`,
    )
    // The panel shows the whole file: every non-blank line is on the page.
    const shown = card?.querySelector("pre")?.textContent ?? ""
    for (const line of tourSources[stop.id].split("\n").filter((text) => text.trim() !== "")) {
      expect(shown, `${stop.id}: ${line}`).toContain(line)
    }
  }
  // The chip bar is plain links, so it works before any script runs.
  const chips = [...(section?.querySelectorAll('[data-tour="chips"] a') ?? [])]
  expect(chips.map((chip) => chip.getAttribute("href"))).toEqual(
    tourStops.map((stop) => `#tour-${stop.id}`),
  )
  expect(section?.querySelectorAll('[role="tab"]')).toHaveLength(7)
  expect(section?.querySelector("[data-pinned]")).toBeNull()
})

it("opens the tool stop on the playground, showing the scaffold's own schema", () => {
  const greet = render().querySelector("#tour-greet")
  expect(
    [...(greet?.querySelectorAll("button[aria-pressed]") ?? [])].map((button) =>
      button.getAttribute("aria-pressed"),
    ),
  ).toEqual(["false", "false", "true"])
  expect(greet?.textContent).toContain('"description": "Greet someone by name."')
  expect(greet?.textContent).toContain('"required": ["name"]')
  expect(greet?.querySelector('[aria-live="polite"]')).not.toBeNull()
})

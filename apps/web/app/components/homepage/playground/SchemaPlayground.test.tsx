// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, expect, it } from "vitest"
import { SchemaPlayground } from "./SchemaPlayground"
import { preparePlayground } from "./schema-variants"

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
})

const variants = await preparePlayground()

async function mount() {
  const container = document.createElement("div")
  document.body.replaceChildren(container)
  root = createRoot(container)
  await act(async () => root?.render(<SchemaPlayground variants={variants} />))
  const button = (label: string) => {
    const match = [...container.querySelectorAll("button")].find((node) =>
      node.textContent?.includes(label),
    )
    if (!match) throw new Error(`No button found whose text includes ${JSON.stringify(label)}`)
    return match
  }
  const pane = (label: string) => container.querySelector(`[aria-label=${JSON.stringify(label)}]`)
  const activePre = (label: string) => pane(label)?.querySelector('pre[data-active="true"]')
  const hiddenPres = (label: string) =>
    [...(pane(label)?.querySelectorAll("pre") ?? [])].filter(
      (node) => node.getAttribute("data-active") !== "true",
    )
  return {
    press: (label: string) => act(async () => button(label).click()),
    pressed: () =>
      [...container.querySelectorAll("button")].map((node) => node.getAttribute("aria-pressed")),
    source: () => activePre("greet.ts source")?.textContent ?? "",
    schema: () => activePre("What the model sees")?.textContent ?? "",
    hiddenVariantCount: (label: string) => hiddenPres(label).length,
    hiddenVariantsAreHiddenAndInert: (label: string) =>
      hiddenPres(label).every(
        (node) => node.getAttribute("aria-hidden") === "true" && node.hasAttribute("inert"),
      ),
    changed: () =>
      [...(activePre("What the model sees")?.querySelectorAll('[data-changed="true"]') ?? [])].map(
        (line) => (line.textContent ?? "").replace(/^\+/, "").trim(),
      ),
    live: () => container.querySelector('[aria-live="polite"]')?.textContent,
  }
}

it("starts on the scaffold's greet.ts, with nothing announced or marked", async () => {
  const view = await mount()
  expect(view.pressed()).toEqual(["false", "false", "true"])
  expect(view.source()).toContain("/** Greet someone by name. */")
  expect(view.schema()).toContain('"required": ["name"]')
  expect(view.changed()).toEqual([])
  expect(view.live()).toBe("")
})

it("keeps every variant in the DOM, but only the active one visible to everyone", async () => {
  const view = await mount()
  // 8 recorded variants, 1 active, so 7 stay in the DOM inert and hidden from AT.
  expect(view.hiddenVariantCount("greet.ts source")).toBe(7)
  expect(view.hiddenVariantCount("What the model sees")).toBe(7)
  expect(view.hiddenVariantsAreHiddenAndInert("greet.ts source")).toBe(true)
  expect(view.hiddenVariantsAreHiddenAndInert("What the model sees")).toBe(true)

  await view.press("language")
  expect(view.hiddenVariantCount("greet.ts source")).toBe(7)
  expect(view.hiddenVariantsAreHiddenAndInert("greet.ts source")).toBe(true)
  expect(view.hiddenVariantsAreHiddenAndInert("What the model sees")).toBe(true)
})

it("re-derives the schema as each toggle flips, marks the changed lines and says why", async () => {
  const view = await mount()

  await view.press("language")
  expect(view.pressed()).toEqual(["false", "true", "true"])
  expect(view.source()).toContain('readonly language: "en" | "es"')
  expect(view.changed()).toEqual([
    '"language": { "type": "string", "enum": ["en", "es"] }',
    '"required": ["name", "language"],',
  ])
  expect(view.live()).toBe(
    "Required: name, language. Optional: none. Description: Greet someone by name.",
  )

  await view.press("JSDoc")
  expect(view.pressed()).toEqual(["false", "true", "false"])
  expect(view.source()).not.toContain("/**")
  expect(view.changed()).toEqual(['"description": "",'])
  expect(view.live()).toBe(
    "Required: name, language. Optional: none. No description, so the model sees only the name greet.",
  )

  const beforeFormal = view.live()
  await view.press("formal")
  expect(view.pressed()).toEqual(["true", "true", "false"])
  expect(view.changed()).toEqual(['"formal": { "type": "boolean" },'])
  // An optional field never becomes required.
  expect(view.schema()).toContain('"required": ["name", "language"]')
  // Toggling a field that's optional in every variant still changes the announcement.
  expect(view.live()).not.toBe(beforeFormal)
  expect(view.live()).toBe(
    "Required: name, language. Optional: formal. No description, so the model sees only the name greet.",
  )
})

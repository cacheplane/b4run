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
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find((node) => node.textContent?.includes(label))
  return {
    press: (label: string) => act(async () => button(label)?.click()),
    pressed: () =>
      [...container.querySelectorAll("button")].map((node) => node.getAttribute("aria-pressed")),
    source: () => container.querySelector('[aria-label="greet.ts source"] pre')?.textContent ?? "",
    schema: () =>
      container.querySelector('[aria-label="What the model sees"] pre')?.textContent ?? "",
    changed: () =>
      [...container.querySelectorAll('[data-changed="true"]')].map((line) =>
        (line.textContent ?? "").replace(/^\+/, "").trim(),
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

it("re-derives the schema as each toggle flips, marks the changed lines and says why", async () => {
  const view = await mount()

  await view.press("language")
  expect(view.pressed()).toEqual(["false", "true", "true"])
  expect(view.source()).toContain('readonly language: "en" | "es"')
  expect(view.changed()).toEqual([
    '"language": { "type": "string", "enum": ["en", "es"] }',
    '"required": ["name", "language"],',
  ])
  expect(view.live()).toBe("Required: name, language. Description: Greet someone by name.")

  await view.press("JSDoc")
  expect(view.pressed()).toEqual(["false", "true", "false"])
  expect(view.source()).not.toContain("/**")
  expect(view.changed()).toEqual(['"description": "",'])
  expect(view.live()).toBe(
    "Required: name, language. No description, so the model sees only the name greet.",
  )

  await view.press("formal")
  expect(view.pressed()).toEqual(["true", "true", "false"])
  expect(view.changed()).toEqual(['"formal": { "type": "boolean" },'])
  // An optional field never becomes required.
  expect(view.schema()).toContain('"required": ["name", "language"]')
})

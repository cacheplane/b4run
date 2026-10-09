import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { ChatDock, statusPresentation } from "./ChatDock"

function render(
  header: string,
  status?: string,
  slots: { banner?: ReactNode; notices?: ReactNode; chat?: ReactNode } = {},
): string {
  return renderToStaticMarkup(
    <ChatDock
      header={header}
      status={status}
      memory={<p>memory</p>}
      banner={slots.banner}
      notices={slots.notices}
    >
      {slots.chat ?? null}
    </ChatDock>,
  )
}

describe("chat dock header", () => {
  test("the status reads as a word: Running, Awaiting approval, Ready", () => {
    expect(statusPresentation("running")).toEqual({ label: "Running", tone: "running" })
    expect(statusPresentation("awaiting approval")).toEqual({
      label: "Awaiting approval",
      tone: "attention",
    })
    expect(statusPresentation(undefined)).toEqual({ label: "Ready", tone: "idle" })
    expect(render("Plan", "running")).toContain("Running")
    expect(render("Plan")).toContain("Ready")
  })

  test("the title gets its own row and carries its full text for when it truncates", () => {
    const long = "I'm taking N738ZU from Flying Cloud to Duluth tomorrow afternoon"
    const html = render(long, "running")
    expect(html).toMatch(new RegExp(`<h2 title="${long.replace(/'/g, "&#x27;")}"[^>]*>`))
  })

  test("the dock holds no brand and no navigation: those are the sidenav's", () => {
    const html = render("Plan")
    expect(html).not.toContain("<h1")
    expect(html).not.toContain("wb-wordmark")
    expect(html).not.toContain("Threads")
    expect(html).not.toContain("New conversation")
  })
})

describe("chat dock slots", () => {
  test("the banner and the notices sit above the conversation, which is the main", () => {
    const html = render("Plan", undefined, {
      banner: <p>banner</p>,
      notices: <p>notices</p>,
      chat: <p>chat</p>,
    })
    const main = html.indexOf("<main")
    expect(html.indexOf("<p>memory</p>")).toBeLessThan(html.indexOf("<p>banner</p>"))
    expect(html.indexOf("<p>banner</p>")).toBeLessThan(html.indexOf("<p>notices</p>"))
    expect(html.indexOf("<p>notices</p>")).toBeLessThan(main)
    expect(html.indexOf("<p>chat</p>")).toBeGreaterThan(main)
  })
  test("no banner, no banner row", () => {
    const html = render("Plan", undefined, { chat: <p>chat</p> })
    expect(html).not.toContain("px-3 pt-2")
  })
})

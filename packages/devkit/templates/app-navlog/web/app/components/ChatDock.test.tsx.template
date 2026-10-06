import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { ChatDock, statusPresentation } from "./ChatDock"

function render(header: string, status?: string): string {
  return renderToStaticMarkup(
    <ChatDock
      header={header}
      status={status}
      rail={null}
      memory={null}
      composer={null}
      onNewConversation={() => {}}
    >
      {null}
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
})

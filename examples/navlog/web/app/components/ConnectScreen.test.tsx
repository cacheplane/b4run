import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { CONNECT_SCREEN_HEADING, ConnectScreen } from "./ConnectScreen"

function render(): string {
  return renderToStaticMarkup(
    <ConnectScreen serverUrl="http://127.0.0.1:3002" onRetry={() => {}} />,
  )
}

describe("ConnectScreen", () => {
  test("renders its heading once, and the tests below assert against the same exported string", () => {
    const html = render()
    expect(html).toContain(CONNECT_SCREEN_HEADING)
  })

  test("frames the server URL as a default, not a diagnosis", () => {
    const html = render()
    expect(html).toContain("http://127.0.0.1:3002")
    expect(html).toContain("B4_SERVER_URL")
  })

  test("shows the env copy step before the command that starts the server", () => {
    const html = render()
    expect(html).toContain("cp server/.env.example server/.env")
    expect(html).toContain("npm run dev:server")
  })

  test("does not suggest the combined npm run dev, which EADDRINUSEs against the running web client", () => {
    const html = render()
    expect(html).not.toMatch(/>npm run dev<\/code>/)
  })

  test("keeps the commands context-neutral, so the template's copy of this file stays byte-equal", () => {
    const html = render()
    expect(html).not.toContain("pnpm")
    expect(html).not.toContain("examples/navlog")
  })

  test("scrolls itself on a short viewport, since the window never scrolls", () => {
    const html = render()
    expect(html).toMatch(/^<div class="[^"]*\boverflow-y-auto\b/)
    expect(html).toMatch(/^<div[^>]*>\s*<div class="[^"]*\bmy-auto\b/)
  })

  test("reminds the reader the server needs a real API key", () => {
    const html = render()
    expect(html).toContain("OPENAI_API_KEY")
  })

  test("renders the wordmark, same as the dock", () => {
    const html = render()
    expect(html).toContain('class="wb-wordmark"')
    expect(html).toContain("B4.run")
    expect(html).toContain("/ navlog")
  })

  test("Try again is the primary (ink) button", () => {
    const html = render()
    expect(html).toMatch(/<button[^>]*bg-wb-text[^>]*>Try again<\/button>/)
  })

  test("renders a retry button", () => {
    const html = render()
    expect(html).toContain("Try again")
    expect(html).toContain("<button")
  })
})

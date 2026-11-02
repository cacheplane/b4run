import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

let host: string | null = "b4.run"
vi.mock("next/headers", () => ({
  headers: async () => new Headers(host === null ? {} : { host }),
}))

import Page, { metadata } from "./page"

async function html(forHost: string | null): Promise<string> {
  host = forHost
  return renderToStaticMarkup(await Page())
}

beforeEach(() => {
  host = "b4.run"
})

describe("/app/download", () => {
  it("links the latest notarized zip by its stable alias and shows the Homebrew line", async () => {
    const out = await html("b4.run")
    expect(out).toContain(
      'href="https://github.com/cacheplane/b4app/releases/latest/download/Agent-Workspace.zip"',
    )
    expect(out).toContain("brew install --cask cacheplane/tap/agent-workspace")
  })

  it("links the pre-release page on test.b4.run", async () => {
    const out = await html("test.b4.run")
    expect(out).toContain('href="https://github.com/cacheplane/b4app/releases"')
    expect(out).not.toContain("latest/download")
  })

  it("is noindex", () => {
    expect(metadata.robots).toMatchObject({ index: false })
  })
})

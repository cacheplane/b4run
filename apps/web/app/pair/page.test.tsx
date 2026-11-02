import { readFileSync } from "node:fs"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

let host: string | null = "b4.run"
vi.mock("next/headers", () => ({
  headers: async () => new Headers(host === null ? {} : { host }),
}))

import Page, { APP_STORE_URL, metadata } from "./page"

async function html(forHost: string | null): Promise<string> {
  host = forHost
  return renderToStaticMarkup(await Page())
}

beforeEach(() => {
  host = "b4.run"
})

describe("/pair", () => {
  it("tells people to open it on an iPhone with Agent Workspace installed", async () => {
    const out = await html("b4.run")
    expect(out).toMatch(/iPhone/)
    expect(out).toMatch(/Agent Workspace/)
  })

  it("is noindex", () => {
    expect(metadata.robots).toMatchObject({ index: false })
  })

  it("renders Coming soon while the App Store URL is unset", async () => {
    expect(APP_STORE_URL).toBeNull()
    const out = await html("b4.run")
    expect(out).toContain("Coming soon to the App Store")
    expect(out).not.toContain("apps.apple.com")
  })

  it("says the beta build comes through TestFlight on test.b4.run", async () => {
    const out = await html("test.b4.run")
    expect(out).toMatch(/TestFlight/)
    expect(out).toMatch(/invitation/)
    expect(out).not.toContain("Coming soon to the App Store")
  })

  it("never reads or forwards the URL fragment", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8")
    expect(source).not.toMatch(/location|\.hash|window|document|use client|<script|dangerouslySet/)
  })
})

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const init = vi.hoisted(() => vi.fn())
vi.mock("posthog-js", () => ({ default: { init } }))

function setHost(host: string) {
  vi.stubGlobal("location", { ...window.location, host, hostname: host.split(":")[0] })
}

beforeEach(() => {
  init.mockClear()
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test")
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("instrumentation-client", () => {
  it("pins every init option", async () => {
    setHost("b4.run")
    const { POSTHOG_INIT_OPTIONS } = await import("../../../instrumentation-client")
    expect(POSTHOG_INIT_OPTIONS).toEqual({
      api_host: "/ingest",
      ui_host: "https://us.posthog.com",
      defaults: "2026-01-30",
      capture_pageview: "history_change",
      capture_pageleave: "if_capture_pageview",
      autocapture: true,
      capture_performance: { web_vitals: true },
      person_profiles: "identified_only",
      respect_dnt: true,
      disable_surveys: true,
      disable_session_recording: true,
    })
  })

  it("calls init on b4.run", async () => {
    setHost("b4.run")
    const { POSTHOG_INIT_OPTIONS } = await import("../../../instrumentation-client")
    expect(init).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledWith("phc_test", POSTHOG_INIT_OPTIONS)
  })

  it("does not call init on a preview host", async () => {
    setHost("b4-run-git-x.vercel.app")
    await import("../../../instrumentation-client")
    expect(init).not.toHaveBeenCalled()
  })

  it("calls init on a preview host when capture-anywhere is set", async () => {
    setHost("localhost:3000")
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_CAPTURE_ANYWHERE", "true")
    await import("../../../instrumentation-client")
    expect(init).toHaveBeenCalledTimes(1)
  })

  it("does not call init without a key", async () => {
    setHost("b4.run")
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "")
    await import("../../../instrumentation-client")
    expect(init).not.toHaveBeenCalled()
  })
})

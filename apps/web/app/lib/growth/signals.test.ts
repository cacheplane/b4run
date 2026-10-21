import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  ctor: vi.fn(),
  capture: vi.fn(),
  flush: vi.fn(async () => undefined),
}))

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(...args: unknown[]) {
      state.ctor(...args)
    }
    capture = state.capture
    flush = state.flush
  },
}))

import { createPosthogServerClient, noopSignalClient } from "./signals"

const input = {
  distinctId: "d1",
  event: "site:contact_accepted",
  properties: { form: "founder_updates", email_kind: "work" },
} as const

describe("createPosthogServerClient", () => {
  beforeEach(() => {
    state.ctor.mockClear()
    state.capture.mockReset()
    state.flush.mockClear()
  })

  it("constructs the pinned client and captures exactly the allowed properties", async () => {
    const client = createPosthogServerClient("phc_key")
    await client.capture(input)
    expect(state.ctor).toHaveBeenCalledWith("phc_key", {
      host: "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    })
    expect(state.capture).toHaveBeenCalledWith({
      distinctId: "d1",
      event: "site:contact_accepted",
      properties: {
        form: "founder_updates",
        email_kind: "work",
        $process_person_profile: false,
      },
      disableGeoip: true,
    })
    expect(state.flush).toHaveBeenCalled()
  })

  it("swallows a thrown capture", async () => {
    state.capture.mockImplementation(() => {
      throw new Error("boom")
    })
    await expect(createPosthogServerClient("k").capture(input)).resolves.toBeUndefined()
  })

  it("swallows a rejected flush", async () => {
    state.flush.mockRejectedValueOnce(new Error("net"))
    await expect(createPosthogServerClient("k").capture(input)).resolves.toBeUndefined()
  })
})

describe("noopSignalClient", () => {
  it("does nothing", async () => {
    await expect(noopSignalClient().capture(input)).resolves.toBeUndefined()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"

const post = (payload: unknown) =>
  POST(
    new Request("https://b4.run/api/signals/v1/cli", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "b4-cli" },
      body: JSON.stringify(payload),
    }),
  )

describe("POST /api/signals/v1/cli", () => {
  // Forwarding stays off whatever the developer's shell sets, so no request reaches PostHog.
  beforeEach(() => {
    vi.stubEnv("GROWTH_CLI_SIGNALS_ENABLED", "")
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("accepts a valid CLI signal with 202 and an empty body", async () => {
    const response = await post({
      schema: 1,
      usage_id: "11111111-1111-4111-8111-111111111111",
      sent_at: "2026-10-22T12:00:00.000Z",
      events: [
        {
          event: "cli:dev_first_run_completed",
          properties: { cli_version: "0.14.0", route_kind: "agent" },
        },
      ],
    })
    expect(response.status).toBe(202)
    expect(await response.text()).toBe("")
  })

  it("rejects a malformed request with 400", async () => {
    const response = await post({ schema: 2, usage_id: "x", events: [] })
    expect(response.status).toBe(400)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})

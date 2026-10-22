import { describe, expect, it, vi } from "vitest"
import {
  CLI_INGEST_MAX_BODY_BYTES,
  CLI_INGEST_MAX_EVENTS,
  type CliSignalsHandlerOptions,
  createCliSignalsHandler,
} from "./cli-ingest"

const USAGE_ID = "11111111-1111-4111-8111-111111111111"
const NOW = new Date("2026-10-22T12:00:00.000Z")

const commandCompleted = (properties: Record<string, unknown> = {}) => ({
  event: "cli:command_completed",
  properties: {
    command: "build",
    cli_version: "0.14.0",
    node_major: 24,
    os: "darwin",
    outcome: "ok",
    duration_bucket: "1s_to_10s",
    ...properties,
  },
})

const firstRun = (properties: Record<string, unknown> = {}) => ({
  event: "cli:dev_first_run_completed",
  properties: { cli_version: "0.14.0", route_kind: "graph", ...properties },
})

const body = (events: unknown[], overrides: Record<string, unknown> = {}) => ({
  schema: 1,
  usage_id: USAGE_ID,
  sent_at: "2020-01-01T00:00:00.000Z",
  events,
  ...overrides,
})

const ENABLED = {
  GROWTH_CLI_SIGNALS_ENABLED: "true",
  NEXT_PUBLIC_POSTHOG_KEY: "phc_test_key",
}

function harness(env: Record<string, string | undefined> = ENABLED) {
  const fetch = vi.fn<NonNullable<CliSignalsHandlerOptions["fetch"]>>(
    async () => new Response(null, { status: 200 }),
  )
  const tasks: Array<() => Promise<void>> = []
  const handler = createCliSignalsHandler({
    env: () => env,
    fetch,
    now: () => NOW,
    schedule: (task) => {
      tasks.push(task)
    },
  })
  const post = (payload: unknown, init: { contentType?: string; raw?: string } = {}) =>
    handler(
      new Request("https://b4.run/api/signals/v1/cli", {
        method: "POST",
        headers: { "content-type": init.contentType ?? "application/json" },
        body: init.raw ?? JSON.stringify(payload),
      }),
    )
  const runScheduled = async () => {
    for (const task of tasks.splice(0)) await task()
  }
  const forwarded = () =>
    fetch.mock.calls.map(([url, init]) => ({
      url,
      payload: JSON.parse(String(init?.body)) as {
        api_key: string
        batch: Array<{
          event: string
          distinct_id: string
          timestamp: string
          properties: Record<string, unknown>
        }>
      },
    }))
  return { post, runScheduled, forwarded, fetch, tasks }
}

describe("CLI signals ingest: accepted requests", () => {
  it("replies 202 with an empty body and forwards the event to PostHog", async () => {
    const h = harness()
    const response = await h.post(body([commandCompleted({ error_class: "B4_E1006" })]))
    expect(response.status).toBe(202)
    expect(await response.text()).toBe("")

    await h.runScheduled()
    expect(h.forwarded()).toEqual([
      {
        url: "https://us.i.posthog.com/batch/",
        payload: {
          api_key: "phc_test_key",
          batch: [
            {
              event: "cli:command_completed",
              distinct_id: USAGE_ID,
              timestamp: NOW.toISOString(),
              properties: {
                command: "build",
                cli_version: "0.14.0",
                node_major: 24,
                os: "darwin",
                outcome: "ok",
                duration_bucket: "1s_to_10s",
                error_class: "B4_E1006",
                $ip: null,
                $geoip_disable: true,
                $process_person_profile: false,
                $lib: "b4-web-cli-ingest",
              },
            },
          ],
        },
      },
    ])
  })

  it("forwards cli:dev_first_run_completed with only its two properties", async () => {
    const h = harness()
    expect((await h.post(body([firstRun()]))).status).toBe(202)
    await h.runScheduled()
    const [event] = h.forwarded()[0]?.payload.batch ?? []
    expect(event?.event).toBe("cli:dev_first_run_completed")
    expect(event?.properties).toMatchObject({ cli_version: "0.14.0", route_kind: "graph" })
    expect(Object.keys(event?.properties ?? {}).filter((key) => !key.startsWith("$"))).toEqual([
      "cli_version",
      "route_kind",
    ])
  })

  it("drops properties outside the event's allowlist", async () => {
    const h = harness()
    await h.post(body([commandCompleted({ path: "/Users/me/app", prompt: "hi", email: "a@b.c" })]))
    await h.runScheduled()
    const properties = h.forwarded()[0]?.payload.batch[0]?.properties ?? {}
    expect(properties).not.toHaveProperty("path")
    expect(properties).not.toHaveProperty("prompt")
    expect(properties).not.toHaveProperty("email")
  })

  it("lowercases the usage id and stamps the server's receipt time, not the client's sent_at", async () => {
    const h = harness()
    await h.post(body([firstRun()], { usage_id: USAGE_ID.toUpperCase().replace(/1/g, "A") }))
    await h.runScheduled()
    const event = h.forwarded()[0]?.payload.batch[0]
    expect(event?.distinct_id).toBe(USAGE_ID.replace(/1/g, "a"))
    expect(event?.timestamp).toBe(NOW.toISOString())
  })

  it("accepts up to ten events and forwards them in one batch", async () => {
    const h = harness()
    const events = Array.from({ length: CLI_INGEST_MAX_EVENTS }, () => commandCompleted())
    expect((await h.post(body(events))).status).toBe(202)
    await h.runScheduled()
    expect(h.fetch).toHaveBeenCalledTimes(1)
    expect(h.forwarded()[0]?.payload.batch).toHaveLength(10)
    expect(CLI_INGEST_MAX_EVENTS).toBe(10)
  })

  it("drops an invalid event and forwards the valid ones", async () => {
    const h = harness()
    const response = await h.post(body([commandCompleted({ command: "start" }), firstRun()]))
    expect(response.status).toBe(202)
    await h.runScheduled()
    expect(h.forwarded()[0]?.payload.batch.map((event) => event.event)).toEqual([
      "cli:dev_first_run_completed",
    ])
  })

  it("uses POSTHOG_HOST when it is set", async () => {
    const h = harness({ ...ENABLED, POSTHOG_HOST: "https://eu.i.posthog.com/" })
    await h.post(body([firstRun()]))
    await h.runScheduled()
    expect(h.forwarded()[0]?.url).toBe("https://eu.i.posthog.com/batch/")
  })
})

describe("CLI signals ingest: rejected requests", () => {
  it.each([
    ["schema is not 1", body([firstRun()], { schema: 2 })],
    ["schema is missing", body([firstRun()], { schema: undefined })],
    ["usage_id is not a UUID", body([firstRun()], { usage_id: "not-a-uuid" })],
    ["usage_id is missing", body([firstRun()], { usage_id: undefined })],
    ["an event name is unknown", body([firstRun(), { event: "cli:other", properties: {} }])],
    ["events is empty", body([])],
    ["events has more than ten entries", body(Array.from({ length: 11 }, () => firstRun()))],
    ["events is not an array", body([], { events: { event: "cli:command_completed" } })],
    ["the body is an array", [firstRun()]],
    ["the body is null", null],
    ["every event is invalid", body([commandCompleted({ outcome: "maybe" })])],
  ])("replies 400 with an empty body when %s", async (_label, payload) => {
    const h = harness()
    const response = await h.post(payload)
    expect(response.status).toBe(400)
    expect(await response.text()).toBe("")
    expect(h.tasks).toHaveLength(0)
  })

  it("replies 400 when the body is not JSON", async () => {
    const h = harness()
    expect((await h.post(undefined, { raw: "{not json" })).status).toBe(400)
  })

  it("replies 415 when the content type is not JSON", async () => {
    const h = harness()
    const response = await h.post(body([firstRun()]), { contentType: "text/plain" })
    expect(response.status).toBe(415)
    expect(h.tasks).toHaveLength(0)
  })

  it("replies 413 when the body exceeds the size cap", async () => {
    const h = harness()
    const raw = JSON.stringify(body([firstRun({ padding: "x".repeat(CLI_INGEST_MAX_BODY_BYTES) })]))
    const response = await h.post(undefined, { raw })
    expect(response.status).toBe(413)
    expect(await response.text()).toBe("")
    expect(h.tasks).toHaveLength(0)
  })
})

describe("CLI signals ingest: event validation", () => {
  it.each([
    ["command is not one of the seven", commandCompleted({ command: "start" })],
    ["outcome is out of range", commandCompleted({ outcome: "maybe" })],
    ["duration_bucket is out of range", commandCompleted({ duration_bucket: "forever" })],
    ["node_major is a string", commandCompleted({ node_major: "24" })],
    ["node_major is not an integer", commandCompleted({ node_major: 24.5 })],
    ["a string is longer than 128 characters", commandCompleted({ os: "x".repeat(129) })],
    ["error_class is not a string", commandCompleted({ error_class: 1006 })],
    ["a required property is missing", commandCompleted({ os: undefined })],
    ["route_kind is out of range", firstRun({ route_kind: "router" })],
    ["properties is not an object", { event: "cli:dev_first_run_completed", properties: [] }],
  ])("drops the event when %s", async (_label, event) => {
    const h = harness()
    await h.post(body([event, firstRun()]))
    await h.runScheduled()
    expect(h.forwarded()[0]?.payload.batch).toHaveLength(1)
  })

  it("accepts a string of exactly 128 characters", async () => {
    const h = harness()
    await h.post(body([commandCompleted({ os: "x".repeat(128) })]))
    await h.runScheduled()
    expect(h.forwarded()[0]?.payload.batch).toHaveLength(1)
  })
})

describe("CLI signals ingest: forwarding switch and failures", () => {
  it("validates but forwards nothing unless GROWTH_CLI_SIGNALS_ENABLED is true", async () => {
    for (const env of [
      { NEXT_PUBLIC_POSTHOG_KEY: "phc_test_key" },
      { ...ENABLED, GROWTH_CLI_SIGNALS_ENABLED: "1" },
      { GROWTH_CLI_SIGNALS_ENABLED: "true" },
    ]) {
      const h = harness(env)
      expect((await h.post(body([firstRun()]))).status).toBe(202)
      expect(h.tasks).toHaveLength(0)
      expect((await h.post(body([firstRun()], { schema: 2 }))).status).toBe(400)
    }
  })

  it("still replies 202 when PostHog fails, and the scheduled task never throws", async () => {
    const h = harness()
    h.fetch.mockRejectedValueOnce(new Error("ECONNRESET"))
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      expect((await h.post(body([firstRun()]))).status).toBe(202)
      await expect(h.runScheduled()).resolves.toBeUndefined()
      h.fetch.mockResolvedValueOnce(new Response("nope", { status: 500 }))
      await h.post(body([firstRun()]))
      await expect(h.runScheduled()).resolves.toBeUndefined()
      for (const call of error.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(USAGE_ID)
      }
    } finally {
      error.mockRestore()
    }
  })

  it("gives the PostHog request an abort signal", async () => {
    const h = harness()
    await h.post(body([firstRun()]))
    await h.runScheduled()
    expect(h.fetch.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})

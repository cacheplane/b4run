import { describe, expect, it } from "vitest"
import { recordingExecutor } from "./fake-executor"
import { type ParsedResendEvent, parseResendEvent, processResendEvent } from "./webhooks"

const base = (type: string, data: Record<string, unknown> = {}) => ({
  type,
  created_at: "2026-10-21T10:00:00.000Z",
  data: { email_id: "em_1", to: ["ada@example.com"], ...data },
})

describe("parseResendEvent", () => {
  it("parses email.delivered with array tags", () => {
    const event = parseResendEvent(
      base("email.delivered", {
        tags: [
          { name: "environment", value: "production" },
          { name: "step", value: "1" },
        ],
      }),
    )
    expect(event).toEqual({
      type: "email.delivered",
      occurredAt: new Date("2026-10-21T10:00:00.000Z"),
      providerEmailId: "em_1",
      to: ["ada@example.com"],
      tags: { environment: "production", step: "1" },
    })
  })

  it("parses object tags", () => {
    const event = parseResendEvent(base("email.delivered", { tags: { environment: "preview" } }))
    expect(event?.tags).toEqual({ environment: "preview" })
  })

  it("defaults tags to empty when absent", () => {
    expect(parseResendEvent(base("email.complained"))?.tags).toEqual({})
  })

  it("normalises bounce types case-insensitively", () => {
    expect(
      parseResendEvent(base("email.bounced", { bounce: { type: "Permanent" } }))?.bounceType,
    ).toBe("permanent")
    expect(
      parseResendEvent(base("email.bounced", { bounce: { type: "Transient" } }))?.bounceType,
    ).toBe("transient")
    expect(
      parseResendEvent(base("email.bounced", { bounce: { type: "Undetermined" } }))?.bounceType,
    ).toBe("unknown")
    expect(parseResendEvent(base("email.bounced"))?.bounceType).toBe("unknown")
  })

  it("omits bounceType for non-bounce events", () => {
    expect(parseResendEvent(base("email.complained"))).not.toHaveProperty("bounceType")
  })

  it("returns undefined for unsupported types and malformed shapes", () => {
    expect(parseResendEvent(base("email.opened"))).toBeUndefined()
    expect(parseResendEvent(base("email.delivered", { email_id: undefined }))).toBeUndefined()
    expect(parseResendEvent(base("email.delivered", { to: "ada@example.com" }))).toBeUndefined()
    expect(parseResendEvent({ type: "email.delivered" })).toBeUndefined()
    expect(
      parseResendEvent({
        ...base("email.delivered"),
        created_at: "not a date",
      }),
    ).toBeUndefined()
    expect(parseResendEvent(null)).toBeUndefined()
    expect(parseResendEvent("x")).toBeUndefined()
  })
})

describe("processResendEvent for the founder digest", () => {
  const digestEvent = (overrides: Partial<ParsedResendEvent>): ParsedResendEvent => ({
    type: "email.bounced",
    occurredAt: new Date("2026-10-21T10:00:00.000Z"),
    providerEmailId: "em_digest",
    to: ["founder@example.com"],
    tags: { app: "b4", environment: "production", kind: "digest" },
    bounceType: "permanent",
    ...overrides,
  })

  it.each([
    digestEvent({}),
    digestEvent({ type: "email.complained" }),
    digestEvent({ type: "email.suppressed" }),
    digestEvent({ type: "email.delivered" }),
  ])("ignores a digest $type event before any database lookup", async (event) => {
    const { executor, calls } = recordingExecutor()
    const outcome = await processResendEvent(executor, {
      event,
      environment: "production",
      emailHmacSecret: "s",
      now: new Date("2026-10-21T11:00:00.000Z"),
    })
    expect(outcome).toBe("ignored_type")
    expect(calls).toHaveLength(0)
  })

  it("still ignores another environment's digest event as an environment mismatch", async () => {
    const { executor, calls } = recordingExecutor()
    const outcome = await processResendEvent(executor, {
      event: digestEvent({ tags: { app: "b4", environment: "preview", kind: "digest" } }),
      environment: "production",
      emailHmacSecret: "s",
      now: new Date("2026-10-21T11:00:00.000Z"),
    })
    expect(outcome).toBe("ignored_environment")
    expect(calls).toHaveLength(0)
  })
})

describe("processResendEvent for an inbound forward", () => {
  // A forward goes to the founder's own mailbox; a bounce of it must never stop a contact,
  // even when the original sender is one.
  const forwardEvent = (overrides: Partial<ParsedResendEvent>): ParsedResendEvent => ({
    type: "email.bounced",
    occurredAt: new Date("2026-10-21T10:00:00.000Z"),
    providerEmailId: "em_forward",
    to: ["ada@example.com"],
    tags: { app: "b4", environment: "production", kind: "forward" },
    bounceType: "permanent",
    ...overrides,
  })

  it.each([
    forwardEvent({}),
    forwardEvent({ type: "email.complained" }),
    forwardEvent({ type: "email.suppressed" }),
    forwardEvent({ type: "email.delivered" }),
  ])("ignores a forward $type event before any database lookup", async (event) => {
    const { executor, calls } = recordingExecutor()
    const outcome = await processResendEvent(executor, {
      event,
      environment: "production",
      emailHmacSecret: "s",
      now: new Date("2026-10-21T11:00:00.000Z"),
    })
    expect(outcome).toBe("ignored_type")
    expect(calls).toHaveLength(0)
  })
})

describe("processResendEvent for another product's mail", () => {
  // The Resend account is shared, so its webhooks carry events for mail B4 never sent.
  const foreignEvent = (overrides: Partial<ParsedResendEvent>): ParsedResendEvent => ({
    type: "email.bounced",
    occurredAt: new Date("2026-10-21T10:00:00.000Z"),
    providerEmailId: "em_foreign",
    to: ["ada@example.com"],
    tags: {},
    bounceType: "permanent",
    ...overrides,
  })

  const cases = (
    ["email.bounced", "email.complained", "email.suppressed", "email.delivered"] as const
  ).flatMap((type) => [
    { label: `untagged ${type}`, event: foreignEvent({ type }) },
    {
      label: `app=threadplane ${type}`,
      event: foreignEvent({ type, tags: { app: "threadplane", environment: "production" } }),
    },
  ])

  it.each(cases)("ignores an $label event before any database lookup", async ({ event }) => {
    const { executor, calls } = recordingExecutor()
    const outcome = await processResendEvent(executor, {
      event,
      environment: "production",
      emailHmacSecret: "s",
      now: new Date("2026-10-21T11:00:00.000Z"),
    })
    expect(outcome).toBe("ignored_app")
    expect(calls).toHaveLength(0)
  })

  it("checks the app before the environment", async () => {
    const { executor, calls } = recordingExecutor()
    const outcome = await processResendEvent(executor, {
      event: foreignEvent({ tags: { environment: "preview" } }),
      environment: "production",
      emailHmacSecret: "s",
      now: new Date("2026-10-21T11:00:00.000Z"),
    })
    expect(outcome).toBe("ignored_app")
    expect(calls).toHaveLength(0)
  })
})

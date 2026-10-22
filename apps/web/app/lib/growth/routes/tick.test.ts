import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SqlExecutor } from "../database"
import type { Mailer } from "../mailer"
import type { LeasedSend, SendOutcome } from "../sequence"
import type { SequenceEnv } from "../sequence-env"

const engine = vi.hoisted(() => ({
  enroll: vi.fn(),
  lease: vi.fn(),
  send: vi.fn(),
  release: vi.fn(),
  digest: vi.fn(),
}))

vi.mock("../sequence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sequence")>()),
  enrollApprovedContacts: engine.enroll,
  leaseDueSends: engine.lease,
  authoriseAndSend: engine.send,
  releaseLeases: engine.release,
}))
vi.mock("../digest", () => ({ sendDailyDigest: engine.digest }))

import { SEND_BATCH, SEND_PACING_MS } from "../sequence"
import { loadSequenceEnv } from "../sequence-env"
import { handleTick, type TickDeps } from "./tick"

const SECRET = "cron-secret-value"
const URL_BASE = "http://localhost/api/growth/tick"
// Thursday 07:05 PDT, inside the send window.
const IN_WINDOW = new Date("2026-10-22T14:05:00.000Z")
// Thursday 09:00 PDT.
const OUT_OF_WINDOW = new Date("2026-10-22T16:00:00.000Z")
const START_AT = new Date("2026-10-20T00:00:00.000Z")

const baseEnv: SequenceEnv = {
  databaseUrl: "postgres://x",
  emailHmacSecret: "s",
  tokenKeyring: { active: { id: 1, secret: "token-secret" }, previous: [] },
  environment: "test",
  publicOrigin: "https://b4.run",
  sequenceEnabled: true,
  sequenceStartAt: START_AT,
  deliveryEnabled: true,
  resendApiKey: "re_test_key",
  cronSecret: SECRET,
  founderEmail: "brian@b4.run",
}

const executor = {} as SqlExecutor
const mailer: Mailer = { send: async () => ({ kind: "accepted", providerEmailId: "em" }) }

interface Harness {
  deps: TickDeps
  sleeps: number[]
  apiKeys: string[]
  setElapsed(fn: () => number): void
}

function harness(
  env: Partial<SequenceEnv> = {},
  options: { now?: Date; omit?: (keyof SequenceEnv)[] } = {},
): Harness {
  const sleeps: number[] = []
  const apiKeys: string[] = []
  let elapsed = () => 0
  let uuid = 0
  const merged: Record<string, unknown> = { ...baseEnv, ...env }
  for (const key of options.omit ?? []) delete merged[key]
  return {
    sleeps,
    apiKeys,
    setElapsed(fn) {
      elapsed = fn
    },
    deps: {
      cronSecret: () => merged.cronSecret as string | undefined,
      loadEnv: () => merged as unknown as SequenceEnv,
      createExecutor: () => executor,
      createMailer: (apiKey) => {
        apiKeys.push(apiKey)
        return mailer
      },
      now: () => options.now ?? IN_WINDOW,
      randomUUID: () => {
        uuid += 1
        return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`
      },
      elapsedMs: () => elapsed(),
      sleep: async (ms) => {
        sleeps.push(ms)
      },
    },
  }
}

const authorised = (secret = SECRET) =>
  new Request(URL_BASE, { headers: { authorization: `Bearer ${secret}` } })

function leased(count: number, prefix: string, leaseToken: string): LeasedSend[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    contactId: `contact-${prefix}-${index}`,
    step: 1,
    attempts: 1,
    leaseToken,
  }))
}

/** Each lease call returns the next batch, stamped with the token the tick passed in. */
function queueBatches(...sizes: number[]) {
  let call = 0
  engine.lease.mockImplementation(async (_executor, input: { leaseToken: string }) => {
    const size = sizes[call] ?? 0
    const batch = leased(size, `b${call}`, input.leaseToken)
    call += 1
    return batch
  })
}

describe("growth tick route", () => {
  beforeEach(() => {
    for (const fn of Object.values(engine)) fn.mockReset()
    engine.enroll.mockResolvedValue({ enrolled: 0 })
    engine.lease.mockResolvedValue([])
    engine.send.mockResolvedValue("sent" satisfies SendOutcome)
    engine.release.mockResolvedValue({ released: 0 })
    engine.digest.mockResolvedValue("nothing_to_report")
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("rejects a missing, wrong, or unconfigured cron secret with 401", async () => {
    const { deps } = harness()
    expect((await handleTick(new Request(URL_BASE), deps)).status).toBe(401)
    expect((await handleTick(authorised("wrong"), deps)).status).toBe(401)
    expect((await handleTick(authorised(`${SECRET}x`), deps)).status).toBe(401)
    expect(
      (await handleTick(new Request(URL_BASE, { headers: { authorization: SECRET } }), deps))
        .status,
    ).toBe(401)
    const unconfigured = harness({}, { omit: ["cronSecret"] })
    expect((await handleTick(authorised(), unconfigured.deps)).status).toBe(401)
    expect(
      (
        await handleTick(
          new Request(URL_BASE, { headers: { authorization: "Bearer " } }),
          unconfigured.deps,
        )
      ).status,
    ).toBe(401)
    expect(engine.enroll).not.toHaveBeenCalled()
    expect(engine.lease).not.toHaveBeenCalled()
    expect(engine.digest).not.toHaveBeenCalled()
  })

  it("rejects an unauthenticated call before reading the configuration", async () => {
    const h = harness()
    const loadEnv = vi.fn(() => {
      throw new Error("GROWTH_SEQUENCE_START_AT is not set")
    })
    h.deps.loadEnv = loadEnv
    expect((await handleTick(new Request(URL_BASE), h.deps)).status).toBe(401)
    expect((await handleTick(authorised("wrong"), h.deps)).status).toBe(401)
    expect(loadEnv).not.toHaveBeenCalled()
  })

  it("enrolls only when the sequence switch is on", async () => {
    engine.enroll.mockResolvedValue({ enrolled: 3 })
    const on = await handleTick(authorised(), harness().deps)
    expect(on.status).toBe(200)
    expect(engine.enroll).toHaveBeenCalledWith(executor, { startAt: START_AT, now: IN_WINDOW })
    expect(await on.json()).toMatchObject({ enrolled: 3 })

    engine.enroll.mockClear()
    const off = await handleTick(
      authorised(),
      harness({ sequenceEnabled: false }, { omit: ["sequenceStartAt"] }).deps,
    )
    expect(off.status).toBe(200)
    expect(engine.enroll).not.toHaveBeenCalled()
    expect(await off.json()).toMatchObject({ enrolled: 0 })
  })

  it("leases and sends nothing when delivery is off", async () => {
    queueBatches(2)
    const h = harness({ deliveryEnabled: false }, { omit: ["resendApiKey"] })
    const res = await handleTick(authorised(), h.deps)
    expect(res.status).toBe(200)
    expect(engine.lease).not.toHaveBeenCalled()
    expect(engine.send).not.toHaveBeenCalled()
    expect(engine.digest).not.toHaveBeenCalled()
    expect(h.apiKeys).toEqual([])
    expect(await res.json()).toMatchObject({ leased: 0, delivery: "disabled" })
  })

  it("fails with config_invalid when delivery is on but the Resend key is missing", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    queueBatches(2)
    const h = harness()
    h.deps.loadEnv = () =>
      loadSequenceEnv({
        GROWTH_DATABASE_URL: "postgres://x",
        GROWTH_EMAIL_HMAC_SECRET: "s",
        GROWTH_TOKEN_SECRET: "t",
        GROWTH_ENVIRONMENT: "test",
        GROWTH_DELIVERY_ENABLED: "true",
      } as unknown as NodeJS.ProcessEnv)
    const res = await handleTick(authorised(), h.deps)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "tick_failed" })
    expect(engine.lease).not.toHaveBeenCalled()
    expect(engine.digest).not.toHaveBeenCalled()
    const logged = stderr.mock.calls.map((call) => String(call[0])).join("")
    expect(logged).toBe("growth tick failed: config_invalid\n")
  })

  it("sends only inside the Pacific window", async () => {
    queueBatches(1)
    const outside = harness({}, { now: OUT_OF_WINDOW })
    const res = await handleTick(authorised(), outside.deps)
    expect(res.status).toBe(200)
    expect(engine.lease).not.toHaveBeenCalled()
    expect(engine.send).not.toHaveBeenCalled()
    // The digest checks its own window.
    expect(engine.digest).toHaveBeenCalledTimes(1)
    expect(await res.json()).toMatchObject({ windowOpen: false, leased: 0 })

    const inside = harness()
    const open = await handleTick(authorised(), inside.deps)
    expect(engine.send).toHaveBeenCalledTimes(1)
    expect(await open.json()).toMatchObject({ windowOpen: true, leased: 1 })
  })

  it("keeps leasing batches until nothing is due, pacing sends and digesting last", async () => {
    queueBatches(SEND_BATCH, 3)
    const order: string[] = []
    engine.enroll.mockImplementation(async () => {
      order.push("enroll")
      return { enrolled: 0 }
    })
    engine.send.mockImplementation(async () => {
      order.push("send")
      return "sent"
    })
    engine.digest.mockImplementation(async () => {
      order.push("digest")
      return "sent"
    })
    const h = harness()
    const res = await handleTick(authorised(), h.deps)
    expect(res.status).toBe(200)
    expect(engine.lease).toHaveBeenCalledTimes(3)
    const tokens = engine.lease.mock.calls.map(
      (call) => (call[1] as { leaseToken: string; limit: number }).leaseToken,
    )
    expect(new Set(tokens).size).toBe(3)
    for (const call of engine.lease.mock.calls) {
      expect(call[1]).toMatchObject({ limit: SEND_BATCH, now: IN_WINDOW })
    }
    expect(engine.send).toHaveBeenCalledTimes(SEND_BATCH + 3)
    // Paced between sends, never after the last.
    expect(h.sleeps).toEqual(Array(SEND_BATCH + 2).fill(SEND_PACING_MS))
    expect(order[0]).toBe("enroll")
    expect(order.at(-1)).toBe("digest")
    expect(h.apiKeys).toEqual(["re_test_key"])
    expect(engine.release).not.toHaveBeenCalled()
    expect(await res.json()).toEqual({
      enrolled: 0,
      leased: SEND_BATCH + 3,
      outcomes: { sent: SEND_BATCH + 3 },
      digest: "sent",
      windowOpen: true,
      delivery: "enabled",
    })
  })

  it("stops starting sends after 40 seconds and releases the unstarted leases", async () => {
    queueBatches(4, 4)
    const h = harness()
    let sends = 0
    engine.send.mockImplementation(async () => {
      sends += 1
      return "sent"
    })
    h.setElapsed(() => (sends >= 1 ? 40_001 : 0))
    const res = await handleTick(authorised(), h.deps)
    expect(res.status).toBe(200)
    expect(engine.send).toHaveBeenCalledTimes(1)
    expect(engine.lease).toHaveBeenCalledTimes(1)
    const [firstLease] = engine.lease.mock.calls
    const token = (firstLease?.[1] as { leaseToken: string } | undefined)?.leaseToken
    expect(engine.release).toHaveBeenCalledWith(executor, {
      leaseToken: token,
      ids: ["b0-1", "b0-2", "b0-3"],
    })
    expect(await res.json()).toMatchObject({ leased: 4, outcomes: { sent: 1 } })
  })

  it("starts no send once the budget passes during the pacing wait", async () => {
    queueBatches(3)
    const h = harness()
    h.setElapsed(() => (h.sleeps.length >= 1 ? 40_001 : 0))
    const res = await handleTick(authorised(), h.deps)
    expect(engine.send).toHaveBeenCalledTimes(1)
    expect(h.sleeps).toEqual([SEND_PACING_MS])
    const [firstLease] = engine.lease.mock.calls
    const token = (firstLease?.[1] as { leaseToken: string } | undefined)?.leaseToken
    expect(engine.release).toHaveBeenCalledWith(executor, {
      leaseToken: token,
      ids: ["b0-1", "b0-2"],
    })
    expect(await res.json()).toMatchObject({ leased: 3, outcomes: { sent: 1 } })
  })

  it("does not lease another batch once 40 seconds have passed", async () => {
    queueBatches(1, 1)
    const h = harness()
    let sends = 0
    engine.send.mockImplementation(async () => {
      sends += 1
      return "sent"
    })
    h.setElapsed(() => (sends >= 1 ? 40_001 : 0))
    await handleTick(authorised(), h.deps)
    expect(engine.lease).toHaveBeenCalledTimes(1)
    expect(engine.release).not.toHaveBeenCalled()
  })

  it("reports counts and never addresses", async () => {
    engine.enroll.mockResolvedValue({ enrolled: 2 })
    queueBatches(4)
    const outcomes: SendOutcome[] = ["sent", "rejected", "retry_later", "sent"]
    engine.send.mockImplementation(async () => outcomes.shift() ?? "sent")
    const res = await handleTick(authorised(), harness().deps)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      enrolled: 2,
      leased: 4,
      outcomes: { sent: 2, rejected: 1, retry_later: 1 },
      digest: "nothing_to_report",
      windowOpen: true,
      delivery: "enabled",
    })
    expect(text).not.toMatch(/@|contact-|b0-|re_test_key|00000000-/)
  })

  it("answers 500 tick_failed and logs only an error code", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    engine.enroll.mockRejectedValue(
      Object.assign(new Error("ada@example.com broke"), { code: "ECONNREFUSED" }),
    )
    const res = await handleTick(authorised(), harness().deps)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "tick_failed" })
    const logged = stderr.mock.calls.map((call) => String(call[0])).join("")
    expect(logged).toContain("econnrefused")
    expect(logged).not.toContain("ada@example.com")
  })

  it("answers 500 tick_failed when the environment cannot load", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const h = harness()
    h.deps.loadEnv = () => {
      throw new Error("GROWTH_SEQUENCE_START_AT is not set")
    }
    const res = await handleTick(authorised(), h.deps)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "tick_failed" })
  })
})

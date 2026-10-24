import { expect, test, vi } from "vitest"
import type { SqlExecutor, SqlQueryResult } from "../database"
import { createResendMailer, SENDER } from "../mailer"
import { loadSequenceEnv } from "../sequence-env"
import { handleTick, type TickDeps } from "./tick"

const NOW = new Date("2026-10-22T14:05:00.000Z")
const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  GROWTH_DATABASE_URL: "postgres://localhost/preflight-test",
  GROWTH_EMAIL_HMAC_SECRET: "preflight-hmac",
  GROWTH_TOKEN_SECRET: "preflight-token",
  GROWTH_ENVIRONMENT: "test",
  GROWTH_PUBLIC_ORIGIN: "https://b4.run",
  GROWTH_SEQUENCE_ENABLED: "true",
  GROWTH_SEQUENCE_START_AT: "2026-10-20T00:00:00Z",
  GROWTH_DELIVERY_ENABLED: "true",
  RESEND_API_KEY: "re_preflight_test",
  GROWTH_FOUNDER_EMAIL: "founder@example.com",
}

const invalidConfigurations = [
  { name: "missing sending key", override: { RESEND_API_KEY: undefined } },
  { name: "blank sending key", override: { RESEND_API_KEY: "  " } },
  { name: "insecure action origin", override: { GROWTH_PUBLIC_ORIGIN: "http://b4.run" } },
  { name: "action origin with a path", override: { GROWTH_PUBLIC_ORIGIN: "https://b4.run/path" } },
  { name: "missing token secret", override: { GROWTH_TOKEN_SECRET: undefined } },
  { name: "invalid active token key", override: { GROWTH_TOKEN_KEY_ID: "0" } },
  { name: "invalid previous token keys", override: { GROWTH_TOKEN_PREVIOUS_KEYS: "1:duplicate" } },
  { name: "missing identity secret", override: { GROWTH_EMAIL_HMAC_SECRET: undefined } },
  { name: "invalid environment", override: { GROWTH_ENVIRONMENT: "staging" } },
  { name: "missing sequence start", override: { GROWTH_SEQUENCE_START_AT: undefined } },
  { name: "invalid sequence start", override: { GROWTH_SEQUENCE_START_AT: "tomorrow" } },
] satisfies readonly { name: string; override: Partial<NodeJS.ProcessEnv> }[]

for (const { name, override } of invalidConfigurations) {
  test(`rejects ${name} before database work and permits a corrected digest`, async () => {
    let raw: NodeJS.ProcessEnv = { ...BASE, ...override }
    const statements: string[] = []
    const query = vi.fn(async (text: string): Promise<SqlQueryResult<Record<string, unknown>>> => {
      statements.push(text)
      // A newly approved contact makes the real digest path claim and send. No sequence is due.
      const rows = text.startsWith("select email, approved_at from growth_contacts")
        ? [{ email: "contact@example.com", approved_at: NOW }]
        : text.startsWith("insert into growth_activity")
          ? [{ id: "digest-claim" }]
          : []
      return { rows, rowCount: rows.length }
    })
    const runQuery: SqlExecutor["query"] = async <Row extends Record<string, unknown>>(
      text: string,
    ) => (await query(text)) as SqlQueryResult<Row>
    const transaction = vi.fn()
    const executor: SqlExecutor = {
      query: runQuery,
      transaction: (operation) => {
        transaction()
        return operation({ query: runQuery })
      },
      end: async () => undefined,
    }
    const createExecutor = vi.fn(() => executor)
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ id: "accepted-digest" }))
    const createMailer = vi.fn((key: string) => createResendMailer(key, fetchImpl))
    const deps: TickDeps = {
      cronSecret: () => "preflight-cron",
      loadEnv: () => loadSequenceEnv(raw),
      createExecutor,
      createMailer,
      inboundRuntime: () => undefined,
      now: () => NOW,
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      elapsedMs: () => 0,
      sleep: async () => undefined,
    }
    const request = () =>
      new Request("https://b4.run/api/growth/tick", {
        headers: { authorization: "Bearer preflight-cron" },
      })
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      const rejected = await handleTick(request(), deps)

      expect(rejected.status).toBe(500)
      expect(await rejected.json()).toEqual({ error: "tick_failed" })
      expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toBe(
        "growth tick failed: config_invalid\n",
      )
      expect(createExecutor).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
      expect(transaction).not.toHaveBeenCalled()
      expect(createMailer).not.toHaveBeenCalled()
      expect(fetchImpl).not.toHaveBeenCalled()

      raw = { ...BASE }
      const recovered = await handleTick(request(), deps)

      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toMatchObject({ delivery: "enabled", digest: "sent" })
      expect(createExecutor).toHaveBeenCalledOnce()
      expect(transaction).toHaveBeenCalledOnce()
      expect(
        statements.filter((sql) => sql.startsWith("insert into growth_activity")),
      ).toHaveLength(1)
      expect(fetchImpl).toHaveBeenCalledOnce()
      const [url, options] = fetchImpl.mock.calls[0] ?? []
      expect(url).toBe("https://api.resend.com/emails")
      expect(options?.headers).toMatchObject({ "Idempotency-Key": "digest:test:2026-10-22" })
      expect(JSON.parse(options?.body as string)).toMatchObject({
        from: SENDER,
        to: ["founder@example.com"],
        reply_to: SENDER,
      })
    } finally {
      stderr.mockRestore()
    }
  })
}

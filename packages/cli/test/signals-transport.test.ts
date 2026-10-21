import { afterEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_SIGNALS_URL,
  type FetchLike,
  resolveSignalsUrl,
  SIGNALS_TIMEOUT_MS,
  sendSignals,
} from "../src/lib/signals/transport.ts"

const body = {
  schema: 1 as const,
  usage_id: "11111111-1111-4111-8111-111111111111",
  sent_at: "2026-10-21T00:00:00.000Z",
  events: [
    {
      event: "cli:dev_first_run_completed" as const,
      properties: { cli_version: "0.14.0", route_kind: "graph" },
    },
  ],
}
afterEach(() => {
  vi.useRealTimers()
})

describe("resolveSignalsUrl", () => {
  it("defaults to the b4.run endpoint", () => {
    expect(resolveSignalsUrl({})).toBe(DEFAULT_SIGNALS_URL)
    expect(DEFAULT_SIGNALS_URL).toBe("https://b4.run/api/signals/v1/cli")
  })
  it("honours B4_SIGNALS_URL when it is an http(s) URL", () => {
    expect(resolveSignalsUrl({ B4_SIGNALS_URL: "http://127.0.0.1:9/x" })).toBe(
      "http://127.0.0.1:9/x",
    )
    expect(resolveSignalsUrl({ B4_SIGNALS_URL: "file:///tmp/x" })).toBe(DEFAULT_SIGNALS_URL)
    expect(resolveSignalsUrl({ B4_SIGNALS_URL: "nope" })).toBe(DEFAULT_SIGNALS_URL)
  })
})

describe("sendSignals", () => {
  it("posts JSON without credentials", async () => {
    const fetch = vi.fn<FetchLike>(async () => ({ ok: true, status: 202 }))
    await sendSignals(body, { url: "http://localhost/x", fetch })
    const call = fetch.mock.calls[0]
    if (!call) throw new Error("fetch was not called")
    const [url, init] = call
    expect(url).toBe("http://localhost/x")
    expect(init.method).toBe("POST")
    expect(init.headers["content-type"]).toBe("application/json")
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain("authorization")
    expect(JSON.parse(init.body)).toEqual(body)
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
  it("aborts the request signal once settled so an unread body is released", async () => {
    let signal: AbortSignal | undefined
    await sendSignals(body, {
      url: "http://localhost/x",
      fetch: async (_url, init) => {
        signal = init.signal
        return { ok: true, status: 202 }
      },
    })
    expect(signal?.aborted).toBe(true)
  })
  it("resolves when fetch rejects and when the response is a 404", async () => {
    await expect(
      sendSignals(body, {
        url: "http://localhost/x",
        fetch: async () => {
          throw new Error("ECONNREFUSED")
        },
      }),
    ).resolves.toBeUndefined()
    await expect(
      sendSignals(body, {
        url: "http://localhost/x",
        fetch: async () => ({ ok: false, status: 404 }),
      }),
    ).resolves.toBeUndefined()
  })
  it("resolves when fetch throws synchronously", async () => {
    await expect(
      sendSignals(body, {
        url: "http://localhost/x",
        fetch: () => {
          throw new TypeError("bad")
        },
      }),
    ).resolves.toBeUndefined()
  })
  it("gives up after the timeout when the request hangs", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason))
        }),
    )
    const pending = sendSignals(body, { url: "http://localhost/x", fetch })
    await vi.advanceTimersByTimeAsync(SIGNALS_TIMEOUT_MS + 1)
    await expect(pending).resolves.toBeUndefined()
    expect(SIGNALS_TIMEOUT_MS).toBe(3000)
  })
  it("never writes to stdout or stderr on failure", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      await sendSignals(body, {
        url: "http://localhost/x",
        fetch: async () => {
          throw new Error("x")
        },
      })
      expect(out).not.toHaveBeenCalled()
      expect(err).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    } finally {
      out.mockRestore()
      err.mockRestore()
      log.mockRestore()
    }
  })
})

import type { Browser, BrowserContext, Page } from "@playwright/test"
import { describe, expect, it, vi } from "vitest"

import {
  MEMORY_LABEL_LIMIT,
  runWorkbenchSuggestionJourneys,
  type SuggestionJourneyDeps,
  type SuggestionJourneyOptions,
  TEACH_CONTENT_SHAPE_MESSAGE,
} from "./workbench-suggestions.ts"

/**
 * The fixture's verbatim reply, CITATION INCLUDED — the journey matches it with
 * `{ exact: true }`, so a shortened copy here would let a locator that can
 * never match look proven.
 */
const PLAN_REPLY =
  "KSTP and KRST are VFR. 66 nm, 33 minutes, 5.5 gal burned, reserve about 6 hours. [poh/cruise-performance.md, Figure 5-7]"
const APPROVAL_TOOL_NAME = "fileFlightPlan"
const GATED_REPLY =
  "Recorded the flight plan at flight-plans/261006-KSTP-KRST.txt. It was not transmitted."
const TEACH_CONTENT = "N738ZU is a Cessna 172N, cruise 2400 RPM, 50 gal usable"

const baseOptions: SuggestionJourneyOptions = {
  webUrl: "http://127.0.0.1:4712",
  screenshotDir: "/tmp/shots",
  approvalToolName: APPROVAL_TOOL_NAME,
  gatedReply: GATED_REPLY,
  planReply: PLAN_REPLY,
  teachContent: TEACH_CONTENT,
}

interface WireResponse {
  readonly method: string
  readonly url: string
  readonly ok?: boolean
  readonly status?: number
  readonly body?: unknown
}

/**
 * What the browser would see on the wire during the teach journey. The reject
 * POST is a DECOY placed before the approve POST: `waitForResponse`'s predicate
 * must turn it down, which is what proves the journey is watching for approve
 * specifically rather than "any decision POST".
 */
const DEFAULT_WIRE: readonly WireResponse[] = [
  {
    method: "GET",
    url: "http://127.0.0.1:4712/api/b4/memory/candidates",
    body: { candidates: [] },
  },
  {
    method: "POST",
    url: "http://127.0.0.1:4712/api/b4/memory/candidates/cand1/reject",
    body: { ok: true },
  },
  {
    method: "POST",
    url: "http://127.0.0.1:4712/api/b4/memory/candidates/cand1/approve",
    body: {
      record: { id: "cand1", content: TEACH_CONTENT, status: "active" },
      action: "activated",
      superseded: [],
    },
  },
]

/**
 * A fake browser whose locators record every chained step as a readable
 * description, so a test can assert both WHAT was located and in what order.
 *
 * `onCall` sees each recorded call and may throw — that is how a test injects a
 * failure at one exact step (say the `Allow once` click) without teaching the
 * fake anything about journeys.
 */
function fakeBrowser(
  overrides: {
    readonly onCall?: (call: string) => void
    readonly countFor?: (desc: string) => number | undefined
    readonly candidates?: readonly { readonly content: string }[]
    readonly candidatesOk?: boolean
    readonly wire?: readonly WireResponse[]
  } = {},
) {
  const calls: string[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const record = (call: string) => {
    calls.push(call)
    overrides.onCall?.(call)
  }
  const name = (value: unknown): string =>
    value instanceof RegExp ? String(value) : JSON.stringify(value)
  // `.first()`/`.last()` narrow a locator; they do not change whether the thing
  // EXISTS, so a count override written for a locator applies to its narrowings
  // too. Without this a base count of 0 would still let `.first().waitFor()`
  // succeed, which is the hole that let a locator matching nothing look proven.
  const baseDesc = (desc: string): string => desc.replace(/ \.(first|last)$/, "")
  const countOf = (desc: string): number => {
    const base = baseDesc(desc)
    return (
      overrides.countFor?.(base) ??
      // The locators the journey expects to find NOTHING: the root tools,
      // computeNavlog and writeFile, must not be rendered inside an activity
      // card's <details>.
      (base.includes("details") && (base.includes("writeFile") || base.includes("computeNavlog"))
        ? 0
        : 1)
    )
  }

  // biome-ignore lint/suspicious/noExplicitAny: a structural stand-in for Locator.
  function locator(desc: string): any {
    return {
      getByRole: (role: string, options?: { name?: unknown }) =>
        locator(
          options?.name === undefined
            ? `${desc} > ${role}`
            : `${desc} > ${role}=${name(options.name)}`,
        ),
      getByText: (text: unknown) => locator(`${desc} > text=${name(text)}`),
      getByLabel: (label: string) => locator(`${desc} > label=${label}`),
      locator: (selector: string) => locator(`${desc} > ${selector}`),
      filter: (options: { hasText?: unknown }) =>
        locator(`${desc} | hasText=${name(options.hasText)}`),
      first: () => locator(`${desc} .first`),
      last: () => locator(`${desc} .last`),
      count: async () => {
        record(`count ${desc}`)
        return countOf(desc)
      },
      // A click and a visibility wait on a locator that matches NOTHING must
      // fail the way Playwright fails — by exhausting the timeout — or "this
      // button does not exist" is unrepresentable and every ordering assertion
      // in this file is decorative. Recorded before throwing, because
      // Playwright would have attempted it too.
      click: async (options?: { timeout?: number }) => {
        record(`click ${desc}`)
        if (countOf(desc) === 0) {
          throw new Error(
            `locator.click: Timeout ${options?.timeout ?? 30_000}ms exceeded.\nwaiting for ${desc}`,
          )
        }
      },
      waitFor: async (options: { state: string; timeout?: number }) => {
        record(`waitFor:${options.state} ${desc}`)
        // Only `visible` — a locator that matches nothing IS hidden.
        if (options.state === "visible" && countOf(desc) === 0) {
          throw new Error(
            `locator.waitFor: Timeout ${options.timeout ?? 30_000}ms exceeded.\nwaiting for ${desc} to be visible`,
          )
        }
      },
    }
  }

  const wireResponse = (wire: WireResponse) => ({
    url: () => wire.url,
    request: () => ({ method: () => wire.method }),
    ok: () => wire.ok !== false,
    status: () => wire.status ?? (wire.ok === false ? 500 : 200),
    json: async () => wire.body,
  })

  const page = {
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener)
    }),
    screenshot: vi.fn(async (options: { path: string }) => {
      calls.push(`screenshot ${options.path}`)
    }),
    getByRole: (role: string, options?: { name?: unknown }) =>
      locator(
        options?.name === undefined ? `page > ${role}` : `page > ${role}=${name(options.name)}`,
      ),
    getByText: (text: unknown) => locator(`page > text=${name(text)}`),
    getByLabel: (label: string) => locator(`page > label=${label}`),
    locator: (selector: string) => locator(`page > ${selector}`),
    // biome-ignore lint/suspicious/noExplicitAny: a structural stand-in for Response.
    waitForResponse: vi.fn(async (predicate: (response: any) => boolean) => {
      record("waitForResponse")
      const match = (overrides.wire ?? DEFAULT_WIRE).find((wire) => predicate(wireResponse(wire)))
      if (match === undefined) throw new Error("Timeout waiting for a matching response")
      return wireResponse(match)
    }),
    request: {
      get: vi.fn(async (url: string) => {
        calls.push(`GET ${url}`)
        return {
          ok: () => overrides.candidatesOk !== false,
          status: () => (overrides.candidatesOk === false ? 500 : 200),
          json: async () => ({ candidates: overrides.candidates ?? [] }),
        }
      }),
    },
  } as unknown as Page
  const context = {
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {
      calls.push("context.close")
    }),
  } as unknown as BrowserContext
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {
      calls.push("browser.close")
    }),
  } as unknown as Browser
  const chromium = { launch: vi.fn(async () => browser) }
  const journey = {
    openReadyWorkbench: vi.fn(async () => {
      calls.push("open")
    }),
    waitForWorkbenchRunCompletion: vi.fn(async () => {
      record("complete")
    }),
  } as unknown as NonNullable<SuggestionJourneyDeps["journey"]>
  const deps: SuggestionJourneyDeps = { chromium, journey }
  const emitConsoleError = (text: string) => {
    listeners.get("console")?.({
      type: () => "error",
      text: () => text,
      location: () => ({ url: "" }),
    })
  }
  return { calls, chromium, deps, journey, page, emitConsoleError }
}

/** Returns the error a call rejected with, failing if it resolved instead. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the call to reject, but it resolved")
}

/**
 * Every locator the three journeys touch, in order.
 *
 * Pinned as ONE array on purpose. Asserting only "the Allow once click
 * happened" leaves the assertions most likely to drift against the template —
 * the plan-card summary, the subagent card, the writeFile card — deletable with
 * every test still green. A golden list makes any locator change, deletion or
 * reordering show up as a diff a reviewer has to look at.
 */
const GOLDEN_CALLS: readonly string[] = [
  "open",
  // Plan a flight
  'click page > button="+ New conversation"',
  "click page > button=/^Plan a flight/",
  "complete",
  'waitFor:visible page > main > details | hasText="Plan · 1/4 complete" .first',
  'count page > main > details | hasText="Plan · 1/4 complete"',
  'waitFor:visible page > main > details | hasText="performance · completed" .first',
  'count page > main > details | hasText="performance · completed"',
  'waitFor:visible page > main > details | hasText="performance · completed" > text=/performance · completed · 1 tool/',
  'click page > main > details | hasText="performance · completed" > summary',
  'waitFor:visible page > main > details[open] | hasText="performance · completed"',
  'waitFor:visible page > main > details | hasText="performance · completed" > label=Subagent tools > text="readDoc"',
  'waitFor:visible page > main > text="computeNavlog" .first',
  'count page > main > text="computeNavlog"',
  'count page > main > details > text="computeNavlog"',
  'waitFor:visible page > main > text="writeFile" .first',
  'count page > main > text="writeFile"',
  'count page > main > details > text="writeFile"',
  `waitFor:visible page > main > text=${JSON.stringify(PLAN_REPLY)} .first`,
  `count page > main > text=${JSON.stringify(PLAN_REPLY)}`,
  // File the plan
  'click page > button="+ New conversation"',
  "click page > button=/^File the plan/",
  `waitFor:visible page > alert | hasText=${JSON.stringify(APPROVAL_TOOL_NAME)} .first`,
  `count page > alert | hasText=${JSON.stringify(APPROVAL_TOOL_NAME)}`,
  `click page > alert | hasText=${JSON.stringify(APPROVAL_TOOL_NAME)} > button="Allow once"`,
  `waitFor:hidden page > alert | hasText=${JSON.stringify(APPROVAL_TOOL_NAME)}`,
  "complete",
  `waitFor:visible page > main > text=${JSON.stringify(GATED_REPLY)} .first`,
  `count page > main > text=${JSON.stringify(GATED_REPLY)}`,
  // Teach it the aircraft
  'click page > button="+ New conversation"',
  "click page > button=/^Teach it the aircraft/",
  "complete",
  `waitFor:visible page > label=Memory candidates > text=${JSON.stringify(TEACH_CONTENT)}`,
  "waitForResponse",
  `click page > label=Memory candidates > button=${JSON.stringify(`Approve: ${TEACH_CONTENT}`)}`,
  `waitFor:hidden page > label=Memory candidates > text=${JSON.stringify(TEACH_CONTENT)}`,
  "GET http://127.0.0.1:4712/api/b4/memory/candidates",
  "context.close",
  "browser.close",
]

describe("runWorkbenchSuggestionJourneys", () => {
  it("drives every journey's locators in order, in one browser", async () => {
    const { calls, chromium, deps, journey } = fakeBrowser()
    await runWorkbenchSuggestionJourneys(baseOptions, deps)

    expect(calls).toEqual(GOLDEN_CALLS)
    expect(chromium.launch).toHaveBeenCalledTimes(1)
    expect(journey.openReadyWorkbench).toHaveBeenCalledTimes(1)
  })

  it("starts each of the three journeys from a new conversation", async () => {
    const { calls, deps } = fakeBrowser()
    await runWorkbenchSuggestionJourneys(baseOptions, deps)
    const starts = calls.filter(
      (call) =>
        call.startsWith("click ") &&
        (call.includes('button="+ New conversation"') || call.includes("button=/^")),
    )
    expect(starts).toEqual([
      'click page > button="+ New conversation"',
      "click page > button=/^Plan a flight/",
      'click page > button="+ New conversation"',
      "click page > button=/^File the plan/",
      'click page > button="+ New conversation"',
      "click page > button=/^Teach it the aircraft/",
    ])
  })

  it("fails with Playwright's own message when the create button is missing", async () => {
    // The rail's create button is `+ New conversation`; the bare string is the
    // UNTITLED ROW's label. Dropping the plus must not stay green.
    const { deps } = fakeBrowser({
      countFor: (desc) => (desc.includes('button="+ New conversation"') ? 0 : undefined),
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^Plan a flight: locator\.click: Timeout 45000ms/)
    expect(rejection.message).toContain('button="+ New conversation"')
  })

  it("fails when a suggestion button is missing", async () => {
    const { deps } = fakeBrowser({
      countFor: (desc) => (desc.includes("Teach it the aircraft") ? 0 : undefined),
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^Teach it the aircraft: locator\.click: Timeout 45000ms/)
  })

  it("fails when a second plan card is rendered in the same thread", async () => {
    const { deps } = fakeBrowser({
      countFor: (desc) => (desc.includes("Plan · 1/4 complete") ? 2 : undefined),
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^Plan a flight: expected exactly one plan card/)
    expect(rejection.message).toContain("found 2")
  })

  it("fails when a second performance subagent card is rendered", async () => {
    const { deps } = fakeBrowser({
      countFor: (desc) =>
        desc.includes("performance · completed") && desc.endsWith('"performance · completed"')
          ? 2
          : undefined,
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/expected exactly one performance subagent card/)
  })

  it("fails when the assistant reply is rendered twice", async () => {
    // Playwright's text engine already drops an ancestor whose child matches,
    // so a second match means a second MESSAGE — the duplicate-emit regression
    // a `.last()` here would have hidden.
    const { deps } = fakeBrowser({
      countFor: (desc) => (desc.includes(PLAN_REPLY) ? 2 : undefined),
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^Plan a flight: expected exactly one assistant reply/)
    expect(rejection.message).toContain("found 2")
  })

  it("fails when the gated reply is rendered twice", async () => {
    const { deps } = fakeBrowser({
      countFor: (desc) => (desc.includes(GATED_REPLY) ? 2 : undefined),
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^File the plan: expected exactly one gated reply/)
  })

  it("fails when writeFile is rendered inside an activity card", async () => {
    const { deps } = fakeBrowser({
      countFor: (desc) => (desc.includes("details") && desc.includes("writeFile") ? 1 : undefined),
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/expected no writeFile inside an activity card/)
  })

  it("fails when computeNavlog is rendered inside an activity card", async () => {
    const { deps } = fakeBrowser({
      countFor: (desc) =>
        desc.includes("details") && desc.includes("computeNavlog") ? 1 : undefined,
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/expected no computeNavlog inside an activity card/)
  })

  it("watches for the approve POST specifically, turning down the reject POST", async () => {
    const { deps } = fakeBrowser({
      wire: [
        {
          method: "POST",
          url: "http://127.0.0.1:4712/api/b4/memory/candidates/cand1/reject",
          body: { ok: true },
        },
      ],
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^Teach it the aircraft: Timeout waiting for a matching/)
  })

  it("fails when the approve response does not carry the candidate as an active record", async () => {
    const { deps } = fakeBrowser({
      wire: [
        {
          method: "POST",
          url: "http://127.0.0.1:4712/api/b4/memory/candidates/cand1/approve",
          body: { record: { content: TEACH_CONTENT, status: "candidate" } },
        },
      ],
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/approved record is 'candidate', not 'active'/)
  })

  it("fails when the approved candidate is still listed over HTTP", async () => {
    const { deps } = fakeBrowser({ candidates: [{ content: TEACH_CONTENT }] })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^Teach it the aircraft: approved candidate is still listed/)
  })

  it("rejects a teachContent longer than the panel's label limit, before launching", async () => {
    const { deps, chromium } = fakeBrowser()
    await expect(
      runWorkbenchSuggestionJourneys(
        { ...baseOptions, teachContent: "a".repeat(MEMORY_LABEL_LIMIT + 1) },
        deps,
      ),
    ).rejects.toThrow(TEACH_CONTENT_SHAPE_MESSAGE)
    expect(chromium.launch).not.toHaveBeenCalled()
  })

  it("rejects a multi-line teachContent, before launching", async () => {
    const { deps, chromium } = fakeBrowser()
    await expect(
      runWorkbenchSuggestionJourneys(
        { ...baseOptions, teachContent: "Brian prefers\nconcise answers" },
        deps,
      ),
    ).rejects.toThrow(TEACH_CONTENT_SHAPE_MESSAGE)
    expect(chromium.launch).not.toHaveBeenCalled()
  })

  it("names the failing journey and screenshots under that journey's own name", async () => {
    const { calls, deps } = fakeBrowser({
      onCall: (call) => {
        if (call.includes("Allow once")) throw new Error("the gate never resolved")
      },
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^File the plan: the gate never resolved/)
    expect(calls).toContain("screenshot /tmp/shots/workbench-browser-gate.png")
    expect(calls).not.toContain("screenshot /tmp/shots/workbench-browser-teach.png")
  })

  it("stops the run when the first journey fails, never reaching the second suggestion", async () => {
    const { calls, deps } = fakeBrowser({
      onCall: (call) => {
        if (call.includes(PLAN_REPLY)) throw new Error("the report never rendered")
      },
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, deps))
    expect(rejection.message).toMatch(/^Plan a flight: the report never rendered/)
    expect(calls.some((call) => call.includes("File the plan"))).toBe(false)
    expect(calls).toContain("screenshot /tmp/shots/workbench-browser-plan.png")
  })

  it("reports a console error from the first journey against that journey", async () => {
    const fake = fakeBrowser()
    let emitted = false
    // The first run completion is the plan journey's; emit there so the
    // error is collected well before the gate and teach journeys run.
    vi.mocked(fake.journey.waitForWorkbenchRunCompletion).mockImplementation(async () => {
      if (!emitted) {
        emitted = true
        fake.emitConsoleError("Hydration failed")
      }
    })
    const rejection = await rejectionOf(runWorkbenchSuggestionJourneys(baseOptions, fake.deps))
    expect(rejection.message).toMatch(/^Plan a flight: Workbench console errors/)
    expect(rejection.message).toContain("Hydration failed")
    expect(fake.calls).toContain("screenshot /tmp/shots/workbench-browser-plan.png")
    expect(fake.calls.some((call) => call.includes("Teach it the aircraft"))).toBe(false)
  })
})

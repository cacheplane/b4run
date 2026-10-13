# Navlog Forecast Facts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every deterministic weather fact in the navlog example comes out of tested code inside `computeNavlog`: forecast coverage, flight category at a time, advisory relevance, the verdict floor and winds per leg. The coordinator narrates those facts, and the web renders them.

**Architecture:**
- Pure rules live in `examples/navlog/server/src/lib/forecast/`, and the AWC fetch helpers move there out of the tool files.
- The `computeNavlog` tool times the legs in two passes, fetches each leg's winds at the time that leg is flown, and returns `Navlog & { forecast }`.
- The weather subagent is deleted.
- The web reads `forecast` from the `computeNavlog` result and stops parsing prose.

**Tech Stack:** TypeScript (NodeNext ESM), B4.run tools and agent routes, vitest, Next.js/React (web), aviationweather.gov Data API via the cached `AwcClient`.

**Spec:** `docs/superpowers/specs/2026-10-12-navlog-forecast-facts-design.md`

## Global Constraints

- Every file under `examples/navlog/{server,web}` is mirrored byte-for-byte into `packages/devkit/templates/app-navlog/{server,web}`.
  - Test files there carry a `.template` suffix (`x.test.ts` → `x.test.ts.template`), and eval files do too (`x.eval.ts` → `x.eval.ts.template`).
  - `packages/devkit/test/templates.test.ts` pins the web `.test.ts.template` count (currently 34) and the `.test.tsx.template` count (currently 24). Update them when web test files are added or removed.
  - Server test files are not count-pinned.
- Server `src/` imports siblings with `.js`; server `test/` imports with `.ts` (for example `../src/lib/forecast/coverage.ts`).
- `exactOptionalPropertyTypes` is on. Never assign `{ x: undefined }` to an optional field; use `...(x !== undefined ? { x } : {})`.
- Lint with `pnpm lint` from the package directory, or `pnpm exec biome check --config-path ../../../packages/config-biome/biome.json <files>`. Never run bare `biome check --write` from the repo root.
- Run every command under Node 24: `source ~/.nvm/nvm.sh && nvm use 24`.
- Models in examples and docs are gpt-5-family only. The routes keep `gpt-5-mini`.
- Changesets are `patch` only, in the fixed group (`@b4run/devkit` and `create-b4-app` for template changes).
- Any `apps/web/content` edit needs `pnpm --dir apps/web seo:lastmod` run after its commit, and the regenerated manifest committed.
- Moving or removing template files breaks `docs/brand/demo/demo.test.mjs` and `docs/brand/demo-rag/overlay.mjs` (its REMOVED and EDITS lists). Run `pnpm test:brand-demo` and `node --test docs/brand/demo-rag/demo-rag.test.mjs` after each such move.
- The "preliminary" definition is fixed by the spec. Preliminary is true when any of these holds:
  - the origin TAF does not cover the departure instant;
  - the destination TAF does not cover the ETA;
  - a leg's flying interval `[start, end]` is not inside the union of the published winds-aloft FOR USE windows.

  An airport that issues no TAF at all is a note, not preliminary.

## Review Focus

These are the inputs the spec implies most likely to bite a user without any task's main tests reaching them. Each is pinned by a test in the task named.

1. **Out-and-back route with a repeated waypoint (KPAO → KHAF → KPAO).** Leg intervals must still map rows to the right legs. The test is in Task 5 (`legIntervals`).
2. **The destination is a navaid, or a waypoint has no METAR/TAF station.** The forecast must still build: `metar` and `taf` are null, and that waypoint adds no coverage reason. The test is in Task 5.
3. **AWC returns an empty winds product, or the leg's nearest station is missing from it.** The leg falls back to the next-nearest station that is in the product (test in Task 4). With no usable station, `computeNavlog` throws a named error rather than computing with zero wind (test in Task 6).
4. **A departure given as a bare clock time ("1400Z") rather than an ISO instant.** The two-pass timing must resolve it once, through `parseUtcInstant`, so both passes use the same instant. The test is in Task 6.
5. **The model raises the BottomLine above the floor (CAUTION floor, NO-GO answer).** The web must show NO-GO with no "raised" note, because only a raise from below the floor is noted. The test is in Task 10.

---

## PR 1: Pure rules and station data (nothing user-facing)

Branch: `git switch -c blove/navlog-forecast-rules origin/main` (in a worktree; see AGENTS.md).

### Task 1: Forecast types and `categoryAt`

**Files:**
- Create: `examples/navlog/server/src/lib/forecast/types.ts`
- Create: `examples/navlog/server/src/lib/forecast/taf.ts`
- Modify: `examples/navlog/server/src/tools/getTaf.ts` (re-export the moved types and parsing; behaviour unchanged)
- Test: `examples/navlog/server/test/forecast-category.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `Category`, `VerdictLevel`, `LegWind`, `AirportWeather`, `AdvisoryFact`, `Coverage`, `VerdictFloor`, `Forecast`, `TimeWindow`.
  - `taf.ts`: `TafPeriod`, `Taf`, `toTaf(record: AwcTaf): Taf`, `fetchTafs(ids: readonly string[], signal?: AbortSignal): Promise<Taf[]>`, `categoryAt(taf: Taf, atMs: number, window: TimeWindow): Category | null`, `worstCategory(a: Category | null, b: Category | null): Category | null`.

- [ ] **Step 1: Write the types**

Create `examples/navlog/server/src/lib/forecast/types.ts`:

```ts
/**
 * The facts computeNavlog returns about the weather for one planned flight.
 * Every field is computed in code from aviationweather.gov data at the times
 * the navlog flies, so the planner narrates them and the Workbench renders
 * them; nothing here is a model's reading.
 */
import type { FlightCategory } from "../flight-category.js"

export type Category = FlightCategory
export type VerdictLevel = "GO" | "CAUTION" | "NO-GO"

/** An interval in epoch milliseconds, [fromMs, toMs). */
export interface TimeWindow {
  readonly fromMs: number
  readonly toMs: number
}

/** The wind the navlog used for one leg, and the forecast it came from. */
export interface LegWind {
  /** 1-based, in route order. */
  readonly leg: number
  /** The FB winds-aloft station id, e.g. "PDX". */
  readonly station: string
  readonly altitudeFt: number
  readonly dirDegTrue: number
  readonly speedKt: number
  readonly tempC: number | null
  readonly forUseFromUtc: string
  readonly forUseToUtc: string
  /** The leg's whole flying interval lies inside the published FOR USE windows. */
  readonly covered: boolean
}

export interface AirportWeather {
  readonly id: string
  readonly role: "origin" | "en-route" | "destination"
  /** Distance along the route from the origin, whole nm. */
  readonly alongNm: number
  /** When the flight is there: the departure, the pass time, or the ETA. */
  readonly atUtc: string
  readonly metar: {
    readonly raw: string
    readonly category: Category | null
    readonly observedAt: string
  } | null
  readonly taf: { readonly raw: string; readonly validToUtc: string } | null
  readonly categoryNow: Category | null
  /** Null when there is no TAF, or the TAF does not reach atUtc. */
  readonly categoryAtTime: Category | null
  /** The highest gust in the METAR or in a TAF period overlapping the flight window. */
  readonly gustKt: number | null
}

export interface AdvisoryFact {
  readonly product: "G-AIRMET" | "AIRMET" | "SIGMET"
  /** The AWC hazard code: ICE, FZLVL, M_FZLVL, TURB-LO, TURB-HI, LLWS, IFR, MT_OBSC, CONVECTIVE, … */
  readonly hazard: string
  readonly lowestFt: number | null
  readonly highestFt: number | null
  readonly validFromUtc: string | null
  readonly validToUtc: string | null
  readonly relevance: "during-flight" | "before-departure" | "after-arrival"
}

export interface Coverage {
  readonly preliminary: boolean
  /** Each gap, named: "the KBDN TAF ends 1200Z, before the 1315Z ETA". */
  readonly reasons: readonly string[]
}

export interface VerdictFloor {
  readonly level: VerdictLevel
  /** NO-GO reasons first, then CAUTION reasons; empty for GO. */
  readonly reasons: readonly string[]
}

export interface Forecast {
  /** One per leg, in order. The navlog's legs use these winds. */
  readonly winds: readonly LegWind[]
  /** Origin, then en-route stations by alongNm, then destination. */
  readonly airports: readonly AirportWeather[]
  readonly advisories: readonly AdvisoryFact[]
  readonly coverage: Coverage
  readonly verdictFloor: VerdictFloor
  /** Facts the brief should mention that change no level, e.g. "No TAF issued for KTTD". */
  readonly notes: readonly string[]
}
```

- [ ] **Step 2: Write the failing test for `categoryAt`**

Create `examples/navlog/server/test/forecast-category.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { categoryAt, type Taf, worstCategory } from "../src/lib/forecast/taf.ts"

const ms = (iso: string): number => Date.parse(iso)
const window = (from: string, to: string) => ({ fromMs: ms(from), toMs: ms(to) })

const TAF: Taf = {
  id: "KBDN",
  issuedAt: "2026-10-12T11:21:00.000Z",
  validFromUtc: "2026-10-12T12:00:00.000Z",
  validToUtc: "2026-10-13T12:00:00.000Z",
  raw: "TAF KBDN …",
  periods: [
    { change: "BASE", fromUtc: "2026-10-12T12:00:00.000Z", toUtc: "2026-10-12T19:00:00.000Z", flightCategory: "VFR" },
    { change: "FM", fromUtc: "2026-10-12T19:00:00.000Z", toUtc: "2026-10-13T05:00:00.000Z", flightCategory: "MVFR" },
    { change: "TEMPO", fromUtc: "2026-10-12T22:00:00.000Z", toUtc: "2026-10-13T01:00:00.000Z", flightCategory: "IFR" },
    { change: "FM", fromUtc: "2026-10-13T05:00:00.000Z", toUtc: "2026-10-13T12:00:00.000Z", flightCategory: "VFR" },
  ],
}

describe("categoryAt", () => {
  it("reads the BASE or FM period that contains the time", () => {
    expect(categoryAt(TAF, ms("2026-10-12T15:00:00Z"), window("2026-10-12T14:00:00Z", "2026-10-12T15:00:00Z"))).toBe("VFR")
    expect(categoryAt(TAF, ms("2026-10-12T20:00:00Z"), window("2026-10-12T19:30:00Z", "2026-10-12T20:00:00Z"))).toBe("MVFR")
  })

  it("is made worse by a TEMPO overlapping the flight window", () => {
    expect(categoryAt(TAF, ms("2026-10-12T21:00:00Z"), window("2026-10-12T20:00:00Z", "2026-10-12T22:30:00Z"))).toBe("IFR")
  })

  it("ignores a TEMPO that ends exactly when the window opens", () => {
    expect(categoryAt(TAF, ms("2026-10-13T02:00:00Z"), window("2026-10-13T01:00:00Z", "2026-10-13T02:00:00Z"))).toBe("MVFR")
  })

  it("is null when no period contains the time", () => {
    expect(categoryAt(TAF, ms("2026-10-13T13:00:00Z"), window("2026-10-13T12:30:00Z", "2026-10-13T13:00:00Z"))).toBeNull()
  })

  it("is null for a period with no category", () => {
    const blank: Taf = { ...TAF, periods: [{ change: "BASE", fromUtc: TAF.validFromUtc, toUtc: TAF.validToUtc }] }
    expect(categoryAt(blank, ms("2026-10-12T15:00:00Z"), window("2026-10-12T14:00:00Z", "2026-10-12T15:00:00Z"))).toBeNull()
  })
})

describe("worstCategory", () => {
  it("ranks LIFR worst and ignores null", () => {
    expect(worstCategory("VFR", "MVFR")).toBe("MVFR")
    expect(worstCategory("LIFR", "IFR")).toBe("LIFR")
    expect(worstCategory(null, "VFR")).toBe("VFR")
    expect(worstCategory(null, null)).toBeNull()
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-category.test.ts`
Expected: FAIL, because it cannot resolve `../src/lib/forecast/taf.ts`.

- [ ] **Step 4: Move the TAF parsing into `lib/forecast/taf.ts` and add `categoryAt`**

Create `examples/navlog/server/src/lib/forecast/taf.ts` by moving, unchanged, from `src/tools/getTaf.ts`:
- the `AwcTafPeriod` and `AwcTaf` interfaces;
- the `TafPeriod` and `Taf` interfaces;
- the `iso`, `CHANGES`, `visibility`, `ceiling` and `period` helpers.

Export `AwcTaf`. Then add:

```ts
import { awc } from "../awc.js"
import type { Category, TimeWindow } from "./types.js"

/** A Taf from AWC's JSON record. */
export function toTaf(record: AwcTaf): Taf {
  return {
    id: record.icaoId,
    issuedAt: record.issueTime ?? "",
    validFromUtc: iso(record.validTimeFrom),
    validToUtc: iso(record.validTimeTo),
    periods: (record.fcsts ?? []).map(period),
    raw: record.rawTAF,
  }
}

/** The current TAFs for some stations, through the shared cached client. */
export async function fetchTafs(ids: readonly string[], signal?: AbortSignal): Promise<Taf[]> {
  if (ids.length === 0) return []
  const query = ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcTaf[]>("taf", { ids: query }, signal)
  return records.map(toTaf)
}

const RANK: Readonly<Record<Category, number>> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 }

/** The worse of two categories; null only when both are. */
export function worstCategory(a: Category | null, b: Category | null): Category | null {
  if (a === null) return b
  if (b === null) return a
  return RANK[a] >= RANK[b] ? a : b
}

/**
 * The flight category a TAF forecasts at `atMs`: the BASE or FM period whose
 * [fromUtc, toUtc) contains it (a later FM supersedes), made worse by any
 * TEMPO, BECMG or PROB period overlapping `window`. Null when no prevailing
 * period contains the time or it carries no category.
 */
export function categoryAt(taf: Taf, atMs: number, window: TimeWindow): Category | null {
  let base: TafPeriod | undefined
  for (const p of taf.periods) {
    if (p.change !== "BASE" && p.change !== "FM") continue
    if (Date.parse(p.fromUtc) <= atMs && atMs < Date.parse(p.toUtc)) base = p
  }
  if (base?.flightCategory === undefined) return null
  let category: Category = base.flightCategory
  for (const p of taf.periods) {
    if (p.change === "BASE" || p.change === "FM" || p.flightCategory === undefined) continue
    const overlaps = Date.parse(p.fromUtc) < window.toMs && Date.parse(p.toUtc) > window.fromMs
    if (overlaps) category = worstCategory(category, p.flightCategory) as Category
  }
  return category
}
```

Rewrite `src/tools/getTaf.ts` to keep its exports and behaviour while delegating to the lib:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { fetchTafs, type Taf } from "../lib/forecast/taf.js"

export type { Taf, TafPeriod } from "../lib/forecast/taf.js"

/**
 * Current TAF for one or more stations: validity, each forecast group with its
 * decoded UTC window and flight category, and the raw forecast text.
 */
export default async (
  input: { readonly ids: readonly string[] },
  ctx: B4ToolContext,
): Promise<Taf[]> => fetchTafs(input.ids, ctx.signal)

export const display = {
  icon: "web",
  running: ({ ids }) => `Fetching TAFs for ${ids.join(", ").toUpperCase()}`,
  done: (_input, tafs) => `Fetched ${tafs.length} TAF${tafs.length === 1 ? "" : "s"}`,
} satisfies ToolDisplay<{ readonly ids: readonly string[] }, Taf[]>
```

- [ ] **Step 5: Run the new test and the existing weather tests**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-category.test.ts test/weather-tools.test.ts && pnpm exec tsc -p . --noEmit`
Expected: PASS and no type errors. `weather-tools.test.ts` still covers `getTaf`'s output unchanged.

- [ ] **Step 6: Commit**

```bash
git add examples/navlog/server/src/lib/forecast examples/navlog/server/src/tools/getTaf.ts examples/navlog/server/test/forecast-category.test.ts
git commit -m "navlog-server: forecast types and categoryAt in lib/forecast"
```

### Task 2: `coverage` and `advisoryRelevance`

**Files:**
- Create: `examples/navlog/server/src/lib/forecast/coverage.ts`
- Create: `examples/navlog/server/src/lib/forecast/advisories.ts`
- Modify: `examples/navlog/server/src/tools/getAdvisories.ts` (delegate the fetch to the lib; behaviour unchanged)
- Test: `examples/navlog/server/test/forecast-coverage.test.ts`
- Test: `examples/navlog/server/test/forecast-advisories.test.ts`

**Interfaces:**
- Consumes: `TimeWindow` and `Coverage` from Task 1.
- Produces:
  - `coverage.ts`:
    - `hhmmZ(ms: number): string`;
    - `coverage(input: CoverageInput): Coverage`, where `CoverageInput = { departureMs: number; etaMs: number; origin: { id: string; taf: { validFromUtc: string; validToUtc: string } | null }; destination: same shape; legs: readonly { leg: number; startMs: number; endMs: number }[]; windWindows: readonly TimeWindow[] }`.
  - `advisories.ts`:
    - `Advisory` (moved from the tool);
    - `fetchAdvisoriesNear(points: readonly { lat: number; lon: number }[], signal?: AbortSignal): Promise<Advisory[]>`;
    - `altitudeFt(text: string | undefined): number | null`;
    - `advisoryRelevance(validFromMs: number | null, validToMs: number | null, departureMs: number, etaMs: number): AdvisoryFact["relevance"]`;
    - `toAdvisoryFact(advisory: Advisory, departureMs: number, etaMs: number): AdvisoryFact`.

- [ ] **Step 1: Write the failing coverage test**

Create `examples/navlog/server/test/forecast-coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { coverage } from "../src/lib/forecast/coverage.ts"

const ms = (iso: string): number => Date.parse(iso)
const taf = (from: string, to: string) => ({ validFromUtc: from, validToUtc: to })
// The FB products' FOR USE windows on 2026-10-12: 6-hour 1400–2100Z, 12-hour 2100–0600Z, 24-hour 0600–1800Z.
const WINDS = [
  { fromMs: ms("2026-10-12T14:00:00Z"), toMs: ms("2026-10-12T21:00:00Z") },
  { fromMs: ms("2026-10-12T21:00:00Z"), toMs: ms("2026-10-13T06:00:00Z") },
  { fromMs: ms("2026-10-13T06:00:00Z"), toMs: ms("2026-10-13T18:00:00Z") },
]
const base = {
  departureMs: ms("2026-10-12T20:00:00Z"),
  etaMs: ms("2026-10-12T21:02:00Z"),
  origin: { id: "KPDX", taf: taf("2026-10-12T18:00:00Z", "2026-10-13T18:00:00Z") },
  destination: { id: "KBDN", taf: taf("2026-10-12T18:00:00Z", "2026-10-13T18:00:00Z") },
  legs: [{ leg: 1, startMs: ms("2026-10-12T20:00:00Z"), endMs: ms("2026-10-12T21:02:00Z") }],
  windWindows: WINDS,
}

describe("coverage", () => {
  it("KPDX → KBDN departing 2000Z is covered: the 2100–2102Z tail falls in the next product's window", () => {
    expect(coverage(base)).toEqual({ preliminary: false, reasons: [] })
  })

  it("names a leg that ends after every winds window", () => {
    const late = { ...base, legs: [{ leg: 1, startMs: ms("2026-10-13T17:30:00Z"), endMs: ms("2026-10-13T18:18:00Z") }] }
    expect(coverage(late)).toEqual({
      preliminary: true,
      reasons: ["winds for leg 1 are forecast until 1800Z; the leg ends 1818Z"],
    })
  })

  it("names a leg that starts before the earliest winds window", () => {
    const early = { ...base, legs: [{ leg: 1, startMs: ms("2026-10-12T13:30:00Z"), endMs: ms("2026-10-12T14:30:00Z") }] }
    expect(coverage(early).reasons).toEqual(["winds for leg 1 are forecast from 1400Z; the leg starts 1330Z"])
  })

  it("names a destination TAF that ends a minute before the ETA", () => {
    const short = { ...base, destination: { id: "KBDN", taf: taf("2026-10-12T12:00:00Z", "2026-10-12T21:01:00Z") } }
    expect(coverage(short)).toEqual({
      preliminary: true,
      reasons: ["the KBDN TAF ends 2101Z, before the 2102Z ETA"],
    })
  })

  it("names an origin TAF that has not started by the departure", () => {
    const notYet = { ...base, origin: { id: "KPDX", taf: taf("2026-10-12T21:00:00Z", "2026-10-13T21:00:00Z") } }
    expect(coverage(notYet).reasons).toEqual(["the KPDX TAF starts 2100Z, after the 2000Z departure"])
  })

  it("does not count an airport with no TAF", () => {
    const none = { ...base, destination: { id: "KTTD", taf: null } }
    expect(coverage(none)).toEqual({ preliminary: false, reasons: [] })
  })

  it("is preliminary when no winds window was published at all", () => {
    expect(coverage({ ...base, windWindows: [] }).reasons).toEqual(["no winds-aloft forecast is published for leg 1"])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-coverage.test.ts`
Expected: FAIL, because it cannot resolve `../src/lib/forecast/coverage.ts`.

- [ ] **Step 3: Implement `coverage.ts`**

Create `examples/navlog/server/src/lib/forecast/coverage.ts`:

```ts
import type { Coverage, TimeWindow } from "./types.js"

/** "2102Z" for an epoch-ms instant. */
export function hhmmZ(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}Z`
}

export interface CoverageInput {
  readonly departureMs: number
  readonly etaMs: number
  readonly origin: { readonly id: string; readonly taf: { readonly validFromUtc: string; readonly validToUtc: string } | null }
  readonly destination: { readonly id: string; readonly taf: { readonly validFromUtc: string; readonly validToUtc: string } | null }
  readonly legs: readonly { readonly leg: number; readonly startMs: number; readonly endMs: number }[]
  /** Every published winds-aloft FOR USE window. The products abut, so their union is what covers a leg. */
  readonly windWindows: readonly TimeWindow[]
}

/** The union of the windows, merged where they touch or overlap, sorted. */
function merge(windows: readonly TimeWindow[]): TimeWindow[] {
  const sorted = [...windows].sort((a, b) => a.fromMs - b.fromMs)
  const out: TimeWindow[] = []
  for (const w of sorted) {
    const last = out.at(-1)
    if (last && w.fromMs <= last.toMs) out[out.length - 1] = { fromMs: last.fromMs, toMs: Math.max(last.toMs, w.toMs) }
    else out.push({ ...w })
  }
  return out
}

/**
 * Whether the forecasts reach the flight, by the one definition the navlog
 * uses: the origin TAF covers the departure, the destination TAF covers the
 * ETA, and every leg's flying interval lies inside the published winds-aloft
 * windows. An airport with no TAF at all is not a gap here (it never will
 * have one); the caller notes it.
 */
export function coverage(input: CoverageInput): Coverage {
  const reasons: string[] = []
  const tafGap = (
    end: { readonly id: string; readonly taf: { readonly validFromUtc: string; readonly validToUtc: string } | null },
    atMs: number,
    what: "departure" | "ETA",
  ): void => {
    if (end.taf === null) return
    const from = Date.parse(end.taf.validFromUtc)
    const to = Date.parse(end.taf.validToUtc)
    if (atMs < from) reasons.push(`the ${end.id} TAF starts ${hhmmZ(from)}, after the ${hhmmZ(atMs)} ${what}`)
    else if (atMs >= to) reasons.push(`the ${end.id} TAF ends ${hhmmZ(to)}, before the ${hhmmZ(atMs)} ${what}`)
  }
  tafGap(input.origin, input.departureMs, "departure")
  tafGap(input.destination, input.etaMs, "ETA")
  const spans = merge(input.windWindows)
  for (const leg of input.legs) {
    if (spans.length === 0) {
      reasons.push(`no winds-aloft forecast is published for leg ${leg.leg}`)
      continue
    }
    if (spans.some((s) => s.fromMs <= leg.startMs && leg.endMs <= s.toMs)) continue
    const before = spans.find((s) => s.fromMs > leg.startMs && s.fromMs <= leg.endMs) ?? spans[0]
    const containing = spans.find((s) => s.fromMs <= leg.startMs && leg.startMs < s.toMs)
    if (containing === undefined && before !== undefined && before.fromMs > leg.startMs) {
      reasons.push(`winds for leg ${leg.leg} are forecast from ${hhmmZ(before.fromMs)}; the leg starts ${hhmmZ(leg.startMs)}`)
    } else {
      const reach = (containing ?? spans.at(-1) as TimeWindow).toMs
      reasons.push(`winds for leg ${leg.leg} are forecast until ${hhmmZ(reach)}; the leg ends ${hhmmZ(leg.endMs)}`)
    }
  }
  return { preliminary: reasons.length > 0, reasons }
}
```

- [ ] **Step 4: Run the coverage test**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-coverage.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing advisories test**

Create `examples/navlog/server/test/forecast-advisories.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { advisoryRelevance, altitudeFt, toAdvisoryFact } from "../src/lib/forecast/advisories.ts"

const ms = (iso: string): number => Date.parse(iso)
const DEP = ms("2026-10-12T20:00:00Z")
const ETA = ms("2026-10-12T21:02:00Z")

describe("advisoryRelevance", () => {
  it("during flight when it starts before the ETA and ends after the departure", () => {
    expect(advisoryRelevance(ms("2026-10-12T18:00:00Z"), ms("2026-10-13T00:00:00Z"), DEP, ETA)).toBe("during-flight")
  })
  it("during flight when it has no end", () => {
    expect(advisoryRelevance(ms("2026-10-12T18:00:00Z"), null, DEP, ETA)).toBe("during-flight")
  })
  it("before departure when it ends at the departure", () => {
    expect(advisoryRelevance(ms("2026-10-12T15:00:00Z"), DEP, DEP, ETA)).toBe("before-departure")
  })
  it("after arrival when it starts at the ETA", () => {
    expect(advisoryRelevance(ETA, ms("2026-10-13T03:00:00Z"), DEP, ETA)).toBe("after-arrival")
  })
})

describe("altitudeFt", () => {
  it("reads the tool's altitude strings", () => {
    expect(altitudeFt("4,000 ft")).toBe(4000)
    expect(altitudeFt("surface")).toBe(0)
    expect(altitudeFt("FL290")).toBe(29000)
    expect(altitudeFt("freezing level")).toBeNull()
    expect(altitudeFt(undefined)).toBeNull()
  })
})

describe("toAdvisoryFact", () => {
  it("takes a freezing-level contour's altitude as both bounds", () => {
    const fact = toAdvisoryFact(
      { product: "G-AIRMET", hazard: "FZLVL", freezingLevel: "8,000 ft", validFrom: "2026-10-12T18:00:00.000Z", validTo: "2026-10-13T00:00:00.000Z" },
      DEP,
      ETA,
    )
    expect(fact).toEqual({
      product: "G-AIRMET",
      hazard: "FZLVL",
      lowestFt: 8000,
      highestFt: 8000,
      validFromUtc: "2026-10-12T18:00:00.000Z",
      validToUtc: "2026-10-13T00:00:00.000Z",
      relevance: "during-flight",
    })
  })
})
```

- [ ] **Step 6: Implement `advisories.ts`**

Create `examples/navlog/server/src/lib/forecast/advisories.ts` by moving, unchanged, from `src/tools/getAdvisories.ts`:
- `AwcValue` and `AwcAdvisory`;
- `Advisory`, with its doc comment;
- `text`, `isoTime`, `feet`, `gairmetAltitude`, `airsigmetAltitude`, `touches`, `present`, `fromGairmet` and `fromAirsigmet`.

Then add:

```ts
import { awc } from "../awc.js"
import type { AdvisoryFact } from "./types.js"

/**
 * G-AIRMETs, AIRMETs and SIGMETs whose area touches any of the points (each
 * padded half a degree), one row per distinct advisory.
 */
export async function fetchAdvisoriesNear(
  points: readonly { readonly lat: number; readonly lon: number }[],
  signal?: AbortSignal,
): Promise<Advisory[]> {
  const [gairmets, airsigmets] = await Promise.all([
    awc.getJson<AwcAdvisory[]>("gairmet", {}, signal),
    awc.getJson<AwcAdvisory[]>("airsigmet", {}, signal),
  ])
  const near = (advisory: AwcAdvisory): boolean => points.some((point) => touches(point, advisory))
  const seen = new Set<string>()
  const rows: Advisory[] = []
  for (const advisory of gairmets) {
    if (!near(advisory)) continue
    const row = fromGairmet(advisory)
    const key = [row.hazard, row.validFrom, row.base, row.top, row.freezingLevel].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  for (const advisory of airsigmets) if (near(advisory)) rows.push(fromAirsigmet(advisory))
  return rows
}

/** "4,000 ft", "surface" or "FL290" in feet; null for "freezing level" or nothing. */
export function altitudeFt(text: string | undefined): number | null {
  if (text === undefined) return null
  if (/^surface$/i.test(text.trim())) return 0
  const fl = /\bFL\s?(\d{2,3})\b/i.exec(text)
  if (fl) return Number(fl[1]) * 100
  const ft = /(\d{1,3}(?:,\d{3})*|\d+)\s*ft\b/i.exec(text)
  return ft ? Number((ft[1] as string).replaceAll(",", "")) : null
}

/** Where an advisory's validity sits against the flight window. A missing start counts as already valid. */
export function advisoryRelevance(
  validFromMs: number | null,
  validToMs: number | null,
  departureMs: number,
  etaMs: number,
): AdvisoryFact["relevance"] {
  if (validToMs !== null && validToMs <= departureMs) return "before-departure"
  if (validFromMs !== null && validFromMs >= etaMs) return "after-arrival"
  return "during-flight"
}

/** The typed fact for one advisory and one flight. */
export function toAdvisoryFact(advisory: Advisory, departureMs: number, etaMs: number): AdvisoryFact {
  const contour = altitudeFt(advisory.freezingLevel)
  const fromMs = advisory.validFrom === undefined ? null : Date.parse(advisory.validFrom)
  const toMs = advisory.validTo === undefined ? null : Date.parse(advisory.validTo)
  return {
    product: advisory.product,
    hazard: advisory.hazard,
    lowestFt: contour ?? altitudeFt(advisory.base),
    highestFt: contour ?? altitudeFt(advisory.top),
    validFromUtc: advisory.validFrom ?? null,
    validToUtc: advisory.validTo ?? null,
    relevance: advisoryRelevance(fromMs, toMs, departureMs, etaMs),
  }
}
```

Rewrite `src/tools/getAdvisories.ts`'s default export as `fetchAdvisoriesNear([input], ctx.signal)`. Keep its `display` export, and `export type { Advisory } from "../lib/forecast/advisories.js"`.

- [ ] **Step 7: Run the tests**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-coverage.test.ts test/forecast-advisories.test.ts test/weather-tools.test.ts && pnpm exec tsc -p . --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add examples/navlog/server/src/lib/forecast examples/navlog/server/src/tools/getAdvisories.ts examples/navlog/server/test/forecast-coverage.test.ts examples/navlog/server/test/forecast-advisories.test.ts
git commit -m "navlog-server: coverage and advisory relevance as pure rules"
```

### Task 3: `verdictFloor`

**Files:**
- Create: `examples/navlog/server/src/lib/forecast/verdict.ts`
- Test: `examples/navlog/server/test/forecast-verdict.test.ts`

**Interfaces:**
- Consumes: `AirportWeather`, `AdvisoryFact`, `Coverage` and `VerdictFloor` from Task 1.
- Produces: `verdictFloor(input: { airports: readonly AirportWeather[]; advisories: readonly AdvisoryFact[]; coverage: Coverage; cruiseFt: number; reserveMin: number; reserveOk: boolean }): VerdictFloor`.

- [ ] **Step 1: Write the failing test**

Create `examples/navlog/server/test/forecast-verdict.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import type { AdvisoryFact, AirportWeather } from "../src/lib/forecast/types.ts"
import { verdictFloor } from "../src/lib/forecast/verdict.ts"

const airport = (over: Partial<AirportWeather> & Pick<AirportWeather, "id" | "role">): AirportWeather => ({
  alongNm: 0,
  atUtc: "2026-10-12T20:00:00.000Z",
  metar: null,
  taf: null,
  categoryNow: "VFR",
  categoryAtTime: "VFR",
  gustKt: null,
  ...over,
})
const advisory = (over: Partial<AdvisoryFact>): AdvisoryFact => ({
  product: "G-AIRMET",
  hazard: "TURB-LO",
  lowestFt: 0,
  highestFt: 12000,
  validFromUtc: null,
  validToUtc: null,
  relevance: "during-flight",
  ...over,
})
const clean = {
  airports: [airport({ id: "KPDX", role: "origin" }), airport({ id: "KBDN", role: "destination" })],
  advisories: [],
  coverage: { preliminary: false, reasons: [] },
  cruiseFt: 9500,
  reserveMin: 390,
  reserveOk: true,
}

describe("verdictFloor", () => {
  it("is GO with no reasons for a clean flight", () => {
    expect(verdictFloor(clean)).toEqual({ level: "GO", reasons: [] })
  })

  it("is NO-GO for IFR at the destination at the ETA, and for a short reserve", () => {
    const out = verdictFloor({
      ...clean,
      airports: [clean.airports[0] as AirportWeather, airport({ id: "KBDN", role: "destination", categoryAtTime: "IFR" })],
      reserveMin: 38,
      reserveOk: false,
    })
    expect(out).toEqual({ level: "NO-GO", reasons: ["KBDN IFR at ETA", "reserve 38 min, under 45"] })
  })

  it("is NO-GO for a convective SIGMET or icing at the cruise during the flight", () => {
    expect(verdictFloor({ ...clean, advisories: [advisory({ product: "SIGMET", hazard: "CONVECTIVE" })] }).level).toBe("NO-GO")
    expect(verdictFloor({ ...clean, advisories: [advisory({ hazard: "ICE", lowestFt: 8000, highestFt: 14000 })] }).reasons).toEqual([
      "icing 8,000–14,000 ft during the flight, at the 9,500 ft cruise",
    ])
  })

  it("is CAUTION for icing that does not reach the cruise, or at an altitude it does not give", () => {
    expect(verdictFloor({ ...clean, advisories: [advisory({ hazard: "ICE", lowestFt: 12000, highestFt: 16000 })] }).level).toBe("CAUTION")
    expect(verdictFloor({ ...clean, advisories: [advisory({ hazard: "ICE", lowestFt: null, highestFt: null })] }).level).toBe("CAUTION")
  })

  it("is CAUTION for a freezing level within 2,000 ft of the cruise, not for one far above it", () => {
    expect(verdictFloor({ ...clean, advisories: [advisory({ hazard: "FZLVL", lowestFt: 8000, highestFt: 8000 })] }).reasons).toEqual([
      "freezing level 8,000 ft during the flight, below the 9,500 ft cruise",
    ])
    expect(verdictFloor({ ...clean, advisories: [advisory({ hazard: "FZLVL", lowestFt: 14000, highestFt: 14000 })] }).level).toBe("GO")
  })

  it("is CAUTION for MVFR at an end, an en-route station worse than VFR, a gust, or a preliminary forecast", () => {
    const out = verdictFloor({
      ...clean,
      airports: [
        airport({ id: "KPDX", role: "origin", categoryNow: "MVFR" }),
        airport({ id: "KS33", role: "en-route", categoryAtTime: null, categoryNow: "IFR" }),
        airport({ id: "KBDN", role: "destination", gustKt: 25 }),
      ],
      coverage: { preliminary: true, reasons: ["the KBDN TAF ends 1200Z, before the 1315Z ETA"] },
    })
    expect(out).toEqual({
      level: "CAUTION",
      reasons: ["KPDX MVFR now", "KS33 IFR en route", "gusts 25 kt at KBDN", "forecast preliminary"],
    })
  })

  it("ignores advisories outside the flight window", () => {
    expect(verdictFloor({ ...clean, advisories: [advisory({ product: "SIGMET", hazard: "CONVECTIVE", relevance: "after-arrival" })] }).level).toBe("GO")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-verdict.test.ts`
Expected: FAIL, because it cannot resolve `../src/lib/forecast/verdict.ts`.

- [ ] **Step 3: Implement `verdict.ts`**

Create `examples/navlog/server/src/lib/forecast/verdict.ts`:

```ts
import type { AdvisoryFact, AirportWeather, Coverage, VerdictFloor } from "./types.js"

const GUST_LIMIT_KT = 20
const FREEZING_MARGIN_FT = 2000
const RESERVE_FLOOR_MIN = 45

const ft = (n: number): string => `${n.toLocaleString("en-US")} ft`

/** "8,000–14,000 ft", "8,000 ft", or how to say the advisory gives no altitude. */
function band(a: AdvisoryFact): string {
  if (a.lowestFt === null) return "at an altitude it does not give"
  if (a.highestFt === null || a.highestFt === a.lowestFt) return ft(a.lowestFt)
  return `${a.lowestFt.toLocaleString("en-US")}–${ft(a.highestFt)}`
}

/**
 * The lowest verdict the facts allow. The planner may state a worse level
 * with a reason; it may never state a better one. NO-GO reasons come first.
 */
export function verdictFloor(input: {
  readonly airports: readonly AirportWeather[]
  readonly advisories: readonly AdvisoryFact[]
  readonly coverage: Coverage
  readonly cruiseFt: number
  readonly reserveMin: number
  readonly reserveOk: boolean
}): VerdictFloor {
  const noGo: string[] = []
  const caution: string[] = []
  for (const a of input.airports) {
    const atTime = a.categoryAtTime
    if (a.role === "en-route") {
      const worst = atTime ?? a.categoryNow
      if (worst !== null && worst !== "VFR") caution.push(`${a.id} ${worst} en route`)
      continue
    }
    const when = a.role === "origin" ? "at departure" : "at ETA"
    if (atTime === "IFR" || atTime === "LIFR") noGo.push(`${a.id} ${atTime} ${when}`)
    else if (a.categoryNow === "MVFR" && atTime === "MVFR") caution.push(`${a.id} MVFR now and ${when}`)
    else if (a.categoryNow === "MVFR") caution.push(`${a.id} MVFR now`)
    else if (atTime === "MVFR") caution.push(`${a.id} MVFR ${when}`)
    if (a.gustKt !== null && a.gustKt > GUST_LIMIT_KT) caution.push(`gusts ${a.gustKt} kt at ${a.id}`)
  }
  if (!input.reserveOk) noGo.push(`reserve ${input.reserveMin} min, under ${RESERVE_FLOOR_MIN}`)
  if (input.coverage.preliminary) caution.push("forecast preliminary")
  const cruise = input.cruiseFt
  for (const a of input.advisories) {
    if (a.relevance !== "during-flight") continue
    const hazard = a.hazard.toUpperCase()
    if (hazard === "CONVECTIVE" && a.product === "SIGMET") {
      noGo.push("convective SIGMET during the flight")
    } else if (hazard === "ICE") {
      const atCruise = a.lowestFt !== null && a.lowestFt <= cruise && (a.highestFt === null || cruise <= a.highestFt)
      if (atCruise) noGo.push(`icing ${band(a)} during the flight, at the ${ft(cruise)} cruise`)
      else caution.push(`icing ${band(a)} during the flight`)
    } else if (hazard === "FZLVL" || hazard === "M_FZLVL") {
      if (a.lowestFt === null) caution.push("a freezing level during the flight at an altitude it does not give")
      else if (a.lowestFt <= cruise + FREEZING_MARGIN_FT) {
        const where = a.lowestFt < cruise ? "below" : "within 2,000 ft of"
        caution.push(`freezing level ${ft(a.lowestFt)} during the flight, ${where} the ${ft(cruise)} cruise`)
      }
    } else if (hazard === "LLWS" || hazard.startsWith("TURB") || hazard === "CONVECTIVE") {
      caution.push(`${hazard.toLowerCase()} during the flight`)
    }
  }
  const reasons = [...new Set([...noGo, ...caution])]
  return { level: noGo.length > 0 ? "NO-GO" : caution.length > 0 ? "CAUTION" : "GO", reasons }
}
```

- [ ] **Step 4: Run the test**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-verdict.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add examples/navlog/server/src/lib/forecast/verdict.ts examples/navlog/server/test/forecast-verdict.test.ts
git commit -m "navlog-server: the verdict floor as a pure rule over typed facts"
```

### Task 4: Winds stations table, `nearestWindsStation`, and the winds lib

**Files:**
- Create: `examples/navlog/server/scripts/build-winds-stations.mjs`
- Create: `examples/navlog/server/scripts/build-winds-stations.d.mts`
- Create: `examples/navlog/server/data/winds-stations.json` (generated, committed)
- Create: `examples/navlog/server/src/lib/forecast/winds.ts`
- Modify: `examples/navlog/server/src/tools/getWindsAloft.ts` (import `chooseProduct`, `FORECAST_HOURS` and `fetchWindsProducts` from the lib; behaviour unchanged)
- Test: `examples/navlog/server/test/forecast-winds.test.ts`

**Interfaces:**
- Produces from `winds.ts`:
  - `FORECAST_HOURS`, `ForecastHours`, `ProductChoice`;
  - `chooseProduct(products: ReadonlyMap<ForecastHours, WindsAloftProduct>, at: number, now: number): ProductChoice | null`;
  - `fetchWindsProducts(region: string, signal?: AbortSignal): Promise<Map<ForecastHours, WindsAloftProduct>>`;
  - `windWindows(products: ReadonlyMap<ForecastHours, WindsAloftProduct>, now: number): TimeWindow[]`;
  - `WindsStation = { id: string; lat: number; lon: number }`;
  - `WINDS_STATIONS: readonly WindsStation[]`;
  - `nearestWindsStation(point: { lat: number; lon: number }, available: ReadonlySet<string>, table?: readonly WindsStation[]): WindsStation | null`.

- [ ] **Step 1: Write the build script**

Create `examples/navlog/server/scripts/build-winds-stations.mjs`:

```js
// Builds the winds-aloft station table: each FB station id in the contiguous-US
// low-level product, with its position.
//
// Usage (from examples/navlog/server):
//   node scripts/build-winds-stations.mjs [--date YYYY-MM-DD]
//
// Positions come from the bundled navaid snapshot (data/navaids.json, VOR
// family) first, then from aviationweather.gov's airport record for K<id>.
// Stations neither resolves (the Gulf points H51, H52, H61) are listed as
// unresolved and left out: a VFR 172 plan never needs them. Writes
// ../data/winds-stations.json.

import { readFileSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const AWC = "https://aviationweather.gov/api/data"
const VOR_TYPES = /VOR|TAC|DME/

/** The 3-character station ids of an FB product, in order. */
export function stationIds(text) {
  const ids = []
  for (const line of text.split("\n")) {
    const id = line.slice(0, 3)
    if (/^[A-Z0-9]{3}$/.test(id) && line.length > 4 && !/^(FT |FD|DAT|VAL|TEM)/.test(line)) ids.push(id)
  }
  return [...new Set(ids)]
}

/** Resolves each id from the navaid rows, then from `lookupAirport(id)`; returns the table and the unresolved ids. */
export async function resolveStations(ids, navaidRows, lookupAirport) {
  const vors = new Map()
  for (const row of navaidRows) if (VOR_TYPES.test(row[2]) && !vors.has(row[0])) vors.set(row[0], row)
  const stations = []
  const unresolved = []
  for (const id of ids) {
    const vor = vors.get(id)
    if (vor) {
      stations.push([id, vor[3], vor[4]])
      continue
    }
    const airport = await lookupAirport(id)
    if (airport) stations.push([id, airport.lat, airport.lon])
    else unresolved.push(id)
  }
  return { stations, unresolved }
}

async function main() {
  const dateArg = process.argv.indexOf("--date")
  const snapshot = dateArg > 0 ? process.argv[dateArg + 1] : new Date().toISOString().slice(0, 10)
  const text = await (await fetch(`${AWC}/windtemp?region=all&level=low&fcst=06`)).text()
  const navaids = JSON.parse(readFileSync(new URL("../data/navaids.json", import.meta.url), "utf8")).navaids
  const lookupAirport = async (id) => {
    const body = await (await fetch(`${AWC}/airport?ids=K${id}&format=json`)).text()
    const [record] = body.trim() === "" ? [] : JSON.parse(body)
    return record && typeof record.lat === "number" ? { lat: record.lat, lon: record.lon } : null
  }
  const { stations, unresolved } = await resolveStations(stationIds(text), navaids, lookupAirport)
  writeFileSync(
    new URL("../data/winds-stations.json", import.meta.url),
    `${JSON.stringify({ snapshot, unresolved, stations })}\n`,
  )
  console.log(`winds-stations: ${stations.length} stations, unresolved: ${unresolved.join(", ") || "none"}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
```

Create `examples/navlog/server/scripts/build-winds-stations.d.mts`:

```ts
export function stationIds(text: string): string[]
export function resolveStations(
  ids: readonly string[],
  navaidRows: readonly (readonly [string, string, string, number, number, ...unknown[]])[],
  lookupAirport: (id: string) => Promise<{ lat: number; lon: number } | null>,
): Promise<{ stations: [string, number, number][]; unresolved: string[] }>
```

- [ ] **Step 2: Generate the table**

Run: `cd examples/navlog/server && node scripts/build-winds-stations.mjs`
Expected: `winds-stations: 173 stations, unresolved: H51, H52, H61` (counts may vary by ±2 if the product changed). Commit the resulting `data/winds-stations.json`. If anything other than `H5x`/`H6x` is unresolved, look up why before continuing.

- [ ] **Step 3: Write the failing winds test**

Create `examples/navlog/server/test/forecast-winds.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import table from "../data/winds-stations.json" with { type: "json" }
import { resolveStations, stationIds } from "../scripts/build-winds-stations.mjs"
import { nearestWindsStation, WINDS_STATIONS } from "../src/lib/forecast/winds.ts"

describe("winds stations table", () => {
  it("places every station but the Gulf points", () => {
    expect(table.unresolved.every((id: string) => /^H\d\d$/.test(id))).toBe(true)
    expect(WINDS_STATIONS.length).toBeGreaterThan(160)
    expect(WINDS_STATIONS.find((s) => s.id === "PDX")).toBeDefined()
    expect(WINDS_STATIONS.find((s) => s.id === "RDM")).toBeDefined()
  })

  it("reads station ids from an FB product and resolves VORs before airports", async () => {
    const text = [
      "DATA BASED ON 121800Z",
      "VALID 130000Z   FOR USE 2000-0300Z. TEMPS NEG ABV 24000",
      "",
      "FT  3000    6000    9000   12000",
      "PDX 9900 2511+07 2609+02 2711-04",
      "RDM      2715+05 2817+00 2821-06",
      "H51 1105 1210+18 1315+12 1420+06",
    ].join("\n")
    expect(stationIds(text)).toEqual(["PDX", "RDM", "H51"])
    const out = await resolveStations(["PDX", "RDM", "H51"], [["PDX", "Portland", "VORTAC", 45.58, -122.6, 116300, 16]], async (id) =>
      id === "RDM" ? { lat: 44.25, lon: -121.15 } : null,
    )
    expect(out).toEqual({ stations: [["PDX", 45.58, -122.6], ["RDM", 44.25, -121.15]], unresolved: ["H51"] })
  })
})

describe("nearestWindsStation", () => {
  const TABLE = [
    { id: "PDX", lat: 45.58, lon: -122.6 },
    { id: "RDM", lat: 44.25, lon: -121.15 },
    { id: "SEA", lat: 47.43, lon: -122.3 },
  ]
  it("picks the great-circle nearest station in the product", () => {
    expect(nearestWindsStation({ lat: 44.8, lon: -121.9 }, new Set(["PDX", "RDM", "SEA"]), TABLE)?.id).toBe("RDM")
  })
  it("falls back to the next nearest when the nearest is not in the product", () => {
    expect(nearestWindsStation({ lat: 44.8, lon: -121.9 }, new Set(["PDX", "SEA"]), TABLE)?.id).toBe("PDX")
  })
  it("is null when no station in the table is in the product", () => {
    expect(nearestWindsStation({ lat: 44.8, lon: -121.9 }, new Set(["XXX"]), TABLE)).toBeNull()
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-winds.test.ts`
Expected: FAIL, because it cannot resolve `../src/lib/forecast/winds.ts`.

- [ ] **Step 5: Implement `winds.ts`**

Create `examples/navlog/server/src/lib/forecast/winds.ts`. Move these unchanged from `src/tools/getWindsAloft.ts`, exporting each:
- `FORECAST_HOURS`;
- `ForecastHours`;
- `ProductChoice`;
- `chooseProduct`.

Then add:

```ts
import table from "../../../data/winds-stations.json" with { type: "json" }
import { awc } from "../awc.js"
import { distanceNm } from "../geo.js"
import { forUseWindow, parseWindsAloft, type WindsAloftProduct } from "../winds-aloft.js"
import type { TimeWindow } from "./types.js"

/** The 6-, 12- and 24-hour low-level products for a region ("all" for the contiguous US). */
export async function fetchWindsProducts(
  region: string,
  signal?: AbortSignal,
): Promise<Map<ForecastHours, WindsAloftProduct>> {
  const texts = await Promise.all(
    FORECAST_HOURS.map((hours) =>
      awc.getText("windtemp", { region, level: "low", fcst: String(hours).padStart(2, "0") }, signal),
    ),
  )
  return new Map(FORECAST_HOURS.map((hours, i) => [hours, parseWindsAloft(texts[i] as string)]))
}

/** Every published product's FOR USE window. */
export function windWindows(
  products: ReadonlyMap<ForecastHours, WindsAloftProduct>,
  now: number,
): TimeWindow[] {
  return FORECAST_HOURS.flatMap((hours) => {
    const product = products.get(hours)
    const window = product ? forUseWindow(product, now) : null
    return window ? [{ fromMs: Date.parse(window.fromUtc), toMs: Date.parse(window.toUtc) }] : []
  })
}

export interface WindsStation {
  readonly id: string
  readonly lat: number
  readonly lon: number
}

/** The committed station table (scripts/build-winds-stations.mjs). */
export const WINDS_STATIONS: readonly WindsStation[] = (
  table.stations as [string, number, number][]
).map(([id, lat, lon]) => ({ id, lat, lon }))

/** The great-circle nearest station whose id is in `available` (the product's stations). */
export function nearestWindsStation(
  point: { readonly lat: number; readonly lon: number },
  available: ReadonlySet<string>,
  stations: readonly WindsStation[] = WINDS_STATIONS,
): WindsStation | null {
  let best: WindsStation | null = null
  let bestNm = Number.POSITIVE_INFINITY
  for (const station of stations) {
    if (!available.has(station.id)) continue
    const nm = distanceNm(point, station)
    if (nm < bestNm) {
      best = station
      bestNm = nm
    }
  }
  return best
}
```

Update `src/tools/getWindsAloft.ts`:
- import `FORECAST_HOURS`, `ForecastHours`, `chooseProduct` and `fetchWindsProducts` from `../lib/forecast/winds.js`;
- replace its inline `Promise.all(... awc.getText ...)` and `products` map with `const products = await fetchWindsProducts(input.region, ctx.signal)`;
- delete the moved declarations;
- keep `export type ForecastHours`, re-exported from the lib.

- [ ] **Step 6: Run the tests**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-winds.test.ts test/weather-tools.test.ts test/winds-aloft.test.ts && pnpm exec tsc -p . --noEmit && pnpm lint`
Expected: PASS. `weather-tools.test.ts` pins `getWindsAloft` unchanged.

- [ ] **Step 7: Mirror to the template, then commit and open PR 1**

The mirror copies every changed or new file under `examples/navlog/server/{src,test,scripts,data}` to the same path under `packages/devkit/templates/app-navlog/server/`, with `.template` appended to `*.test.ts` files.

```bash
for f in $(git diff --name-only --diff-filter=AM origin/main -- examples/navlog/server) $(git ls-files --others --exclude-standard examples/navlog/server); do
  dest="packages/devkit/templates/app-navlog/${f#examples/navlog/}"; case "$f" in *.test.ts) dest="$dest.template";; esac
  mkdir -p "$(dirname "$dest")" && cp "$f" "$dest"
done
pnpm --filter @b4run/devkit exec vitest run
```

Expected: devkit 48 pass (server test files are not count-pinned). Then add a `patch` changeset for `@b4run/devkit` and `create-b4-app`, "navlog template: forecast rules in lib/forecast", and commit:

```bash
git add examples/navlog/server packages/devkit/templates/app-navlog/server .changeset/navlog-forecast-rules.md
git commit -m "navlog-server: winds station table and the winds lib; mirror the template"
```

Open PR 1, then merge on green.

---

## PR 2: The cut-over

Branch: `git switch -c blove/navlog-forecast-facts origin/main`, after PR 1 has merged.

### Task 5: `buildForecast`, the pure assembly

**Files:**
- Create: `examples/navlog/server/src/lib/forecast/build.ts`
- Modify: `examples/navlog/server/src/tools/getMetar.ts` (move `Metar` and its parsing to `src/lib/forecast/metar.ts`, and add `gustKt`)
- Create: `examples/navlog/server/src/lib/forecast/metar.ts`
- Test: `examples/navlog/server/test/forecast-build.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `metar.ts`: `Metar` (now with `gustKt: number | null`), `fetchMetars(ids: readonly string[], signal?: AbortSignal): Promise<(Metar & { lat: number | null; lon: number | null; name: string | null })[]>`.
  - `build.ts`:
    - `legIntervals(navlog: Navlog): { leg: number; startMs: number; endMs: number; midMs: number }[]`;
    - `timeAtAlong(navlog: Navlog, alongNm: number): number`;
    - `buildForecast(input: BuildForecastInput): Forecast`, where `BuildForecastInput = { navlog: Navlog; winds: readonly LegWind[]; windWindows: readonly TimeWindow[]; metars: readonly Metar[]; tafs: readonly Taf[]; advisories: readonly Advisory[]; stations: readonly { id: string; alongNm: number }[] }`.

- [ ] **Step 1: Move the METAR parsing and add the gust**

Create `src/lib/forecast/metar.ts` from `src/tools/getMetar.ts`'s `AwcMetar`, `Metar`, `ceilingOf` and `num`. Then:
- add `readonly wgst?: number`, `readonly lat?: number`, `readonly lon?: number` and `readonly name?: string` to `AwcMetar`;
- add `readonly gustKt: number | null` to `Metar`;
- export:

```ts
export async function fetchMetars(
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<(Metar & { readonly lat: number | null; readonly lon: number | null; readonly name: string | null })[]> {
  if (ids.length === 0) return []
  const query = ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcMetar[]>("metar", { ids: query }, signal)
  return records.map((record) => ({
    id: record.icaoId,
    observedAt: record.reportTime ?? "",
    flightCategory: record.fltCat ?? "UNKNOWN",
    windDirDeg: num(record.wdir),
    windKt: record.wspd ?? null,
    gustKt: record.wgst ?? null,
    visibilityMi: num(record.visib),
    ceilingFt: ceilingOf(record.clouds),
    tempC: record.temp ?? null,
    dewpointC: record.dewp ?? null,
    altimeterHpa: record.altim ?? null,
    raw: record.rawOb,
    lat: record.lat ?? null,
    lon: record.lon ?? null,
    name: record.name ?? null,
  }))
}
```

`getMetar`'s default export becomes `(await fetchMetars(input.ids, ctx.signal)).map(({ lat, lon, name, ...metar }) => metar)`. Its output gains only `gustKt`. Update `test/weather-tools.test.ts`'s expected METAR objects to include `gustKt: null`, or the stubbed gust where a fixture has `wgst`.

- [ ] **Step 2: Write the failing build test**

Create `examples/navlog/server/test/forecast-build.test.ts`. It builds a navlog with the pure `computeNavlog`, so the times are real:

```ts
import { describe, expect, it } from "vitest"
import { buildForecast, legIntervals, timeAtAlong } from "../src/lib/forecast/build.ts"
import type { Taf } from "../src/lib/forecast/taf.ts"
import { computeNavlog, type NavlogWaypoint } from "../src/lib/navlog.ts"

const KPDX: NavlogWaypoint = { id: "KPDX", kind: "airport", lat: 45.5887, lon: -122.5969, elevationFt: 31, magneticVariationDeg: 16 }
const KBDN: NavlogWaypoint = { id: "KBDN", kind: "airport", lat: 44.0946, lon: -121.2002, elevationFt: 3458, magneticVariationDeg: 14 }
const KHAF: NavlogWaypoint = { id: "KHAF", kind: "airport", lat: 37.5134, lon: -122.5011, elevationFt: 66, magneticVariationDeg: 13 }
const KPAO: NavlogWaypoint = { id: "KPAO", kind: "airport", lat: 37.4611, lon: -122.115, elevationFt: 7, magneticVariationDeg: 13 }
const aircraft = { tailNumber: "N734ST", cruiseRpm: 2400, usableFuelGal: 50 }
const calm = (n: number) => Array.from({ length: n }, () => ({ dirDegTrue: 0, speedKt: 0 }))
const navlog = (waypoints: NavlogWaypoint[]) =>
  computeNavlog({ aircraft, altitudeFt: 9500, departureTimeUtc: "2026-10-12T20:00:00Z", waypoints, winds: calm(waypoints.length - 1) })

const tafFor = (id: string): Taf => ({
  id,
  issuedAt: "2026-10-12T17:20:00.000Z",
  validFromUtc: "2026-10-12T18:00:00.000Z",
  validToUtc: "2026-10-13T18:00:00.000Z",
  raw: `TAF ${id} 121720Z 1218/1318 VRB05KT P6SM SKC`,
  periods: [{ change: "BASE", fromUtc: "2026-10-12T18:00:00.000Z", toUtc: "2026-10-13T18:00:00.000Z", flightCategory: "VFR" }],
})
const metarFor = (id: string, category = "VFR") => ({
  id, observedAt: "2026-10-12T18:15:00.000Z", flightCategory: category, windDirDeg: 330, windKt: 6, gustKt: null,
  visibilityMi: 10, ceilingFt: null, tempC: 10, dewpointC: -3, altimeterHpa: 1016, raw: `METAR ${id} 121815Z AUTO 33006KT 10SM CLR`,
})

describe("legIntervals", () => {
  it("maps rows to legs, including an out-and-back that repeats a waypoint", () => {
    const log = navlog([KPAO, KHAF, KPAO])
    const legs = legIntervals(log)
    expect(legs.map((l) => l.leg)).toEqual([1, 2])
    expect(legs[0]?.startMs).toBe(Date.parse("2026-10-12T20:00:00Z"))
    expect(legs[1]?.startMs).toBe(legs[0]?.endMs)
    expect(legs[1]?.endMs).toBe(Date.parse(log.legs.at(-1)?.etaUtc ?? ""))
  })
})

describe("timeAtAlong", () => {
  it("is the departure at 0 nm and the ETA at the route's length", () => {
    const log = navlog([KPDX, KBDN])
    expect(timeAtAlong(log, 0)).toBe(Date.parse(log.departureTimeUtc))
    expect(timeAtAlong(log, log.totals.distanceNm)).toBe(Date.parse(log.legs.at(-1)?.etaUtc ?? ""))
  })
})

describe("buildForecast", () => {
  it("assembles origin, stations by alongNm and destination, and a GO floor for a clean flight", () => {
    const log = navlog([KPDX, KBDN])
    const forecast = buildForecast({
      navlog: log,
      winds: [{ leg: 1, station: "PDX", altitudeFt: 9500, dirDegTrue: 28, speedKt: 17, tempC: -4, forUseFromUtc: "2026-10-12T14:00:00.000Z", forUseToUtc: "2026-10-12T21:00:00.000Z", covered: true }],
      windWindows: [{ fromMs: Date.parse("2026-10-12T14:00:00Z"), toMs: Date.parse("2026-10-13T18:00:00Z") }],
      metars: [metarFor("KPDX"), metarFor("KS33"), metarFor("KBDN")],
      tafs: [tafFor("KPDX"), tafFor("KBDN")],
      advisories: [],
      stations: [{ id: "KS33", alongNm: 80 }],
    })
    expect(forecast.airports.map((a) => [a.id, a.role, a.categoryNow, a.categoryAtTime])).toEqual([
      ["KPDX", "origin", "VFR", "VFR"],
      ["KS33", "en-route", "VFR", null],
      ["KBDN", "destination", "VFR", "VFR"],
    ])
    expect(forecast.coverage).toEqual({ preliminary: false, reasons: [] })
    expect(forecast.verdictFloor).toEqual({ level: "GO", reasons: [] })
    expect(forecast.notes).toEqual(["No TAF issued for KS33"])
  })

  it("builds for a navaid destination with no METAR or TAF", () => {
    const SNS: NavlogWaypoint = { id: "SNS", kind: "navaid", lat: 36.6628, lon: -121.6064, magneticVariationDeg: 14 }
    const log = navlog([KPAO, SNS])
    const forecast = buildForecast({
      navlog: log, winds: [], windWindows: [], metars: [metarFor("KPAO")], tafs: [tafFor("KPAO")], advisories: [], stations: [],
    })
    expect(forecast.airports.at(-1)).toMatchObject({ id: "SNS", role: "destination", metar: null, taf: null, categoryAtTime: null })
    expect(forecast.coverage.reasons.some((r) => r.includes("SNS"))).toBe(false)
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-build.test.ts`
Expected: FAIL, because it cannot resolve `../src/lib/forecast/build.ts`.

- [ ] **Step 4: Implement `build.ts`**

Create `examples/navlog/server/src/lib/forecast/build.ts`:

```ts
import type { Navlog } from "../navlog.js"
import { type Advisory, toAdvisoryFact } from "./advisories.js"
import { coverage } from "./coverage.js"
import type { Metar } from "./metar.js"
import { categoryAt, type Taf } from "./taf.js"
import type { AirportWeather, Category, Forecast, LegWind, TimeWindow } from "./types.js"
import { verdictFloor } from "./verdict.js"

const CATEGORIES = new Set(["VFR", "MVFR", "IFR", "LIFR"])
const asCategory = (value: string | undefined): Category | null =>
  value !== undefined && CATEGORIES.has(value) ? (value as Category) : null

/**
 * Each route leg's flying interval, from the navlog rows. A leg is one or two
 * consecutive rows (a climb and a cruise) with the same from and to; rows of
 * the next leg start where the last one ended, so an out-and-back that
 * repeats a waypoint still maps cleanly.
 */
export function legIntervals(
  navlog: Navlog,
): { readonly leg: number; readonly startMs: number; readonly endMs: number; readonly midMs: number }[] {
  const out: { leg: number; startMs: number; endMs: number; midMs: number }[] = []
  let startMs = Date.parse(navlog.departureTimeUtc)
  let rowIndex = 0
  for (let leg = 1; leg < navlog.waypoints.length; leg++) {
    const from = navlog.waypoints[leg - 1]?.id
    const to = navlog.waypoints[leg]?.id
    let endMs = startMs
    while (rowIndex < navlog.legs.length) {
      const row = navlog.legs[rowIndex]
      if (row === undefined || row.from !== from || row.to !== to) break
      endMs = Date.parse(row.etaUtc)
      rowIndex++
    }
    out.push({ leg, startMs, endMs, midMs: (startMs + endMs) / 2 })
    startMs = endMs
  }
  return out
}

/** The instant the flight passes `alongNm` from the origin, interpolated over the rows. */
export function timeAtAlong(navlog: Navlog, alongNm: number): number {
  let flownNm = 0
  let clock = Date.parse(navlog.departureTimeUtc)
  for (const row of navlog.legs) {
    const endMs = Date.parse(row.etaUtc)
    if (alongNm <= flownNm + row.distanceNm || row === navlog.legs.at(-1)) {
      const share = row.distanceNm === 0 ? 1 : Math.min(1, Math.max(0, (alongNm - flownNm) / row.distanceNm))
      return Math.round(clock + share * (endMs - clock))
    }
    flownNm += row.distanceNm
    clock = endMs
  }
  return clock
}

export interface BuildForecastInput {
  readonly navlog: Navlog
  readonly winds: readonly LegWind[]
  readonly windWindows: readonly TimeWindow[]
  readonly metars: readonly Metar[]
  readonly tafs: readonly Taf[]
  readonly advisories: readonly Advisory[]
  /** En-route stations, with their distance along the route. */
  readonly stations: readonly { readonly id: string; readonly alongNm: number }[]
}

/** Every weather fact for one planned flight, from data already fetched. Pure. */
export function buildForecast(input: BuildForecastInput): Forecast {
  const { navlog } = input
  const departureMs = Date.parse(navlog.departureTimeUtc)
  const etaMs = Date.parse(navlog.legs.at(-1)?.etaUtc ?? navlog.departureTimeUtc)
  const flight: TimeWindow = { fromMs: departureMs, toMs: etaMs }
  const metarById = new Map(input.metars.map((m) => [m.id.toUpperCase(), m]))
  const tafById = new Map(input.tafs.map((t) => [t.id.toUpperCase(), t]))
  const notes: string[] = []

  const weatherAt = (id: string, role: AirportWeather["role"], alongNm: number, atMs: number): AirportWeather => {
    const metar = metarById.get(id.toUpperCase()) ?? null
    const taf = tafById.get(id.toUpperCase()) ?? null
    if (metar !== null && taf === null) notes.push(`No TAF issued for ${id}`)
    const overlapGust = (taf?.periods ?? [])
      .filter((p) => p.gustKt !== undefined && Date.parse(p.fromUtc) < flight.toMs && Date.parse(p.toUtc) > flight.fromMs)
      .map((p) => p.gustKt as number)
    const gusts = [...overlapGust, ...(metar?.gustKt != null ? [metar.gustKt] : [])]
    return {
      id,
      role,
      alongNm: Math.round(alongNm),
      atUtc: new Date(atMs).toISOString(),
      metar: metar === null ? null : { raw: metar.raw, category: asCategory(metar.flightCategory), observedAt: metar.observedAt },
      taf: taf === null ? null : { raw: taf.raw, validToUtc: taf.validToUtc },
      categoryNow: metar === null ? null : asCategory(metar.flightCategory),
      categoryAtTime: taf === null ? null : categoryAt(taf, atMs, flight),
      gustKt: gusts.length === 0 ? null : Math.max(...gusts),
    }
  }

  const origin = navlog.waypoints[0]
  const destination = navlog.waypoints.at(-1)
  const airports: AirportWeather[] = []
  if (origin) airports.push(weatherAt(origin.id, "origin", 0, departureMs))
  for (const station of [...input.stations].sort((a, b) => a.alongNm - b.alongNm)) {
    airports.push(weatherAt(station.id, "en-route", station.alongNm, timeAtAlong(navlog, station.alongNm)))
  }
  if (destination) airports.push(weatherAt(destination.id, "destination", navlog.totals.distanceNm, etaMs))

  const end = (a: AirportWeather | undefined) => ({
    id: a?.id ?? "",
    taf: a?.taf ? { validFromUtc: tafById.get(a.id.toUpperCase())?.validFromUtc ?? "", validToUtc: a.taf.validToUtc } : null,
  })
  const cov = coverage({
    departureMs,
    etaMs,
    origin: end(airports[0]),
    destination: end(airports.at(-1)),
    legs: legIntervals(navlog),
    windWindows: input.windWindows,
  })
  const advisories = input.advisories.map((a) => toAdvisoryFact(a, departureMs, etaMs))
  return {
    winds: input.winds,
    airports,
    advisories,
    coverage: cov,
    verdictFloor: verdictFloor({
      airports,
      advisories,
      coverage: cov,
      cruiseFt: navlog.altitudeFt,
      reserveMin: navlog.totals.reserveMin,
      reserveOk: navlog.totals.reserveOk,
    }),
    notes: [...new Set(notes)],
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd examples/navlog/server && pnpm exec vitest run test/forecast-build.test.ts test/weather-tools.test.ts && pnpm exec tsc -p . --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add examples/navlog/server/src/lib/forecast examples/navlog/server/src/tools/getMetar.ts examples/navlog/server/test
git commit -m "navlog-server: buildForecast assembles the facts for one flight"
```

### Task 6: The `computeNavlog` tool: two-pass timing, fetch, forecast

**Files:**
- Modify: `examples/navlog/server/src/tools/computeNavlog.ts`
- Modify: `examples/navlog/server/b4.config.ts` (add `noOffloadTools`)
- Test: `examples/navlog/server/test/compute-navlog-tool.test.ts`
- Test: `examples/navlog/server/test/config.test.ts` (create it if it does not exist)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: the tool input `ComputeNavlogInput = Omit<NavlogInput, "winds"> & { stations?: readonly { id: string; alongNm: number }[] }` and the output `Navlog & { forecast: Forecast }`.

- [ ] **Step 1: Write the failing tool test**

Create `examples/navlog/server/test/compute-navlog-tool.test.ts`. It uses the `stubAwc` pattern from `test/route-tools.test.ts`. Read that file first and copy its `json()` helper and fetch-stub style. The stub answers:
- `windtemp` with one FB text per `fcst` value;
- `metar`, `taf`, `gairmet` and `airsigmet` with JSON arrays.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { awc } from "../src/lib/awc.ts"
import computeNavlog from "../src/tools/computeNavlog.ts"

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
// FOR USE windows relative to 2026-10-12: 06 → 1400–2100Z, 12 → 2100–0600Z, 24 → 0600–1800Z.
const fb = (validDdhh: string, forUse: string) =>
  [
    "DATA BASED ON 121200Z",
    `VALID ${validDdhh}00Z   FOR USE ${forUse}Z. TEMPS NEG ABV 24000`,
    "",
    "FT  3000    6000    9000   12000",
    "PDX 9900 2511+07 0217-04 2711-04",
    "RDM      2715+05 0315-05 2821-06",
  ].join("\n")
const ctx = { signal: undefined } as never
const KPDX = { id: "KPDX", kind: "airport" as const, lat: 45.5887, lon: -122.5969, elevationFt: 31, magneticVariationDeg: 16 }
const KBDN = { id: "KBDN", kind: "airport" as const, lat: 44.0946, lon: -121.2002, elevationFt: 3458, magneticVariationDeg: 14 }
const input = {
  aircraft: { tailNumber: "N734ST", cruiseRpm: 2400, usableFuelGal: 50 },
  altitudeFt: 9500,
  departureTimeUtc: "2026-10-12T20:00:00Z",
  waypoints: [KPDX, KBDN],
  stations: [{ id: "KS33", alongNm: 80 }],
}

function stub(windtemp: Record<string, string>) {
  const fetchMock = vi.fn(async (url: string) => {
    const u = new URL(url)
    const p = u.pathname.split("/").at(-1)
    if (p === "windtemp") return new Response(windtemp[u.searchParams.get("fcst") ?? ""] ?? "")
    if (p === "metar") return json(["KPDX", "KS33", "KBDN"].map((id) => ({ icaoId: id, rawOb: `METAR ${id} 121815Z 33006KT 10SM CLR`, fltCat: "VFR", reportTime: "2026-10-12T18:15:00.000Z" })))
    if (p === "taf") return json(["KPDX", "KBDN"].map((id) => ({ icaoId: id, rawTAF: `TAF ${id}`, validTimeFrom: Date.parse("2026-10-12T18:00:00Z") / 1000, validTimeTo: Date.parse("2026-10-13T18:00:00Z") / 1000, fcsts: [{ timeFrom: Date.parse("2026-10-12T18:00:00Z") / 1000, timeTo: Date.parse("2026-10-13T18:00:00Z") / 1000, visib: "6+", clouds: [] }] })))
    return json([])
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

beforeEach(() => {
  awc.clearCache()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-12T18:30:00Z"))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("computeNavlog tool", () => {
  it("takes no winds, uses the forecast at each leg's time, and returns the forecast", async () => {
    stub({ "06": fb("13", "1400-2100"), "12": fb("13", "2100-0600"), "24": fb("13", "0600-1800") })
    const out = await computeNavlog(input as never, ctx)
    expect(out.forecast.winds).toHaveLength(1)
    expect(out.forecast.winds[0]).toMatchObject({ leg: 1, station: "PDX", covered: true })
    expect(out.legs.at(-1)?.wind).toEqual({ dir: out.forecast.winds[0]?.dirDegTrue, kt: out.forecast.winds[0]?.speedKt })
    expect(out.forecast.coverage.preliminary).toBe(false)
    expect(out.forecast.airports.map((a) => a.id)).toEqual(["KPDX", "KS33", "KBDN"])
  })

  it("resolves a bare clock-time departure once, so both passes use the same instant", async () => {
    stub({ "06": fb("13", "1400-2100"), "12": fb("13", "2100-0600"), "24": fb("13", "0600-1800") })
    const out = await computeNavlog({ ...input, departureTimeUtc: "2000Z" } as never, ctx)
    expect(out.departureTimeUtc).toBe("2026-10-12T20:00:00.000Z")
  })

  it("throws a named error when no winds product is published", async () => {
    stub({ "06": "", "12": "", "24": "" })
    await expect(computeNavlog(input as never, ctx)).rejects.toThrow(/no winds-aloft station/i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd examples/navlog/server && pnpm exec vitest run test/compute-navlog-tool.test.ts`
Expected: FAIL. The current tool requires `winds` ("computeNavlog needs one wind entry per leg") and returns no `forecast`.

- [ ] **Step 3: Implement the tool**

Replace `examples/navlog/server/src/tools/computeNavlog.ts`:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { fetchAdvisoriesNear } from "../lib/forecast/advisories.js"
import { buildForecast, legIntervals } from "../lib/forecast/build.js"
import { fetchMetars } from "../lib/forecast/metar.js"
import { fetchTafs } from "../lib/forecast/taf.js"
import type { Forecast, LegWind } from "../lib/forecast/types.js"
import { chooseProduct, fetchWindsProducts, nearestWindsStation, windWindows } from "../lib/forecast/winds.js"
import { parseUtcInstant } from "../lib/fpl.js"
import { computeNavlog as navlogOf, type Navlog, type NavlogInput, type NavlogWaypoint } from "../lib/navlog.js"
import { interpolateWind } from "../lib/winds-aloft.js"

export type ComputeNavlogInput = Omit<NavlogInput, "winds"> & {
  /** The en-route stations findRouteStations returned, with their alongNm. */
  readonly stations?: readonly { readonly id: string; readonly alongNm: number }[]
}

const midpoint = (a: NavlogWaypoint, b: NavlogWaypoint) => ({ lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 })

/**
 * Compute the navlog and its weather in code. Pass the waypoints from
 * lookupAirport and lookupNavaid, the cruise altitude, the departure and the
 * en-route stations from findRouteStations; never pass winds. The tool times
 * every leg, takes the winds aloft forecast for the time each leg is flown,
 * and returns the legs with a forecast block: categories, advisories, whether
 * the forecasts reach the flight (coverage) and the verdict floor. The
 * forecast block is authoritative; narrate it, never recompute it.
 */
export default async (
  input: ComputeNavlogInput,
  ctx: B4ToolContext,
): Promise<Navlog & { readonly forecast: Forecast }> => {
  const now = Date.now()
  // Resolve a clock-time departure once, so every pass times the same flight.
  const departureTimeUtc = parseUtcInstant(input.departureTimeUtc, () => now).toISOString()
  const base: NavlogInput = { ...input, departureTimeUtc, winds: input.waypoints.slice(1).map(() => ({ dirDegTrue: 0, speedKt: 0 })) }
  const products = await fetchWindsProducts("all", ctx.signal)

  const windsFor = (navlog: Navlog): LegWind[] =>
    legIntervals(navlog).map(({ leg, startMs, endMs, midMs }) => {
      const choice = chooseProduct(products, midMs, now)
      const product = choice ? products.get(choice.forecastHours) : undefined
      const from = input.waypoints[leg - 1] as NavlogWaypoint
      const to = input.waypoints[leg] as NavlogWaypoint
      const station = product ? nearestWindsStation(midpoint(from, to), new Set(Object.keys(product.stations))) : null
      if (!choice || !product || !station) {
        throw new Error(`no winds-aloft station in the published products for leg ${leg} (${from.id}–${to.id})`)
      }
      const wind = interpolateWind(product.stations[station.id] as NonNullable<(typeof product.stations)[string]>, input.altitudeFt)
      const inWindow = (ms: number) => windWindows(products, now).some((w) => w.fromMs <= ms && ms <= w.toMs)
      return {
        leg,
        station: station.id,
        altitudeFt: input.altitudeFt,
        dirDegTrue: wind.dirDegTrue,
        speedKt: wind.speedKt,
        tempC: wind.tempC,
        forUseFromUtc: choice.window.fromUtc,
        forUseToUtc: choice.window.toUtc,
        covered: inWindow(startMs) && inWindow(endMs),
      }
    })

  // Pass 1: calm air, for each leg's time. Pass 2: the forecast for those times.
  let winds = windsFor(navlogOf(base, () => now))
  let navlog = navlogOf({ ...base, winds }, () => now)
  // The winds changed the times: re-pick once if any leg's mid-time moved to another product.
  const second = windsFor(navlog)
  if (second.some((w, i) => w.forUseFromUtc !== winds[i]?.forUseFromUtc)) {
    winds = second
    navlog = navlogOf({ ...base, winds }, () => now)
  }

  const stations = input.stations ?? []
  const endIds = [input.waypoints[0], input.waypoints.at(-1)].filter((w) => w?.kind === "airport").map((w) => (w as NavlogWaypoint).id)
  const [metars, tafs, advisories] = await Promise.all([
    fetchMetars([...endIds, ...stations.map((s) => s.id)], ctx.signal),
    fetchTafs([...endIds, ...stations.map((s) => s.id)], ctx.signal),
    fetchAdvisoriesNear(input.waypoints, ctx.signal),
  ])
  const forecast = buildForecast({ navlog, winds, windWindows: windWindows(products, now), metars, tafs, advisories, stations })
  return { ...navlog, forecast }
}

export const display = {
  icon: "tool",
  running: ({ waypoints }) => `Computing the navlog and forecast for ${waypoints.length - 1} leg${waypoints.length === 2 ? "" : "s"}`,
  done: (_input, log) =>
    `Computed the navlog and forecast: ${log.totals.distanceNm} nm, ${log.totals.eteMin} min, ${log.totals.fuelGal} gal, reserve ${Math.round(log.totals.reserveMin)} min, ${log.forecast.verdictFloor.level} floor`,
  sources: (log) => log.sources.map((source) => ({ title: `${source.figure} (${source.path})` })),
} satisfies ToolDisplay<ComputeNavlogInput, Navlog & { readonly forecast: Forecast }>
```

Check: `parseUtcInstant` is exported from `src/lib/fpl.ts` and `navlog.ts` already imports it. Confirm its signature is `(text: string, now?: () => number) => Date`. If it differs, adapt the call; don't change `fpl.ts`.

- [ ] **Step 4: Exempt the tool from offloading, with a test**

In `examples/navlog/server/b4.config.ts`, change `toolOutput` to:

```ts
  // Tool-output offloading. Results above the threshold are spilled to
  // workspace/tool-outputs/ and replaced in-context with a short stub. The
  // Workbench reads computeNavlog's and findRouteStations' results off the
  // wire, so those two are never offloaded, however long the route.
  toolOutput: {
    offloadThresholdChars: 12000,
    previewLines: 10,
    noOffloadTools: ["computeNavlog", "findRouteStations"],
  },
```

Create (or extend) `examples/navlog/server/test/config.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import config from "../b4.config.ts"

describe("b4.config", () => {
  it("never offloads the results the Workbench reads", () => {
    expect(config.toolOutput?.noOffloadTools).toEqual(expect.arrayContaining(["computeNavlog", "findRouteStations"]))
  })
})
```

- [ ] **Step 5: Run the server suite**

Run: `cd examples/navlog/server && pnpm exec vitest run && pnpm exec tsc -p . --noEmit && pnpm lint`
Expected: the new tests pass. `test/navlog.test.ts` (the pure lib) is unchanged and passes.

If any existing test calls the tool `computeNavlog` with `winds`, update it to the new input:
- remove `winds`;
- add the AWC stub from Step 1;
- assert the same fields.

Grep `test/` for `computeNavlog` to find them.

- [ ] **Step 6: Commit**

```bash
git add examples/navlog/server/src/tools/computeNavlog.ts examples/navlog/server/b4.config.ts examples/navlog/server/test
git commit -m "navlog-server: computeNavlog times the legs, fetches their forecast, returns the facts"
```

### Task 7: Retire the weather subagent; coordinator prompt and skill

**Files:**
- Delete: `examples/navlog/server/src/app/navlog/subagents/weather/`
- Modify: `examples/navlog/server/src/app/navlog/index.ts`
- Modify: `examples/navlog/server/src/app/navlog/skills/brief-weather/SKILL.md`
- Modify: `examples/navlog/server/src/app/navlog/subagents/performance/index.ts` (if it names the weather subagent or its tools)
- Regenerate: `examples/navlog/server/.b4/b4.generated.d.ts` (run `pnpm --filter @b4-example/navlog-server check` or `b4 typegen`, whichever the server README names)

**Interfaces:**
- Consumes: Task 6's tool contract (no `winds`; `stations`; `forecast` returned).

- [ ] **Step 1: Delete the subagent**

```bash
git rm -r examples/navlog/server/src/app/navlog/subagents/weather
grep -rn "weather" examples/navlog/server/src/app/navlog --include=*.ts
```

Expected: no remaining reference to a `weather` subagent.

- [ ] **Step 2: Rewrite the coordinator's numbered steps**

In `examples/navlog/server/src/app/navlog/index.ts`, replace steps 5–7 and the BottomLine, WatchFor and Assumptions bullets with the text below. Keep the rest of the prompt as is.

```text
5. Call \`findRouteStations\` with the waypoint identifiers in route order, each with its kind (airport or navaid). Leave corridorNm and max at their defaults unless the pilot asked for a wider or narrower search.
6. Dispatch \`task({ subagent: "performance", input: "<airports, altitude, cruise RPM>" })\`.
7. Call \`computeNavlog\` with the waypoints, the altitude, departureUtc as the departure time, the aircraft from step 1 (tail number, cruise RPM, usable fuel), personsOnBoard and the stations from step 5 (id and alongNm). Never pass winds: the tool takes the forecast for the time each leg is flown. Its \`forecast\` block is authoritative: the winds, each airport's category now and when you are there, the advisories and their relevance, whether the forecasts reach the flight (coverage) and the verdict floor. Narrate it; never recompute it.
```

The answer-format bullets:

```text
- BottomLine: level at least forecast.verdictFloor.level. Raise it only for a reason the facts do not already state (terrain, a lower altitude that avoids icing is not legal), and say that reason; never lower it. The sentence states the floor's most important reason, or your raise.
- WatchFor: up to 3 items from forecast.advisories with relevance during-flight and from forecast.verdictFloor.reasons, each with its altitude in what and its valid window in when; an empty list when nothing applies.
- Assumptions: the departure instant in UTC with its date; people on board ("1 assumed — tell me if different" when the pilot did not say); any baseline value you used. Never state whether the forecast is preliminary: the Workbench shows forecast.coverage.
```

In the Citations bullet, change the weather sources sentence to:

```text
weather products named in forecast (source METAR <ICAO> with locator <time>Z; TAF <ICAO>, AIRMET <hazard> or SIGMET <hazard> with an empty locator)
```

- [ ] **Step 3: Rewrite the brief-weather skill as narration only**

Replace `examples/navlog/server/src/app/navlog/skills/brief-weather/SKILL.md`:

```markdown
---
description: How to narrate computeNavlog's forecast block as a VFR go/no-go brief.
---

# Brief weather

The facts are computed: computeNavlog's `forecast` gives each airport's category now and when you are there, the advisories with their relevance, coverage and the verdict floor. Your job is the words, not the arithmetic.

- Lead with the level and the single most important reason, taken from `forecast.verdictFloor.reasons`. The hazard that matters goes first.
- Quote an airport's raw METAR or TAF when it is the reason, so the pilot can check it.
- A freezing level below the cruise means cruising in below-freezing air. Say so plainly: a 172N has no ice protection.
- Raise the level above the floor only for something the facts do not state, and say what it is. Never lower it.
- When `forecast.coverage.preliminary` is true, close by suggesting a re-brief nearer the departure; do not list it as an assumption.
- A note that should give the pilot pause is better than a cheerful brief.
```

- [ ] **Step 4: Regenerate route types, and check**

Run: `cd examples/navlog/server && pnpm check && pnpm exec tsc -p . --noEmit && pnpm exec vitest run`
Expected: `check` reports the route valid with one subagent (performance), and the tests pass.

If a test pinned the weather subagent (grep `test/` for `subagents/weather` or `"weather"`), delete that assertion, or change it to assert the subagent is absent.

- [ ] **Step 5: Commit**

```bash
git add -A examples/navlog/server/src/app examples/navlog/server/.b4 examples/navlog/server/test
git commit -m "navlog-server: retire the weather subagent; the coordinator narrates the forecast"
```

### Task 8: Evals

**Files:**
- Modify: `examples/navlog/server/src/app/navlog/evals/navlog-quality.fixtures.ts`
- Modify: `examples/navlog/server/src/app/navlog/evals/navlog-quality.eval.ts`

**Interfaces:**
- Consumes: the new `computeNavlog` input (Task 6) and the coordinator flow (Task 7).

- [ ] **Step 1: Update the scripted runs**

In `navlog-quality.fixtures.ts`, inside `planFixtures(plan, judgeMatch)`:
- delete the `.callsTool("task", { subagent: "weather", ... })` call;
- delete the weather subagent's own thread (the `.user(weatherInput)…replies(weatherBrief)` block);
- change the `computeNavlog` call's input to `{ aircraft, altitudeFt, departureTimeUtc, waypoints, stations: [] , personsOnBoard }`, with no `winds`;
- remove any constant used only by the weather thread (`weatherInput`, `WEATHER_BRIEF` and similar). Grep the file for them after editing.

The scripted planning brief (`planBrief(...)`) must not list a preliminary/coverage assumption. Remove any `assumptions` entry whose statement mentions "preliminary" or "coverage".

- [ ] **Step 2: Update the scorers**

In `navlog-quality.eval.ts`:
- remove `toolCalled("task", { withArgs: { subagent: "weather" } })` from `scorers`;
- add the two scorers below. Use the same helper the file already has for reading `computeNavlog`'s result from the run, the one the `navlog-shape` scorer uses. Read the file and reuse it; don't write a second reader.

```ts
const LEVELS = ["GO", "CAUTION", "NO-GO"] as const
const rank = (level: string): number => LEVELS.indexOf(level as (typeof LEVELS)[number])

const bottomLineRespectsFloor = scorer("bottom-line-respects-floor", ({ run }) => {
  const navlog = navlogResult(run) as { forecast?: { verdictFloor?: { level?: string } } } | null
  const floor = navlog?.forecast?.verdictFloor?.level
  const answer = bottomLineLevel(run)
  if (floor === undefined || answer === null) return 0
  return rank(answer) >= rank(floor) ? 1 : 0
})

const noCoverageAssumption = scorer("no-coverage-assumption", ({ run }) => {
  const statements = assumptionStatements(run)
  return statements.some((s) => /prelim|coverage/i.test(s)) ? 0 : 1
})
```

`navlogResult`, `bottomLineLevel` and `assumptionStatements` stand for whatever the file already uses to read the run:
- `navlog-shape` reads the `computeNavlog` result;
- `opens-with-bottom-line` reads the BottomLine;
- `lists-assumptions` reads the Assumptions.

Name and reuse those exact helpers. If one is inline, extract it to a `const` in the same file and use it in both places.

Update the `llmJudge` criteria string's weather sentence so it no longer says "the brief names the flight category at every airport". It should say "the answer's level is at least the computed verdict floor and its reason matches the forecast".

- [ ] **Step 3: Run the evals**

Run: `cd examples/navlog/server && pnpm eval`
Expected: every case `PASS` with mean 1.00. `computeNavlog` reaches aviationweather.gov live during replay, so run this with network access.

- [ ] **Step 4: Commit**

```bash
git add examples/navlog/server/src/app/navlog/evals
git commit -m "navlog-server: evals without the weather subagent; floor and coverage scorers"
```

### Task 9: Web types and selector

**Files:**
- Create: `examples/navlog/web/app/lib/forecast.ts`
- Modify: `examples/navlog/web/app/lib/navlog-types.ts` (add `forecast?: Forecast` to `Navlog`)
- Test: `examples/navlog/web/app/lib/forecast.test.ts`

**Interfaces:**
- Produces:
  - from `forecast.ts`: `Category`, `LegWind`, `AirportWeather`, `AdvisoryFact`, `Coverage`, `VerdictFloor` and `Forecast` (the server's types, re-declared as plain types the way `navlog-types.ts` re-declares `Navlog`);
  - `readForecast(navlog: Navlog | null): Forecast | null`;
  - `windsLine(wind: LegWind): string`;
  - `advisoryLine(advisory: AdvisoryFact): string`.

- [ ] **Step 1: Write the failing test**

Create `examples/navlog/web/app/lib/forecast.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { advisoryLine, readForecast, windsLine } from "./forecast"
import { SAMPLE_NAVLOG } from "./test-fixtures"

const FORECAST = {
  winds: [{ leg: 1, station: "PDX", altitudeFt: 9500, dirDegTrue: 28, speedKt: 17, tempC: -4, forUseFromUtc: "2026-10-12T14:00:00.000Z", forUseToUtc: "2026-10-12T21:00:00.000Z", covered: true }],
  airports: [],
  advisories: [{ product: "G-AIRMET", hazard: "FZLVL", lowestFt: 8000, highestFt: 8000, validFromUtc: "2026-10-12T18:00:00.000Z", validToUtc: "2026-10-13T00:00:00.000Z", relevance: "during-flight" }],
  coverage: { preliminary: false, reasons: [] },
  verdictFloor: { level: "CAUTION", reasons: ["freezing level 8,000 ft during the flight, below the 9,500 ft cruise"] },
  notes: [],
} as const

describe("readForecast", () => {
  it("is the navlog's forecast block, or null for a navlog without one", () => {
    expect(readForecast({ ...SAMPLE_NAVLOG, forecast: FORECAST } as never)).toEqual(FORECAST)
    expect(readForecast(SAMPLE_NAVLOG)).toBeNull()
    expect(readForecast(null)).toBeNull()
  })
  it("rejects a malformed block rather than rendering half of it", () => {
    expect(readForecast({ ...SAMPLE_NAVLOG, forecast: { winds: "no" } } as never)).toBeNull()
  })
})

describe("display lines", () => {
  it("reads one leg's winds", () => {
    expect(windsLine(FORECAST.winds[0])).toBe("leg 1: 028° at 17 kt, −4 °C, 9,500 ft (PDX), for use 1400Z–2100Z")
  })
  it("reads one advisory", () => {
    expect(advisoryLine(FORECAST.advisories[0])).toBe("G-AIRMET FZLVL · 8,000 ft · 1800Z–0000Z · during flight")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd examples/navlog/web && pnpm exec vitest run app/lib/forecast.test.ts`
Expected: FAIL, because it cannot resolve `./forecast`.

- [ ] **Step 3: Implement `forecast.ts`**

Create `examples/navlog/web/app/lib/forecast.ts`. Copy the interfaces from the server's `src/lib/forecast/types.ts` (Task 1, Step 1) verbatim, with `Category = "VFR" | "MVFR" | "IFR" | "LIFR"`, and add:

```ts
import type { Navlog } from "./navlog-types"
import { isRecord } from "./tool-result"

/**
 * The weather facts computeNavlog computed for the navlog on screen, read
 * from its result. Null when the navlog has none (a thread planned before the
 * forecast block) or the block is not well formed; a surface then shows no
 * weather rather than half of it.
 */
export function readForecast(navlog: Navlog | null): Forecast | null {
  const block = (navlog as { forecast?: unknown } | null)?.forecast
  if (!isRecord(block)) return null
  const { winds, airports, advisories, coverage, verdictFloor, notes } = block
  if (!Array.isArray(winds) || !Array.isArray(airports) || !Array.isArray(advisories) || !Array.isArray(notes)) return null
  if (!isRecord(coverage) || !isRecord(verdictFloor)) return null
  return block as unknown as Forecast
}

const ft = (n: number): string => `${n.toLocaleString("en-US")} ft`
const hhmm = (iso: string | null): string => (iso === null ? "…" : `${iso.slice(11, 13)}${iso.slice(14, 16)}Z`)

/** "leg 1: 028° at 17 kt, −4 °C, 9,500 ft (PDX), for use 1400Z–2100Z" */
export function windsLine(w: LegWind): string {
  const temp = w.tempC === null ? "" : `, ${w.tempC < 0 ? "−" : ""}${Math.abs(w.tempC)} °C`
  return `leg ${w.leg}: ${String(w.dirDegTrue).padStart(3, "0")}° at ${Math.round(w.speedKt)} kt${temp}, ${ft(w.altitudeFt)} (${w.station}), for use ${hhmm(w.forUseFromUtc)}–${hhmm(w.forUseToUtc)}`
}

/** "G-AIRMET FZLVL · 8,000 ft · 1800Z–0000Z · during flight" */
export function advisoryLine(a: AdvisoryFact): string {
  const alt = a.lowestFt === null ? "altitude not given" : a.highestFt !== null && a.highestFt !== a.lowestFt ? `${ft(a.lowestFt)}–${ft(a.highestFt)}` : ft(a.lowestFt)
  return `${a.product} ${a.hazard} · ${alt} · ${hhmm(a.validFromUtc)}–${hhmm(a.validToUtc)} · ${a.relevance.replace("-", " ")}`
}
```

In `navlog-types.ts`, add `import type { Forecast } from "./forecast"` and `readonly forecast?: Forecast` to `Navlog`.

- [ ] **Step 4: Run it**

Run: `cd examples/navlog/web && pnpm exec vitest run app/lib/forecast.test.ts && pnpm exec tsc --noEmit`
Expected: PASS. Fix `windsLine` until the test's exact strings hold. The test is the contract.

- [ ] **Step 5: Commit**

```bash
git add examples/navlog/web/app/lib/forecast.ts examples/navlog/web/app/lib/forecast.test.ts examples/navlog/web/app/lib/navlog-types.ts
git commit -m "navlog-web: read computeNavlog's forecast block"
```

### Task 10: Web verdict from the floor

**Files:**
- Modify: `examples/navlog/web/app/lib/verdict.ts`
- Modify: `examples/navlog/web/app/lib/verdict.test.ts`

**Interfaces:**
- Consumes: `Forecast` and `VerdictFloor` from Task 9.
- Produces: `resolveVerdict({ forecast, answer }: { forecast: Forecast | null; answer?: string }): EffectiveVerdict | null`. `effectiveVerdict`, `raiseNote`, `outrankNote` and `isWorse` are unchanged. `verdictFloor` and `maxGustKt` are deleted from the web, because the server computes the floor.

- [ ] **Step 1: Write the failing tests**

Replace the `verdictFloor` and `resolveVerdict` blocks of `app/lib/verdict.test.ts` with these cases, using a `forecast(level, reasons)` helper that builds a minimal `Forecast`:

```ts
describe("resolveVerdict", () => {
  it("shows the floor when the planner's BottomLine is lower, with a raised note", () => {
    const v = resolveVerdict({ forecast: forecast("CAUTION", ["forecast preliminary"]), answer: bottomLine("GO") })
    expect(v).toMatchObject({ level: "CAUTION", raisedFrom: "GO", floorReasons: ["forecast preliminary"] })
    expect(raiseNote(v as EffectiveVerdict)).toBe("Raised from GO: forecast preliminary.")
  })

  it("keeps a planner's level above the floor, with no raised note", () => {
    const v = resolveVerdict({ forecast: forecast("CAUTION", ["freezing level 8,000 ft during the flight, below the 9,500 ft cruise"]), answer: bottomLine("NO-GO") })
    expect(v?.level).toBe("NO-GO")
    expect(raiseNote(v as EffectiveVerdict)).toBeNull()
  })

  it("is the floor alone while the answer is still streaming", () => {
    expect(resolveVerdict({ forecast: forecast("GO", []) })).toBeNull()
    expect(resolveVerdict({ forecast: forecast("NO-GO", ["KBDN IFR at ETA"]) })?.level).toBe("NO-GO")
  })

  it("is the planner's call when there is no forecast block", () => {
    expect(resolveVerdict({ forecast: null, answer: bottomLine("CAUTION") })?.level).toBe("CAUTION")
  })
})
```

`bottomLine(level)` builds a structured answer string with one `BottomLine` component. The file's existing helpers for structured answers (from #1023) already do this, so reuse them.

- [ ] **Step 2: Run to verify it fails**

Run: `cd examples/navlog/web && pnpm exec vitest run app/lib/verdict.test.ts`
Expected: FAIL. `resolveVerdict` takes `weather`/`navlog`, not `forecast`.

- [ ] **Step 3: Implement**

In `app/lib/verdict.ts`:
- delete `verdictFloor`, `maxGustKt`, `VerdictFloorOptions` and the regex constants they use, and every import from `./weather-selectors` and `./advisories`;
- keep `VerdictLevel`, `Verdict`, `RANK`, `effectiveVerdict`, `raiseNote`, `outrankNote`, `isWorse` and `readBottomLine`;
- replace `ResolveVerdictInput` and `resolveVerdict` with:

```ts
/** What `resolveVerdict` reads: the computed facts and the planning answer. */
export interface ResolveVerdictInput {
  /** computeNavlog's forecast block for the navlog on screen. */
  readonly forecast: Forecast | null
  /** The planning answer's text, for its BottomLine. */
  readonly answer?: string | undefined
}

/**
 * The one verdict every surface shows. The planner's BottomLine, raised to
 * the floor computeNavlog computed when it is lower (the "Raised from" note
 * says why); a planner's call above the floor stands, with its own reason.
 */
export function resolveVerdict({ forecast, answer }: ResolveVerdictInput): EffectiveVerdict | null {
  const model = answer ? readBottomLine(answer) : null
  const floor: VerdictFloor = forecast?.verdictFloor ?? { level: "GO", reasons: [] }
  return effectiveVerdict(model, floor)
}
```

Keep the `VerdictFloor` type, which `effectiveVerdict` takes, now imported from `./forecast`.

- [ ] **Step 4: Run it**

Run: `cd examples/navlog/web && pnpm exec vitest run app/lib/verdict.test.ts`
Expected: PASS. The callers fail to typecheck until Task 11; that's expected.

- [ ] **Step 5: Commit**

```bash
git add examples/navlog/web/app/lib/verdict.ts examples/navlog/web/app/lib/verdict.test.ts
git commit -m "navlog-web: the verdict shows the computed floor, never re-derives it"
```

### Task 11: Web surfaces on the forecast; delete the prose parsers

**Files:**
- Modify:
  - `examples/navlog/web/app/components/ThreadWorkbench.tsx`
  - `WorkbenchLayout.tsx`
  - `NavlogSheet.tsx`
  - `WeatherTab.tsx`
  - `MarkerPanel.tsx`
  - `RouteMap.tsx`
  - `VerdictCard.tsx`
  - `RawReport.tsx`
  - `app/brief/components.tsx`
  - `app/lib/map/layers.ts`
  - `app/lib/map/markers.ts`
  - `app/lib/weather-roles.ts`
- Delete:
  - `app/lib/weather-selectors.ts` and `.test.ts`
  - `app/lib/advisories.ts` and `.test.ts`
  - `app/lib/winds.ts` and `.test.ts`
- Modify tests:
  - `WeatherTab.test.tsx`
  - `MarkerPanel.test.tsx`
  - `VerdictCard.test.tsx`
  - `app/lib/weather-roles.test.ts`
  - `app/lib/brief-contract.test.ts`

**Interfaces:**
- Consumes: Task 9 (`readForecast`, `windsLine`, `advisoryLine`, types) and Task 10 (`resolveVerdict({ forecast, answer })`).
- Produces: every component prop that was `weatherBrief: WeatherBrief | null` becomes `forecast: Forecast | null`. `ThreadWorkbench` derives `const forecast = useMemo(() => readForecast(navlog), [navlog])`, and stops reading `latestWeatherBriefText`.

- [ ] **Step 1: Rewrite the component tests against a fixture forecast**

Add `SAMPLE_FORECAST: Forecast` to `app/lib/test-fixtures.ts`. Give it:
- origin KPDX, en-route KS33 and destination KBDN, all VFR;
- one winds line;
- one FZLVL advisory during the flight;
- `coverage: { preliminary: false, reasons: [] }`;
- floor CAUTION with the freezing-level reason.

Then rewrite:
- **`WeatherTab.test.tsx`.** Given `SAMPLE_FORECAST`, the tab shows Origin KPDX, En route KS33 "80 nm along", and Destination KBDN, each with its raw METAR/TAF. It shows exactly one winds line, `windsLine(SAMPLE_FORECAST.winds[0])`, and the advisory line. With `coverage: { preliminary: true, reasons: ["the KBDN TAF ends 1200Z, before the 1315Z ETA"] }`, a notice reads "Preliminary: the KBDN TAF ends 1200Z, before the 1315Z ETA".
- **`MarkerPanel.test.tsx`.** For KBDN it shows its category now and at time, and the raw METAR and TAF from `forecast.airports`.
- **`VerdictCard.test.tsx`.** It shows the floor's level and reasons, and the "Raised from GO" note when the answer said GO.
- **`brief-contract.test.ts`.** Replace any `parseWeatherBrief` input with `SAMPLE_FORECAST`.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd examples/navlog/web && pnpm exec vitest run app/components/WeatherTab.test.tsx app/components/MarkerPanel.test.tsx app/components/VerdictCard.test.tsx`
Expected: FAIL (props mismatch).

- [ ] **Step 3: Rewire the components**

For each component, make these exact changes:
- **`ThreadWorkbench.tsx`:**
  - drop the `latestWeatherBriefText`/`parseWeatherBrief` imports and the `weatherBrief` memo;
  - add `const forecast = useMemo(() => readForecast(navlog), [navlog])`;
  - pass `forecast` where `weatherBrief` was passed.
- **`WorkbenchLayout.tsx`, `NavlogSheet.tsx`:** rename the `weatherBrief` prop to `forecast: Forecast | null` and pass it through. In `WorkbenchLayout`, the map's `categories` record becomes:

  ```ts
  const categories = useMemo(() => {
    const out: Record<string, Category> = {}
    for (const a of forecast?.airports ?? []) {
      const c = a.categoryAtTime ?? a.categoryNow
      if (c !== null) out[a.id] = c
    }
    return out
  }, [forecast])
  ```

  Its marker panel lookup is `forecast?.airports.find((a) => a.id.toUpperCase() === markerKey) ?? null`.
- **`WeatherTab.tsx`:**
  - Group cards by `airport.role`, in the order of `forecast.airports`.
  - Each card shows `metar?.raw` ("No METAR" when null), `taf?.raw` ("No TAF issued" when null), the category pill from `categoryAtTime ?? categoryNow`, and "near departure", "near destination" or "N nm along" from `alongNm`, using `weather-roles.ts`'s existing `groupByRole` thresholds.
  - The winds section maps `forecast.winds` through `windsLine`, and the advisories section maps `forecast.advisories` through `advisoryLine`, with `during-flight` items first.
  - When `forecast.coverage.preliminary`, render `<p className="wb-forecast-note">Preliminary: {reasons.join("; ")}</p>`. Reuse the existing `.wb-forecast-note` style from `styles/status.css`, so no new CSS.
- **`MarkerPanel.tsx`:** its `airport` prop is now the forecast's `AirportWeather | null`. It renders `categoryNow` and `categoryAtTime`, and the two raw reports through `RawReport`.
- **`RawReport.tsx`:** takes `{ label: "METAR" | "TAF"; raw: string | null }`, replacing the `ReportView` from `weather-selectors`. Null shows "No METAR" or "No TAF issued".
- **`VerdictCard.tsx`, `brief/components.tsx`:**
  - call `resolveVerdict({ forecast, answer })`;
  - the advisory chips come from `forecast.advisories.filter((a) => a.relevance === "during-flight")`, labelled by `advisoryLine`;
  - delete the imports from `advisories.ts`.
- **`lib/map/layers.ts`, `lib/map/markers.ts`:** import `Category` from `../forecast` instead of `FlightCategory` from `../weather-selectors`.
- **`lib/weather-roles.ts`:** `RoleEntry.airport` becomes the forecast's `AirportWeather | null`. `groupByRole(navlog, forecast, stations)` takes the forecast. `latestRouteStations` stays as is, since the map still draws the stations before the navlog exists.

Then delete the parsers:

```bash
git rm examples/navlog/web/app/lib/weather-selectors.ts examples/navlog/web/app/lib/weather-selectors.test.ts \
  examples/navlog/web/app/lib/advisories.ts examples/navlog/web/app/lib/advisories.test.ts \
  examples/navlog/web/app/lib/winds.ts examples/navlog/web/app/lib/winds.test.ts
grep -rn "weather-selectors\|lib/advisories\|lib/winds\|from \"./advisories\"\|from \"./winds\"" examples/navlog/web/app
```

Expected: the grep prints nothing.

- [ ] **Step 4: Run the web suite**

Run: `cd examples/navlog/web && pnpm exec vitest run && pnpm exec tsc --noEmit && pnpm lint`
Expected: PASS. `design-rules.test.ts` passes, since no new CSS was added.

- [ ] **Step 5: Commit**

```bash
git add -A examples/navlog/web
git commit -m "navlog-web: Weather tab, map, marker panel and verdict render the computed forecast"
```

### Task 12: Docs, template mirror, brand demo, changeset

**Files:**
- Modify:
  - `examples/navlog/README.md`
  - `examples/navlog/server/README.md`
  - `examples/navlog/web/README.md`
  - `examples/navlog/server/AGENTS.md`
  - the template counterparts under `packages/devkit/templates/app-navlog/` (worded independently)
- Modify (b4.run docs):
  - `apps/web/content/docs/recipes/navlog.mdx`
  - `flight-planner.mdx`
  - `flight-planner-web-ui.mdx`
  - `apps/web/content/docs/subagents.mdx` (if it names the navlog weather subagent)
  - `apps/web/content/docs/evals.mdx`
- Modify:
  - `docs/brand/demo/scenario.mjs`
  - `docs/brand/demo/demo.test.mjs`
  - `docs/brand/demo/storyboard.mjs` (only the comments or beats naming the weather subagent)
  - `docs/brand/demo-rag/overlay.mjs`
- Modify: `packages/devkit/test/templates.test.ts` (the web test-file counts)
- Create: `.changeset/navlog-forecast-facts.md`
- Modify: `AGENTS.md` (the workspace-map row naming "weather and performance subagents")

- [ ] **Step 1: Update the prose**

Grep for every place that describes the old flow:

```bash
grep -rln "weather subagent\|subagents/weather\|weather and performance subagents\|parseWeatherBrief\|weather-selectors\|Winds per leg\|one wind entry per leg" \
  examples/navlog packages/devkit/templates/app-navlog apps/web/content docs/brand AGENTS.md README.md
```

For each hit, describe the new flow:
- `computeNavlog` computes the weather facts at the times it flies;
- the coordinator narrates them;
- the performance subagent is the example's subagent;
- the Workbench renders `forecast`.

`flight-planner.mdx` quotes the coordinator prompt's steps verbatim. Copy steps 5–7 exactly from `src/app/navlog/index.ts` after Task 7.

- [ ] **Step 2: Brand demo**

In `docs/brand/demo/scenario.mjs`:
- remove the weather subagent's scripted thread (`.user(weatherInput)…replies(weatherBrief)`) and the coordinator's `task` weather call;
- change the scripted `computeNavlog` input to drop `winds` and add `stations: []`.

The loopback AWC stub (`docs/brand/demo/awc-stub.mjs`) must answer `windtemp` with `region=all`. Grep it for the region check and allow `all`.

Update `demo.test.mjs`'s assertions that read `weatherBrief`, `parseWeatherBrief` or `parseWindsLine`, so they assert on the `computeNavlog` result's `forecast` instead. Read each failing assertion and keep its intent:
- VFR at both ends;
- one winds entry;
- GO floor.

In `docs/brand/demo-rag/overlay.mjs`, REMOVED already drops the whole `server/src/app/navlog` directory, so the deleted subagent needs no entry. Add `server/src/lib/forecast` and `server/data/winds-stations.json` to REMOVED next to the other flight libraries, and the new server tests (`forecast-category`, `forecast-coverage`, `forecast-advisories`, `forecast-verdict`, `forecast-winds`, `forecast-build`, `compute-navlog-tool`) to its test list, then run its test.

Run:

```bash
pnpm test:brand-demo
node --test docs/brand/demo-rag/demo-rag.test.mjs
```

Expected: both pass.

- [ ] **Step 3: Mirror and pin**

Mirror every change under `examples/navlog/{server,web}` into `packages/devkit/templates/app-navlog`, with `.template` on test and eval files, and delete the template copies of deleted files. A copy of the mirror script used in earlier navlog PRs:

```bash
node - <<'EOF'
const { execFileSync } = require("node:child_process")
const fs = require("node:fs"), path = require("node:path")
const roots = { server: [".env.example","AGENTS.md","b4.config.ts","data","scripts","src","test","workspace"], web: [".env.example",".gitignore","app","data","next.config.mjs","postcss.config.mjs","tsconfig.json","vitest.config.ts"] }
const norm = (s) => s === "gitignore.template" ? ".gitignore" : s.endsWith(".template") ? s.slice(0, -9) : s
const toT = (s) => s === ".gitignore" ? "gitignore.template" : /\.(test|eval)\.tsx?$/.test(s) || s === "tsconfig.json" ? `${s}.template` : s
const ls = (d) => execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "."], { cwd: d, encoding: "utf8" }).split("\n").filter(Boolean).filter((f) => fs.existsSync(path.join(d, f)))
for (const [side, r] of Object.entries(roots)) {
  const ex = `examples/navlog/${side}`, tp = `packages/devkit/templates/app-navlog/${side}`
  const inR = (p) => r.some((x) => p === x || p.startsWith(`${x}/`)) && !/^workspace\/(reports|tool-outputs|flight-plans)/.test(p)
  const exF = new Set(ls(ex).filter(inR)); const tpF = ls(tp).map((f) => ({ f, n: f.split("/").map(norm).join("/") })).filter((x) => inR(x.n))
  const byN = new Map(tpF.map((x) => [x.n, x.f]))
  for (const x of tpF) if (!exF.has(x.n)) fs.rmSync(path.join(tp, x.f))
  for (const f of exF) { const d = path.join(tp, byN.get(f) ?? f.split("/").map((s, i, a) => i === a.length - 1 ? toT(s) : s).join("/")); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.copyFileSync(path.join(ex, f), d) }
}
EOF
find packages/devkit/templates/app-navlog/web -name "*.test.ts.template" | wc -l
find packages/devkit/templates/app-navlog/web -name "*.test.tsx.template" | wc -l
```

Set those two counts in `packages/devkit/test/templates.test.ts` (the `.toHaveLength(...)` values in "normalizes every template-suffixed web path"). Then run:

```bash
pnpm --filter @b4run/devkit exec vitest run
pnpm --filter create-b4-app exec vitest run
```

Expected: both pass.

- [ ] **Step 4: Changeset, lastmod and checks**

Create `.changeset/navlog-forecast-facts.md`:

```markdown
---
"@b4run/devkit": patch
"create-b4-app": patch
---

The navlog template computes its weather facts in code. `computeNavlog` no longer takes winds: it times each leg, takes the winds-aloft forecast for the time that leg is flown, and returns a `forecast` block with each airport's category now and when you are there, the advisories and their relevance, whether the forecasts reach the flight, and the verdict floor. The weather subagent is retired: the coordinator narrates the computed facts, and the Workbench renders them instead of parsing prose.
```

Then run:

```bash
git add -A examples/navlog packages/devkit apps/web/content docs/brand AGENTS.md .changeset/navlog-forecast-facts.md
git commit -m "navlog: docs, template mirror and brand demo for the computed forecast"
pnpm --dir apps/web seo:lastmod && git add apps/web/app/seo/lastmod.generated.json && git commit -m "chore(web): regenerate the SEO lastmod manifest"
pnpm lint && pnpm build && pnpm typecheck && node scripts/check-docs.mjs && pnpm --filter @b4run/web exec vitest run
```

Expected: all pass. If `check-docs` flags a quoted prompt block in `flight-planner.mdx`, recopy it from the source.

### Task 13: Live verification and PR 2

- [ ] **Step 1: Run the definition-of-done check locally**

Start both servers: `preview_start` with `navlog-server`, then `navlog-web`. In Chrome against `http://localhost:3010`, open a new plan and plan KPDX → KBDN at 9,500 ft, departing 2000Z. When the run is Ready, check each of these:
- the step list shows no weather subagent, and `computeNavlog`'s label ends with "… floor";
- the Weather tab shows Origin KPDX, the en-route stations near the course, and Destination KBDN with its METAR and TAF;
- the winds section shows exactly one line, for leg 1;
- no Assumptions row mentions "preliminary" or "coverage", and when `forecast.coverage.preliminary` is false no Preliminary notice shows;
- the verdict card's level is at least the computed floor (read it with `JSON.parse` of the `computeNavlog` result in the page if needed).

- [ ] **Step 2: Open PR 2, then merge on green**

Push the branch and open the PR, with the KPDX → KBDN before/after in the body. Enable auto-merge (squash).

- [ ] **Step 3: Verify in production**

After the merge, wait for `deploy-navlog.yml` (Railway) and both Vercel deploys to succeed. Repeat Step 1's plan on https://navlog-web.vercel.app and confirm the same five checks.

---

## PR 3: Demo re-record (follow-up)

### Task 14: Re-record the README video

- [ ] **Step 1:** Run `pnpm media:readme:capture`, then `node docs/brand/demo/check-media.mjs --local`. Expected: the check passes, and frames show no weather subagent step.
- [ ] **Step 2:** Upload. Read `BLOB_READ_WRITE_TOKEN` from the b4-run Vercel project (the `VERCEL_API_TOKEN` is in the repo-root `.env`; the method is in the session memory notes). Run `pnpm media:readme:upload -- --apply` with `B4_MEDIA_PUBLIC_BASE_URL=https://9rq8ezyghevy0wop.public.blob.vercel-storage.com`, and commit the refreshed poster.
- [ ] **Step 3:** Ask Brian to attach the new MP4 through github.com and send the `user-attachments` URL. Then:
  - replace it in `README.md`, `scripts/lib/readme-contracts.mjs` and `scripts/readme-contracts.test.mjs`;
  - repin `scripts/release/test/fixtures/release-script-hashes.json` and `STARTING_SCRIPT_PIN_SHA256` in `scripts/release/test/workflow-contracts.test.mjs`, with a repin-log comment line;
  - run `pnpm test:release-controller`;
  - open the PR and merge on green.

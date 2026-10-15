# Navlog forecast facts in code

**Status:** design approved in conversation 2026-10-12; spec for review.
**Scope:** `examples/navlog` (server and web) and its mirror in `packages/devkit/templates/app-navlog`, plus the docs, evals and brand demo that describe it.

## Problem

A production plan (KPDX → KBDN, 9,500 ft, departing 2000Z) contradicted itself. The weather brief said "Departure is within TAF and winds-aloft coverage", and the planning answer listed "Winds-aloft coverage is preliminary" as an assumption.

Two model calls decided the same fact independently, from different readings of one prompt rule:

- The weather subagent judged coverage **before** the navlog existed, from an ETA it estimated at about 100 kt, and checked only the departure time.
- The coordinator judged it again **after** `computeNavlog`, from the real ETA (2102Z), and saw that it fell past the 6-hour winds product's window (until 2100Z).

Neither is a prompt typo. The prompts ask models to do deterministic arithmetic, and two models doing the same arithmetic from different inputs disagree. The same pattern runs through the weather subagent's prompt:

- the flight category at the ETA, from TAF periods;
- each advisory's relevance to the flight window;
- the GO / CAUTION / NO-GO thresholds;
- the forecast horizon.

Downstream, the web re-derives these facts again by regex over the subagent's prose (`web/app/lib/weather-selectors.ts`, `verdict.ts`'s `verdictFloor`). A related defect: the coordinator copies each leg's winds from the subagent's prose into `computeNavlog`. That's the same copy-by-hand error class that once shifted a route's coordinates.

Patching the prompt again would move the disagreement somewhere else. The fix is to put each fact in exactly one place.

## Principle

**Code computes facts once, from tool data. The coordinator narrates them. The web renders them.**

A rule that is time arithmetic, a threshold or a lookup lives in a tested function. It never lives in a prompt, and is never parsed back out of prose.

## Decisions

| Decision | Choice |
|---|---|
| Scope | All deterministic weather facts: forecast coverage, category at a time, advisory relevance, verdict floor, winds per leg. |
| "Preliminary" | True when the origin TAF does not cover the departure, the destination TAF does not cover the ETA, or a leg's flying interval is not covered by the published winds-aloft windows. |
| Who owns timed facts | `computeNavlog`, the only component that knows each leg's times. |
| Weather subagent | Retired. The coordinator narrates from `computeNavlog`'s `forecast`. The performance subagent remains the example's subagent. |
| Verdict | `forecast.verdictFloor` is a floor. The model may raise the BottomLine level with a stated reason, never lower it. The web enforces and displays this. |
| Demo video | A separate follow-up (PR 3). |

## Design

### Flow

Before:

```
baseline + recall → resolveDeparture → lookups → findRouteStations
  → task(weather) ∥ task(performance) → computeNavlog(winds copied from prose) → answer
```

After:

```
baseline + recall → resolveDeparture → lookups → findRouteStations
  → task(performance) → computeNavlog({ waypoints, altitudeFt, departureTimeUtc, aircraft, stations })
  → answer (narrates navlog + forecast)
```

`computeNavlog`'s input loses `winds` and gains `stations`, the en-route station ids `findRouteStations` returned. The model passes identifiers and the numbers it already has; it never transcribes weather.

### Timing and winds inside `computeNavlog`

The leg times depend on the winds, and the choice of winds product depends on the times. Two passes resolve it:

1. Time every leg with no wind, at the POH true airspeed, to get each leg's interval.
2. Fetch the winds-aloft products (6-, 12- and 24-hour, `region=all`, one request each, cached by the AWC client). For each leg, take the wind at the station nearest the leg's midpoint, from the product whose FOR USE window contains the leg's mid-time.
3. Compute the navlog with those winds. That gives the final leg intervals and ETA.
4. If a leg's mid-time now falls in a different product's window, refetch that leg's wind once and recompute. The windows are hours wide, so one correction is enough. If it still differs, keep the second result and note it in `forecast.notes`.

**Climb.** The climb segment uses the same station's wind at the cruise altitude, as the navlog does today.

**Station positions.** A committed `server/data/winds-stations.json` maps each FB station id to its position. It is built by `server/scripts/build-winds-stations.mjs`:
- VORs come from the bundled navaid snapshot (121 of 176 stations).
- Airports come from AWC airport records, K-prefixed (most of the rest).
- The offshore Gulf points (H51, H52, H61) cannot be placed from either source. They are listed as unresolved and left out of station selection: a VFR 172 plan never needs a Gulf point.

`nearestWindsStation(position)` is a pure function over that table. No region choice remains: `region=all` covers the contiguous US. Alaska and Hawaii stay out of scope, matching the 172N demo's corpus.

### The `forecast` block

`computeNavlog` returns `Navlog & { forecast: Forecast }`:

```ts
interface Forecast {
  /** One per leg, in order. The legs' wind fields come from here. */
  readonly winds: readonly LegWind[]
  /** Origin, then en-route stations by alongNm, then destination. */
  readonly airports: readonly AirportWeather[]
  readonly advisories: readonly AdvisoryFact[]
  readonly coverage: { readonly preliminary: boolean; readonly reasons: readonly string[] }
  readonly verdictFloor: { readonly level: "GO" | "CAUTION" | "NO-GO"; readonly reasons: readonly string[] }
  /** Facts the brief should mention but that change no level: "No TAF issued for KTTD", a refetched wind. */
  readonly notes: readonly string[]
}

interface LegWind {
  readonly leg: number            // 1-based
  readonly station: string        // FB id, e.g. "PDX"
  readonly altitudeFt: number
  readonly dirDegTrue: number
  readonly speedKt: number
  readonly tempC: number | null
  readonly forUseFromUtc: string
  readonly forUseToUtc: string
  readonly covered: boolean       // the leg's interval lies inside the union of published windows
}

interface AirportWeather {
  readonly id: string
  readonly role: "origin" | "en-route" | "destination"
  readonly alongNm: number
  /** When the flight is there: the departure, the pass time, or the ETA. */
  readonly atUtc: string
  readonly metar: { readonly raw: string; readonly category: Category; readonly observedAt: string } | null
  readonly taf: { readonly raw: string; readonly validToUtc: string } | null
  readonly categoryNow: Category | null
  readonly categoryAtTime: Category | null   // null: no TAF, or the TAF does not reach atUtc
  readonly gustKt: number | null              // the highest gust in the METAR or the TAF periods overlapping the flight window
}

interface AdvisoryFact {
  readonly product: "G-AIRMET" | "AIRMET" | "SIGMET"
  readonly hazard: string           // the AWC hazard code: ICE, FZLVL, TURB-LO, CONVECTIVE, …
  readonly lowestFt: number | null
  readonly highestFt: number | null
  readonly validFromUtc: string
  readonly validToUtc: string | null
  readonly relevance: "during-flight" | "before-departure" | "after-arrival"
}
```

**Size.** The web reads `computeNavlog`'s and `findRouteStations`' results inline, so neither may ever be offloaded. `b4.config.ts` lists both in `toolOutput.noOffloadTools`, the runtime's per-tool exemption, which always includes `readFile` and `listDir`. Offloading stays on for every other tool, so the example still demonstrates it. With that exemption, the block's size needs no limit or trimming. A long route's navlog stays in the model's context in full, as it does today.

### Rules: `server/src/lib/forecast/`

Each rule is a pure function with unit tests. None takes a network or clock argument.

**`coverage(input) → { preliminary, reasons }`**, with three checks:
- **Origin.** The origin TAF covers the departure: `validFrom ≤ departure < validTo`.
- **Destination.** The destination TAF covers the ETA.
- **Winds.** Each leg's flying interval `[start, end]` lies inside the union of the published FOR USE windows. The 6-, 12- and 24-hour products are published together and their windows abut, so a leg straddling two windows is covered.
- **Not counted:** an airport that issues no TAF at all. That's a permanent fact, not a forecast that hasn't been published yet, and it goes to `notes`.
- **Reasons name the gap**, e.g. "winds for leg 2 are forecast until 0600Z; the leg ends 0618Z" or "the KBDN TAF ends 1200Z, before the 1315Z ETA".
- **Today's case:** KPDX → KBDN, departing 2000Z with the ETA at 2102Z, is **not** preliminary. The 2100–2102Z tail falls inside the 12-hour product's window, and both TAFs reach the times they need.

**`categoryAt(taf, at, window) → Category | null`**
- The BASE or FM period whose `[fromUtc, toUtc)` contains `at` gives the base category.
- Any TEMPO, BECMG or PROB period that overlaps `window` makes it worse.
- `null` when no period contains `at`.
- `window` is the flight window (departure to ETA) for every airport, the same as today's prompt rule.

**`advisoryRelevance(advisory, departure, eta)`**
- `during-flight` when `validFrom < eta` and (`validTo` is absent, or `validTo > departure`).
- `before-departure` when `validTo ≤ departure`.
- `after-arrival` when `validFrom ≥ eta`.

**`verdictFloor(facts, navlog) → { level, reasons }`.** This moves the web's `verdictFloor` rules to typed data, and adds the prompt's NO-GO rules that code can decide.

| Level | When |
|---|---|
| NO-GO | Origin IFR/LIFR at departure, or destination IFR/LIFR at the ETA |
| NO-GO | Reserve under 45 min (`reserveOk` false) |
| NO-GO | A convective SIGMET during the flight |
| NO-GO | An icing advisory during the flight whose altitude band includes the cruise altitude |
| CAUTION | MVFR at the origin or the destination, now or at its time |
| CAUTION | An en-route station IFR, LIFR or MVFR at its pass time |
| CAUTION | A gust over 20 kt at the origin or the destination, in its METAR or in a TAF period overlapping the flight window |
| CAUTION | `coverage.preliminary` |
| CAUTION | A freezing level within 2,000 ft of the cruise altitude, or below it, during the flight |
| CAUTION | An LLWS, turbulence or icing advisory during the flight that is not already NO-GO |

"No lower legal VFR altitude avoids it" stays a model judgement. The floor never asserts it: the model may raise CAUTION to NO-GO for terrain or icing with a stated reason.

**`nearestWindsStation(position, table)`.** The great-circle nearest station in the committed table.

The current `getWindsAloft` product-window selection (`chooseProduct`) moves into `lib/forecast/winds.ts` unchanged. `getWindsAloft` becomes a thin wrapper over it.

### Tools

| Tool | Change |
|---|---|
| `computeNavlog` | Input: `{ aircraft, altitudeFt, departureTimeUtc, waypoints, stations, personsOnBoard? }`, with no `winds`. Fetches METAR, TAF, winds and advisories through the cached AWC client and returns `Navlog & { forecast }`. Its step label reads "Computed the navlog and forecast: 108 nm, 62 min, …". If the AWC data is unavailable it throws a named error and never computes with invented weather. |
| `getMetar`, `getTaf`, `getAdvisories`, `getWindsAloft` | Kept as tools, for questions outside planning ("what's the TAF at KSBA?"). They share `lib/forecast` and `lib/awc` with `computeNavlog`, so an answer and a navlog read the same cached data. |
| `findRouteStations` | Unchanged; its ids feed `computeNavlog`'s `stations`. |

### Agent and prompts

- **Deleted:** `server/src/app/navlog/subagents/weather/`, with its prompt and its tool scope.
- **Rewritten:** the coordinator's `skills/brief-weather/SKILL.md`. Today it repeats the arithmetic: flight-category thresholds, reading the TAF at the ETA, the coverage horizon, advisory relevance and passing winds to `computeNavlog`. It becomes narration-only guidance:
  - lead with the floor's most important reason;
  - quote the raw METAR and TAF;
  - say a below-freezing cruise plainly;
  - raise the level only for a reason the facts do not state;
  - suggest a re-brief when `coverage.preliminary`.
- **Coordinator prompt, removed:**
  - the weather `task` step and the "one wind entry per leg from the weather brief" instruction;
  - "use the weather brief's verdict";
  - the "preliminary" Assumptions rule.
- **Coordinator prompt, added, stated once as a contract rather than as arithmetic:**
  - `computeNavlog` returns `forecast`, and its facts are authoritative.
  - BottomLine is at least `forecast.verdictFloor.level`. Raise it only with a reason the facts do not already state.
  - WatchFor comes from `forecast.advisories` with relevance `during-flight` and the floor's reasons.
  - Never restate coverage as an assumption: the Workbench shows it.
  - Cite the METAR, TAF and advisory products named in `forecast`.
- **Brief kit schema:** unchanged.

### Web

- **New selector.** `web/app/lib/forecast-selectors.ts`: `latestForecast(turns)` reads `forecast` from the latest `computeNavlog` result.
- **Weather tab and marker panels.** Render `forecast.airports` (role, METAR, TAF, category now and at its time), `forecast.winds` (one line per leg) and `forecast.advisories`. A coverage notice shows `forecast.coverage.reasons` when `preliminary` is true.
- **`weather-selectors.ts` is deleted.** Its prose parser has no input left. `advisories.ts` and `winds.ts` from #1023 are replaced by typed renderers, or removed if nothing needs them.
- **`verdict.ts`.** Shows `forecast.verdictFloor` and the model's BottomLine. When the model's level is lower than the floor, the displayed level is the floor, with "Raised from …" (the existing behaviour, now fed by typed reasons). It no longer computes the floor.
- **`MarkerPanel`, `WeatherTab`, `VerdictCard`, `RouteMap` categories.** Read `forecast`. Map marker colours come from `categoryAtTime ?? categoryNow`.

### Evals

- **Fixtures.** `navlog-quality.fixtures.ts` drops the weather subagent's thread and the coordinator's weather `task` call. `computeNavlog`'s scripted input loses `winds` and gains `stations`.
- **Scorers removed:** `toolCalled(task, { subagent: "weather" })`.
- **Scorers added:**
  - `bottom-line-respects-floor`: the answer's BottomLine level is at least the `computeNavlog` result's `verdictFloor.level`.
  - `no-coverage-assumption`: Assumptions never mention preliminary or coverage.
- **Judge.** The `llmJudge` criteria are updated to the new brief.
- **Network.** `computeNavlog` reaches aviationweather.gov during replay, as the weather tools do today. The scorers check structure and consistency, not live values.

### Docs, template, demo

- **Docs to update:**
  - `examples/navlog/README.md`, `server/README.md`, `web/README.md` and `server/AGENTS.md`;
  - their template counterparts, worded independently;
  - the b4.run pages: Navlog Example App, Build a Flight Planner, Flight Planner Web UI, Subagents and Evals. Each describes the flow and the subagents.
- **Template.** The mirror stays byte-for-byte. The devkit template pins and `docs/brand/demo-rag/overlay.mjs`'s REMOVED list (the weather subagent path) are updated.
- **Brand demo, PR 2.** The scenario script and the capture beats lose the weather subagent, and `pnpm test:brand-demo` is kept passing.
- **Brand demo, PR 3.** Re-recording the video and replacing the README video are their own follow-up, as agreed.

## Testing

- **Pure rules.** Unit tests per `lib/forecast/*` rule. They use table cases from real AWC payloads, including today's KPDX → KBDN, which is not preliminary. Edge cases:
  - a leg straddling two winds windows;
  - a TAF ending 1 minute before the ETA;
  - an advisory with no `validTo`;
  - an airport with no TAF;
  - TEMPO worsening at the edge of the window.
- **`computeNavlog`.** Tested with a stubbed AWC (the `route-tools.test.ts` pattern):
  - the two-pass timing;
  - the one-time refetch when a leg's mid-time changes product;
  - a named error when the winds are unavailable;
  - a config test asserting that `computeNavlog` and `findRouteStations` are in `noOffloadTools`.
- **Web.** Selector and component tests render the Weather tab, the verdict and the coverage notice from a fixture `forecast`. The existing `WeatherTab`, `VerdictCard` and `MarkerPanel` tests are rewritten against it.
- **Live check, the definition of done.** The same KPDX → KBDN plan, locally and in production:
  - every place says the same thing about coverage;
  - the winds show one line per leg;
  - BottomLine is at least the floor;
  - the Weather tab matches `forecast`.

## Delivery

1. **PR 1, `lib/forecast/` and the station data** (nothing user-facing):
   - the rules with their tests;
   - `build-winds-stations.mjs` and `data/winds-stations.json`;
   - `getWindsAloft` refactored onto `lib/forecast/winds.ts`, with no behaviour change.
2. **PR 2, the cut-over:**
   - `computeNavlog` with `forecast`, and the weather subagent retired;
   - the coordinator prompt;
   - the web on `forecast`;
   - evals, docs, the template mirror and the brand-demo scenario;
   - verified live, locally and in production.
3. **PR 3, the demo:** re-capture the README video, upload it to Blob, re-attach it to the README, and repin `readme-contracts.mjs`.

## Risks

- **Model compliance with the floor.** The model can still write a lower BottomLine. The web enforces the floor on display, and the eval scorer catches it in replay. Prompt wording is no longer load-bearing for correctness.
- **Tool result size.** The `noOffloadTools` exemption means a large forecast block is never replaced by a stub. The cost is context length on very long routes, unchanged from today.
- **AWC availability.** `computeNavlog` now depends on aviationweather.gov, as the weather subagent did. One failure surface replaces several, and the error names the product that failed.
- **Station table drift.** The FB station list changes rarely. The build script reports any station in a live product that is missing from the table, and a test pins the table against a recorded product.

# Navlog PR 4: the map-dominant Workbench

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `examples/navlog/web` (and its devkit template mirror) into the map-dominant flight-planning Workbench from spec section 5: a full-viewport Leaflet map, a floating chat dock, a flight-category weather strip with colored airport markers, and a bottom navlog sheet with the form, the ICAO flight plan, the brief and print/copy actions, with a phone layout.

**Architecture:** The client keeps CopilotKit and its own `Transcript`, `Composer`, `ThreadRail`, `MemoryPanel` and permission cards; PR 4 re-homes them inside a dock and adds three surfaces. Every new surface is fed by a pure selector over data the client already has: `latestNavlog(messages)` reads the most recent `computeNavlog` tool result, `latestWeatherBrief(runs)` reads the `weather` subagent's result, and `routeGeometry(navlog)` turns legs into map data. Leaflet is loaded in one client-only component behind `next/dynamic`; everything else renders on the server and is unit-tested with `renderToStaticMarkup`, the suite's existing pattern. The map-dominant layout is CSS: the map is `position: fixed; inset: 0`, the surfaces are absolutely positioned over it, and a `md:` breakpoint turns the dock and sheet into one tabbed bottom sheet on phones.

**Tech Stack:** Next.js 16 (app router), React 19, Tailwind 4 (`@theme inline` tokens in `app/theme.css`), CopilotKit 1.76 (`useRenderTool`, `useAgent`), `@b4run/ag-ui/react` (`useSubagentRuns`), Leaflet 1.9 with OpenStreetMap tiles, Vitest with `renderToStaticMarkup`.

**Spec:** `docs/superpowers/specs/2026-10-04-navlog-example-design.md` section 5. **Mockup:** `.superpowers/brainstorm/70001-1791084588/content/layout-v2.html` in the controller's worktree (gitignored): open it in a browser for the intended look.

**Branch:** `blove/navlog-web` from `origin/main` after PR 3 merges (the starter prompts, `computeNavlog` and the `weather` subagent exist from PR 3).

**Template mirror rule:** the devkit parity test requires `packages/devkit/templates/app-navlog/web/app/` to mirror `examples/navlog/web/app/` byte for byte, with test files as `*.test.ts.template` / `*.test.tsx.template`. After each task:

```bash
rsync -a --delete --exclude "*.test.ts" --exclude "*.test.tsx" examples/navlog/web/app/ packages/devkit/templates/app-navlog/web/app/
for f in $(cd examples/navlog/web && find app -name "*.test.ts" -o -name "*.test.tsx"); do cp "examples/navlog/web/$f" "packages/devkit/templates/app-navlog/web/$f.template"; done
for f in $(cd packages/devkit/templates/app-navlog/web && find app -name "*.template"); do [ -f "examples/navlog/web/${f%.template}" ] || rm "packages/devkit/templates/app-navlog/web/$f"; done
pnpm --filter @b4run/devkit test
```

`package.json.template` is edited by hand when `package.json` changes (Task 1). The parity test also pins the count of `.test.ts.template` files under `web/` (`templates.test.ts`, "normalizes every template-suffixed web path"); bump that number when you add test files.

**Harness contract this PR must keep** (the W7/W8 journeys in `test/harness/workbench-suggestions.ts` and `test/generated/run-generated-research-activation.test.ts` drive this UI in Chromium and are in `validate`): the transcript stays inside `<main>`; the three starter prompts are `role="button"` elements whose names start with the suggestion titles; the memory panel keeps its heading, candidate rows and Approve button names; the permission card keeps `role="alert"` and its Approve control; the subagent card stays a `<details>` whose summary reads `<name> · completed · N tool(s)`; tool cards keep the tool name as visible text. Anything else may move. Run `pnpm verify:harness:framework` before opening the PR and adjust locators in the harness only where a locator depended on layout, never on the names above.

**Run every command from the repo root with Node 24.** Format with `pnpm --filter @b4-example/navlog-web lint` (its script is scoped) or `pnpm exec biome format --write --config-path packages/config-biome/biome.json <files>`.

---

## File structure

```
examples/navlog/web/
  package.json                      + leaflet, @types/leaflet
  app/theme.css                     + layout tokens, flight-category tokens, map filter, print
  app/layout.tsx                    + leaflet.css import, title
  app/page.tsx                      registers NavlogCard beside ToolCallCard
  app/lib/
    navlog-types.ts                 the Navlog shape the client renders (mirrors the server's output)
    navlog-selectors.ts             latestNavlog(messages), parseNavlog(text)
    weather-selectors.ts            latestWeatherBrief(runs), flightCategory parsing, category tokens
    route-geometry.ts               polyline, markers, bounds, leg midpoints from a Navlog
    format.ts                       hhmm, nm, gal, headings with leading zeros
  app/components/
    AppShell.tsx                    returns <WorkbenchLayout …/> instead of the two-column shell
    WorkbenchLayout.tsx             fixed map + dock + strip + sheet + phone tabs
    RouteMap.tsx                    Leaflet, client-only, draws from route-geometry
    ChatDock.tsx                    header (brand, thread menu, memory toggle) + Transcript + Composer
    WeatherStrip.tsx                category chips + winds line + station popover
    NavlogSheet.tsx                 totals bar, actions, table/cards, FlightPlanBlock, brief
    NavlogTable.tsx                 the legs table (desktop) and leg cards (phone)
    FlightPlanBlock.tsx             items 7..19 as a form, copy button
    NavlogCard.tsx                  useRenderTool({ name: "computeNavlog" }) → compact card in the transcript
    EmptyState.tsx                  floats the suggestions over the map
```

---

## Task 1: dependencies, tokens, layout shell

**Files:**
- Modify: `examples/navlog/web/package.json`, `packages/devkit/templates/app-navlog/web/package.json.template`
- Modify: `examples/navlog/web/app/theme.css`, `app/layout.tsx`
- Regenerate: `pnpm-lock.yaml`

- [ ] **Step 1: Add Leaflet**

In `package.json` `dependencies` add `"leaflet": "^1.9.4"`; in `devDependencies` add `"@types/leaflet": "^1.9.12"`. Mirror both lines into `package.json.template`. Then:

```bash
pnpm install
grep -n "leaflet" pnpm-lock.yaml | head -3
```

Expected: the importer `examples/navlog/web` lists both.

- [ ] **Step 2: Theme tokens**

Append to `app/theme.css` after the `:root[data-wb-theme="dark"]` block:

```css
/*
 * Layout tokens for the map-dominant workbench. The map fills the viewport;
 * the dock, the weather strip and the navlog sheet float over it.
 */
:root {
  --wb-dock-width: min(380px, 34vw);
  --wb-sheet-max: 46vh;
  --wb-gutter: 16px;
  --wb-route: #2563eb;
  --wb-cat-vfr: #15803d;
  --wb-cat-mvfr: #1d4ed8;
  --wb-cat-ifr: #b91c1c;
  --wb-cat-lifr: #9d174d;
  --wb-cat-vfr-bg: #dcfce7;
  --wb-cat-mvfr-bg: #dbeafe;
  --wb-cat-ifr-bg: #fee2e2;
  --wb-cat-lifr-bg: #fce7f3;
}

@media (prefers-color-scheme: dark) {
  :root:not([data-wb-theme="light"]) {
    --wb-route: #60a5fa;
    --wb-cat-vfr: #4ade80;
    --wb-cat-mvfr: #93c5fd;
    --wb-cat-ifr: #fca5a5;
    --wb-cat-lifr: #f9a8d4;
    --wb-cat-vfr-bg: #052e16;
    --wb-cat-mvfr-bg: #172554;
    --wb-cat-ifr-bg: #450a0a;
    --wb-cat-lifr-bg: #500724;
  }
}

:root[data-wb-theme="dark"] {
  --wb-route: #60a5fa;
  --wb-cat-vfr: #4ade80;
  --wb-cat-mvfr: #93c5fd;
  --wb-cat-ifr: #fca5a5;
  --wb-cat-lifr: #f9a8d4;
  --wb-cat-vfr-bg: #052e16;
  --wb-cat-mvfr-bg: #172554;
  --wb-cat-ifr-bg: #450a0a;
  --wb-cat-lifr-bg: #500724;
}

/* The OpenStreetMap tiles, muted in light mode and inverted in dark mode so the route carries the color. */
.wb-map .leaflet-tile-pane {
  filter: saturate(0.55) contrast(0.95);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-wb-theme="light"]) .wb-map .leaflet-tile-pane {
    filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9) saturate(0.6);
  }
}

:root[data-wb-theme="dark"] .wb-map .leaflet-tile-pane {
  filter: invert(1) hue-rotate(180deg) brightness(0.9) contrast(0.9) saturate(0.6);
}

.wb-map .leaflet-container {
  background: var(--wb-bg);
  font: inherit;
}

.wb-map .wb-wp-label {
  border: 1px solid var(--wb-border);
  border-radius: 6px;
  background: var(--wb-surface);
  padding: 1px 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--wb-text);
  white-space: nowrap;
}

.wb-map .wb-hdg-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--wb-route);
  white-space: nowrap;
  text-shadow: 0 0 3px var(--wb-surface), 0 0 3px var(--wb-surface);
}

/* A floating surface over the map. */
.wb-panel {
  border: 1px solid var(--wb-border);
  border-radius: var(--wb-radius);
  background: var(--wb-surface);
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.08);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-wb-theme="light"]) .wb-panel {
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.4);
  }
}

/* Flight-category chips and markers. Color never stands alone: every chip carries its text. */
.wb-cat {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 4px 10px;
  font-size: 12px;
  font-weight: 600;
}
.wb-cat[data-cat="VFR"] { background: var(--wb-cat-vfr-bg); color: var(--wb-cat-vfr); }
.wb-cat[data-cat="MVFR"] { background: var(--wb-cat-mvfr-bg); color: var(--wb-cat-mvfr); }
.wb-cat[data-cat="IFR"] { background: var(--wb-cat-ifr-bg); color: var(--wb-cat-ifr); }
.wb-cat[data-cat="LIFR"] { background: var(--wb-cat-lifr-bg); color: var(--wb-cat-lifr); }
.wb-cat[data-cat="UNKNOWN"] { background: var(--wb-rail); color: var(--wb-muted); }

/* Motion: subtle, and none under reduced motion. */
.wb-sheet,
.wb-dock {
  transition: transform 240ms ease, opacity 240ms ease;
}
@media (prefers-reduced-motion: reduce) {
  .wb-sheet,
  .wb-dock {
    transition: none;
  }
}

/* Print: the navlog sheet alone, one landscape page. */
@media print {
  @page { size: landscape; margin: 12mm; }
  body * { visibility: hidden; }
  .wb-sheet, .wb-sheet * { visibility: visible; }
  .wb-sheet { position: static !important; max-height: none !important; box-shadow: none !important; border: 0 !important; }
  .wb-sheet-actions, .wb-sheet-grip, .wb-sheet-tabs { display: none !important; }
}
```

- [ ] **Step 3: Layout**

`app/layout.tsx`: add `import "leaflet/dist/leaflet.css"` before `./theme.css`, and change the title to `"B4.run navlog — a C172N VFR flight planner"`.

- [ ] **Step 4: Lint, mirror, commit**

```bash
pnpm --filter @b4-example/navlog-web lint && pnpm --filter @b4-example/navlog-web typecheck
```
Run the mirror block; then:

```bash
git add examples/navlog/web/package.json examples/navlog/web/app/theme.css examples/navlog/web/app/layout.tsx packages/devkit/templates/app-navlog/web pnpm-lock.yaml
git commit -m "feat(navlog-web): Leaflet dependency, layout and flight-category tokens

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: pure selectors and geometry

**Files:**
- Create: `app/lib/navlog-types.ts`, `app/lib/navlog-selectors.ts`, `app/lib/weather-selectors.ts`, `app/lib/route-geometry.ts`, `app/lib/format.ts`
- Test: `app/lib/navlog-selectors.test.ts`, `app/lib/weather-selectors.test.ts`, `app/lib/route-geometry.test.ts`, `app/lib/format.test.ts`

- [ ] **Step 1: Write the failing tests**

`app/lib/navlog-selectors.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { latestNavlog, parseNavlog } from "./navlog-selectors"
import { SAMPLE_NAVLOG } from "./navlog-types"

const toolCall = (id: string, name: string) => ({
  id: `m-${id}`,
  role: "assistant" as const,
  content: "",
  toolCalls: [{ id, type: "function" as const, function: { name, arguments: "{}" } }],
})
const toolResult = (id: string, content: string) => ({ id: `r-${id}`, role: "tool" as const, toolCallId: id, content })

describe("parseNavlog", () => {
  test("accepts the server's Navlog JSON", () => {
    expect(parseNavlog(JSON.stringify(SAMPLE_NAVLOG))?.totals.distanceNm).toBe(66.3)
  })
  test("unwraps a { result } envelope and rejects anything else", () => {
    expect(parseNavlog(JSON.stringify({ result: SAMPLE_NAVLOG }))?.legs).toHaveLength(2)
    expect(parseNavlog("not json")).toBeNull()
    expect(parseNavlog(JSON.stringify({ legs: "nope" }))).toBeNull()
  })
})

describe("latestNavlog", () => {
  test("returns the most recent computeNavlog result in the thread", () => {
    const older = { ...SAMPLE_NAVLOG, totals: { ...SAMPLE_NAVLOG.totals, distanceNm: 1 } }
    const messages = [
      toolCall("c1", "computeNavlog"),
      toolResult("c1", JSON.stringify(older)),
      toolCall("c2", "readDoc"),
      toolResult("c2", '{"content":"x"}'),
      toolCall("c3", "computeNavlog"),
      toolResult("c3", JSON.stringify(SAMPLE_NAVLOG)),
    ]
    expect(latestNavlog(messages)?.totals.distanceNm).toBe(66.3)
  })
  test("is null with no navlog, and ignores a call whose result has not arrived", () => {
    expect(latestNavlog([toolCall("c1", "computeNavlog")])).toBeNull()
    expect(latestNavlog([])).toBeNull()
  })
})
```

`app/lib/weather-selectors.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { categoryOf, latestWeatherBrief, parseWeatherBrief } from "./weather-selectors"

const BRIEF = `Airports:
KSTP: VFR now, VFR at ETA, ceiling none, visibility 10 mi, wind 270 at 5. METAR KSTP 040253Z 27005KT 10SM CLR 14/12 A3008. TAF KSTP 040230Z ...
KRST: VFR now, MVFR at ETA, ceiling 8500 ft, visibility 9 mi, wind 260 at 11. METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010. TAF KRST ...
Winds per leg:
leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z
Advisories: none
Go/no-go note: Rochester trends MVFR by 15Z; the 1400Z departure stays ahead of it.`

describe("parseWeatherBrief", () => {
  test("reads one row per airport with category now and at ETA", () => {
    const brief = parseWeatherBrief(BRIEF)
    expect(brief.airports).toEqual([
      { id: "KSTP", now: "VFR", atEta: "VFR", line: expect.stringContaining("ceiling none"), metar: "METAR KSTP 040253Z 27005KT 10SM CLR 14/12 A3008.", taf: "TAF KSTP 040230Z ..." },
      { id: "KRST", now: "VFR", atEta: "MVFR", line: expect.stringContaining("ceiling 8500 ft"), metar: "METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010.", taf: "TAF KRST ..." },
    ])
  })
  test("reads the winds lines and the note", () => {
    const brief = parseWeatherBrief(BRIEF)
    expect(brief.winds).toEqual(["leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z"])
    expect(brief.note).toBe("Rochester trends MVFR by 15Z; the 1400Z departure stays ahead of it.")
  })
  test("tolerates a brief that is not in the expected shape", () => {
    expect(parseWeatherBrief("nothing useful")).toEqual({ airports: [], winds: [], advisories: [], note: "" })
  })
})

describe("categoryOf", () => {
  test("normalizes category words and falls back to UNKNOWN", () => {
    expect(categoryOf("mvfr")).toBe("MVFR")
    expect(categoryOf("Lifr at ETA")).toBe("LIFR")
    expect(categoryOf("")).toBe("UNKNOWN")
  })
})

describe("latestWeatherBrief", () => {
  test("picks the most recent completed weather run", () => {
    const runs = [
      { id: "a", name: "weather", status: "completed" as const, result: "Airports:\nKSTP: VFR now, VFR at ETA, x. METAR a. TAF b\n", toolCalls: [] },
      { id: "b", name: "performance", status: "completed" as const, result: "Cruise…", toolCalls: [] },
      { id: "c", name: "weather", status: "running" as const, toolCalls: [] },
    ]
    expect(latestWeatherBrief(runs)?.airports[0]?.id).toBe("KSTP")
    expect(latestWeatherBrief([])).toBeNull()
  })
})
```

`app/lib/route-geometry.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "./navlog-types"
import { routeGeometry } from "./route-geometry"

describe("routeGeometry", () => {
  test("one marker per waypoint and one polyline through them", () => {
    const g = routeGeometry(SAMPLE_NAVLOG)
    expect(g.markers.map((m) => m.id)).toEqual(["KSTP", "KRST"])
    expect(g.polyline).toEqual([
      [44.9346, -93.0603],
      [43.9083, -92.49],
    ])
  })
  test("one heading label per leg pair at the leg midpoint, climb and cruise merged", () => {
    const g = routeGeometry(SAMPLE_NAVLOG)
    expect(g.legLabels).toEqual([{ from: "KSTP", to: "KRST", at: [44.42145, -92.77515], text: "MH 168°" }])
  })
  test("bounds cover every waypoint", () => {
    const g = routeGeometry(SAMPLE_NAVLOG)
    expect(g.bounds).toEqual([
      [43.9083, -93.0603],
      [44.9346, -92.49],
    ])
  })
})
```

`app/lib/format.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { formatHeading, formatHhmm, formatUtcHhmm } from "./format"

describe("format", () => {
  test("headings are three digits", () => {
    expect(formatHeading(5)).toBe("005")
    expect(formatHeading(168)).toBe("168")
    expect(formatHeading(360)).toBe("360")
  })
  test("minutes become h:mm", () => {
    expect(formatHhmm(44)).toBe("0:44")
    expect(formatHhmm(125)).toBe("2:05")
  })
  test("ISO instants become HHMMZ", () => {
    expect(formatUtcHhmm("2026-10-05T14:07:00.000Z")).toBe("1407Z")
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/lib
```
Expected: the four new files fail on missing modules.

- [ ] **Step 3: Implement `app/lib/navlog-types.ts`**

```ts
/**
 * The navlog as the server's `computeNavlog` tool returns it. Kept as a plain
 * type (not imported from the server package) because the Workbench reads
 * the tool result off the wire and must not depend on the server's build.
 */
export interface NavlogWaypoint {
  readonly id: string
  readonly lat: number
  readonly lon: number
  readonly kind: "airport" | "navaid" | "fix"
  readonly elevationFt?: number
  readonly magneticVariationDeg: number
}

export interface NavlogLeg {
  readonly from: string
  readonly to: string
  readonly segment: "climb" | "cruise"
  readonly trueCourse: number
  readonly variation: number
  readonly magneticCourse: number
  readonly wind: { readonly dir: number; readonly kt: number }
  readonly wca: number
  readonly trueHeading: number
  readonly magneticHeading: number
  readonly tasKt: number
  readonly groundspeedKt: number
  readonly distanceNm: number
  readonly remainingNm: number
  readonly eteMin: number
  readonly etaUtc: string
  readonly fuelGal: number
  readonly fuelRemainingGal: number
}

export interface FlightPlan {
  readonly item7: string
  readonly item8: string
  readonly item9: string
  readonly item10: string
  readonly item13: string
  readonly item15: string
  readonly item16: string
  readonly item18: string
  readonly item19: string
}

export interface Navlog {
  readonly aircraft: {
    readonly tailNumber: string
    readonly type: string
    readonly cruiseRpm: number
    readonly tasKt: number
    readonly gph: number
    readonly usableFuelGal: number
  }
  readonly altitudeFt: number
  readonly departureTimeUtc: string
  readonly waypoints: readonly NavlogWaypoint[]
  readonly legs: readonly NavlogLeg[]
  readonly totals: {
    readonly distanceNm: number
    readonly eteMin: number
    readonly fuelGal: number
    readonly fuelRemainingGal: number
    readonly reserveMin: number
    readonly reserveOk: boolean
  }
  readonly flightPlan: FlightPlan
  readonly sources: readonly { readonly figure: string; readonly path: string }[]
}

/** A fixture every test and story shares: KSTP to KRST at 4500 ft in N738ZU. */
export const SAMPLE_NAVLOG: Navlog = {
  aircraft: { tailNumber: "N738ZU", type: "C172", cruiseRpm: 2400, tasKt: 109.75, gph: 7.025, usableFuelGal: 50 },
  altitudeFt: 4500,
  departureTimeUtc: "2026-10-05T14:00:00.000Z",
  waypoints: [
    { id: "KSTP", lat: 44.9346, lon: -93.0603, kind: "airport", elevationFt: 215, magneticVariationDeg: 0 },
    { id: "KRST", lat: 43.9083, lon: -92.49, kind: "airport", elevationFt: 1317, magneticVariationDeg: 0 },
  ],
  legs: [
    { from: "KSTP", to: "KRST", segment: "climb", trueCourse: 158, variation: 0, magneticCourse: 158, wind: { dir: 320, kt: 20 }, wca: 4, trueHeading: 162, magneticHeading: 162, tasKt: 72, groundspeedKt: 91, distanceNm: 9, remainingNm: 57.3, eteMin: 7, etaUtc: "2026-10-05T14:07:00.000Z", fuelGal: 2.5, fuelRemainingGal: 47.5 },
    { from: "KSTP", to: "KRST", segment: "cruise", trueCourse: 158, variation: 0, magneticCourse: 158, wind: { dir: 320, kt: 20 }, wca: 10, trueHeading: 168, magneticHeading: 168, tasKt: 109.75, groundspeedKt: 128, distanceNm: 57, remainingNm: 0, eteMin: 27, etaUtc: "2026-10-05T14:34:00.000Z", fuelGal: 3.2, fuelRemainingGal: 44.3 },
  ],
  totals: { distanceNm: 66.3, eteMin: 34, fuelGal: 5.7, fuelRemainingGal: 44.3, reserveMin: 378.4, reserveOk: true },
  flightPlan: { item7: "N738ZU", item8: "VG", item9: "C172/L", item10: "SG/C", item13: "KSTP1400", item15: "N0110VFR DCT", item16: "KRST0034", item18: "DOF/261005", item19: "E/0427 P/1" },
  sources: [
    { figure: "Figure 5-6", path: "poh/time-fuel-distance-to-climb.md" },
    { figure: "Figure 5-7", path: "poh/cruise-performance.md" },
  ],
}
```

- [ ] **Step 4: Implement `app/lib/navlog-selectors.ts`**

```ts
import type { Navlog } from "./navlog-types"

/** The subset of an AG-UI message this selector reads. */
export interface MessageLike {
  readonly id: string
  readonly role: string
  readonly content?: unknown
  readonly toolCallId?: string
  readonly toolCalls?: readonly { readonly id: string; readonly function: { readonly name: string } }[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

/** Parse a `computeNavlog` tool result (JSON text, or a `{ result }` envelope) into a Navlog, or null. */
export function parseNavlog(text: string): Navlog | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const candidate = isRecord(parsed) && "result" in parsed && isRecord(parsed.result) ? parsed.result : parsed
  if (!isRecord(candidate)) return null
  if (!Array.isArray(candidate.legs) || !Array.isArray(candidate.waypoints) || !isRecord(candidate.totals) || !isRecord(candidate.flightPlan)) {
    return null
  }
  return candidate as unknown as Navlog
}

const contentText = (content: unknown): string => {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("")
  }
  return ""
}

/** The most recent `computeNavlog` result in the thread, or null. */
export function latestNavlog(messages: readonly MessageLike[]): Navlog | null {
  const callIds = new Set<string>()
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (call.function.name === "computeNavlog") callIds.add(call.id)
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "tool" || message.toolCallId === undefined || !callIds.has(message.toolCallId)) continue
    const navlog = parseNavlog(contentText(message.content))
    if (navlog) return navlog
  }
  return null
}
```

- [ ] **Step 5: Implement `app/lib/weather-selectors.ts`**

```ts
export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR" | "UNKNOWN"

export interface AirportWeather {
  readonly id: string
  readonly now: FlightCategory
  readonly atEta: FlightCategory
  /** The rest of the airport line before the raw reports. */
  readonly line: string
  readonly metar: string
  readonly taf: string
}

export interface WeatherBrief {
  readonly airports: readonly AirportWeather[]
  readonly winds: readonly string[]
  readonly advisories: readonly string[]
  readonly note: string
}

/** The subset of a subagent run this selector reads (from `useSubagentRuns`). */
export interface SubagentRunLike {
  readonly id: string
  readonly name: string
  readonly status: string
  readonly result?: unknown
}

export function categoryOf(text: string): FlightCategory {
  const m = /\b(LIFR|MVFR|IFR|VFR)\b/i.exec(text)
  return m ? (m[1] as string).toUpperCase() as FlightCategory : "UNKNOWN"
}

const EMPTY: WeatherBrief = { airports: [], winds: [], advisories: [], note: "" }

/**
 * Parse the weather subagent's brief. The subagent is prompted to a fixed
 * shape (sections "Airports:", "Winds per leg:", "Advisories:", "Go/no-go
 * note:"); anything else degrades to an empty brief rather than a throw.
 */
export function parseWeatherBrief(text: string): WeatherBrief {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  let section: "airports" | "winds" | "advisories" | "note" | null = null
  const airports: AirportWeather[] = []
  const winds: string[] = []
  const advisories: string[] = []
  const note: string[] = []
  for (const line of lines) {
    if (/^airports:/i.test(line)) { section = "airports"; continue }
    if (/^winds per leg:/i.test(line)) { section = "winds"; continue }
    if (/^advisories:/i.test(line)) {
      section = "advisories"
      const inline = line.replace(/^advisories:\s*/i, "")
      if (inline && !/^none$/i.test(inline)) advisories.push(inline)
      continue
    }
    if (/^go\/no-go note:/i.test(line)) {
      section = "note"
      const inline = line.replace(/^go\/no-go note:\s*/i, "")
      if (inline) note.push(inline)
      continue
    }
    if (section === "airports") {
      const m = /^([A-Z0-9]{3,4}):\s*(.*)$/.exec(line)
      if (!m) continue
      const [, id, rest] = m as unknown as [string, string, string]
      const metarAt = rest.search(/\bMETAR\b/)
      const tafAt = rest.search(/\bTAF\b/)
      const head = metarAt >= 0 ? rest.slice(0, metarAt).trim() : rest
      const metar = metarAt >= 0 ? rest.slice(metarAt, tafAt > metarAt ? tafAt : undefined).trim() : ""
      const taf = tafAt >= 0 ? rest.slice(tafAt).trim() : ""
      const [nowText = "", etaText = ""] = head.split(",")
      airports.push({ id, now: categoryOf(nowText), atEta: categoryOf(etaText), line: head, metar, taf })
    } else if (section === "winds") winds.push(line)
    else if (section === "advisories" && !/^none$/i.test(line)) advisories.push(line)
    else if (section === "note") note.push(line)
  }
  if (airports.length === 0 && winds.length === 0 && advisories.length === 0 && note.length === 0) return EMPTY
  return { airports, winds, advisories, note: note.join(" ") }
}

/** The most recent completed `weather` subagent run's brief, or null. */
export function latestWeatherBrief(runs: readonly SubagentRunLike[]): WeatherBrief | null {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]
    if (run?.name !== "weather" || run.status !== "completed" || typeof run.result !== "string") continue
    return parseWeatherBrief(run.result)
  }
  return null
}
```

- [ ] **Step 6: Implement `app/lib/route-geometry.ts` and `app/lib/format.ts`**

```ts
import { formatHeading } from "./format"
import type { Navlog } from "./navlog-types"

export type LatLng = readonly [number, number]

export interface RouteGeometry {
  readonly polyline: readonly LatLng[]
  readonly markers: readonly { readonly id: string; readonly at: LatLng; readonly kind: string }[]
  readonly legLabels: readonly { readonly from: string; readonly to: string; readonly at: LatLng; readonly text: string }[]
  /** [[southLat, westLon], [northLat, eastLon]] */
  readonly bounds: readonly [LatLng, LatLng]
}

const round5 = (n: number): number => Math.round(n * 100000) / 100000

/** Map data from a navlog: markers, the route line, one heading label per leg (cruise heading), and bounds. */
export function routeGeometry(navlog: Navlog): RouteGeometry {
  const polyline = navlog.waypoints.map((wp): LatLng => [wp.lat, wp.lon])
  const markers = navlog.waypoints.map((wp) => ({ id: wp.id, at: [wp.lat, wp.lon] as LatLng, kind: wp.kind }))
  const legLabels = navlog.waypoints.slice(1).map((to, i) => {
    const from = navlog.waypoints[i] as Navlog["waypoints"][number]
    const legs = navlog.legs.filter((leg) => leg.from === from.id && leg.to === to.id)
    const cruise = legs.find((leg) => leg.segment === "cruise") ?? legs[0]
    return {
      from: from.id,
      to: to.id,
      at: [round5((from.lat + to.lat) / 2), round5((from.lon + to.lon) / 2)] as LatLng,
      text: `MH ${formatHeading(cruise?.magneticHeading ?? 0)}°`,
    }
  })
  const lats = navlog.waypoints.map((wp) => wp.lat)
  const lons = navlog.waypoints.map((wp) => wp.lon)
  return {
    polyline,
    markers,
    legLabels,
    bounds: [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ],
  }
}
```

```ts
export const formatHeading = (deg: number): string => String(Math.round(deg)).padStart(3, "0")

export const formatHhmm = (minutes: number): string => `${Math.floor(minutes / 60)}:${String(Math.round(minutes % 60)).padStart(2, "0")}`

export const formatUtcHhmm = (iso: string): string => {
  const d = new Date(iso)
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}Z`
}

export const formatGal = (gal: number): string => gal.toFixed(1)
```

- [ ] **Step 7: Run, mirror, commit**

```bash
pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/lib
```
Expected: all pass (the `legLabels` test expects the midpoint rounded to five decimals and `MH 168°` from the cruise segment). Run the mirror block (bump the template-suffixed count by 4), then:

```bash
git add examples/navlog/web/app/lib packages/devkit/templates/app-navlog/web packages/devkit/test/templates.test.ts
git commit -m "feat(navlog-web): navlog and weather selectors, route geometry, formatting

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: the navlog sheet, table, flight plan block, navlog card

**Files:**
- Create: `app/components/NavlogTable.tsx`, `FlightPlanBlock.tsx`, `NavlogSheet.tsx`, `NavlogCard.tsx`
- Test: `app/components/NavlogTable.test.tsx`, `FlightPlanBlock.test.tsx`, `NavlogSheet.test.tsx`, `NavlogCard.test.tsx`
- Modify: `app/page.tsx` (register `NavlogCard`)

- [ ] **Step 1: Write the failing tests**

`app/components/NavlogTable.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { NavlogTable } from "./NavlogTable"

describe("NavlogTable", () => {
  test("renders one row per leg segment with three-digit headings and h:mm times", () => {
    const html = renderToStaticMarkup(<NavlogTable navlog={SAMPLE_NAVLOG} />)
    expect(html).toContain("KSTP → KRST (climb)")
    expect(html).toContain(">162<")
    expect(html).toContain(">168<")
    expect(html).toContain("0:07")
    expect(html).toContain("1407Z")
  })
  test("renders a totals row with reserve", () => {
    const html = renderToStaticMarkup(<NavlogTable navlog={SAMPLE_NAVLOG} />)
    expect(html).toContain("Totals")
    expect(html).toContain("66.3")
    expect(html).toContain("0:34")
    expect(html).toContain("5.7")
  })
  test("marks each row with its leg index for map highlighting", () => {
    const html = renderToStaticMarkup(<NavlogTable navlog={SAMPLE_NAVLOG} />)
    expect(html).toContain('data-leg="0"')
    expect(html).toContain('data-leg="1"')
  })
  test("phone cards carry the same numbers", () => {
    const html = renderToStaticMarkup(<NavlogTable navlog={SAMPLE_NAVLOG} variant="cards" />)
    expect(html).toContain("KSTP → KRST (cruise)")
    expect(html).toContain("128")
    expect(html).not.toContain("<table")
  })
})
```

`app/components/FlightPlanBlock.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { FlightPlanBlock, fplMessage } from "./FlightPlanBlock"

describe("FlightPlanBlock", () => {
  test("renders items 7 to 19 with their ICAO labels", () => {
    const html = renderToStaticMarkup(<FlightPlanBlock plan={SAMPLE_NAVLOG.flightPlan} />)
    for (const label of ["7 Aircraft ID", "8 Rules / type", "9 Type / wake", "10 Equipment", "13 Departure", "15 Speed / level / route", "16 Destination / EET", "18 Other", "19 Endurance / POB"]) {
      expect(html).toContain(label)
    }
    expect(html).toContain("N738ZU")
    expect(html).toContain("KRST0034")
  })
  test("formats the FPL message for the copy button", () => {
    expect(fplMessage(SAMPLE_NAVLOG.flightPlan)).toBe("(FPL-N738ZU-VG\n-C172/L-SG/C\n-KSTP1400\n-N0110VFR DCT\n-KRST0034\n-DOF/261005\n-E/0427 P/1)")
  })
})
```

`app/components/NavlogSheet.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { NavlogSheet } from "./NavlogSheet"

describe("NavlogSheet", () => {
  test("collapsed shows the totals line and the actions", () => {
    const html = renderToStaticMarkup(<NavlogSheet navlog={SAMPLE_NAVLOG} brief="VFR all the way." open={false} onToggle={() => {}} />)
    expect(html).toContain("KSTP → KRST")
    expect(html).toContain("66.3 nm")
    expect(html).toContain("0:34")
    expect(html).toContain("5.7 gal")
    expect(html).toContain("Print")
    expect(html).toContain("Copy FPL")
    expect(html).not.toContain("<table")
  })
  test("open shows the table, the flight plan and the brief", () => {
    const html = renderToStaticMarkup(<NavlogSheet navlog={SAMPLE_NAVLOG} brief="VFR all the way." open={true} onToggle={() => {}} />)
    expect(html).toContain("<table")
    expect(html).toContain("7 Aircraft ID")
    expect(html).toContain("VFR all the way.")
  })
  test("warns when the reserve is short", () => {
    const thirsty = { ...SAMPLE_NAVLOG, totals: { ...SAMPLE_NAVLOG.totals, reserveOk: false, reserveMin: 20 } }
    const html = renderToStaticMarkup(<NavlogSheet navlog={thirsty} brief="" open={false} onToggle={() => {}} />)
    expect(html).toContain("Reserve under 45 min")
  })
  test("is a disclosure with aria-expanded", () => {
    const html = renderToStaticMarkup(<NavlogSheet navlog={SAMPLE_NAVLOG} brief="" open={true} onToggle={() => {}} />)
    expect(html).toContain('aria-expanded="true"')
  })
})
```

`app/components/NavlogCard.test.tsx`:

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { NavlogCardView } from "./NavlogCard"

vi.mock("@copilotkit/react-core/v2", () => ({ useRenderTool: () => {} }))

describe("NavlogCardView", () => {
  test("in progress shows a skeleton line", () => {
    const html = renderToStaticMarkup(<NavlogCardView status="inProgress" parameters={{}} />)
    expect(html).toContain("Computing the navlog")
  })
  test("complete shows the compact summary from the result", () => {
    const html = renderToStaticMarkup(<NavlogCardView status="complete" parameters={{}} result={JSON.stringify(SAMPLE_NAVLOG)} />)
    expect(html).toContain("computeNavlog")
    expect(html).toContain("66.3 nm")
    expect(html).toContain("2 legs")
  })
  test("a result that is not a navlog falls back to the tool name", () => {
    const html = renderToStaticMarkup(<NavlogCardView status="complete" parameters={{}} result="oops" />)
    expect(html).toContain("computeNavlog")
    expect(html).not.toContain("nm")
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/components/Navlog app/components/FlightPlan
```
Expected: module not found.

- [ ] **Step 3: Implement `NavlogTable.tsx`**

```tsx
import { formatGal, formatHeading, formatHhmm, formatUtcHhmm } from "../lib/format"
import type { Navlog, NavlogLeg } from "../lib/navlog-types"

const legName = (leg: NavlogLeg): string => `${leg.from} → ${leg.to} (${leg.segment})`

const COLUMNS: readonly { readonly key: string; readonly label: string; readonly value: (leg: NavlogLeg) => string }[] = [
  { key: "tc", label: "TC", value: (leg) => formatHeading(leg.trueCourse) },
  { key: "var", label: "Var", value: (leg) => `${Math.abs(leg.variation)}${leg.variation < 0 ? "W" : "E"}` },
  { key: "mc", label: "MC", value: (leg) => formatHeading(leg.magneticCourse) },
  { key: "wind", label: "Wind", value: (leg) => `${formatHeading(leg.wind.dir)}/${leg.wind.kt}` },
  { key: "wca", label: "WCA", value: (leg) => `${leg.wca > 0 ? "+" : ""}${leg.wca}` },
  { key: "mh", label: "MH", value: (leg) => formatHeading(leg.magneticHeading) },
  { key: "tas", label: "TAS", value: (leg) => String(Math.round(leg.tasKt)) },
  { key: "gs", label: "GS", value: (leg) => String(leg.groundspeedKt) },
  { key: "dist", label: "Dist", value: (leg) => String(leg.distanceNm) },
  { key: "rem", label: "Rem", value: (leg) => String(leg.remainingNm) },
  { key: "ete", label: "ETE", value: (leg) => formatHhmm(leg.eteMin) },
  { key: "eta", label: "ETA", value: (leg) => formatUtcHhmm(leg.etaUtc) },
  { key: "fuel", label: "Fuel", value: (leg) => formatGal(leg.fuelGal) },
  { key: "fuelrem", label: "Rem", value: (leg) => formatGal(leg.fuelRemainingGal) },
]

export interface NavlogTableProps {
  readonly navlog: Navlog
  /** `table` (desktop) or `cards` (phone). */
  readonly variant?: "table" | "cards"
  readonly onHoverLeg?: (index: number | null) => void
}

/** The classic paper navlog: one row per leg segment, a totals row. */
export function NavlogTable({ navlog, variant = "table", onHoverLeg }: NavlogTableProps) {
  if (variant === "cards") {
    return (
      <div className="grid gap-2 pt-2">
        {navlog.legs.map((leg, index) => (
          <div key={`${leg.from}-${leg.to}-${leg.segment}`} data-leg={index} className="grid grid-cols-3 gap-x-3 gap-y-1 rounded-wb border border-wb-border p-2.5 text-[12.5px] tabular-nums">
            <span className="col-span-3 font-semibold">{legName(leg)}</span>
            {(["mh", "gs", "dist", "ete", "eta", "fuel"] as const).map((key) => {
              const column = COLUMNS.find((c) => c.key === key) as (typeof COLUMNS)[number]
              return (
                <span key={key}>
                  <span className="block text-[11px] text-wb-muted">{column.label}</span>
                  {column.value(leg)}
                </span>
              )
            })}
          </div>
        ))}
      </div>
    )
  }
  return (
    <table className="w-full border-collapse text-[12.5px] tabular-nums">
      <thead>
        <tr>
          <th className="border-b border-wb-border px-1.5 py-1.5 text-left font-medium text-wb-muted">Leg</th>
          {COLUMNS.map((column) => (
            <th key={column.key} className="whitespace-nowrap border-b border-wb-border px-1.5 py-1.5 text-right font-medium text-wb-muted">
              {column.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {navlog.legs.map((leg, index) => (
          <tr
            key={`${leg.from}-${leg.to}-${leg.segment}`}
            data-leg={index}
            tabIndex={0}
            className="wb-focus hover:bg-wb-rail focus:bg-wb-rail"
            onMouseEnter={() => onHoverLeg?.(index)}
            onMouseLeave={() => onHoverLeg?.(null)}
            onFocus={() => onHoverLeg?.(index)}
            onBlur={() => onHoverLeg?.(null)}
          >
            <td className="whitespace-nowrap border-b border-wb-border px-1.5 py-1.5">{legName(leg)}</td>
            {COLUMNS.map((column) => (
              <td key={column.key} className="whitespace-nowrap border-b border-wb-border px-1.5 py-1.5 text-right">
                {column.value(leg)}
              </td>
            ))}
          </tr>
        ))}
        <tr className="font-semibold">
          <td className="px-1.5 py-1.5">Totals</td>
          {COLUMNS.map((column) => (
            <td key={column.key} className="px-1.5 py-1.5 text-right">
              {column.key === "dist" ? navlog.totals.distanceNm : column.key === "ete" ? formatHhmm(navlog.totals.eteMin) : column.key === "fuel" ? formatGal(navlog.totals.fuelGal) : column.key === "fuelrem" ? formatGal(navlog.totals.fuelRemainingGal) : ""}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  )
}
```

- [ ] **Step 4: Implement `FlightPlanBlock.tsx`**

```tsx
"use client"
import { useState } from "react"
import type { FlightPlan } from "../lib/navlog-types"

const ITEMS: readonly { readonly key: keyof FlightPlan; readonly label: string }[] = [
  { key: "item7", label: "7 Aircraft ID" },
  { key: "item8", label: "8 Rules / type" },
  { key: "item9", label: "9 Type / wake" },
  { key: "item10", label: "10 Equipment" },
  { key: "item13", label: "13 Departure" },
  { key: "item15", label: "15 Speed / level / route" },
  { key: "item16", label: "16 Destination / EET" },
  { key: "item18", label: "18 Other" },
  { key: "item19", label: "19 Endurance / POB" },
]

/** The FPL message a filing service accepts, one item per line. */
export function fplMessage(plan: FlightPlan): string {
  return [`(FPL-${plan.item7}-${plan.item8}`, `-${plan.item9}-${plan.item10}`, `-${plan.item13}`, `-${plan.item15}`, `-${plan.item16}`, `-${plan.item18}`, `-${plan.item19})`].join("\n")
}

/** ICAO flight plan items 7 to 19 laid out as the form, with a copy button. */
export function FlightPlanBlock({ plan }: { readonly plan: FlightPlan }) {
  const [copied, setCopied] = useState(false)
  return (
    <section aria-label="Flight plan" className="mt-3">
      <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2 text-[12px]">
        {ITEMS.map((item) => (
          <div key={item.key} className="rounded-wb-sm bg-wb-rail px-2 py-1.5">
            <span className="block text-[11px] text-wb-muted">{item.label}</span>
            <span className="font-medium tabular-nums">{plan[item.key]}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="wb-focus mt-2 rounded-wb-sm border border-wb-border px-2.5 py-1 text-[12px]"
        onClick={() => {
          void navigator.clipboard?.writeText(fplMessage(plan)).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          })
        }}
      >
        {copied ? "Copied" : "Copy FPL"}
      </button>
    </section>
  )
}
```

- [ ] **Step 5: Implement `NavlogSheet.tsx`**

```tsx
"use client"
import { formatGal, formatHhmm } from "../lib/format"
import type { Navlog } from "../lib/navlog-types"
import { FlightPlanBlock } from "./FlightPlanBlock"
import { NavlogTable } from "./NavlogTable"

export interface NavlogSheetProps {
  readonly navlog: Navlog
  /** The assistant's plain-language brief for this plan (the last assistant message). */
  readonly brief: string
  readonly open: boolean
  readonly onToggle: () => void
  readonly onHoverLeg?: (index: number | null) => void
  /** `table` on desktop, `cards` on phones. */
  readonly variant?: "table" | "cards"
}

/**
 * The bottom sheet: one line of totals when collapsed; the navlog form, the
 * flight plan and the brief when open. A native disclosure, not a gesture.
 */
export function NavlogSheet({ navlog, brief, open, onToggle, onHoverLeg, variant = "table" }: NavlogSheetProps) {
  const first = navlog.waypoints[0]?.id ?? ""
  const last = navlog.waypoints.at(-1)?.id ?? ""
  const reserve = navlog.totals.reserveOk ? `${formatHhmm(navlog.totals.reserveMin)} reserve` : "Reserve under 45 min"
  return (
    <section className="wb-panel wb-sheet flex max-h-[var(--wb-sheet-max)] flex-col" aria-label="Navlog">
      <div className="wb-sheet-grip mx-auto mt-2 h-1 w-9 rounded bg-wb-border" />
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-3.5 pb-2.5 pt-2 text-[13px]">
        <button type="button" className="wb-focus flex flex-wrap items-baseline gap-x-5 gap-y-1 text-left" aria-expanded={open} onClick={onToggle}>
          <span><span className="mr-1 text-[12px] text-wb-muted">Route</span><strong>{first} → {last}</strong></span>
          <span><span className="mr-1 text-[12px] text-wb-muted">Dist</span><strong>{navlog.totals.distanceNm} nm</strong></span>
          <span><span className="mr-1 text-[12px] text-wb-muted">ETE</span><strong>{formatHhmm(navlog.totals.eteMin)}</strong></span>
          <span><span className="mr-1 text-[12px] text-wb-muted">Fuel</span><strong>{formatGal(navlog.totals.fuelGal)} gal</strong></span>
          <span className={navlog.totals.reserveOk ? "" : "text-[color:var(--wb-cat-ifr)]"}><strong>{reserve}</strong></span>
        </button>
        <span className="wb-sheet-actions ml-auto flex gap-2">
          <button type="button" className="wb-focus rounded-wb-sm border border-wb-border px-2.5 py-1 text-[12px]" onClick={() => window.print()}>Print</button>
        </span>
      </div>
      {open ? (
        <div className="overflow-auto border-t border-wb-border px-3.5 pb-3.5">
          <NavlogTable navlog={navlog} variant={variant} {...(onHoverLeg ? { onHoverLeg } : {})} />
          <FlightPlanBlock plan={navlog.flightPlan} />
          {brief ? (
            <div className="mt-3 text-[13px]">
              <span className="text-[11px] uppercase tracking-[0.04em] text-wb-muted">Brief</span>
              <p className="mt-1 whitespace-pre-wrap">{brief}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
```

The "Copy FPL" action lives in `FlightPlanBlock` (so the collapsed test's `Copy FPL` expectation needs it in the bar too): add a second button in the `wb-sheet-actions` span that copies `fplMessage(navlog.flightPlan)` the same way `FlightPlanBlock` does (import `fplMessage`). Keep the two buttons' behaviour identical.

- [ ] **Step 6: Implement `NavlogCard.tsx` and register it**

```tsx
"use client"
import { useRenderTool } from "@copilotkit/react-core/v2"
import { parseNavlog } from "../lib/navlog-selectors"
import type { ToolCallStatus } from "./ToolCallCard"

export interface NavlogCardViewProps {
  readonly status: ToolCallStatus
  readonly parameters: unknown
  readonly result?: string | undefined
}

/** The compact in-transcript card for a computeNavlog call; the sheet and the map show the full result. */
export function NavlogCardView({ status, result }: NavlogCardViewProps) {
  const navlog = status === "complete" && result !== undefined ? parseNavlog(result) : null
  return (
    <div className="rounded-wb border border-wb-border bg-wb-surface px-3 py-2 text-[13px]">
      <span className="font-mono text-[12px] text-wb-muted">computeNavlog</span>
      {status !== "complete" ? (
        <p className="mt-0.5 motion-safe:animate-pulse">Computing the navlog…</p>
      ) : navlog ? (
        <p className="mt-0.5 tabular-nums">
          {navlog.totals.distanceNm} nm · {navlog.legs.length} legs · {navlog.totals.fuelGal.toFixed(1)} gal. See the navlog sheet and the map.
        </p>
      ) : null}
    </div>
  )
}

/** Registration-only, like ToolCallCard: a name-specific renderer wins over the wildcard. */
export function NavlogCard() {
  useRenderTool(
    {
      name: "computeNavlog",
      render: ({ status, parameters, result }: { status: ToolCallStatus; parameters: unknown; result?: string }) => (
        <NavlogCardView status={status} parameters={parameters} {...(result !== undefined ? { result } : {})} />
      ),
    },
    [],
  )
  return null
}
```

In `app/page.tsx`, import `NavlogCard` and render `<NavlogCard />` next to `<ToolCallCard />` (the comment there says both are registration-only; extend it to name the third).

- [ ] **Step 7: Run, mirror, commit**

```bash
pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app/components
pnpm --filter @b4-example/navlog-web lint && pnpm --filter @b4-example/navlog-web typecheck
```
Mirror (bump the template test count by 4), then:

```bash
git add examples/navlog/web/app packages/devkit/templates/app-navlog/web packages/devkit/test/templates.test.ts
git commit -m "feat(navlog-web): navlog sheet, table, flight plan block and in-transcript card

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: weather strip and the route map

**Files:**
- Create: `app/components/WeatherStrip.tsx`, `app/components/RouteMap.tsx`
- Test: `app/components/WeatherStrip.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test } from "vitest"
import { WeatherStrip } from "./WeatherStrip"

const brief = {
  airports: [
    { id: "KSTP", now: "VFR" as const, atEta: "VFR" as const, line: "VFR now, VFR at ETA", metar: "METAR KSTP …", taf: "TAF KSTP …" },
    { id: "KRST", now: "VFR" as const, atEta: "MVFR" as const, line: "VFR now, MVFR at ETA", metar: "METAR KRST …", taf: "TAF KRST …" },
  ],
  winds: ["leg 1: 320/29 -3C at 4500 ft, MSP, valid 040600Z"],
  advisories: [],
  note: "",
}

describe("WeatherStrip", () => {
  test("one chip per airport, labelled by text and data-cat, worst of now and ETA", () => {
    const html = renderToStaticMarkup(<WeatherStrip brief={brief} />)
    expect(html).toContain('data-cat="VFR"')
    expect(html).toContain("KSTP VFR")
    expect(html).toContain('data-cat="MVFR"')
    expect(html).toContain("KRST MVFR at ETA")
  })
  test("shows the first winds line and the raw reports in a disclosure", () => {
    const html = renderToStaticMarkup(<WeatherStrip brief={brief} />)
    expect(html).toContain("320/29")
    expect(html).toContain("METAR KRST …")
    expect(html).toContain("<details")
  })
  test("renders nothing without a brief", () => {
    expect(renderToStaticMarkup(<WeatherStrip brief={null} />)).toBe("")
  })
})
```

- [ ] **Step 2: Run it to verify it fails, then implement `WeatherStrip.tsx`**

```tsx
import type { AirportWeather, FlightCategory, WeatherBrief } from "../lib/weather-selectors"

const ORDER: readonly FlightCategory[] = ["LIFR", "IFR", "MVFR", "VFR", "UNKNOWN"]
const worse = (a: FlightCategory, b: FlightCategory): FlightCategory => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b)

function chipText(airport: AirportWeather): string {
  if (airport.atEta !== "UNKNOWN" && airport.atEta !== airport.now) return `${airport.id} ${airport.atEta} at ETA`
  return `${airport.id} ${airport.now}`
}

/** Flight-category chips for each airport in the brief, plus the first winds line; raw reports open in a disclosure. */
export function WeatherStrip({ brief }: { readonly brief: WeatherBrief | null }) {
  if (brief === null || brief.airports.length === 0) return null
  return (
    <section className="wb-panel flex flex-wrap items-center gap-2 px-2.5 py-2" aria-label="Weather">
      {brief.airports.map((airport) => (
        <details key={airport.id} className="relative">
          <summary className="wb-focus wb-cat cursor-pointer list-none" data-cat={worse(airport.now, airport.atEta)}>
            {chipText(airport)}
          </summary>
          <div className="wb-panel absolute left-0 top-full z-10 mt-1 w-[22rem] max-w-[80vw] p-2.5 text-[12px]">
            <p className="font-medium">{airport.id}: {airport.line}</p>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{airport.metar}</pre>
            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">{airport.taf}</pre>
          </div>
        </details>
      ))}
      {brief.winds[0] ? <span className="border-l border-wb-border pl-2 text-[12px] text-wb-muted">{brief.winds[0]}</span> : null}
    </section>
  )
}
```

- [ ] **Step 3: Implement `RouteMap.tsx` (client-only; no unit test, it needs a DOM)**

```tsx
"use client"
import type { Map as LeafletMap, Polyline } from "leaflet"
import { useEffect, useRef } from "react"
import type { RouteGeometry } from "../lib/route-geometry"
import type { FlightCategory } from "../lib/weather-selectors"

export interface RouteMapProps {
  readonly geometry: RouteGeometry | null
  /** Flight category per airport id, for marker color. */
  readonly categories: Readonly<Record<string, FlightCategory>>
  readonly highlightedLeg: number | null
  /** Extra padding on the left (the dock) and bottom (the sheet), in pixels. */
  readonly padding: { readonly left: number; readonly bottom: number; readonly top: number }
}

const CATEGORY_VAR: Record<FlightCategory, string> = {
  VFR: "--wb-cat-vfr",
  MVFR: "--wb-cat-mvfr",
  IFR: "--wb-cat-ifr",
  LIFR: "--wb-cat-lifr",
  UNKNOWN: "--wb-muted",
}

const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/**
 * The map behind everything. Leaflet is imported inside the effect so this
 * module never runs on the server; `WorkbenchLayout` loads it with
 * `next/dynamic` and `ssr: false` for the same reason.
 */
export function RouteMap({ geometry, categories, highlightedLeg, padding }: RouteMapProps) {
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<LeafletMap | null>(null)
  const layers = useRef<{ route?: Polyline; segments: Polyline[]; markers: unknown[] }>({ segments: [], markers: [] })

  useEffect(() => {
    let cancelled = false
    void import("leaflet").then((L) => {
      if (cancelled || container.current === null || map.current !== null) return
      const instance = L.map(container.current, { zoomControl: false, attributionControl: true })
      L.control.zoom({ position: "bottomright" }).addTo(instance)
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19,
      }).addTo(instance)
      instance.setView([39.5, -98.35], 4)
      map.current = instance
    })
    return () => {
      cancelled = true
      map.current?.remove()
      map.current = null
    }
  }, [])

  useEffect(() => {
    const instance = map.current
    if (instance === null) return
    void import("leaflet").then((L) => {
      for (const seg of layers.current.segments) seg.remove()
      layers.current.route?.remove()
      for (const marker of layers.current.markers) (marker as { remove(): void }).remove()
      layers.current = { segments: [], markers: [] }
      if (geometry === null) return
      const route = L.polyline(geometry.polyline.map((p) => [p[0], p[1]]), { color: cssVar("--wb-route"), weight: 3 }).addTo(instance)
      const segments = geometry.polyline.slice(1).map((to, i) => {
        const from = geometry.polyline[i] as readonly [number, number]
        return L.polyline([[from[0], from[1]], [to[0], to[1]]], { color: cssVar("--wb-accent-from"), weight: 7, opacity: 0 }).addTo(instance)
      })
      const markers: unknown[] = []
      for (const marker of geometry.markers) {
        const cat = categories[marker.id] ?? "UNKNOWN"
        markers.push(L.circleMarker([marker.at[0], marker.at[1]], { radius: 6, color: cssVar("--wb-surface"), weight: 2, fillColor: cssVar(CATEGORY_VAR[cat]), fillOpacity: 1 }).addTo(instance))
        markers.push(L.marker([marker.at[0], marker.at[1]], { icon: L.divIcon({ className: "wb-wp-label", html: `${marker.id} ${cat === "UNKNOWN" ? "" : cat}`.trim(), iconSize: undefined, iconAnchor: [-10, 10] }), interactive: false, keyboard: false }).addTo(instance))
      }
      for (const label of geometry.legLabels) {
        markers.push(L.marker([label.at[0], label.at[1]], { icon: L.divIcon({ className: "wb-hdg-label", html: label.text, iconSize: undefined }), interactive: false, keyboard: false }).addTo(instance))
      }
      layers.current = { route, segments, markers }
      instance.fitBounds([[geometry.bounds[0][0], geometry.bounds[0][1]], [geometry.bounds[1][0], geometry.bounds[1][1]]], {
        paddingTopLeft: [padding.left, padding.top],
        paddingBottomRight: [40, padding.bottom],
      })
    })
  }, [geometry, categories, padding])

  useEffect(() => {
    layers.current.segments.forEach((seg, i) => seg.setStyle({ opacity: i === highlightedLeg ? 0.6 : 0 }))
  }, [highlightedLeg])

  return <div ref={container} className="wb-map fixed inset-0 z-0" aria-label="Route map" />
}
```

The map's highlighted leg maps the navlog's leg *segments* (climb and cruise of the same pair) onto one polyline segment: `WorkbenchLayout` converts the table's `data-leg` index into a waypoint-pair index by counting distinct `(from, to)` pairs before it (a small helper in `route-geometry.ts`: `pairIndexOf(navlog, legIndex)`; add it with a two-line test).

- [ ] **Step 4: Run, mirror, commit**

```bash
pnpm --filter @b4-example/navlog-web exec vitest --run --config vitest.config.ts app
pnpm --filter @b4-example/navlog-web lint && pnpm --filter @b4-example/navlog-web typecheck
```
Mirror (bump the count by 1), then:

```bash
git add examples/navlog/web/app packages/devkit/templates/app-navlog/web packages/devkit/test/templates.test.ts
git commit -m "feat(navlog-web): weather strip and the Leaflet route map

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: the layout, the dock, the empty state

**Files:**
- Create: `app/components/WorkbenchLayout.tsx`, `app/components/ChatDock.tsx`
- Modify: `app/components/AppShell.tsx` (the returned JSX only), `app/components/EmptyState.tsx`
- Test: `app/components/WorkbenchLayout.test.tsx`; update `AppShell.test.tsx` and `EmptyState`-related expectations where the DOM moved

- [ ] **Step 1: Write the failing test**

```tsx
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, test, vi } from "vitest"
import { SAMPLE_NAVLOG } from "../lib/navlog-types"
import { WorkbenchLayout } from "./WorkbenchLayout"

vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="map" /> }))

describe("WorkbenchLayout", () => {
  test("desktop: dock, strip and sheet float over the map, transcript inside main", () => {
    const html = renderToStaticMarkup(
      <WorkbenchLayout navlog={SAMPLE_NAVLOG} brief={null} assistantBrief="ok" dock={<p>transcript</p>} composer={<p>composer</p>} rail={<p>rail</p>} memory={<p>memory</p>} header="Thread one" />,
    )
    expect(html).toContain('data-testid="map"')
    expect(html).toContain("<main")
    expect(html).toContain("transcript")
    expect(html).toContain("aria-label=\"Navlog\"")
    expect(html).toContain("Thread one")
  })
  test("without a navlog there is no sheet", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout navlog={null} brief={null} assistantBrief="" dock={<p>t</p>} composer={<p>c</p>} rail={<p>r</p>} memory={<p>m</p>} header="x" />)
    expect(html).not.toContain('aria-label="Navlog"')
  })
  test("phone tabs exist for Navlog and Chat", () => {
    const html = renderToStaticMarkup(<WorkbenchLayout navlog={SAMPLE_NAVLOG} brief={null} assistantBrief="" dock={<p>t</p>} composer={<p>c</p>} rail={<p>r</p>} memory={<p>m</p>} header="x" />)
    expect(html).toContain('role="tablist"')
    expect(html).toContain(">Navlog<")
    expect(html).toContain(">Chat<")
  })
})
```

- [ ] **Step 2: Implement `ChatDock.tsx`**

```tsx
"use client"
import type { ReactNode } from "react"

export interface ChatDockProps {
  readonly header: string
  readonly status?: string | undefined
  readonly rail: ReactNode
  readonly memory: ReactNode
  readonly children: ReactNode
  readonly composer: ReactNode
}

/**
 * The floating chat panel. The thread rail and the memory panel keep their
 * DOM (the harness journeys locate them by name) but live behind two
 * disclosures in the dock header instead of a permanent column.
 */
export function ChatDock({ header, status, rail, memory, children, composer }: ChatDockProps) {
  return (
    <section className="wb-panel wb-dock flex min-h-0 flex-col" aria-label="Chat">
      <header className="flex shrink-0 items-center gap-2 border-b border-wb-border px-3 py-2">
        <span className="wb-brand-mark shrink-0 text-[14px] font-semibold tracking-tight">B4.run navlog</span>
        <h1 className="min-w-0 truncate text-[12.5px] font-medium">{header}</h1>
        {status ? <span className="shrink-0 text-[11px] uppercase tracking-[0.08em] text-wb-muted">{status}</span> : null}
        <details className="ml-auto shrink-0">
          <summary className="wb-focus cursor-pointer list-none text-[12px] text-wb-muted">Threads</summary>
          <div className="wb-panel absolute right-2 z-20 mt-1 max-h-[60vh] w-72 overflow-auto py-2">{rail}</div>
        </details>
        <details className="shrink-0">
          <summary className="wb-focus cursor-pointer list-none text-[12px] text-wb-muted">Memory</summary>
          <div className="wb-panel absolute right-2 z-20 mt-1 max-h-[60vh] w-80 overflow-auto py-2">{memory}</div>
        </details>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
      {composer}
    </section>
  )
}
```

If the harness `teach` journey cannot open the memory disclosure (it locates the panel's heading and Approve button directly), render the memory panel `<details open>` by default when the journey's locator needs it visible, and note the choice in the PR. Check `test/harness/workbench-suggestions.ts` `teachJourney` before deciding; the cheapest robust answer is `open` by default on desktop.

- [ ] **Step 3: Implement `WorkbenchLayout.tsx`**

```tsx
"use client"
import dynamic from "next/dynamic"
import { type ReactNode, useMemo, useState } from "react"
import type { Navlog } from "../lib/navlog-types"
import { pairIndexOf, routeGeometry } from "../lib/route-geometry"
import type { FlightCategory, WeatherBrief } from "../lib/weather-selectors"
import { ChatDock } from "./ChatDock"
import { NavlogSheet } from "./NavlogSheet"
import { WeatherStrip } from "./WeatherStrip"

const RouteMap = dynamic(() => import("./RouteMap").then((m) => m.RouteMap), { ssr: false })

export interface WorkbenchLayoutProps {
  readonly navlog: Navlog | null
  readonly brief: WeatherBrief | null
  /** The assistant's latest prose, shown in the sheet as the brief. */
  readonly assistantBrief: string
  readonly header: string
  readonly status?: string | undefined
  readonly rail: ReactNode
  readonly memory: ReactNode
  readonly dock: ReactNode
  readonly composer: ReactNode
}

const DOCK_PAD = 420
const SHEET_PAD = 140

/**
 * Map full-bleed; the dock floats left, the weather strip top-right, the
 * navlog sheet along the bottom. Under `md` the dock and the sheet become one
 * bottom sheet with Navlog and Chat tabs.
 */
export function WorkbenchLayout({ navlog, brief, assistantBrief, header, status, rail, memory, dock, composer }: WorkbenchLayoutProps) {
  const [sheetOpen, setSheetOpen] = useState(true)
  const [tab, setTab] = useState<"navlog" | "chat">("chat")
  const [hoveredLeg, setHoveredLeg] = useState<number | null>(null)
  const geometry = useMemo(() => (navlog ? routeGeometry(navlog) : null), [navlog])
  const categories = useMemo(() => {
    const out: Record<string, FlightCategory> = {}
    for (const airport of brief?.airports ?? []) out[airport.id] = airport.atEta !== "UNKNOWN" ? airport.atEta : airport.now
    return out
  }, [brief])
  const padding = useMemo(() => ({ left: DOCK_PAD, bottom: navlog ? SHEET_PAD : 40, top: 90 }), [navlog])
  const highlightedLeg = navlog && hoveredLeg !== null ? pairIndexOf(navlog, hoveredLeg) : null

  return (
    <div className="relative h-dvh overflow-hidden">
      <RouteMap geometry={geometry} categories={categories} highlightedLeg={highlightedLeg} padding={padding} />

      {/* Desktop surfaces */}
      <div className="absolute inset-x-[var(--wb-gutter)] top-[var(--wb-gutter)] z-10 hidden justify-end md:flex">
        <WeatherStrip brief={brief} />
      </div>
      <div className="absolute bottom-[calc(var(--wb-gutter)+96px)] left-[var(--wb-gutter)] top-[var(--wb-gutter)] z-10 hidden w-[var(--wb-dock-width)] md:flex">
        <ChatDock header={header} status={status} rail={rail} memory={memory} composer={composer}>
          {dock}
        </ChatDock>
      </div>
      {navlog ? (
        <div className="absolute inset-x-[var(--wb-gutter)] bottom-[var(--wb-gutter)] z-10 hidden md:block">
          <NavlogSheet navlog={navlog} brief={assistantBrief} open={sheetOpen} onToggle={() => setSheetOpen((v) => !v)} onHoverLeg={setHoveredLeg} />
        </div>
      ) : null}

      {/* Phone: one bottom sheet with tabs */}
      <div className="absolute inset-x-0 bottom-0 z-10 flex max-h-[58vh] flex-col md:hidden">
        <div className="absolute inset-x-3 top-[-52px]">
          <WeatherStrip brief={brief} />
        </div>
        <section className="wb-panel wb-sheet flex min-h-0 flex-1 flex-col rounded-b-none">
          <div className="wb-sheet-tabs flex gap-1 px-3 pt-1.5" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "chat"} className="wb-focus px-3 py-1.5 text-[13px] aria-selected:border-b-2 aria-selected:border-wb-accent-from" onClick={() => setTab("chat")}>Chat</button>
            <button type="button" role="tab" aria-selected={tab === "navlog"} className="wb-focus px-3 py-1.5 text-[13px] aria-selected:border-b-2 aria-selected:border-wb-accent-from" onClick={() => setTab("navlog")}>Navlog</button>
          </div>
          {tab === "navlog" && navlog ? (
            <NavlogSheet navlog={navlog} brief={assistantBrief} open={true} onToggle={() => {}} variant="cards" />
          ) : (
            <ChatDock header={header} status={status} rail={rail} memory={memory} composer={composer}>
              {dock}
            </ChatDock>
          )}
        </section>
      </div>
    </div>
  )
}
```

Add to `route-geometry.ts`:

```ts
/** The waypoint-pair index a navlog leg (climb or cruise row) belongs to. */
export function pairIndexOf(navlog: Navlog, legIndex: number): number {
  const leg = navlog.legs[legIndex]
  if (!leg) return 0
  return Math.max(0, navlog.waypoints.findIndex((wp) => wp.id === leg.from))
}
```

and the test `expect(pairIndexOf(SAMPLE_NAVLOG, 1)).toBe(0)` in `route-geometry.test.ts`.

The phone branch renders the dock twice in the tree (desktop hidden, phone hidden by breakpoint); both are in the DOM. CopilotKit hooks inside `Transcript` and `Composer` are called in each instance, which is allowed, but the harness journeys locate `page.getByRole("main")` once. Give the phone instance `aria-hidden` and `inert` via a wrapper `div` when the viewport is `md` and up: use a `useMediaQuery("(min-width: 768px)")` hook (a six-line `useSyncExternalStore` over `matchMedia`, in `app/lib/use-media-query.ts`, defaulting to `true` on the server) and render only the branch that applies instead of hiding with CSS. That removes the duplicate entirely; update the layout test to mock the hook (`vi.mock("../lib/use-media-query", ...)`) once for desktop and once for phone.

- [ ] **Step 4: Rewire `AppShell.tsx` and `EmptyState.tsx`**

In `AppShell.tsx`, after the `serverStatus === "down"` early return, replace the two-column JSX with:

```tsx
  const navlog = latestNavlog(agent.messages as readonly MessageLike[])
  const weatherBrief = latestWeatherBrief(subagentRuns.runs)
  const assistantBrief = lastAssistantText(agent.messages as readonly MessageLike[])
  return (
    <WorkbenchLayout
      navlog={navlog}
      brief={weatherBrief}
      assistantBrief={assistantBrief}
      header={activeThread?.title ?? UNTITLED_THREAD_LABEL}
      status={agent.isRunning ? "running" : isAwaitingApproval ? "awaiting approval" : undefined}
      rail={<ThreadRail threads={threads} activeThreadId={activeThreadId} onSelect={onSelectThread} onCreate={onCreateThread} />}
      memory={<MemoryPanel />}
      composer={<Composer key={activeThreadId} onSend={send} onStop={stop} canAttachImages={canAttachImages} isRunning={agent.isRunning} isAwaitingApproval={isAwaitingApproval} />}
      dock={
        <Transcript
          agent={agent}
          threadKey={activeThreadId}
          messages={agent.messages}
          notices={notices}
          isRunning={agent.isRunning}
          onSelectSuggestion={selectSuggestion}
          hasRestoredHistory={hasRestoredHistory}
          runError={runError}
          onDismissRunError={dismissRunError}
          onRunError={reportRunError}
          threadSource={threadSource}
          onHydratedPendingChange={setHydratedPendingCount}
        />
      }
    />
  )
```

with `const subagentRuns = useSubagentRuns(agent)` added beside the other hooks (import from `@b4run/ag-ui/react`; `Transcript` already calls the same hook, which is fine), and `lastAssistantText` added to `navlog-selectors.ts`:

```ts
/** The latest assistant prose in the thread, for the sheet's brief. */
export function lastAssistantText(messages: readonly MessageLike[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role === "assistant") {
      const text = contentText(message.content).trim()
      if (text.length > 0) return text
    }
  }
  return ""
}
```

(with a test: picks the last non-empty assistant message, "" when none). `EmptyState.tsx`: keep its markup and the suggestion buttons (the journeys click them by name); only change the heading to `B4.run navlog` and the sentence under it to "A VFR flight planner for a Cessna 172N that briefs weather, reads the POH, computes the navlog in code, and files only when you ask." The empty state renders inside the dock's transcript, which is where the journeys expect the buttons.

- [ ] **Step 5: Run the web suite, fix moved-DOM expectations**

```bash
pnpm --filter @b4-example/navlog-web test
```
`AppShell.test.tsx` renders the shell with mocked hooks; expectations about the `<aside>` rail column and the `<header>` inside `<main>` will fail. Update them to the new structure (the brand mark now sits in the dock header; the rail is inside a `details`). Do not weaken assertions about behaviour (thread switching, hydration, run errors).

- [ ] **Step 6: Lint, typecheck, mirror, commit**

```bash
pnpm --filter @b4-example/navlog-web lint && pnpm --filter @b4-example/navlog-web typecheck && pnpm --filter @b4-example/navlog-web build
```
Mirror (bump the count by the number of new test files), then:

```bash
git add examples/navlog/web/app packages/devkit/templates/app-navlog/web packages/devkit/test/templates.test.ts
git commit -m "feat(navlog-web): map-dominant layout with a chat dock, weather strip and navlog sheet

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: harness journeys, e2e, README, changeset, gate, PR

**Files:**
- Modify (only where a locator depended on layout): `test/harness/workbench-suggestions.ts`, `test/harness/workbench-browser.ts`, `test/generated/run-generated-research-activation.test.ts`
- Modify: `examples/navlog/web/e2e/copilotkit-v2.spec.ts` if it asserts layout
- Modify: `examples/navlog/web/README.md`, `packages/devkit/templates/app-navlog/web/README.md`, `packages/devkit/templates/app-navlog/README.md`
- Create: `.changeset/navlog-map-workbench.md`

- [ ] **Step 1: Run the framework lane and fix locators**

```bash
pnpm verify:harness:self-test && pnpm verify:harness:framework
```
Expected failures, if any, come from locators that assumed the rail column or `header` placement. Fix in the harness: the thread rail is reached by opening the "Threads" disclosure first; the memory panel by "Memory" unless it is `open` by default. Names the journeys depend on (suggestion titles, tool names, subagent summary text, `role="alert"`, Approve) must not change. Re-run until green.

- [ ] **Step 2: e2e spec**

```bash
pnpm --filter @b4-example/navlog-web exec playwright install --with-deps chromium
pnpm --filter @b4-example/navlog-web test:e2e
```
Fix only layout-dependent selectors.

- [ ] **Step 3: READMEs**

Describe the three surfaces, Leaflet with OpenStreetMap tiles and attribution, the selectors (`latestNavlog`, `latestWeatherBrief`) as the way data reaches the map and sheet, the print and copy actions, and the phone layout. Keep every command. No banned docs-bundle terms.

- [ ] **Step 4: Changeset**

```md
---
"@b4run/devkit": patch
"create-b4-app": patch
---

The `navlog` scaffold's Workbench is map-first: a full-viewport route map (Leaflet, OpenStreetMap), a floating chat dock, flight-category chips with matching airport markers, and a bottom navlog sheet with the legs table, the ICAO flight plan, the brief, print and copy. Phones get one tabbed bottom sheet.
```

- [ ] **Step 5: Gate and PR**

```bash
pnpm lint && pnpm check:build-cache && pnpm build && pnpm typecheck && pnpm test && pnpm check:release-inventory && node scripts/check-docs.mjs && node scripts/check-changesets.mjs
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
git fetch origin main && git merge --no-edit origin/main && git push -u origin HEAD
gh pr create --title "feat(navlog-web): the map-dominant Workbench" --body "$(cat <<'EOF'
## Summary
PR 4 of the navlog series (`docs/superpowers/specs/2026-10-04-navlog-example-design.md`, section 5). Presentation only: the server, prompts and harness journeys landed in PR 3.
- The route map fills the viewport (Leaflet, OpenStreetMap tiles, muted in light and inverted in dark); markers are colored by flight category and labelled by text.
- A floating chat dock holds the transcript, composer, thread rail and memory panel.
- A weather strip shows flight-category chips per airport (worst of now and ETA) and the winds line; chips open the raw METAR and TAF.
- A bottom navlog sheet shows totals collapsed, and the legs table, ICAO flight plan block, brief, print and copy when open; hovering a leg highlights it on the map.
- Phones get one bottom sheet with Chat and Navlog tabs and per-leg cards.
- Data reaches the surfaces through pure selectors over the thread (`latestNavlog`, `latestWeatherBrief`, `routeGeometry`), all unit-tested.

## Test plan
- [x] `pnpm --filter @b4-example/navlog-web test`, `lint`, `typecheck`, `build`
- [x] `pnpm --filter @b4run/devkit test` (parity)
- [x] `pnpm verify:harness:framework`, `pnpm --filter @b4-example/navlog-web test:e2e`
- [x] Local `pnpm ci:validate` sequence
- [ ] Manual: light and dark, 375px and 1440px, print preview

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review against the spec

- Spec 5 map: Task 4 `RouteMap` (OSM tiles, filters, markers by category with text, polyline, heading labels, fit bounds), Task 1 tokens and CSS filters. Empty-state centering on the home field from memory is not implemented: the map opens on the continental US (spec allows either); noted for PR 5 where memory is reachable from the proxy.
- Spec 5 chat dock: Task 5 `ChatDock` with rail and memory in header disclosures; approval prompts stay inside `Transcript`, which is inside the dock.
- Spec 5 weather strip and marker colors: Task 4; chip and marker share `categoryOf` and the worst-of rule; raw METAR/TAF in a disclosure; color never alone.
- Spec 5 navlog sheet: Task 3 (totals line, actions, table, FPL block, brief, hover highlight, native disclosure, print stylesheet in Task 1).
- Spec 5 data flow: Task 2 selectors read the tool result and the subagent run; `NavlogCard` is the name-specific `useRenderTool`.
- Spec 5 phone: Task 5 tabs, cards variant, strip collapses to one row; safe-area insets are left to the sheet's bottom padding (`pb-[env(safe-area-inset-bottom)]`, add to the phone section's class list).
- Spec 5 motion: Task 1 transitions and reduced-motion rule.
- Placeholder scan: none. Type consistency: `Navlog`/`FlightPlan` (Task 2 types) are used by Tasks 3 to 5; `WeatherBrief`/`FlightCategory` by Tasks 4 and 5; `RouteGeometry` and `pairIndexOf` by Tasks 4 and 5; `ToolCallStatus` is imported from the existing `ToolCallCard`.

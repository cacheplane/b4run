# Navlog PR 3: the server becomes a C172N VFR flight planner

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the research corpus, tools, subagents and prompts in `examples/navlog/server` (and its devkit template mirror) with a Cessna 172N VFR flight planner: live aviationweather.gov tools, a pure `computeNavlog` module grounded in the 1978 172N POH, `fileFlightPlan` behind approval, keyless unit tests and recorded evals, with every scaffold test and harness journey retargeted so `validate` stays green.

**Architecture:** Pure math and parsers live in `src/lib/` (typegen treats every `.ts` directly under `src/tools/` as a tool, so helpers must not live there). Tools in `src/tools/` are thin: validate input, call the lib, return structured JSON, export `display`. Two subagents, `weather` and `performance`, are scoped to disjoint tool sets. The Workbench's three starter prompts and the harness journeys change with the server (behavior), while the map-dominant layout waits for PR 4 (presentation), so the generated-activation lane stays hermetic: its journeys never touch the network.

**Tech Stack:** TypeScript, Node 24, `@b4run/sdk` tools (`B4ToolContext`, `ToolDisplay`), `@b4run/testing` (`createAgentHarness`, `script()`), `@b4run/evals`, Vitest, zod, aviationweather.gov Data API (no key), pnpm, Biome.

**Spec:** `docs/superpowers/specs/2026-10-04-navlog-example-design.md` sections 4 and 7.

**Branch:** `blove/navlog-server` from `origin/main` after PR 2 (#934) merges. Paths below assume the rename landed (`examples/navlog`, `templates/app-navlog`, route `src/app/navlog`).

**Plan-level refinements of the spec (recorded here, fold into the spec in this PR's docs commit):**
- The Workbench's `DemoSuggestions.tsx` prompts and the harness journeys are part of PR 3, not PR 4. The generated-activation lane (`test/generated/run-generated-research-activation.test.ts`) and the W8 journeys (`test/harness/workbench-suggestions.ts`) script tool calls by name through the Workbench, and both are in `validate`. PR 4 keeps the prompts and only changes the layout.
- The harness journeys stay hermetic: the planning journey calls `computeNavlog` with inline waypoints and winds and dispatches the `performance` subagent (which reads the POH from the workspace); the `weather` subagent and the network tools are exercised by unit tests with a stubbed `fetch` and by the recorded evals.
- The brand demo scenario (`docs/brand/demo/scenario.mjs`) is retargeted so `pnpm test:brand-demo` passes; the clips themselves are re-recorded later.

**Run every command from the repo root with Node 24 (`source ~/.nvm/nvm.sh && nvm use 24`).** Never bare `biome check --write`; format with `pnpm --filter @b4-example/navlog-server lint` (its script is already scoped) or `pnpm exec biome format --write --config-path packages/config-biome/biome.json <files>`.

**Template mirror rule (every task):** the devkit parity test requires `packages/devkit/templates/app-navlog/server/` to mirror `examples/navlog/server/` byte for byte, with test files named `*.test.ts.template` and the eval `*.eval.ts.template`. After each task's example change, mirror it:

```bash
# from the repo root; copies source, workspace, config; renames tests/evals to .template
rsync -a --delete --exclude node_modules --exclude .b4 --exclude .env examples/navlog/server/src/ packages/devkit/templates/app-navlog/server/src/
rsync -a --delete examples/navlog/server/workspace/ packages/devkit/templates/app-navlog/server/workspace/
cp examples/navlog/server/b4.config.ts packages/devkit/templates/app-navlog/server/b4.config.ts
for f in examples/navlog/server/test/*.test.ts; do cp "$f" "packages/devkit/templates/app-navlog/server/test/$(basename "$f").template"; done
for f in packages/devkit/templates/app-navlog/server/test/*.template; do [ -f "examples/navlog/server/test/$(basename "${f%.template}")" ] || rm "$f"; done
for f in $(find examples/navlog/server/src -name "*.eval.ts"); do rel=${f#examples/navlog/server/}; mv "packages/devkit/templates/app-navlog/server/$rel" "packages/devkit/templates/app-navlog/server/$rel.template"; done
pnpm --filter @b4run/devkit test
```

(`package.json.template`, `.b4/b4.generated.d.ts`, `.b4/scenarios.generated.d.ts` and `README.md` are mirrored by hand where a task says so.)

---

## File structure

```
examples/navlog/server/
  b4.config.ts                       tools scope on the route lives in index.ts; config loses sandbox + bash permissions
  package.json                       drops @b4run/sandbox and test:sandbox:docker
  src/app/navlog/
    index.ts                         coordinator prompt; tools: { deny: ["runBash"], approve: ["fileFlightPlan"] }
    state.ts                         unchanged shape
    plan.md                          four seeded todos
    memory.md                        aircraft-profile memory conventions
    memory.ts                        unchanged schema
    skills/brief-weather/SKILL.md
    skills/poh-lookup/SKILL.md
    subagents/weather/index.ts       tools: { allow: [getMetar, getTaf, getWindsAloft, getAdvisories] }
    subagents/performance/index.ts   tools: { allow: [readDoc, lookupAirport] }
    evals/navlog-quality.eval.ts     recorded cases, shape scorers
  src/lib/
    geo.ts                           great-circle distance, initial true course
    wind.ts                          wind triangle
    poh-tables.ts                    Fig 5-4, 5-6, 5-7, 5-10 data + interpolation
    navlog.ts                        computeNavlog core: legs, climb split, totals, reserve
    fpl.ts                           ICAO flight plan fields + message text
    awc.ts                           aviationweather.gov client with 5-minute cache
    winds-aloft.ts                   FB text product parser + altitude interpolation
    geo-filter.ts                    point-in-bbox for advisories
  src/tools/
    lookupAirport.ts getMetar.ts getTaf.ts getWindsAloft.ts getAdvisories.ts
    computeNavlog.ts fileFlightPlan.ts readDoc.ts renderChart.ts (unchanged)
  workspace/
    AGENTS.md
    poh/{airspeed-limits,weights-and-fuel,takeoff-distance,rate-of-climb,time-fuel-distance-to-climb,cruise-performance,landing-distance}.md
    regs/{vfr-fuel-reserves,vfr-cruising-altitudes}.md
  test/
    geo.test.ts wind.test.ts poh-tables.test.ts navlog.test.ts fpl.test.ts
    winds-aloft.test.ts awc.test.ts weather-tools.test.ts file-flight-plan.test.ts
    corpus-sync.test.ts render-chart.test.ts (unchanged)
```

Deleted: `src/tools/searchCorpus.ts`, `workspace/corpus/*`, `workspace/scripts/fetch-source.mjs`, `workspace/tool-outputs/*`, `subagents/researcher/`, `skills/{cite-sources,synthesize-findings}`, `test/sandbox-docker.test.ts`, the old `test/navlog.test.ts` scenario (replaced by the `navlog.test.ts` unit test of the core).

---

## Task 1: POH and regulation corpus

**Files:**
- Create: `examples/navlog/server/workspace/poh/*.md` (7 files), `workspace/regs/*.md` (2 files)
- Modify: `examples/navlog/server/workspace/AGENTS.md`
- Delete: `workspace/corpus/`, `workspace/scripts/`, `workspace/tool-outputs/`

Every file is our own transcription. Figures come from the 1978 Cessna 172N Pilot's Operating Handbook (Textron); the handbook's prose is not copied. Values were read from the scanned figures and cross-checked against the OCR layer.

- [ ] **Step 1: Remove the old corpus**

```bash
git rm -r -q examples/navlog/server/workspace/corpus examples/navlog/server/workspace/scripts examples/navlog/server/workspace/tool-outputs
```

- [ ] **Step 2: Write `workspace/poh/airspeed-limits.md`**

```md
# Airspeed limitations and indicator markings

Source: Cessna 172N POH (1978), Section 2, Figures 2-1 and 2-2. Speeds in knots.

| Speed | KCAS | KIAS | Meaning |
|---|---|---|---|
| VNE never exceed | 158 | 160 | Do not exceed in any operation |
| VNO maximum structural cruising | 126 | 128 | Exceed only in smooth air, with caution |
| VA maneuvering, 2300 lb | 96 | 97 | No full or abrupt control movement above this speed |
| VA maneuvering, 1950 lb | 88 | 89 | |
| VA maneuvering, 1600 lb | 80 | 80 | |
| VFE maximum flap extended | 86 | 85 | Do not exceed with flaps down |
| Maximum window open | 158 | 160 | |

Indicator markings (KIAS): white arc 41 to 85 (full-flap operating range, lower limit is VS0 at maximum weight, upper limit is VFE); green arc 47 to 128 (normal operating range, lower limit is VS1 at maximum weight and most forward CG, upper limit is VNO); yellow arc 128 to 160 (smooth air only); red line 160 (VNE).

Power plant: Avco Lycoming O-320-H2AD, 160 BHP at 2700 RPM maximum. Static RPM at full throttle, carburetor heat off, full rich: 2280 to 2400.
```

- [ ] **Step 3: Write `workspace/poh/weights-and-fuel.md`**

```md
# Weight and fuel limits

Source: Cessna 172N POH (1978), Section 2, Weight Limits and Fuel Limitations.

## Weights

| Category | Maximum takeoff | Maximum landing | Baggage |
|---|---|---|---|
| Normal | 2300 lb | 2300 lb | Area 1 (station 82 to 108) 120 lb; Area 2 (station 108 to 142) 50 lb; combined 120 lb |
| Utility | 2000 lb | 2000 lb | Baggage compartment and rear seat must be unoccupied |

## Fuel

| Tanks | Each tank | Total | Usable (all flight conditions) | Unusable |
|---|---|---|---|---|
| Standard (2) | 21.5 US gal | 43 US gal | 40 US gal | 3 US gal |
| Long range (2) | 27 US gal | 54 US gal | 50 US gal | 4 US gal |

Takeoff and landing are made with the fuel selector in BOTH. Fuel is 100LL at 6 lb per US gallon for weight calculations.
```

- [ ] **Step 4: Write `workspace/poh/takeoff-distance.md`**

```md
# Takeoff distance, short field, 2300 lb

Source: Cessna 172N POH (1978), Section 5, Figure 5-4 (sheet 1). Conditions: flaps up, full throttle before brake release, paved level dry runway, zero wind. Liftoff 52 KIAS, 50 ft 59 KIAS. Distances in feet: ground roll / total to clear a 50 ft obstacle.

| Pressure altitude | 0 °C | 10 °C | 20 °C | 30 °C | 40 °C |
|---|---|---|---|---|---|
| Sea level | 720 / 1300 | 775 / 1390 | 835 / 1490 | 895 / 1590 | 960 / 1700 |
| 1000 | 790 / 1420 | 850 / 1525 | 915 / 1630 | 980 / 1745 | 1050 / 1865 |
| 2000 | 865 / 1555 | 930 / 1670 | 1000 / 1790 | 1075 / 1915 | 1155 / 2055 |
| 3000 | 950 / 1710 | 1025 / 1835 | 1100 / 1970 | 1185 / 2115 | 1270 / 2265 |
| 4000 | 1045 / 1880 | 1125 / 2025 | 1210 / 2170 | 1300 / 2335 | 1395 / 2510 |
| 5000 | 1150 / 2075 | 1240 / 2240 | 1330 / 2410 | 1435 / 2595 | 1540 / 2795 |
| 6000 | 1265 / 2305 | 1365 / 2485 | 1475 / 2680 | 1585 / 2895 | 1705 / 3125 |
| 7000 | 1400 / 2565 | 1510 / 2770 | 1630 / 3000 | 1755 / 3245 | 1890 / 3515 |
| 8000 | 1550 / 2870 | 1675 / 3110 | 1805 / 3375 | 1945 / 3670 | 2095 / 3990 |

Notes from the figure: short-field technique; before takeoff from fields above 3000 ft elevation, lean to maximum RPM in a full-throttle static run-up; decrease distances 10% for each 9 knots of headwind; with tailwinds up to 10 knots, increase distances 10% for each 2 knots; on a dry grass runway, increase the ground-roll figure by 15%.
```

- [ ] **Step 5: Write `workspace/poh/rate-of-climb.md`**

```md
# Rate of climb, maximum, 2300 lb

Source: Cessna 172N POH (1978), Section 5, Figure 5-5. Conditions: flaps up, full throttle, mixture leaned above 3000 ft for maximum RPM. Rate in feet per minute at the climb speed shown.

| Pressure altitude | Climb speed KIAS | −20 °C | 0 °C | 20 °C | 40 °C |
|---|---|---|---|---|---|
| Sea level | 73 | 875 | 815 | 755 | 695 |
| 2000 | 72 | 765 | 705 | 650 | 590 |
| 4000 | 71 | 655 | 600 | 545 | 485 |
| 6000 | 70 | 545 | 495 | 440 | 385 |
| 8000 | 69 | 440 | 390 | 335 | 280 |
| 10,000 | 68 | 335 | 285 | 230 | |
| 12,000 | 67 | 230 | 180 | | |
```

- [ ] **Step 6: Write `workspace/poh/time-fuel-distance-to-climb.md`**

```md
# Time, fuel and distance to climb, maximum rate, 2300 lb

Source: Cessna 172N POH (1978), Section 5, Figure 5-6. Conditions: flaps up, full throttle, standard temperature. Values are cumulative from sea level. Add 1.1 gallons for engine start, taxi and takeoff. Increase time, fuel and distance 10% for each 10 °C above standard. Distances assume zero wind.

| Pressure altitude | Temp °C | Climb speed KIAS | Rate of climb fpm | Time min | Fuel used gal | Distance nm |
|---|---|---|---|---|---|---|
| Sea level | 15 | 73 | 770 | 0 | 0.0 | 0 |
| 1000 | 13 | 73 | 725 | 1 | 0.3 | 2 |
| 2000 | 11 | 72 | 675 | 3 | 0.6 | 3 |
| 3000 | 9 | 72 | 630 | 4 | 0.9 | 5 |
| 4000 | 7 | 71 | 580 | 6 | 1.2 | 8 |
| 5000 | 5 | 71 | 535 | 8 | 1.6 | 10 |
| 6000 | 3 | 70 | 485 | 10 | 1.9 | 12 |
| 7000 | 1 | 69 | 440 | 12 | 2.3 | 15 |
| 8000 | −1 | 69 | 390 | 15 | 2.7 | 19 |
| 9000 | −3 | 68 | 345 | 17 | 3.2 | 22 |
| 10,000 | −5 | 68 | 295 | 21 | 3.7 | 27 |
| 11,000 | −7 | 67 | 250 | 24 | 4.2 | 32 |
| 12,000 | −9 | 67 | 200 | 29 | 4.9 | 38 |
```

- [ ] **Step 7: Write `workspace/poh/cruise-performance.md`**

```md
# Cruise performance, 2300 lb, recommended lean mixture

Source: Cessna 172N POH (1978), Section 5, Figure 5-7. Columns are percent brake horsepower / true airspeed KTAS / fuel flow GPH at 20 °C below standard, standard, and 20 °C above standard temperature. A dash means the setting is not available at that temperature.

| Pressure altitude | RPM | 20 °C below | Standard | 20 °C above |
|---|---|---|---|---|
| 2000 | 2500 | — | 75 / 116 / 8.4 | 71 / 115 / 7.9 |
| 2000 | 2400 | 72 / 111 / 8.0 | 67 / 111 / 7.5 | 63 / 110 / 7.1 |
| 2000 | 2300 | 64 / 106 / 7.1 | 60 / 105 / 6.7 | 56 / 105 / 6.3 |
| 2000 | 2200 | 56 / 101 / 6.3 | 53 / 100 / 6.1 | 50 / 99 / 5.8 |
| 2000 | 2100 | 50 / 95 / 5.8 | 47 / 94 / 5.6 | 45 / 93 / 5.4 |
| 4000 | 2550 | — | 75 / 118 / 8.4 | 71 / 118 / 7.9 |
| 4000 | 2500 | 76 / 116 / 8.5 | 71 / 115 / 8.0 | 67 / 115 / 7.5 |
| 4000 | 2400 | 68 / 111 / 7.6 | 64 / 110 / 7.1 | 60 / 109 / 6.7 |
| 4000 | 2300 | 60 / 105 / 6.8 | 57 / 105 / 6.4 | 54 / 104 / 6.1 |
| 4000 | 2200 | 54 / 100 / 6.1 | 51 / 99 / 5.9 | 48 / 98 / 5.7 |
| 4000 | 2100 | 48 / 94 / 5.6 | 46 / 93 / 5.5 | 44 / 92 / 5.3 |
| 6000 | 2600 | — | 75 / 120 / 8.4 | 71 / 120 / 7.9 |
| 6000 | 2500 | 72 / 116 / 8.1 | 67 / 115 / 7.6 | 64 / 114 / 7.1 |
| 6000 | 2400 | 64 / 110 / 7.2 | 60 / 109 / 6.8 | 57 / 109 / 6.4 |
| 6000 | 2300 | 57 / 105 / 6.5 | 54 / 104 / 6.2 | 52 / 103 / 5.9 |
| 6000 | 2200 | 51 / 99 / 5.9 | 49 / 98 / 5.7 | 47 / 97 / 5.5 |
| 6000 | 2100 | 46 / 93 / 5.5 | 44 / 92 / 5.4 | 42 / 91 / 5.2 |
| 8000 | 2650 | — | 75 / 122 / 8.4 | 71 / 122 / 7.9 |
| 8000 | 2600 | 76 / 120 / 8.6 | 71 / 120 / 8.0 | 67 / 119 / 7.5 |
| 8000 | 2500 | 68 / 115 / 7.7 | 64 / 114 / 7.2 | 60 / 113 / 6.8 |
| 8000 | 2400 | 61 / 110 / 6.9 | 58 / 109 / 6.5 | 55 / 108 / 6.2 |
| 8000 | 2300 | 55 / 104 / 6.2 | 52 / 103 / 6.0 | 50 / 102 / 5.8 |
| 8000 | 2200 | 49 / 98 / 5.7 | 47 / 97 / 5.5 | 45 / 96 / 5.4 |
| 10,000 | 2650 | 76 / 122 / 8.5 | 71 / 122 / 8.0 | 67 / 121 / 7.5 |
| 10,000 | 2600 | 72 / 120 / 8.1 | 68 / 119 / 7.6 | 64 / 118 / 7.1 |
| 10,000 | 2500 | 65 / 114 / 7.3 | 61 / 114 / 6.8 | 58 / 112 / 6.5 |
| 10,000 | 2400 | 58 / 109 / 6.5 | 55 / 108 / 6.2 | 52 / 107 / 6.0 |
| 10,000 | 2300 | 52 / 103 / 6.0 | 50 / 102 / 5.8 | 48 / 101 / 5.6 |
| 10,000 | 2200 | 47 / 97 / 5.6 | 45 / 96 / 5.4 | 44 / 95 / 5.3 |
| 12,000 | 2600 | 68 / 119 / 7.7 | 64 / 118 / 7.2 | 61 / 117 / 6.8 |
| 12,000 | 2500 | 62 / 114 / 6.9 | 58 / 113 / 6.5 | 55 / 111 / 6.2 |
| 12,000 | 2400 | 56 / 108 / 6.3 | 53 / 107 / 6.0 | 51 / 106 / 5.8 |
| 12,000 | 2300 | 50 / 102 / 5.8 | 48 / 101 / 5.6 | 46 / 100 / 5.5 |
| 12,000 | 2200 | 46 / 96 / 5.5 | 44 / 95 / 5.4 | 43 / 94 / 5.3 |

Range and endurance (Figures 5-8 and 5-9) assume a 45 minute reserve at 45% BHP, which is 4.1 gallons.
```

- [ ] **Step 8: Write `workspace/poh/landing-distance.md`**

```md
# Landing distance, short field, 2300 lb

Source: Cessna 172N POH (1978), Section 5, Figure 5-10. Conditions: flaps 40°, power off, maximum braking, paved level dry runway, zero wind, 60 KIAS at 50 ft. Distances in feet: ground roll / total to clear a 50 ft obstacle.

| Pressure altitude | 0 °C | 10 °C | 20 °C | 30 °C | 40 °C |
|---|---|---|---|---|---|
| Sea level | 495 / 1205 | 510 / 1235 | 530 / 1265 | 545 / 1295 | 565 / 1330 |
| 1000 | 510 / 1235 | 530 / 1265 | 550 / 1300 | 565 / 1330 | 585 / 1365 |
| 2000 | 530 / 1265 | 550 / 1300 | 570 / 1335 | 590 / 1370 | 610 / 1405 |
| 3000 | 550 / 1300 | 570 / 1335 | 590 / 1370 | 610 / 1405 | 630 / 1440 |
| 4000 | 570 / 1335 | 590 / 1370 | 615 / 1410 | 635 / 1445 | 655 / 1480 |
| 5000 | 590 / 1370 | 615 / 1415 | 635 / 1450 | 655 / 1485 | 680 / 1525 |
| 6000 | 615 / 1415 | 640 / 1455 | 660 / 1490 | 685 / 1535 | 705 / 1570 |
| 7000 | 640 / 1455 | 660 / 1490 | 685 / 1535 | 710 / 1575 | 730 / 1615 |
| 8000 | 665 / 1500 | 690 / 1540 | 710 / 1580 | 735 / 1620 | 760 / 1665 |

Notes from the figure: short-field technique; decrease distances 10% for each 9 knots of headwind; with tailwinds up to 10 knots, increase distances 10% for each 2 knots; on a dry grass runway, increase the ground-roll figure by 45%.
```

- [ ] **Step 9: Write `workspace/regs/vfr-fuel-reserves.md` and `workspace/regs/vfr-cruising-altitudes.md`**

```md
# VFR fuel reserves

14 CFR 91.151: no person may begin a flight under VFR unless, considering wind and forecast weather, there is enough fuel to fly to the first point of intended landing and then fly for at least 30 minutes by day or 45 minutes at night at normal cruising speed. This planner uses 45 minutes at the planned cruise burn as its reserve for every flight, day or night, and flags a plan whose fuel remaining at destination is below that.
```

```md
# VFR cruising altitudes

14 CFR 91.159: above 3000 ft AGL and below 18,000 ft MSL, on a magnetic course of 0° through 179° fly an odd thousand plus 500 ft (3500, 5500, 7500); on a magnetic course of 180° through 359° fly an even thousand plus 500 ft (4500, 6500, 8500). The rule is keyed to magnetic course, not heading. Below 3000 ft AGL any altitude is allowed.
```

- [ ] **Step 10: Rewrite `workspace/AGENTS.md`**

```md
# Navlog workspace memory

B4.run injects this file into the agent's system prompt every turn. Use it for
durable flight-planning conventions; the agent updates it with
`writeFile({ path: "AGENTS.md", content: "..." })` when it learns something
worth keeping across sessions.

## House style

- Every performance number comes from a POH table the performance subagent
  read; cite it as the figure, e.g. `[poh/cruise-performance.md, Figure 5-7]`.
- Weather comes from the live tools, never from memory. Quote the raw METAR
  and TAF the brief is based on.
- Never do navigation arithmetic yourself. `computeNavlog` owns distance,
  course, wind correction, groundspeed, time and fuel.
- Present the navlog and the brief first. File a flight plan only when the
  pilot asks, and expect the human to approve it.
- Save the navlog as `reports/<departure>-<destination>.md` in the workspace.
```

- [ ] **Step 11: Commit**

```bash
git add -A examples/navlog/server/workspace
git commit -m "feat(navlog): POH and regulation corpus replaces the research corpus

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 2: geo and wind math

**Files:**
- Create: `examples/navlog/server/src/lib/geo.ts`, `src/lib/wind.ts`
- Test: `examples/navlog/server/test/geo.test.ts`, `test/wind.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/geo.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { distanceNm, initialTrueCourse, magneticFromTrue } from "../src/lib/geo.ts"

// KSTP 44.9346,-93.0603  KRST 43.9083,-92.4900 (FAA airport records)
const KSTP = { lat: 44.9346, lon: -93.0603 }
const KRST = { lat: 43.9083, lon: -92.49 }

describe("great circle", () => {
  it("measures KSTP to KRST at about 66 nm", () => {
    expect(distanceNm(KSTP, KRST)).toBeCloseTo(66.3, 0)
  })
  it("gives a south-southeast initial true course from KSTP to KRST", () => {
    const tc = initialTrueCourse(KSTP, KRST)
    expect(tc).toBeGreaterThan(155)
    expect(tc).toBeLessThan(160)
  })
  it("is zero distance and course 0 for the same point", () => {
    expect(distanceNm(KSTP, KSTP)).toBe(0)
    expect(initialTrueCourse(KSTP, KSTP)).toBe(0)
  })
  it("normalizes courses into [0, 360)", () => {
    expect(initialTrueCourse({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 5)
  })
})

describe("magnetic from true", () => {
  it("subtracts east variation and adds west variation", () => {
    expect(magneticFromTrue(100, 5)).toBe(95) // 5E
    expect(magneticFromTrue(100, -5)).toBe(105) // 5W
  })
  it("wraps around north", () => {
    expect(magneticFromTrue(2, 5)).toBe(357)
    expect(magneticFromTrue(358, -5)).toBe(3)
  })
})
```

`test/wind.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { solveWindTriangle } from "../src/lib/wind.ts"

describe("wind triangle", () => {
  it("direct headwind slows groundspeed with no correction angle", () => {
    const r = solveWindTriangle({ trueCourse: 360, tasKt: 110, windDirTrue: 360, windKt: 20 })
    expect(r.windCorrectionAngle).toBeCloseTo(0, 5)
    expect(r.trueHeading).toBeCloseTo(0, 5)
    expect(r.groundspeedKt).toBeCloseTo(90, 5)
  })
  it("direct tailwind speeds groundspeed with no correction angle", () => {
    const r = solveWindTriangle({ trueCourse: 90, tasKt: 110, windDirTrue: 270, windKt: 20 })
    expect(r.windCorrectionAngle).toBeCloseTo(0, 5)
    expect(r.groundspeedKt).toBeCloseTo(130, 5)
  })
  it("direct crosswind from the right needs a right correction", () => {
    const r = solveWindTriangle({ trueCourse: 360, tasKt: 100, windDirTrue: 90, windKt: 20 })
    expect(r.windCorrectionAngle).toBeCloseTo(11.54, 1)
    expect(r.trueHeading).toBeCloseTo(11.54, 1)
    expect(r.groundspeedKt).toBeCloseTo(97.98, 1)
  })
  it("direct crosswind from the left needs a left correction", () => {
    const r = solveWindTriangle({ trueCourse: 360, tasKt: 100, windDirTrue: 270, windKt: 20 })
    expect(r.windCorrectionAngle).toBeCloseTo(-11.54, 1)
    expect(r.trueHeading).toBeCloseTo(348.46, 1)
  })
  it("calm wind leaves everything as is", () => {
    const r = solveWindTriangle({ trueCourse: 200, tasKt: 110, windDirTrue: 0, windKt: 0 })
    expect(r.windCorrectionAngle).toBe(0)
    expect(r.trueHeading).toBe(200)
    expect(r.groundspeedKt).toBe(110)
  })
  it("throws when the wind exceeds TAS so no solution exists", () => {
    expect(() =>
      solveWindTriangle({ trueCourse: 360, tasKt: 50, windDirTrue: 90, windKt: 60 }),
    ).toThrow(/exceeds true airspeed/)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/geo.test.ts test/wind.test.ts
```
Expected: both files fail to import (`Cannot find module`).

- [ ] **Step 3: Implement `src/lib/geo.ts`**

```ts
export interface LatLon {
  readonly lat: number
  readonly lon: number
}

const EARTH_RADIUS_NM = 3440.065
const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI

/** Normalize an angle in degrees into [0, 360). */
export function normalizeDeg(deg: number): number {
  const r = deg % 360
  return r < 0 ? r + 360 : r
}

/** Great-circle distance in nautical miles (haversine). */
export function distanceNm(from: LatLon, to: LatLon): number {
  const dLat = toRad(to.lat - from.lat)
  const dLon = toRad(to.lon - from.lon)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Initial true course in degrees, [0, 360). Zero for coincident points. */
export function initialTrueCourse(from: LatLon, to: LatLon): number {
  if (from.lat === to.lat && from.lon === to.lon) return 0
  const phi1 = toRad(from.lat)
  const phi2 = toRad(to.lat)
  const dLon = toRad(to.lon - from.lon)
  const y = Math.sin(dLon) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLon)
  return normalizeDeg(toDeg(Math.atan2(y, x)))
}

/**
 * True to magnetic. `variationDeg` is signed: positive east, negative west.
 * "East is least": subtract east variation.
 */
export function magneticFromTrue(trueDeg: number, variationDeg: number): number {
  return normalizeDeg(trueDeg - variationDeg)
}
```

- [ ] **Step 4: Implement `src/lib/wind.ts`**

```ts
import { normalizeDeg } from "./geo.js"

export interface WindTriangleInput {
  readonly trueCourse: number
  readonly tasKt: number
  /** Direction the wind blows FROM, degrees true. */
  readonly windDirTrue: number
  readonly windKt: number
}

export interface WindTriangleResult {
  /** Degrees, positive right (into the wind), negative left. */
  readonly windCorrectionAngle: number
  readonly trueHeading: number
  readonly groundspeedKt: number
}

const toRad = (deg: number): number => (deg * Math.PI) / 180
const toDeg = (rad: number): number => (rad * 180) / Math.PI

/** Classic E6B wind triangle. Throws when the crosswind component exceeds TAS. */
export function solveWindTriangle(input: WindTriangleInput): WindTriangleResult {
  const { trueCourse, tasKt, windDirTrue, windKt } = input
  if (windKt === 0) {
    return { windCorrectionAngle: 0, trueHeading: trueCourse, groundspeedKt: tasKt }
  }
  const relative = toRad(windDirTrue - trueCourse)
  const crosswind = windKt * Math.sin(relative)
  const headwind = windKt * Math.cos(relative)
  const ratio = crosswind / tasKt
  if (Math.abs(ratio) > 1) {
    throw new Error(`crosswind component ${crosswind.toFixed(1)} kt exceeds true airspeed ${tasKt} kt`)
  }
  const wca = toDeg(Math.asin(ratio))
  const groundspeed = tasKt * Math.cos(toRad(wca)) - headwind
  if (groundspeed <= 0) {
    throw new Error(`headwind component ${headwind.toFixed(1)} kt exceeds true airspeed ${tasKt} kt`)
  }
  return {
    windCorrectionAngle: wca,
    trueHeading: normalizeDeg(trueCourse + wca),
    groundspeedKt: groundspeed,
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/geo.test.ts test/wind.test.ts
```
Expected: 11 tests pass.

- [ ] **Step 6: Commit**

```bash
git add examples/navlog/server/src/lib/geo.ts examples/navlog/server/src/lib/wind.ts examples/navlog/server/test/geo.test.ts examples/navlog/server/test/wind.test.ts
git commit -m "feat(navlog): great-circle and wind-triangle math

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 3: POH tables in code, kept in sync with the corpus

**Files:**
- Create: `examples/navlog/server/src/lib/poh-tables.ts`
- Test: `test/poh-tables.test.ts`, `test/corpus-sync.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/poh-tables.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { climbFromSeaLevel, cruiseAt, landingDistance, takeoffDistance } from "../src/lib/poh-tables.ts"

describe("cruise performance (Figure 5-7)", () => {
  it("returns the table row at a listed altitude and RPM, standard temperature", () => {
    expect(cruiseAt({ pressureAltitudeFt: 4000, rpm: 2400 })).toEqual({ bhpPct: 64, tasKt: 110, gph: 7.1 })
  })
  it("interpolates between altitude rows", () => {
    const r = cruiseAt({ pressureAltitudeFt: 5000, rpm: 2400 })
    expect(r.tasKt).toBeCloseTo(109.5, 5)
    expect(r.gph).toBeCloseTo(6.95, 5)
  })
  it("uses the 20 °C above column when asked", () => {
    expect(cruiseAt({ pressureAltitudeFt: 2000, rpm: 2300, temperature: "above" })).toEqual({
      bhpPct: 56,
      tasKt: 105,
      gph: 6.3,
    })
  })
  it("rejects an RPM the table does not list at that altitude", () => {
    expect(() => cruiseAt({ pressureAltitudeFt: 2000, rpm: 2600 })).toThrow(/not listed/)
  })
  it("rejects a setting the table marks unavailable", () => {
    expect(() => cruiseAt({ pressureAltitudeFt: 2000, rpm: 2500, temperature: "below" })).toThrow(/not available/)
  })
})

describe("time, fuel and distance to climb (Figure 5-6)", () => {
  it("reads a listed altitude", () => {
    expect(climbFromSeaLevel(4000)).toEqual({ timeMin: 6, fuelGal: 1.2, distanceNm: 8 })
  })
  it("interpolates between rows", () => {
    expect(climbFromSeaLevel(4500)).toEqual({ timeMin: 7, fuelGal: 1.4, distanceNm: 9 })
  })
  it("is zero at sea level and rejects above the table", () => {
    expect(climbFromSeaLevel(0)).toEqual({ timeMin: 0, fuelGal: 0, distanceNm: 0 })
    expect(() => climbFromSeaLevel(13000)).toThrow(/above 12,000/)
  })
})

describe("takeoff and landing (Figures 5-4 and 5-10)", () => {
  it("reads takeoff distance at 1000 ft and 20 °C", () => {
    expect(takeoffDistance({ pressureAltitudeFt: 1000, temperatureC: 20 })).toEqual({ groundRollFt: 915, over50FtFt: 1630 })
  })
  it("interpolates takeoff distance across temperature", () => {
    expect(takeoffDistance({ pressureAltitudeFt: 0, temperatureC: 5 })).toEqual({ groundRollFt: 748, over50FtFt: 1345 })
  })
  it("reads landing distance at 2000 ft and 10 °C", () => {
    expect(landingDistance({ pressureAltitudeFt: 2000, temperatureC: 10 })).toEqual({ groundRollFt: 550, over50FtFt: 1300 })
  })
})
```

`test/corpus-sync.test.ts` (keeps the Markdown the model reads equal to the numbers the code uses):

```ts
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { CLIMB_TABLE, CRUISE_TABLE, LANDING_TABLE, TAKEOFF_TABLE } from "../src/lib/poh-tables.ts"

const doc = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../workspace/poh/${name}.md`, import.meta.url)), "utf8")

const fmtAlt = (ft: number): string => (ft === 0 ? "Sea level" : ft.toLocaleString("en-US"))

describe("workspace/poh matches src/lib/poh-tables", () => {
  it("cruise rows", () => {
    const md = doc("cruise-performance")
    for (const row of CRUISE_TABLE) {
      const cell = (c: { bhpPct: number; tasKt: number; gph: number } | null): string =>
        c === null ? "—" : `${c.bhpPct} / ${c.tasKt} / ${c.gph.toFixed(1)}`
      const line = `| ${fmtAlt(row.pressureAltitudeFt)} | ${row.rpm} | ${cell(row.below)} | ${cell(row.standard)} | ${cell(row.above)} |`
      expect(md, line).toContain(line)
    }
  })
  it("climb rows", () => {
    const md = doc("time-fuel-distance-to-climb")
    for (const row of CLIMB_TABLE) {
      const line = `| ${row.timeMin} | ${row.fuelGal.toFixed(1)} | ${row.distanceNm} |`
      expect(md, `${row.pressureAltitudeFt}`).toContain(line)
    }
  })
  it("takeoff and landing rows", () => {
    const to = doc("takeoff-distance")
    for (const row of TAKEOFF_TABLE) {
      const cells = row.byTemperature.map((c) => `${c.groundRollFt} / ${c.over50FtFt}`).join(" | ")
      expect(to).toContain(`| ${fmtAlt(row.pressureAltitudeFt)} | ${cells} |`)
    }
    const ld = doc("landing-distance")
    for (const row of LANDING_TABLE) {
      const cells = row.byTemperature.map((c) => `${c.groundRollFt} / ${c.over50FtFt}`).join(" | ")
      expect(ld).toContain(`| ${fmtAlt(row.pressureAltitudeFt)} | ${cells} |`)
    }
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/poh-tables.test.ts test/corpus-sync.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/lib/poh-tables.ts`**

```ts
/**
 * Cessna 172N (1978) POH Section 5 tables, 2300 lb, transcribed. The Markdown
 * twins in workspace/poh are what the model reads; test/corpus-sync.test.ts
 * keeps the two equal.
 */

export interface CruiseCell {
  readonly bhpPct: number
  readonly tasKt: number
  readonly gph: number
}
export interface CruiseRow {
  readonly pressureAltitudeFt: number
  readonly rpm: number
  readonly below: CruiseCell | null
  readonly standard: CruiseCell
  readonly above: CruiseCell
}
const c = (bhpPct: number, tasKt: number, gph: number): CruiseCell => ({ bhpPct, tasKt, gph })
const r = (
  pressureAltitudeFt: number,
  rpm: number,
  below: CruiseCell | null,
  standard: CruiseCell,
  above: CruiseCell,
): CruiseRow => ({ pressureAltitudeFt, rpm, below, standard, above })

/** Figure 5-7. */
export const CRUISE_TABLE: readonly CruiseRow[] = [
  r(2000, 2500, null, c(75, 116, 8.4), c(71, 115, 7.9)),
  r(2000, 2400, c(72, 111, 8.0), c(67, 111, 7.5), c(63, 110, 7.1)),
  r(2000, 2300, c(64, 106, 7.1), c(60, 105, 6.7), c(56, 105, 6.3)),
  r(2000, 2200, c(56, 101, 6.3), c(53, 100, 6.1), c(50, 99, 5.8)),
  r(2000, 2100, c(50, 95, 5.8), c(47, 94, 5.6), c(45, 93, 5.4)),
  r(4000, 2550, null, c(75, 118, 8.4), c(71, 118, 7.9)),
  r(4000, 2500, c(76, 116, 8.5), c(71, 115, 8.0), c(67, 115, 7.5)),
  r(4000, 2400, c(68, 111, 7.6), c(64, 110, 7.1), c(60, 109, 6.7)),
  r(4000, 2300, c(60, 105, 6.8), c(57, 105, 6.4), c(54, 104, 6.1)),
  r(4000, 2200, c(54, 100, 6.1), c(51, 99, 5.9), c(48, 98, 5.7)),
  r(4000, 2100, c(48, 94, 5.6), c(46, 93, 5.5), c(44, 92, 5.3)),
  r(6000, 2600, null, c(75, 120, 8.4), c(71, 120, 7.9)),
  r(6000, 2500, c(72, 116, 8.1), c(67, 115, 7.6), c(64, 114, 7.1)),
  r(6000, 2400, c(64, 110, 7.2), c(60, 109, 6.8), c(57, 109, 6.4)),
  r(6000, 2300, c(57, 105, 6.5), c(54, 104, 6.2), c(52, 103, 5.9)),
  r(6000, 2200, c(51, 99, 5.9), c(49, 98, 5.7), c(47, 97, 5.5)),
  r(6000, 2100, c(46, 93, 5.5), c(44, 92, 5.4), c(42, 91, 5.2)),
  r(8000, 2650, null, c(75, 122, 8.4), c(71, 122, 7.9)),
  r(8000, 2600, c(76, 120, 8.6), c(71, 120, 8.0), c(67, 119, 7.5)),
  r(8000, 2500, c(68, 115, 7.7), c(64, 114, 7.2), c(60, 113, 6.8)),
  r(8000, 2400, c(61, 110, 6.9), c(58, 109, 6.5), c(55, 108, 6.2)),
  r(8000, 2300, c(55, 104, 6.2), c(52, 103, 6.0), c(50, 102, 5.8)),
  r(8000, 2200, c(49, 98, 5.7), c(47, 97, 5.5), c(45, 96, 5.4)),
  r(10000, 2650, c(76, 122, 8.5), c(71, 122, 8.0), c(67, 121, 7.5)),
  r(10000, 2600, c(72, 120, 8.1), c(68, 119, 7.6), c(64, 118, 7.1)),
  r(10000, 2500, c(65, 114, 7.3), c(61, 114, 6.8), c(58, 112, 6.5)),
  r(10000, 2400, c(58, 109, 6.5), c(55, 108, 6.2), c(52, 107, 6.0)),
  r(10000, 2300, c(52, 103, 6.0), c(50, 102, 5.8), c(48, 101, 5.6)),
  r(10000, 2200, c(47, 97, 5.6), c(45, 96, 5.4), c(44, 95, 5.3)),
  r(12000, 2600, c(68, 119, 7.7), c(64, 118, 7.2), c(61, 117, 6.8)),
  r(12000, 2500, c(62, 114, 6.9), c(58, 113, 6.5), c(55, 111, 6.2)),
  r(12000, 2400, c(56, 108, 6.3), c(53, 107, 6.0), c(51, 106, 5.8)),
  r(12000, 2300, c(50, 102, 5.8), c(48, 101, 5.6), c(46, 100, 5.5)),
  r(12000, 2200, c(46, 96, 5.5), c(44, 95, 5.4), c(43, 94, 5.3)),
]

export type CruiseTemperature = "below" | "standard" | "above"

const round1 = (n: number): number => Math.round(n * 10) / 10

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** Cruise row for a pressure altitude (interpolated between the table's altitudes) and a listed RPM. */
export function cruiseAt(input: {
  readonly pressureAltitudeFt: number
  readonly rpm: number
  readonly temperature?: CruiseTemperature
}): CruiseCell {
  const temperature = input.temperature ?? "standard"
  const altitudes = [...new Set(CRUISE_TABLE.map((row) => row.pressureAltitudeFt))].sort((a, b) => a - b)
  const alt = Math.min(Math.max(input.pressureAltitudeFt, altitudes[0] ?? 0), altitudes.at(-1) ?? 0)
  const lower = [...altitudes].reverse().find((a) => a <= alt) ?? altitudes[0] ?? 0
  const upper = altitudes.find((a) => a >= alt) ?? lower
  const cellAt = (altitudeFt: number): CruiseCell => {
    const row = CRUISE_TABLE.find((entry) => entry.pressureAltitudeFt === altitudeFt && entry.rpm === input.rpm)
    if (!row) throw new Error(`cruise RPM ${input.rpm} is not listed at ${altitudeFt} ft (Figure 5-7)`)
    const cell = row[temperature]
    if (cell === null) throw new Error(`cruise ${input.rpm} RPM at ${altitudeFt} ft is not available 20 °C below standard (Figure 5-7)`)
    return cell
  }
  const lo = cellAt(lower)
  if (lower === upper) return lo
  const hi = cellAt(upper)
  const t = (alt - lower) / (upper - lower)
  return {
    bhpPct: Math.round(lerp(lo.bhpPct, hi.bhpPct, t)),
    tasKt: lerp(lo.tasKt, hi.tasKt, t),
    gph: lerp(lo.gph, hi.gph, t),
  }
}

export interface ClimbRow {
  readonly pressureAltitudeFt: number
  readonly timeMin: number
  readonly fuelGal: number
  readonly distanceNm: number
}

/** Figure 5-6, cumulative from sea level, standard temperature. */
export const CLIMB_TABLE: readonly ClimbRow[] = [
  { pressureAltitudeFt: 0, timeMin: 0, fuelGal: 0.0, distanceNm: 0 },
  { pressureAltitudeFt: 1000, timeMin: 1, fuelGal: 0.3, distanceNm: 2 },
  { pressureAltitudeFt: 2000, timeMin: 3, fuelGal: 0.6, distanceNm: 3 },
  { pressureAltitudeFt: 3000, timeMin: 4, fuelGal: 0.9, distanceNm: 5 },
  { pressureAltitudeFt: 4000, timeMin: 6, fuelGal: 1.2, distanceNm: 8 },
  { pressureAltitudeFt: 5000, timeMin: 8, fuelGal: 1.6, distanceNm: 10 },
  { pressureAltitudeFt: 6000, timeMin: 10, fuelGal: 1.9, distanceNm: 12 },
  { pressureAltitudeFt: 7000, timeMin: 12, fuelGal: 2.3, distanceNm: 15 },
  { pressureAltitudeFt: 8000, timeMin: 15, fuelGal: 2.7, distanceNm: 19 },
  { pressureAltitudeFt: 9000, timeMin: 17, fuelGal: 3.2, distanceNm: 22 },
  { pressureAltitudeFt: 10000, timeMin: 21, fuelGal: 3.7, distanceNm: 27 },
  { pressureAltitudeFt: 11000, timeMin: 24, fuelGal: 4.2, distanceNm: 32 },
  { pressureAltitudeFt: 12000, timeMin: 29, fuelGal: 4.9, distanceNm: 38 },
]

/** Cumulative climb figures from sea level to a pressure altitude, interpolated, rounded like the table. */
export function climbFromSeaLevel(pressureAltitudeFt: number): { timeMin: number; fuelGal: number; distanceNm: number } {
  if (pressureAltitudeFt <= 0) return { timeMin: 0, fuelGal: 0, distanceNm: 0 }
  const top = CLIMB_TABLE.at(-1)
  if (!top || pressureAltitudeFt > top.pressureAltitudeFt) throw new Error("climb table ends above 12,000 ft (Figure 5-6)")
  const lower = [...CLIMB_TABLE].reverse().find((row) => row.pressureAltitudeFt <= pressureAltitudeFt) ?? CLIMB_TABLE[0]
  const upper = CLIMB_TABLE.find((row) => row.pressureAltitudeFt >= pressureAltitudeFt) ?? lower
  if (!lower || !upper) throw new Error("climb table is empty")
  if (lower === upper) return { timeMin: lower.timeMin, fuelGal: lower.fuelGal, distanceNm: lower.distanceNm }
  const t = (pressureAltitudeFt - lower.pressureAltitudeFt) / (upper.pressureAltitudeFt - lower.pressureAltitudeFt)
  return {
    timeMin: Math.round(lerp(lower.timeMin, upper.timeMin, t)),
    fuelGal: round1(lerp(lower.fuelGal, upper.fuelGal, t)),
    distanceNm: Math.round(lerp(lower.distanceNm, upper.distanceNm, t)),
  }
}

export interface FieldCell {
  readonly groundRollFt: number
  readonly over50FtFt: number
}
export interface FieldRow {
  readonly pressureAltitudeFt: number
  /** Index 0..4 = 0, 10, 20, 30, 40 °C. */
  readonly byTemperature: readonly [FieldCell, FieldCell, FieldCell, FieldCell, FieldCell]
}
const f = (groundRollFt: number, over50FtFt: number): FieldCell => ({ groundRollFt, over50FtFt })
const row = (pressureAltitudeFt: number, ...cells: [FieldCell, FieldCell, FieldCell, FieldCell, FieldCell]): FieldRow => ({
  pressureAltitudeFt,
  byTemperature: cells,
})

/** Figure 5-4, sheet 1 (2300 lb, short field). */
export const TAKEOFF_TABLE: readonly FieldRow[] = [
  row(0, f(720, 1300), f(775, 1390), f(835, 1490), f(895, 1590), f(960, 1700)),
  row(1000, f(790, 1420), f(850, 1525), f(915, 1630), f(980, 1745), f(1050, 1865)),
  row(2000, f(865, 1555), f(930, 1670), f(1000, 1790), f(1075, 1915), f(1155, 2055)),
  row(3000, f(950, 1710), f(1025, 1835), f(1100, 1970), f(1185, 2115), f(1270, 2265)),
  row(4000, f(1045, 1880), f(1125, 2025), f(1210, 2170), f(1300, 2335), f(1395, 2510)),
  row(5000, f(1150, 2075), f(1240, 2240), f(1330, 2410), f(1435, 2595), f(1540, 2795)),
  row(6000, f(1265, 2305), f(1365, 2485), f(1475, 2680), f(1585, 2895), f(1705, 3125)),
  row(7000, f(1400, 2565), f(1510, 2770), f(1630, 3000), f(1755, 3245), f(1890, 3515)),
  row(8000, f(1550, 2870), f(1675, 3110), f(1805, 3375), f(1945, 3670), f(2095, 3990)),
]

/** Figure 5-10 (2300 lb, short field, flaps 40°). */
export const LANDING_TABLE: readonly FieldRow[] = [
  row(0, f(495, 1205), f(510, 1235), f(530, 1265), f(545, 1295), f(565, 1330)),
  row(1000, f(510, 1235), f(530, 1265), f(550, 1300), f(565, 1330), f(585, 1365)),
  row(2000, f(530, 1265), f(550, 1300), f(570, 1335), f(590, 1370), f(610, 1405)),
  row(3000, f(550, 1300), f(570, 1335), f(590, 1370), f(610, 1405), f(630, 1440)),
  row(4000, f(570, 1335), f(590, 1370), f(615, 1410), f(635, 1445), f(655, 1480)),
  row(5000, f(590, 1370), f(615, 1415), f(635, 1450), f(655, 1485), f(680, 1525)),
  row(6000, f(615, 1415), f(640, 1455), f(660, 1490), f(685, 1535), f(705, 1570)),
  row(7000, f(640, 1455), f(660, 1490), f(685, 1535), f(710, 1575), f(730, 1615)),
  row(8000, f(665, 1500), f(690, 1540), f(710, 1580), f(735, 1620), f(760, 1665)),
]

function fieldLookup(table: readonly FieldRow[], input: { readonly pressureAltitudeFt: number; readonly temperatureC: number }, figure: string): FieldCell {
  const alt = input.pressureAltitudeFt
  const first = table[0]
  const last = table.at(-1)
  if (!first || !last) throw new Error(`${figure} table is empty`)
  if (alt < first.pressureAltitudeFt || alt > last.pressureAltitudeFt) {
    throw new Error(`${figure} covers sea level to ${last.pressureAltitudeFt} ft pressure altitude`)
  }
  if (input.temperatureC < 0 || input.temperatureC > 40) throw new Error(`${figure} covers 0 to 40 °C`)
  const lower = [...table].reverse().find((entry) => entry.pressureAltitudeFt <= alt) ?? first
  const upper = table.find((entry) => entry.pressureAltitudeFt >= alt) ?? lower
  const tAlt = lower === upper ? 0 : (alt - lower.pressureAltitudeFt) / (upper.pressureAltitudeFt - lower.pressureAltitudeFt)
  const tempIndex = input.temperatureC / 10
  const i0 = Math.min(3, Math.floor(tempIndex))
  const i1 = Math.min(4, i0 + 1)
  const tTemp = tempIndex - i0
  const at = (entry: FieldRow, key: keyof FieldCell): number =>
    lerp(entry.byTemperature[i0]?.[key] ?? 0, entry.byTemperature[i1]?.[key] ?? 0, tTemp)
  return {
    groundRollFt: Math.round(lerp(at(lower, "groundRollFt"), at(upper, "groundRollFt"), tAlt)),
    over50FtFt: Math.round(lerp(at(lower, "over50FtFt"), at(upper, "over50FtFt"), tAlt)),
  }
}

export function takeoffDistance(input: { readonly pressureAltitudeFt: number; readonly temperatureC: number }): FieldCell {
  return fieldLookup(TAKEOFF_TABLE, input, "Figure 5-4")
}

export function landingDistance(input: { readonly pressureAltitudeFt: number; readonly temperatureC: number }): FieldCell {
  return fieldLookup(LANDING_TABLE, input, "Figure 5-10")
}
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/poh-tables.test.ts test/corpus-sync.test.ts
```
Expected: all pass. If a corpus-sync row fails, the Markdown and the TS disagree; fix the one that disagrees with the POH figure (Task 1 and this task transcribe the same scan).

- [ ] **Step 5: Commit**

```bash
git add examples/navlog/server/src/lib/poh-tables.ts examples/navlog/server/test/poh-tables.test.ts examples/navlog/server/test/corpus-sync.test.ts
git commit -m "feat(navlog): POH tables in code, kept in sync with the corpus

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 4: the navlog core and the ICAO flight plan

**Files:**
- Create: `src/lib/navlog.ts`, `src/lib/fpl.ts`
- Test: `test/navlog.test.ts` (replaces the old scenario file of that name; delete it first), `test/fpl.test.ts`

- [ ] **Step 1: Delete the old scenario test and write the failing tests**

```bash
git rm -q examples/navlog/server/test/navlog.test.ts
```

`test/navlog.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { computeNavlog, type NavlogInput } from "../src/lib/navlog.ts"

const base: NavlogInput = {
  aircraft: { tailNumber: "N738ZU", cruiseRpm: 2400, usableFuelGal: 50 },
  altitudeFt: 4500,
  departureTimeUtc: "2026-10-05T14:00:00Z",
  waypoints: [
    { id: "KSTP", lat: 44.9346, lon: -93.0603, elevationFt: 215, magneticVariationDeg: 0, kind: "airport" },
    { id: "KRST", lat: 43.9083, lon: -92.49, elevationFt: 1317, magneticVariationDeg: 0, kind: "airport" },
  ],
  winds: [{ dirDegTrue: 320, speedKt: 20, tempC: 5 }],
}

describe("computeNavlog", () => {
  it("splits the first leg into a climb segment and a cruise segment", () => {
    const log = computeNavlog(base)
    expect(log.legs.map((leg) => leg.segment)).toEqual(["climb", "cruise"])
    expect(log.legs[0]?.from).toBe("KSTP")
    expect(log.legs[1]?.to).toBe("KRST")
    // Figure 5-6 at 4500 ft: 7 min, 1.4 gal, 9 nm, plus 1.1 gal start/taxi/takeoff on the climb segment.
    expect(log.legs[0]?.distanceNm).toBe(9)
    expect(log.legs[0]?.fuelGal).toBeCloseTo(2.5, 5)
  })
  it("uses the Figure 5-7 cruise row at the pressure altitude and RPM", () => {
    const log = computeNavlog(base)
    expect(log.aircraft.tasKt).toBeCloseTo(109.75, 2) // 4500 ft between 110 (4000) and 109.5 (5000)
    expect(log.aircraft.gph).toBeCloseTo(7.025, 3)
  })
  it("applies the wind triangle to the cruise segment", () => {
    const log = computeNavlog(base)
    const cruise = log.legs[1]
    expect(cruise?.wind).toEqual({ dir: 320, kt: 20 })
    expect(cruise?.groundspeedKt).toBeGreaterThan(cruise?.tasKt ?? 0) // quartering tailwind on a SSE course
    expect(cruise?.magneticHeading).toBeLessThan(cruise?.magneticCourse ?? 0) // wind from the right-rear: correct left? no: from 320 on a 157 course is from behind-right, WCA positive
  })
  it("accumulates distance, time, fuel and ETA across legs", () => {
    const log = computeNavlog(base)
    const total = log.legs.reduce((sum, leg) => sum + leg.distanceNm, 0)
    expect(log.totals.distanceNm).toBeCloseTo(total, 5)
    expect(log.totals.eteMin).toBe(log.legs.reduce((sum, leg) => sum + leg.eteMin, 0))
    expect(log.legs.at(-1)?.remainingNm).toBe(0)
    expect(log.legs.at(-1)?.fuelRemainingGal).toBeCloseTo(50 - log.totals.fuelGal, 5)
    expect(log.legs[0]?.etaUtc).toBe("2026-10-05T14:07:00.000Z")
  })
  it("reports the reserve in minutes at cruise burn and flags under 45", () => {
    const log = computeNavlog(base)
    expect(log.totals.reserveMin).toBeCloseTo((log.totals.fuelRemainingGal / log.aircraft.gph) * 60, 5)
    expect(log.totals.reserveOk).toBe(true)
    const thirsty = computeNavlog({ ...base, aircraft: { ...base.aircraft, usableFuelGal: 8 } })
    expect(thirsty.totals.reserveOk).toBe(false)
  })
  it("applies magnetic variation per leg from the departure waypoint of that leg", () => {
    const log = computeNavlog({
      ...base,
      waypoints: [
        { ...base.waypoints[0]!, magneticVariationDeg: 2 },
        { ...base.waypoints[1]!, magneticVariationDeg: -3 },
      ],
    })
    expect(log.legs[0]?.variation).toBe(2)
    expect(log.legs[0]?.magneticCourse).toBeCloseTo(log.legs[0]!.trueCourse - 2, 5)
  })
  it("rejects fewer than two waypoints and a winds array of the wrong length", () => {
    expect(() => computeNavlog({ ...base, waypoints: [base.waypoints[0]!] })).toThrow(/at least two waypoints/)
    expect(() => computeNavlog({ ...base, winds: [] })).toThrow(/one wind entry per leg/)
  })
  it("names its POH sources", () => {
    const log = computeNavlog(base)
    expect(log.sources.map((s) => s.figure)).toEqual(["Figure 5-6", "Figure 5-7"])
  })
})
```

Delete the comment on the `magneticHeading` line that argues with itself; the assertion to keep is: wind from 320 on a 157 true course blows from behind-right, so the correction is to the right (`windCorrectionAngle > 0`) and `magneticHeading > magneticCourse`. Write the test as:

```ts
    expect(cruise?.wca).toBeGreaterThan(0)
    expect(cruise?.magneticHeading).toBeGreaterThan(cruise?.magneticCourse ?? 0)
```

`test/fpl.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { buildFlightPlan, formatFplMessage } from "../src/lib/fpl.ts"

const plan = buildFlightPlan({
  tailNumber: "N738ZU",
  departure: "KSTP",
  destination: "KRST",
  route: ["FGT", "KOWA"],
  departureTimeUtc: "2026-10-05T14:00:00Z",
  cruiseTasKt: 110,
  altitudeFt: 4500,
  eteMin: 48,
  enduranceMin: 400,
  personsOnBoard: 2,
})

describe("ICAO flight plan", () => {
  it("fills items 7 to 19 from the navlog", () => {
    expect(plan).toEqual({
      item7: "N738ZU",
      item8: "VG",
      item9: "C172/L",
      item10: "SG/C",
      item13: "KSTP1400",
      item15: "N0110VFR DCT FGT DCT KOWA DCT",
      item16: "KRST0048",
      item18: "DOF/261005",
      item19: "E/0640 P/2",
    })
  })
  it("formats the FPL message", () => {
    expect(formatFplMessage(plan)).toBe(
      "(FPL-N738ZU-VG\n-C172/L-SG/C\n-KSTP1400\n-N0110VFR DCT FGT DCT KOWA DCT\n-KRST0048\n-DOF/261005\n-E/0640 P/2)",
    )
  })
  it("writes DCT alone for a direct flight", () => {
    const direct = buildFlightPlan({ ...planInput(), route: [] })
    expect(direct.item15).toBe("N0110VFR DCT")
  })
})

function planInput() {
  return {
    tailNumber: "N738ZU",
    departure: "KSTP",
    destination: "KRST",
    route: ["FGT", "KOWA"],
    departureTimeUtc: "2026-10-05T14:00:00Z",
    cruiseTasKt: 110,
    altitudeFt: 4500,
    eteMin: 48,
    enduranceMin: 400,
    personsOnBoard: 2,
  }
}
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/navlog.test.ts test/fpl.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/lib/fpl.ts`**

```ts
export interface FlightPlanInput {
  readonly tailNumber: string
  readonly departure: string
  readonly destination: string
  /** Intermediate fixes, in order, without departure and destination. */
  readonly route: readonly string[]
  readonly departureTimeUtc: string
  readonly cruiseTasKt: number
  readonly altitudeFt: number
  readonly eteMin: number
  readonly enduranceMin: number
  readonly personsOnBoard: number
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

const hhmm = (minutes: number): string => {
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return `${String(h).padStart(2, "0")}${String(m).padStart(2, "0")}`
}

/** ICAO flight plan items for a VFR C172 with a transponder and GPS. */
export function buildFlightPlan(input: FlightPlanInput): FlightPlan {
  const dep = new Date(input.departureTimeUtc)
  if (Number.isNaN(dep.getTime())) throw new Error(`departureTimeUtc is not a date: ${input.departureTimeUtc}`)
  const time = `${String(dep.getUTCHours()).padStart(2, "0")}${String(dep.getUTCMinutes()).padStart(2, "0")}`
  const dof = `${String(dep.getUTCFullYear()).slice(-2)}${String(dep.getUTCMonth() + 1).padStart(2, "0")}${String(dep.getUTCDate()).padStart(2, "0")}`
  const routeText = input.route.length === 0 ? "DCT" : `DCT ${input.route.join(" DCT ")} DCT`
  return {
    item7: input.tailNumber.toUpperCase(),
    item8: "VG",
    item9: "C172/L",
    item10: "SG/C",
    item13: `${input.departure.toUpperCase()}${time}`,
    item15: `N${String(Math.round(input.cruiseTasKt)).padStart(4, "0")}VFR ${routeText}`,
    item16: `${input.destination.toUpperCase()}${hhmm(input.eteMin)}`,
    item18: `DOF/${dof}`,
    item19: `E/${hhmm(input.enduranceMin)} P/${input.personsOnBoard}`,
  }
}

/** The message form a filing service accepts, one item per line. Recorded, not transmitted. */
export function formatFplMessage(plan: FlightPlan): string {
  return [
    `(FPL-${plan.item7}-${plan.item8}`,
    `-${plan.item9}-${plan.item10}`,
    `-${plan.item13}`,
    `-${plan.item15}`,
    `-${plan.item16}`,
    `-${plan.item18}`,
    `-${plan.item19})`,
  ].join("\n")
}
```

- [ ] **Step 4: Implement `src/lib/navlog.ts`**

```ts
import { buildFlightPlan, type FlightPlan } from "./fpl.js"
import { distanceNm, initialTrueCourse, type LatLon, magneticFromTrue } from "./geo.js"
import { climbFromSeaLevel, cruiseAt } from "./poh-tables.js"
import { solveWindTriangle } from "./wind.js"

export interface NavlogWaypoint extends LatLon {
  readonly id: string
  readonly kind: "airport" | "navaid" | "fix"
  readonly elevationFt?: number
  /** Signed: east positive, west negative. */
  readonly magneticVariationDeg: number
}

export interface NavlogWind {
  readonly dirDegTrue: number
  readonly speedKt: number
  readonly tempC?: number
}

export interface NavlogInput {
  readonly aircraft: {
    readonly tailNumber: string
    readonly cruiseRpm: number
    readonly usableFuelGal: number
  }
  readonly altitudeFt: number
  readonly departureTimeUtc: string
  readonly waypoints: readonly NavlogWaypoint[]
  /** One entry per leg (waypoints.length - 1). */
  readonly winds: readonly NavlogWind[]
  readonly personsOnBoard?: number
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

export interface Navlog {
  readonly aircraft: {
    readonly tailNumber: string
    readonly type: "C172"
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

const START_TAXI_TAKEOFF_GAL = 1.1
const RESERVE_MIN = 45
/** Figure 5-6 climb speed, used as climb-segment TAS. */
const CLIMB_TAS_KT = 72

const round1 = (n: number): number => Math.round(n * 10) / 10

/** Pure navlog arithmetic. No model, no network. */
export function computeNavlog(input: NavlogInput): Navlog {
  if (input.waypoints.length < 2) throw new Error("computeNavlog needs at least two waypoints")
  const legCount = input.waypoints.length - 1
  if (input.winds.length !== legCount) throw new Error(`computeNavlog needs one wind entry per leg (${legCount})`)
  const departure = new Date(input.departureTimeUtc)
  if (Number.isNaN(departure.getTime())) throw new Error(`departureTimeUtc is not a date: ${input.departureTimeUtc}`)

  const cruise = cruiseAt({ pressureAltitudeFt: input.altitudeFt, rpm: input.aircraft.cruiseRpm })
  const climb = climbFromSeaLevel(input.altitudeFt)

  const legs: NavlogLeg[] = []
  let clock = departure.getTime()
  let fuelRemaining = input.aircraft.usableFuelGal
  const totalDistance = input.waypoints.slice(1).reduce(
    (sum, wp, i) => sum + distanceNm(input.waypoints[i] as LatLon, wp),
    0,
  )
  let flown = 0

  const push = (partial: Omit<NavlogLeg, "etaUtc" | "fuelRemainingGal" | "remainingNm">): void => {
    clock += partial.eteMin * 60_000
    fuelRemaining = round1(fuelRemaining - partial.fuelGal)
    flown += partial.distanceNm
    legs.push({
      ...partial,
      remainingNm: Math.max(0, Math.round((totalDistance - flown) * 10) / 10),
      etaUtc: new Date(clock).toISOString(),
      fuelRemainingGal: fuelRemaining,
    })
  }

  for (let i = 0; i < legCount; i++) {
    const from = input.waypoints[i] as NavlogWaypoint
    const to = input.waypoints[i + 1] as NavlogWaypoint
    const wind = input.winds[i] as NavlogWind
    const legDistance = distanceNm(from, to)
    const trueCourse = initialTrueCourse(from, to)
    const variation = from.magneticVariationDeg
    const magneticCourse = magneticFromTrue(trueCourse, variation)

    const segments: { segment: "climb" | "cruise"; distanceNm: number; tasKt: number }[] = []
    if (i === 0 && climb.distanceNm > 0) {
      const climbDistance = Math.min(climb.distanceNm, legDistance)
      segments.push({ segment: "climb", distanceNm: climbDistance, tasKt: CLIMB_TAS_KT })
      if (legDistance > climbDistance) segments.push({ segment: "cruise", distanceNm: legDistance - climbDistance, tasKt: cruise.tasKt })
    } else {
      segments.push({ segment: "cruise", distanceNm: legDistance, tasKt: cruise.tasKt })
    }

    for (const seg of segments) {
      const tri = solveWindTriangle({ trueCourse, tasKt: seg.tasKt, windDirTrue: wind.dirDegTrue, windKt: wind.speedKt })
      const isClimb = seg.segment === "climb"
      const eteMin = isClimb ? climb.timeMin : Math.round((seg.distanceNm / tri.groundspeedKt) * 60)
      const fuelGal = isClimb ? round1(climb.fuelGal + START_TAXI_TAKEOFF_GAL) : round1((eteMin / 60) * cruise.gph)
      push({
        from: from.id,
        to: to.id,
        segment: seg.segment,
        trueCourse: Math.round(trueCourse),
        variation,
        magneticCourse: Math.round(magneticCourse),
        wind: { dir: wind.dirDegTrue, kt: wind.speedKt },
        wca: Math.round(tri.windCorrectionAngle),
        trueHeading: Math.round(tri.trueHeading),
        magneticHeading: Math.round(magneticFromTrue(tri.trueHeading, variation)),
        tasKt: seg.tasKt,
        groundspeedKt: Math.round(tri.groundspeedKt),
        distanceNm: Math.round(seg.distanceNm),
        eteMin,
        fuelGal,
      })
    }
  }

  const eteMin = legs.reduce((sum, leg) => sum + leg.eteMin, 0)
  const fuelGal = round1(legs.reduce((sum, leg) => sum + leg.fuelGal, 0))
  const fuelRemainingGal = round1(input.aircraft.usableFuelGal - fuelGal)
  const reserveMin = (fuelRemainingGal / cruise.gph) * 60
  const first = input.waypoints[0] as NavlogWaypoint
  const last = input.waypoints[input.waypoints.length - 1] as NavlogWaypoint

  return {
    aircraft: {
      tailNumber: input.aircraft.tailNumber,
      type: "C172",
      cruiseRpm: input.aircraft.cruiseRpm,
      tasKt: cruise.tasKt,
      gph: cruise.gph,
      usableFuelGal: input.aircraft.usableFuelGal,
    },
    altitudeFt: input.altitudeFt,
    departureTimeUtc: departure.toISOString(),
    waypoints: input.waypoints,
    legs,
    totals: {
      distanceNm: Math.round(totalDistance * 10) / 10,
      eteMin,
      fuelGal,
      fuelRemainingGal,
      reserveMin,
      reserveOk: reserveMin >= RESERVE_MIN,
    },
    flightPlan: buildFlightPlan({
      tailNumber: input.aircraft.tailNumber,
      departure: first.id,
      destination: last.id,
      route: input.waypoints.slice(1, -1).map((wp) => wp.id),
      departureTimeUtc: departure.toISOString(),
      cruiseTasKt: cruise.tasKt,
      altitudeFt: input.altitudeFt,
      eteMin,
      enduranceMin: Math.round((input.aircraft.usableFuelGal / cruise.gph) * 60),
      personsOnBoard: input.personsOnBoard ?? 1,
    }),
    sources: [
      { figure: "Figure 5-6", path: "poh/time-fuel-distance-to-climb.md" },
      { figure: "Figure 5-7", path: "poh/cruise-performance.md" },
    ],
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/navlog.test.ts test/fpl.test.ts
```
Expected: all pass. If the climb fuel test reports 2.5 vs 2.5000001, the `round1` on `fuelGal` makes it exact; if `etaUtc` differs, the climb segment's `eteMin` must be `climb.timeMin` (7 at 4500 ft), not derived from groundspeed.

- [ ] **Step 6: Commit**

```bash
git add examples/navlog/server/src/lib/navlog.ts examples/navlog/server/src/lib/fpl.ts examples/navlog/server/test/navlog.test.ts examples/navlog/server/test/fpl.test.ts
git commit -m "feat(navlog): navlog core and ICAO flight plan, pure and unit-tested

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 5: aviationweather.gov client and the winds-aloft parser

**Files:**
- Create: `src/lib/awc.ts`, `src/lib/winds-aloft.ts`, `src/lib/geo-filter.ts`
- Test: `test/awc.test.ts`, `test/winds-aloft.test.ts`

- [ ] **Step 1: Write the failing tests**

`test/winds-aloft.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { interpolateWind, parseWindsAloft } from "../src/lib/winds-aloft.ts"

// A real FBUS31 KWNO excerpt for region "chi", 06Z forecast.
const SAMPLE = `(Extracted from FBUS31 KWNO 040200)
FD1US1
DATA BASED ON 040000Z    
VALID 040600Z   FOR USE 0200-0900Z. TEMPS NEG ABV 24000

FT  3000    6000    9000   12000   18000   24000  30000  34000  39000
MSP 3332 3229+07 3132+02 3037-03 3145-16 3255-27 337443 326952 305554
SPI 9900 2712+14 2514+09 2616+02 2736-10 2845-23 275839 266847 258854
GCK      3409+14 0411+10 0312+05 0408-08 3609-22 331738 302146 273551
BRL 2610 2918+13 2719+08 2621+01 2841-12 2960-23 276840 277648 269054
`

describe("parseWindsAloft", () => {
  it("reads the header, validity and levels", () => {
    const product = parseWindsAloft(SAMPLE)
    expect(product.basedOn).toBe("040000Z")
    expect(product.validAt).toBe("040600Z")
    expect(product.forUse).toBe("0200-0900Z")
    expect(product.levelsFt).toEqual([3000, 6000, 9000, 12000, 18000, 24000, 30000, 34000, 39000])
  })
  it("decodes direction, speed and temperature per level", () => {
    const msp = parseWindsAloft(SAMPLE).stations.MSP
    expect(msp?.[3000]).toEqual({ dirDegTrue: 330, speedKt: 32, tempC: null })
    expect(msp?.[6000]).toEqual({ dirDegTrue: 320, speedKt: 29, tempC: 7 })
    expect(msp?.[12000]).toEqual({ dirDegTrue: 300, speedKt: 37, tempC: -3 })
  })
  it("decodes light and variable as calm", () => {
    expect(parseWindsAloft(SAMPLE).stations.SPI?.[3000]).toEqual({ dirDegTrue: 0, speedKt: 0, tempC: null })
  })
  it("leaves a missing low level undefined", () => {
    expect(parseWindsAloft(SAMPLE).stations.GCK?.[3000]).toBeUndefined()
    expect(parseWindsAloft(SAMPLE).stations.GCK?.[6000]).toEqual({ dirDegTrue: 340, speedKt: 9, tempC: 14 })
  })
  it("decodes winds over 100 knots and negative temps above 24000", () => {
    expect(parseWindsAloft(SAMPLE).stations.BRL?.[30000]).toEqual({ dirDegTrue: 270, speedKt: 68, tempC: -40 })
    expect(parseWindsAloft("FT  3000\nXYZ 7599\n").stations.XYZ?.[3000]).toEqual({ dirDegTrue: 250, speedKt: 199, tempC: null })
  })
})

describe("interpolateWind", () => {
  it("interpolates direction and speed between bracketing levels", () => {
    const msp = parseWindsAloft(SAMPLE).stations.MSP!
    const w = interpolateWind(msp, 4500)
    expect(w.dirDegTrue).toBe(325)
    expect(w.speedKt).toBeCloseTo(30.5, 5)
    expect(w.tempC).toBeNull()
  })
  it("returns the level itself at a listed altitude", () => {
    const msp = parseWindsAloft(SAMPLE).stations.MSP!
    expect(interpolateWind(msp, 6000)).toEqual({ dirDegTrue: 320, speedKt: 29, tempC: 7 })
  })
  it("interpolates direction across north", () => {
    const station = { 3000: { dirDegTrue: 350, speedKt: 10, tempC: null }, 6000: { dirDegTrue: 10, speedKt: 10, tempC: null } }
    expect(interpolateWind(station, 4500).dirDegTrue).toBe(0)
  })
  it("rejects an altitude below the lowest or above the highest level", () => {
    const msp = parseWindsAloft(SAMPLE).stations.MSP!
    expect(() => interpolateWind(msp, 1500)).toThrow(/outside/)
  })
})
```

`test/awc.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest"
import { AwcClient } from "../src/lib/awc.ts"

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("AwcClient", () => {
  it("builds the airport URL and parses JSON", async () => {
    const fetchMock = vi.fn(async () => jsonResponse([{ icaoId: "KSTP", lat: 44.9, lon: -93.1 }]))
    vi.stubGlobal("fetch", fetchMock)
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => 0 })
    const data = await client.getJson<{ icaoId: string }[]>("airport", { ids: "KSTP" })
    expect(data[0]?.icaoId).toBe("KSTP")
    expect(fetchMock).toHaveBeenCalledWith("https://awc.test/api/data/airport?ids=KSTP&format=json", expect.anything())
  })
  it("serves a repeat request from the cache inside the TTL and refetches after it", async () => {
    let now = 0
    const fetchMock = vi.fn(async () => jsonResponse({ n: 1 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => now })
    await client.getJson("metar", { ids: "KSTP" })
    await client.getJson("metar", { ids: "KSTP" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now = 5 * 60_000 + 1
    await client.getJson("metar", { ids: "KSTP" })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it("throws a readable error on a non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })))
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => 0 })
    await expect(client.getText("windtemp", { region: "chi" })).rejects.toThrow(/aviationweather.gov windtemp returned 503/)
  })
  it("passes the abort signal through", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return jsonResponse([])
    })
    vi.stubGlobal("fetch", fetchMock)
    const client = new AwcClient({ baseUrl: "https://awc.test/api/data", now: () => 0 })
    await client.getJson("taf", { ids: "KRST" }, new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/awc.test.ts test/winds-aloft.test.ts
```
Expected: module not found.

- [ ] **Step 3: Implement `src/lib/awc.ts`**

```ts
/**
 * Minimal aviationweather.gov Data API client. No key. The public limit is
 * 100 requests a minute across every caller, so every response is cached
 * in-process for five minutes keyed by the full URL. `B4_AWC_BASE_URL`
 * overrides the base for tests and stubs.
 */
export type AwcProduct = "airport" | "metar" | "taf" | "windtemp" | "gairmet" | "sigmet" | "stationinfo" | "navaid"

export const AWC_DEFAULT_BASE_URL = "https://aviationweather.gov/api/data"
const TTL_MS = 5 * 60_000

interface CacheEntry {
  readonly at: number
  readonly body: string
}

export class AwcClient {
  readonly #baseUrl: string
  readonly #now: () => number
  readonly #cache = new Map<string, CacheEntry>()

  constructor(options: { readonly baseUrl?: string; readonly now?: () => number } = {}) {
    this.#baseUrl = (options.baseUrl ?? process.env.B4_AWC_BASE_URL ?? AWC_DEFAULT_BASE_URL).replace(/\/$/, "")
    this.#now = options.now ?? Date.now
  }

  url(product: AwcProduct, params: Readonly<Record<string, string>>): string {
    const query = new URLSearchParams(params)
    return `${this.#baseUrl}/${product}?${query.toString()}`
  }

  async getText(product: AwcProduct, params: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    const url = this.url(product, params)
    const cached = this.#cache.get(url)
    const now = this.#now()
    if (cached && now - cached.at <= TTL_MS) return cached.body
    const response = await fetch(url, { headers: { accept: "application/json, text/plain" }, ...(signal ? { signal } : {}) })
    if (!response.ok) throw new Error(`aviationweather.gov ${product} returned ${response.status}`)
    const body = await response.text()
    this.#cache.set(url, { at: now, body })
    return body
  }

  async getJson<T>(product: AwcProduct, params: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<T> {
    const body = await this.getText(product, { ...params, format: "json" }, signal)
    return JSON.parse(body) as T
  }
}

/** One shared client per process, so the cache is shared by every tool call. */
export const awc = new AwcClient()
```

- [ ] **Step 4: Implement `src/lib/winds-aloft.ts`**

```ts
export interface WindAtLevel {
  readonly dirDegTrue: number
  readonly speedKt: number
  readonly tempC: number | null
}

export type StationWinds = Readonly<Record<number, WindAtLevel>>

export interface WindsAloftProduct {
  readonly basedOn: string | null
  readonly validAt: string | null
  readonly forUse: string | null
  readonly levelsFt: readonly number[]
  readonly stations: Readonly<Record<string, StationWinds>>
}

/** Decode one FB group: ddff, ddff+tt, ddff-tt, or ddfftt (temps negative above 24,000 ft). */
function decodeGroup(group: string, levelFt: number): WindAtLevel {
  const wind = group.slice(0, 4)
  const rest = group.slice(4)
  let dir = Number.parseInt(wind.slice(0, 2), 10) * 10
  let speed = Number.parseInt(wind.slice(2, 4), 10)
  if (wind === "9900") return { dirDegTrue: 0, speedKt: 0, tempC: null }
  if (dir > 360) {
    dir -= 500
    speed += 100
  }
  if (dir === 360) dir = 0
  let tempC: number | null = null
  if (rest.length > 0) {
    const signed = rest.startsWith("+") || rest.startsWith("-")
    const magnitude = Number.parseInt(signed ? rest.slice(1) : rest, 10)
    if (!Number.isNaN(magnitude)) {
      tempC = rest.startsWith("-") || (!signed && levelFt > 24000) ? -magnitude : magnitude
    }
  }
  return { dirDegTrue: dir, speedKt: speed, tempC }
}

/** Parse the FB (windtemp) text product. Missing groups (blank columns) are left out. */
export function parseWindsAloft(text: string): WindsAloftProduct {
  const lines = text.split(/\r?\n/)
  const basedOn = /DATA BASED ON (\d{6}Z)/.exec(text)?.[1] ?? null
  const validAt = /VALID (\d{6}Z)/.exec(text)?.[1] ?? null
  const forUse = /FOR USE (\d{4}-\d{4}Z)/.exec(text)?.[1] ?? null
  const headerIndex = lines.findIndex((line) => line.startsWith("FT "))
  if (headerIndex < 0) throw new Error("winds aloft product has no FT header line")
  const header = lines[headerIndex] as string
  const columns: { levelFt: number; start: number }[] = []
  for (const match of header.matchAll(/\d+/g)) {
    columns.push({ levelFt: Number(match[0]), start: match.index ?? 0 })
  }
  const stations: Record<string, Record<number, WindAtLevel>> = {}
  for (const line of lines.slice(headerIndex + 1)) {
    if (!/^[A-Z0-9]{3} /.test(line)) continue
    const id = line.slice(0, 3)
    const row: Record<number, WindAtLevel> = {}
    for (const column of columns) {
      // Each group is right-aligned under its header number; take the token that ends at or after the header's end.
      const end = column.start + String(column.levelFt).length
      const slice = line.slice(Math.max(4, end - 7), end + 1)
      const token = slice.trim().split(/\s+/).pop() ?? ""
      if (!/^\d{4}([+-]?\d{2})?$/.test(token)) continue
      row[column.levelFt] = decodeGroup(token, column.levelFt)
    }
    stations[id] = row
  }
  return { basedOn, validAt, forUse, levelsFt: columns.map((column) => column.levelFt), stations }
}

function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((b - a + 540) % 360) - 180
  return (a + delta * t + 360) % 360
}

/** Wind at an altitude between two forecast levels of one station. */
export function interpolateWind(station: StationWinds, altitudeFt: number): WindAtLevel {
  const levels = Object.keys(station).map(Number).sort((a, b) => a - b)
  const lowest = levels[0]
  const highest = levels.at(-1)
  if (lowest === undefined || highest === undefined || altitudeFt < lowest || altitudeFt > highest) {
    throw new Error(`altitude ${altitudeFt} ft is outside this station's forecast levels (${lowest ?? "none"} to ${highest ?? "none"})`)
  }
  const exact = station[altitudeFt]
  if (exact) return exact
  const lower = [...levels].reverse().find((level) => level < altitudeFt) as number
  const upper = levels.find((level) => level > altitudeFt) as number
  const lo = station[lower] as WindAtLevel
  const hi = station[upper] as WindAtLevel
  const t = (altitudeFt - lower) / (upper - lower)
  const tempC = lo.tempC !== null && hi.tempC !== null ? lo.tempC + (hi.tempC - lo.tempC) * t : null
  return {
    dirDegTrue: Math.round(lerpAngle(lo.dirDegTrue, hi.dirDegTrue, t)),
    speedKt: lo.speedKt + (hi.speedKt - lo.speedKt) * t,
    tempC,
  }
}
```

If the column-slicing parse fails the `GCK` blank-column test, replace the per-column slice with a token walk: split the line after the id on whitespace, and when `line.length` is shorter than the header, align tokens by their end position (`line.indexOf(token, cursor) + token.length` compared with each header number's end). The tests define the contract; the slicing is an implementation detail.

- [ ] **Step 5: Implement `src/lib/geo-filter.ts`**

```ts
import type { LatLon } from "./geo.js"

/** True when the point lies inside the bounding box of a polygon's coordinates, padded by `padDeg`. */
export function withinBoundingBox(point: LatLon, coords: readonly { readonly lat: number; readonly lon: number }[], padDeg = 0.5): boolean {
  if (coords.length === 0) return false
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let minLon = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  for (const c of coords) {
    minLat = Math.min(minLat, c.lat)
    maxLat = Math.max(maxLat, c.lat)
    minLon = Math.min(minLon, c.lon)
    maxLon = Math.max(maxLon, c.lon)
  }
  return point.lat >= minLat - padDeg && point.lat <= maxLat + padDeg && point.lon >= minLon - padDeg && point.lon <= maxLon + padDeg
}
```

- [ ] **Step 6: Run the tests, then commit**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/awc.test.ts test/winds-aloft.test.ts
git add examples/navlog/server/src/lib/awc.ts examples/navlog/server/src/lib/winds-aloft.ts examples/navlog/server/src/lib/geo-filter.ts examples/navlog/server/test/awc.test.ts examples/navlog/server/test/winds-aloft.test.ts
git commit -m "feat(navlog): aviationweather.gov client with a cache, FB winds-aloft parser

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 6: the tools

**Files:**
- Delete: `src/tools/searchCorpus.ts`
- Modify: `src/tools/readDoc.ts`
- Create: `src/tools/lookupAirport.ts`, `getMetar.ts`, `getTaf.ts`, `getWindsAloft.ts`, `getAdvisories.ts`, `computeNavlog.ts`, `fileFlightPlan.ts`
- Test: `test/weather-tools.test.ts`, `test/file-flight-plan.test.ts`

Each tool default-exports `async (input, ctx: B4ToolContext)` and exports `display` typed `ToolDisplay`. Tool input types are inline object types (typegen reads them).

- [ ] **Step 1: Write the failing tests**

`test/weather-tools.test.ts`:

```ts
import type { B4ToolContext } from "@b4run/sdk"
import { afterEach, describe, expect, it, vi } from "vitest"
import getMetar from "../src/tools/getMetar.ts"
import getWindsAloft from "../src/tools/getWindsAloft.ts"
import lookupAirport from "../src/tools/lookupAirport.ts"

const ctx = { signal: new AbortController().signal } as unknown as B4ToolContext
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })
const text = (body: string): Response => new Response(body, { status: 200 })

afterEach(() => vi.unstubAllGlobals())

describe("lookupAirport", () => {
  it("returns the fields the planner needs from the FAA record", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([{
      icaoId: "KSTP", name: "ST PAUL/ST PAUL DOWNTOWN HOLMAN FLD ", state: "MN", lat: 44.9346, lon: -93.0603, elev: 215, magdec: "01E",
      freqs: "ATIS,118.35;LCL/P,119.1",
      runways: [{ id: "14/32", dimension: "6491x150", surface: "A", alignment: 146 }],
    }])))
    const airport = await lookupAirport({ id: "kstp" }, ctx)
    expect(airport).toEqual({
      id: "KSTP", name: "St Paul/St Paul Downtown Holman Fld", state: "MN", lat: 44.9346, lon: -93.0603, elevationFt: 215,
      magneticVariationDeg: 1,
      frequencies: [{ name: "ATIS", mhz: "118.35" }, { name: "LCL/P", mhz: "119.1" }],
      runways: [{ id: "14/32", lengthFt: 6491, widthFt: 150, surface: "A", alignmentDeg: 146 }],
    })
  })
  it("reads west variation as negative and rejects an unknown id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([{ icaoId: "KRST", lat: 43.9, lon: -92.5, elev: 1317, magdec: "02W", runways: [] }])))
    expect((await lookupAirport({ id: "KRST" }, ctx)).magneticVariationDeg).toBe(-2)
    vi.stubGlobal("fetch", vi.fn(async () => json([])))
    await expect(lookupAirport({ id: "ZZZZ" }, ctx)).rejects.toThrow(/no airport record for ZZZZ/)
  })
})

describe("getMetar", () => {
  it("returns category, wind, visibility, ceiling and the raw text per station", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([{
      icaoId: "KRST", reportTime: "2026-10-04T03:00:00.000Z", temp: 15.6, dewp: 9.4, wdir: 260, wspd: 11, visib: 9, altim: 1019.4,
      rawOb: "METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010", clouds: [{ cover: "OVC", base: 8500 }], fltCat: "VFR",
    }])))
    const out = await getMetar({ ids: ["KRST"] }, ctx)
    expect(out).toEqual([{
      id: "KRST", observedAt: "2026-10-04T03:00:00.000Z", flightCategory: "VFR", windDirDeg: 260, windKt: 11, visibilityMi: 9,
      ceilingFt: 8500, tempC: 15.6, dewpointC: 9.4, altimeterHpa: 1019.4, raw: "METAR KRST 040254Z 26011KT 9SM OVC085 16/09 A3010",
    }])
  })
})

describe("getWindsAloft", () => {
  const product = `FT  3000    6000    9000\nMSP 3332 3229+07 3132+02\n`
  it("interpolates a station's wind to the requested altitude", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => text(product)))
    const out = await getWindsAloft({ region: "chi", station: "MSP", altitudeFt: 4500 }, ctx)
    expect(out.station).toBe("MSP")
    expect(out.wind).toEqual({ dirDegTrue: 325, speedKt: 30.5, tempC: null })
  })
  it("lists the available stations when the requested one is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => text(product)))
    await expect(getWindsAloft({ region: "chi", station: "XYZ", altitudeFt: 4500 }, ctx)).rejects.toThrow(/available: MSP/)
  })
})
```

`test/file-flight-plan.test.ts`:

```ts
import type { B4ToolContext } from "@b4run/sdk"
import { describe, expect, it, vi } from "vitest"
import fileFlightPlan from "../src/tools/fileFlightPlan.ts"

describe("fileFlightPlan", () => {
  it("writes the FPL message to the workspace and says it was recorded, not transmitted", async () => {
    const writeFile = vi.fn(async () => ({ bytesWritten: 1 }))
    const ctx = { signal: new AbortController().signal, fs: { writeFile } } as unknown as B4ToolContext
    const out = await fileFlightPlan({
      flightPlan: { item7: "N738ZU", item8: "VG", item9: "C172/L", item10: "SG/C", item13: "KSTP1400", item15: "N0110VFR DCT", item16: "KRST0048", item18: "DOF/261005", item19: "E/0640 P/2" },
    }, ctx)
    expect(writeFile).toHaveBeenCalledWith(
      "flight-plans/261005-KSTP-KRST.txt",
      "(FPL-N738ZU-VG\n-C172/L-SG/C\n-KSTP1400\n-N0110VFR DCT\n-KRST0048\n-DOF/261005\n-E/0640 P/2)\n",
    )
    expect(out).toEqual({ status: "recorded", path: "flight-plans/261005-KSTP-KRST.txt", transmitted: false })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/weather-tools.test.ts test/file-flight-plan.test.ts
```
Expected: module not found.

- [ ] **Step 3: Write the tools**

`src/tools/lookupAirport.ts`:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"

interface AwcAirport {
  readonly icaoId?: string
  readonly name?: string
  readonly state?: string
  readonly lat: number
  readonly lon: number
  readonly elev?: number
  readonly magdec?: string
  readonly freqs?: string
  readonly runways?: readonly { readonly id: string; readonly dimension?: string; readonly surface?: string; readonly alignment?: number }[]
}

export interface Airport {
  readonly id: string
  readonly name: string
  readonly state: string
  readonly lat: number
  readonly lon: number
  readonly elevationFt: number
  /** Signed: east positive, west negative. */
  readonly magneticVariationDeg: number
  readonly frequencies: readonly { readonly name: string; readonly mhz: string }[]
  readonly runways: readonly { readonly id: string; readonly lengthFt: number; readonly widthFt: number; readonly surface: string; readonly alignmentDeg: number }[]
}

function titleCase(text: string): string {
  return text.trim().toLowerCase().replace(/\b[a-z]/g, (ch) => ch.toUpperCase())
}

function variationFrom(magdec: string | undefined): number {
  const m = /^(\d+)([EW])$/.exec((magdec ?? "").trim())
  if (!m) return 0
  const value = Number.parseInt(m[1] as string, 10)
  return m[2] === "W" ? -value : value
}

/**
 * Look up an airport by ICAO or FAA identifier: coordinates, field elevation,
 * magnetic variation, frequencies and runways, from the FAA record served by
 * aviationweather.gov.
 */
export default async (input: { readonly id: string }, ctx: B4ToolContext): Promise<Airport> => {
  const id = input.id.trim().toUpperCase()
  const records = await awc.getJson<AwcAirport[]>("airport", { ids: id }, ctx.signal)
  const record = records[0]
  if (!record) throw new Error(`no airport record for ${id}`)
  const frequencies = (record.freqs ?? "")
    .split(";")
    .map((entry) => entry.split(","))
    .filter((parts): parts is [string, string] => parts.length === 2)
    .map(([name, mhz]) => ({ name: name.trim(), mhz: mhz.trim() }))
  const runways = (record.runways ?? []).map((runway) => {
    const [length, width] = (runway.dimension ?? "0x0").split("x").map((n) => Number.parseInt(n, 10))
    return { id: runway.id, lengthFt: length ?? 0, widthFt: width ?? 0, surface: runway.surface ?? "", alignmentDeg: runway.alignment ?? 0 }
  })
  return {
    id: record.icaoId ?? id,
    name: titleCase(record.name ?? id),
    state: record.state ?? "",
    lat: record.lat,
    lon: record.lon,
    elevationFt: record.elev ?? 0,
    magneticVariationDeg: variationFrom(record.magdec),
    frequencies,
    runways,
  }
}

export const display = {
  icon: "web",
  running: ({ id }) => `Looking up ${id.toUpperCase()}`,
  done: ({ id }, airport) => `Looked up ${id.toUpperCase()}, ${airport.name}, field elevation ${airport.elevationFt} ft`,
} satisfies ToolDisplay<{ readonly id: string }, Airport>
```

`src/tools/getMetar.ts`:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"

interface AwcMetar {
  readonly icaoId: string
  readonly reportTime?: string
  readonly temp?: number
  readonly dewp?: number
  readonly wdir?: number | string
  readonly wspd?: number
  readonly visib?: number | string
  readonly altim?: number
  readonly rawOb: string
  readonly clouds?: readonly { readonly cover: string; readonly base?: number }[]
  readonly fltCat?: string
}

export interface Metar {
  readonly id: string
  readonly observedAt: string
  readonly flightCategory: string
  readonly windDirDeg: number | null
  readonly windKt: number | null
  readonly visibilityMi: number | null
  readonly ceilingFt: number | null
  readonly tempC: number | null
  readonly dewpointC: number | null
  readonly altimeterHpa: number | null
  readonly raw: string
}

const CEILING_COVERS = new Set(["BKN", "OVC", "OVX"])

function ceilingOf(clouds: AwcMetar["clouds"]): number | null {
  const layers = (clouds ?? []).filter((layer) => CEILING_COVERS.has(layer.cover) && layer.base !== undefined)
  if (layers.length === 0) return null
  return Math.min(...layers.map((layer) => layer.base as number))
}

const num = (value: number | string | undefined): number | null => {
  if (value === undefined) return null
  if (typeof value === "number") return value
  const parsed = Number.parseFloat(value)
  return Number.isNaN(parsed) ? null : parsed
}

/** Current METAR for one or more stations, parsed, with the raw observation. */
export default async (input: { readonly ids: readonly string[] }, ctx: B4ToolContext): Promise<Metar[]> => {
  const ids = input.ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcMetar[]>("metar", { ids }, ctx.signal)
  return records.map((record) => ({
    id: record.icaoId,
    observedAt: record.reportTime ?? "",
    flightCategory: record.fltCat ?? "UNKNOWN",
    windDirDeg: num(record.wdir),
    windKt: record.wspd ?? null,
    visibilityMi: num(record.visib),
    ceilingFt: ceilingOf(record.clouds),
    tempC: record.temp ?? null,
    dewpointC: record.dewp ?? null,
    altimeterHpa: record.altim ?? null,
    raw: record.rawOb,
  }))
}

export const display = {
  icon: "web",
  running: ({ ids }) => `Fetching METARs for ${ids.join(", ").toUpperCase()}`,
  done: (_input, metars) => `Fetched METARs: ${metars.map((m) => `${m.id} ${m.flightCategory}`).join(", ")}`,
} satisfies ToolDisplay<{ readonly ids: readonly string[] }, Metar[]>
```

`src/tools/getTaf.ts`:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"

interface AwcTaf {
  readonly icaoId: string
  readonly issueTime?: string
  readonly validTimeFrom?: number
  readonly validTimeTo?: number
  readonly rawTAF: string
}

export interface Taf {
  readonly id: string
  readonly issuedAt: string
  readonly validFromUtc: string
  readonly validToUtc: string
  readonly raw: string
}

const iso = (epochSeconds: number | undefined): string => (epochSeconds === undefined ? "" : new Date(epochSeconds * 1000).toISOString())

/** Current TAF for one or more stations, with validity and the raw forecast text. */
export default async (input: { readonly ids: readonly string[] }, ctx: B4ToolContext): Promise<Taf[]> => {
  const ids = input.ids.map((id) => id.trim().toUpperCase()).join(",")
  const records = await awc.getJson<AwcTaf[]>("taf", { ids }, ctx.signal)
  return records.map((record) => ({
    id: record.icaoId,
    issuedAt: record.issueTime ?? "",
    validFromUtc: iso(record.validTimeFrom),
    validToUtc: iso(record.validTimeTo),
    raw: record.rawTAF,
  }))
}

export const display = {
  icon: "web",
  running: ({ ids }) => `Fetching TAFs for ${ids.join(", ").toUpperCase()}`,
  done: (_input, tafs) => `Fetched ${tafs.length} TAF${tafs.length === 1 ? "" : "s"}`,
} satisfies ToolDisplay<{ readonly ids: readonly string[] }, Taf[]>
```

`src/tools/getWindsAloft.ts`:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"
import { interpolateWind, parseWindsAloft, type WindAtLevel } from "../lib/winds-aloft.js"

export const WINDS_ALOFT_REGIONS = ["bos", "mia", "chi", "dfw", "slc", "sfo", "alaska", "hawaii"] as const
export type WindsAloftRegion = (typeof WINDS_ALOFT_REGIONS)[number]

export interface WindsAloft {
  readonly region: string
  readonly station: string
  readonly altitudeFt: number
  readonly forecastHours: number
  readonly basedOn: string | null
  readonly validAt: string | null
  readonly forUse: string | null
  readonly wind: WindAtLevel
}

/**
 * Forecast wind and temperature at an altitude, from the FB winds-aloft
 * product for a region and one of its stations. Pick the station nearest the
 * leg; when the station is not in the product, the error lists the ones that are.
 */
export default async (
  input: { readonly region: WindsAloftRegion; readonly station: string; readonly altitudeFt: number; readonly forecastHours?: 6 | 12 | 24 },
  ctx: B4ToolContext,
): Promise<WindsAloft> => {
  if (!(WINDS_ALOFT_REGIONS as readonly string[]).includes(input.region)) {
    throw new Error(`region must be one of ${WINDS_ALOFT_REGIONS.join(", ")}`)
  }
  const forecastHours = input.forecastHours ?? 6
  const text = await awc.getText("windtemp", { region: input.region, level: "low", fcst: String(forecastHours).padStart(2, "0") }, ctx.signal)
  const product = parseWindsAloft(text)
  const station = input.station.trim().toUpperCase()
  const levels = product.stations[station]
  if (!levels) throw new Error(`station ${station} is not in the ${input.region} product; available: ${Object.keys(product.stations).join(", ")}`)
  return {
    region: input.region,
    station,
    altitudeFt: input.altitudeFt,
    forecastHours,
    basedOn: product.basedOn,
    validAt: product.validAt,
    forUse: product.forUse,
    wind: interpolateWind(levels, input.altitudeFt),
  }
}

export const display = {
  icon: "web",
  running: ({ station, altitudeFt }) => `Fetching winds aloft at ${station.toUpperCase()} for ${altitudeFt} ft`,
  done: (_input, out) => `Winds at ${out.station} ${out.altitudeFt} ft: ${out.wind.dirDegTrue}° at ${Math.round(out.wind.speedKt)} kt`,
} satisfies ToolDisplay<{ readonly region: WindsAloftRegion; readonly station: string; readonly altitudeFt: number; readonly forecastHours?: 6 | 12 | 24 }, WindsAloft>
```

`src/tools/getAdvisories.ts`:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { awc } from "../lib/awc.js"
import { withinBoundingBox } from "../lib/geo-filter.js"

interface AwcAdvisory {
  readonly product?: string
  readonly hazard?: string
  readonly severity?: string
  readonly validTimeFrom?: string | number
  readonly validTimeTo?: string | number
  readonly base?: string | number
  readonly top?: string | number
  readonly coords?: readonly { readonly lat: number; readonly lon: number }[]
  readonly rawAirSigmet?: string
}

export interface Advisory {
  readonly product: string
  readonly hazard: string
  readonly severity: string
  readonly validFrom: string
  readonly validTo: string
  readonly base: string
  readonly top: string
  readonly raw: string
}

const text = (value: string | number | undefined): string => (value === undefined ? "" : String(value))

/** G-AIRMETs and SIGMETs whose area touches a point (padded half a degree), for a route corridor check. */
export default async (input: { readonly lat: number; readonly lon: number }, ctx: B4ToolContext): Promise<Advisory[]> => {
  const [gairmets, sigmets] = await Promise.all([
    awc.getJson<AwcAdvisory[]>("gairmet", {}, ctx.signal),
    awc.getJson<AwcAdvisory[]>("sigmet", {}, ctx.signal),
  ])
  return [...gairmets.map((g) => ({ ...g, product: g.product ?? "G-AIRMET" })), ...sigmets.map((s) => ({ ...s, product: s.product ?? "SIGMET" }))]
    .filter((advisory) => withinBoundingBox(input, advisory.coords ?? []))
    .map((advisory) => ({
      product: advisory.product ?? "",
      hazard: advisory.hazard ?? "",
      severity: advisory.severity ?? "",
      validFrom: text(advisory.validTimeFrom),
      validTo: text(advisory.validTimeTo),
      base: text(advisory.base),
      top: text(advisory.top),
      raw: advisory.rawAirSigmet ?? "",
    }))
}

export const display = {
  icon: "web",
  running: ({ lat, lon }) => `Checking advisories near ${lat.toFixed(2)}, ${lon.toFixed(2)}`,
  done: (_input, advisories) => (advisories.length === 0 ? "No advisories touch the route" : `${advisories.length} advisor${advisories.length === 1 ? "y" : "ies"} touch the route`),
} satisfies ToolDisplay<{ readonly lat: number; readonly lon: number }, Advisory[]>
```

`src/tools/computeNavlog.ts`:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { computeNavlog, type Navlog, type NavlogInput } from "../lib/navlog.js"

/**
 * Compute the navlog in code: great-circle legs, magnetic courses, the wind
 * triangle, POH climb and cruise figures, time, fuel, reserve and the ICAO
 * flight plan. Pass the waypoints from lookupAirport and the winds from
 * getWindsAloft; never estimate these numbers yourself.
 */
export default async (input: NavlogInput, _ctx: B4ToolContext): Promise<Navlog> => computeNavlog(input)

export const display = {
  icon: "tool",
  running: ({ waypoints }) => `Computing the navlog for ${waypoints.length - 1} leg${waypoints.length === 2 ? "" : "s"}`,
  done: (_input, log) => `Computed the navlog: ${log.totals.distanceNm} nm, ${log.totals.eteMin} min, ${log.totals.fuelGal} gal, reserve ${Math.round(log.totals.reserveMin)} min`,
  sources: (log) => log.sources.map((source) => ({ title: `${source.figure} (${source.path})` })),
} satisfies ToolDisplay<NavlogInput, Navlog>
```

`src/tools/fileFlightPlan.ts`:

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"
import { type FlightPlan, formatFplMessage } from "../lib/fpl.js"

export interface FiledFlightPlan {
  readonly status: "recorded"
  readonly path: string
  readonly transmitted: false
}

/**
 * Record an ICAO flight plan in the workspace. This writes the FPL message to
 * flight-plans/; it does not transmit to a filing service. The route approves
 * each call (tools.approve), so a person confirms before anything is written.
 */
export default async (input: { readonly flightPlan: FlightPlan }, ctx: B4ToolContext): Promise<FiledFlightPlan> => {
  const plan = input.flightPlan
  const dof = plan.item18.replace(/^DOF\//, "")
  const departure = plan.item13.slice(0, 4)
  const destination = plan.item16.slice(0, 4)
  const path = `flight-plans/${dof}-${departure}-${destination}.txt`
  await ctx.fs.writeFile(path, `${formatFplMessage(plan)}\n`)
  return { status: "recorded", path, transmitted: false }
}

export const display = {
  icon: "write",
  running: ({ flightPlan }) => `Filing ${flightPlan.item7} ${flightPlan.item13.slice(0, 4)} to ${flightPlan.item16.slice(0, 4)}`,
  done: (_input, out) => `Recorded the flight plan at ${out.path} (not transmitted)`,
} satisfies ToolDisplay<{ readonly flightPlan: FlightPlan }, FiledFlightPlan>
```

`src/tools/readDoc.ts` (replace the path rule and the comment):

```ts
import type { B4ToolContext, ToolDisplay } from "@b4run/sdk"

const ROOTS = ["poh/", "regs/"]

function assertDocPath(path: string): void {
  if (!ROOTS.some((root) => path.startsWith(root)) || path.includes("..") || path.startsWith("/")) {
    throw new Error(`readDoc accepts workspace paths under ${ROOTS.join(" or ")}, got "${path}"`)
  }
}

/**
 * Read a POH table or regulation excerpt by its workspace path, e.g.
 * "poh/cruise-performance.md". Large documents are offloaded by B4.run and
 * retrieved on demand, so reading one does not flood the context.
 */
export default async (input: { readonly path: string }, ctx: B4ToolContext) => {
  assertDocPath(input.path)
  const content = await ctx.fs.readFile(input.path)
  return { content }
}

export const display = {
  icon: "read",
  running: ({ path }) => `Reading ${path}`,
  done: ({ path }) => `Read ${path}`,
  sources: () => [],
} satisfies ToolDisplay<{ readonly path: string }, { readonly content: string }>
```

Remove the old tool:

```bash
git rm -q examples/navlog/server/src/tools/searchCorpus.ts
```

- [ ] **Step 4: Run the tests**

```bash
pnpm --filter @b4-example/navlog-server exec vitest run test/weather-tools.test.ts test/file-flight-plan.test.ts
```
Expected: all pass. If `display` fails typecheck on `satisfies ToolDisplay<...>` because the tool's output type is a Promise, the generic's second parameter is the resolved value (as written above); keep it.

- [ ] **Step 5: Commit**

```bash
git add -A examples/navlog/server/src/tools examples/navlog/server/test/weather-tools.test.ts examples/navlog/server/test/file-flight-plan.test.ts
git commit -m "feat(navlog): live weather tools, computeNavlog and fileFlightPlan

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 7: route, subagents, skills, memory, config, manifest

**Files:**
- Modify: `src/app/navlog/index.ts`, `plan.md`, `memory.md`, `b4.config.ts`, `package.json`, `.env.example`
- Create: `src/app/navlog/subagents/weather/index.ts`, `subagents/performance/index.ts`, `skills/brief-weather/SKILL.md`, `skills/poh-lookup/SKILL.md`
- Delete: `subagents/researcher/`, `skills/cite-sources/`, `skills/synthesize-findings/`, `test/sandbox-docker.test.ts`

- [ ] **Step 1: Remove what goes**

```bash
git rm -r -q examples/navlog/server/src/app/navlog/subagents/researcher examples/navlog/server/src/app/navlog/skills/cite-sources examples/navlog/server/src/app/navlog/skills/synthesize-findings examples/navlog/server/test/sandbox-docker.test.ts
```

- [ ] **Step 2: Write `src/app/navlog/index.ts`**

```ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  // A plan fans out: recall → plan → two subagents → compute → brief. That
  // legitimately exceeds LangGraph's default 25 super-steps.
  recursionLimit: 100,
  description:
    "A VFR flight planner for a Cessna 172N: briefs weather, looks up POH performance, computes the navlog in code, and files a flight plan on request.",
  tools: { deny: ["runBash"], approve: ["fileFlightPlan"] },
  systemPrompt: `You are a VFR flight-planning assistant for a Cessna 172N. Given a request:

1. Start with \`recall({ query: "aircraft profile and pilot preferences" })\`. The profile holds the tail number, cruise RPM and usable fuel. If none is stored, ask once, then \`remember\` what the pilot tells you.
2. Parse the request into departure, destination, optional waypoints, cruise altitude and departure time (UTC). Ask once if altitude or time is missing.
3. Record the legs as todos.
4. Dispatch \`task({ subagent: "weather", input: "<airports, waypoints, altitude, departure time>" })\` and \`task({ subagent: "performance", input: "<airports, altitude, cruise RPM>" })\`.
5. Call \`lookupAirport\` for each airport you have not already looked up, then \`computeNavlog\` with the waypoints, the altitude, the departure time, the aircraft profile and one wind entry per leg from the weather brief. Never do navigation arithmetic yourself.
6. Save the navlog with \`writeFile({ path: "reports/<departure>-<destination>.md", content: "<markdown table of the legs and totals>" })\`.
7. If a chart would help, \`renderChart({ title, series })\` with fuel remaining by checkpoint.
8. Reply with a short plain-language brief: flight category at each airport, winds at altitude, fuel burned and reserve, and anything that should give the pilot pause. Cite POH figures as [poh/<file>.md, Figure N].
9. When the pilot states a durable preference or an aircraft fact, call \`remember({ data, content })\`.
10. File a flight plan with \`fileFlightPlan({ flightPlan })\` only when the pilot asks. A person approves it before it runs.`,
})
```

- [ ] **Step 3: Write `plan.md` and `memory.md`**

`plan.md`:

```md
<!--
The presence of this file opts this route into B4.run's planning capability.
The seeded checklist items below become the thread's initial `todos`.
-->

- [ ] Recall the aircraft profile and parse the route, altitude and departure time
- [ ] Brief the weather and look up POH performance
- [ ] Compute the navlog and save it to the workspace
- [ ] Brief the pilot and file only on request
```

`memory.md`:

```md
# Navlog Route Memory

- The aircraft profile lives in long-term memory as subject `aircraft` with
  predicates `tail_number`, `cruise_rpm`, `usable_fuel_gal`, `reserve_minutes`.
  Recall it at the start of every plan; remember new facts the pilot states.
- Performance numbers come from POH tables the performance subagent read; cite
  the figure. Weather comes from the live tools; quote the raw observation.
- `computeNavlog` owns every number on the navlog.
```

- [ ] **Step 4: Write the subagents**

`subagents/weather/index.ts`:

```ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description:
    "Briefs the weather for a VFR route: METARs, TAFs, winds aloft at the planned altitude for each leg, and advisories.",
  tools: { allow: ["getMetar", "getTaf", "getWindsAloft", "getAdvisories"], deny: ["runBash", "writeFile", "editFile"] },
  systemPrompt: `You are a weather briefer for a VFR flight. Given airports, waypoints, a cruise altitude and a departure time:

- \`getMetar\` and \`getTaf\` for every airport. State the flight category (VFR, MVFR, IFR, LIFR) at each, from the METAR now and the TAF at the planned time.
- \`getWindsAloft\` once per leg: choose the FB region for the route (bos, mia, chi, dfw, slc, sfo, alaska, hawaii) and the station nearest the leg's midpoint; if the station is not in the product, use one the error lists. Use the 6 hour forecast unless the departure is more than 6 hours out.
- \`getAdvisories\` at the departure, the destination and each waypoint.
- Return a brief with this shape, and nothing else:
  Airports: one line each, id, category now, category at ETA, ceiling, visibility, wind, then the raw METAR and TAF.
  Winds per leg: one line each, "leg N: dir/kt tempC at altitude, station, valid".
  Advisories: one line each or "none".
  Go/no-go note: one or two sentences.
- Never invent an observation. If a tool fails, say which and continue.`,
})
```

`subagents/performance/index.ts`:

```ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  description:
    "Looks up Cessna 172N POH performance for the actual fields: takeoff and landing distances, the cruise row to use, and climb figures, with figure citations.",
  tools: { allow: ["readDoc", "lookupAirport"], deny: ["runBash", "writeFile", "editFile"] },
  systemPrompt: `You are a performance planner for a Cessna 172N. Given airports, a cruise altitude and a cruise RPM:

- \`lookupAirport\` each airport for field elevation and runways.
- \`readDoc\` the tables you need: poh/takeoff-distance.md, poh/landing-distance.md, poh/cruise-performance.md, poh/time-fuel-distance-to-climb.md, and regs/vfr-cruising-altitudes.md when the altitude looks wrong for the direction of flight.
- Report takeoff distance at the departure field elevation and the current temperature, landing distance at the destination, the cruise row (RPM, %BHP, KTAS, GPH) at the cruise pressure altitude, and the climb time, fuel and distance. Interpolate between rows and say so.
- Cite every number as [poh/<file>.md, Figure N]. Never invent a number the tables do not support.`,
})
```

- [ ] **Step 5: Write the skills**

`skills/brief-weather/SKILL.md`:

```md
---
description: How to turn METAR, TAF, winds aloft and advisories into a VFR go/no-go brief.
---

# Brief weather

- Flight category comes from ceiling and visibility: VFR ceiling above 3000 ft and visibility above 5 mi; MVFR 1000 to 3000 ft or 3 to 5 mi; IFR 500 to below 1000 ft or 1 to below 3 mi; LIFR below 500 ft or below 1 mi.
- Read the TAF at the planned arrival time, not the issue time. Name the TEMPO or FM group you used.
- Winds aloft are forecast in degrees true. Pass them to computeNavlog as given; it handles variation.
- Quote the raw METAR and TAF under each airport so the pilot can check your reading.
- A note that should give the pilot pause is better than a cheerful brief.
```

`skills/poh-lookup/SKILL.md`:

```md
---
description: How to read the transcribed Cessna 172N POH tables and cite them.
---

# POH lookup

- Pressure altitude, not field elevation, enters every table. With a standard altimeter setting the two are equal; otherwise add 1000 ft per inch below 29.92.
- Temperature columns are 0, 10, 20, 30 and 40 °C for takeoff and landing; interpolate and say so.
- The cruise table lists specific RPM settings per altitude. Use the pilot's cruise RPM; if the table lacks it at that altitude, say which nearby settings exist.
- Cite as [poh/<file>.md, Figure N], the figure number is in each file's first lines.
- Climb figures are cumulative from sea level; add 1.1 gal for start, taxi and takeoff.
```

- [ ] **Step 6: Replace `b4.config.ts`**

```ts
import { config } from "@b4run/cli"

export default config({
  appDir: "src/app",

  // Tool scoping lives on the route (src/app/navlog/index.ts): runBash is
  // denied and fileFlightPlan asks a person before each call.

  // Tool-output offloading. Large tool results are spilled to
  // workspace/tool-outputs/ and replaced in-context with a short stub the
  // agent can read back on demand. The threshold is low so a TAF bundle or a
  // full POH table trips it (the default is 40000 chars).
  toolOutput: {
    offloadThresholdChars: 1500,
    previewLines: 10,
  },

  memory: {
    // Keep durable writes reviewable: remember() creates candidates until a
    // developer runs `npm run memory:approve -- <id>`.
    writes: "candidate",
  },

  // Persistence (SQLite checkpointer + Agent Protocol) is on by default.

  // --- Capability seam (documented, inactive): cross-origin access ---
  // B4.run sends no `Access-Control-*` header unless this block exists, and
  // `web/` deliberately does not need it: its browser client reaches B4.run
  // through a same-origin Next proxy (`web/app/api/b4/[...path]/route.ts`).
  //
  // server: {
  //   cors: { origins: ["http://localhost:3010", "http://127.0.0.1:3010"] },
  // },

  // --- Capability seam (documented, inactive): conversation summarization ---
  // summarization: {
  //   enabled: true,
  //   maxTokens: 12000,
  //   keepRecentTurns: 6,
  // },
})
```

- [ ] **Step 7: Trim `package.json`**

Remove the `test:sandbox:docker` script and the `"@b4run/sandbox": "workspace:*"` dependency. Apply the same two removals to `packages/devkit/templates/app-navlog/server/package.json.template` (its dependency value is a version placeholder; remove the whole `@b4run/sandbox` line). In `.env.example` remove any `B4_DEMO_DOCKER_SANDBOX` / `B4_SANDBOX_SCOPE` lines and add:

```
# aviationweather.gov needs no key. Override the base URL only for a local stub.
# B4_AWC_BASE_URL=https://aviationweather.gov/api/data
```

- [ ] **Step 8: Typegen, check, lockfile, mirror**

```bash
pnpm install --lockfile-only
pnpm build
pnpm --filter @b4-example/navlog-server exec b4 typegen
pnpm --filter @b4-example/navlog-server check
pnpm --filter @b4-example/navlog-server lint
pnpm --filter @b4-example/navlog-server typecheck
pnpm --filter @b4-example/navlog-server test
```
Expected: `b4 check` passes (it validates the `tools.allow/deny/approve` names and warns about nothing); lint, typecheck and the unit tests pass. Then run the mirror block from the top of this plan, copy `examples/navlog/server/.b4/b4.generated.d.ts` and `scenarios.generated.d.ts` over the template's committed copies (adjust the `../src` import path if the diff shows only that), and run `pnpm --filter @b4run/devkit test`. The generated-app and parity tests still reference the old scaffold; Task 9 fixes them, so for now only the parity tests must pass.

- [ ] **Step 9: Commit**

```bash
git add -A examples/navlog/server packages/devkit/templates/app-navlog/server pnpm-lock.yaml
git commit -m "feat(navlog): flight-planning route, weather and performance subagents, skills and config

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 8: recorded evals

**Files:**
- Replace: `src/app/navlog/evals/navlog-quality.eval.ts`
- Create (by recording): `src/app/navlog/evals/navlog-quality.<slug>.fixtures.json` per case

- [ ] **Step 1: Write the eval**

```ts
import { custom, defineEval, gate, llmJudge, toolCalled } from "@b4run/evals"
import { z } from "zod"

const JUDGE_CRITERIA =
  "The brief names the flight category at every airport, states fuel burned and the reserve at destination, and cites at least one POH figure."

const legSchema = z.object({
  magneticHeading: z.number(),
  groundspeedKt: z.number().positive(),
  eteMin: z.number().nonnegative(),
  fuelGal: z.number().nonnegative(),
})
const navlogSchema = z.object({
  legs: z.array(legSchema).min(1),
  totals: z.object({ eteMin: z.number(), fuelGal: z.number(), reserveMin: z.number(), reserveOk: z.boolean() }),
  flightPlan: z.object({ item7: z.string(), item13: z.string(), item16: z.string() }),
})

const navlogResult = (run: { toolResults: ReadonlyArray<{ name?: string; result?: unknown }> }): unknown =>
  run.toolResults.find((entry) => entry.name === "computeNavlog")?.result

export default defineEval({
  name: "navlog quality",
  dataset: [
    { name: "stp to rst", input: "Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z tomorrow. My airplane is N738ZU, a 172N, cruise 2400 RPM, 50 gallons usable." },
    { name: "stp to rst via owa", input: "Plan KSTP to KRST via KOWA at 4500, departing 1500Z tomorrow, in N738ZU (172N, 2400 RPM, 50 gal usable)." },
    { name: "file after planning", input: "Plan KSTP to KRST at 4500 departing 1400Z tomorrow in N738ZU (172N, 2400 RPM, 50 gal usable), then file the flight plan." },
  ],
  scorers: [
    toolCalled("computeNavlog", { threshold: 1 }),
    toolCalled("task", { withArgs: { subagent: "weather" }, threshold: 1 }),
    toolCalled("task", { withArgs: { subagent: "performance" }, threshold: 1 }),
    custom((run) => (navlogSchema.safeParse(navlogResult(run)).success ? 1 : 0), { name: "navlog-shape", threshold: 1 }),
    custom((run) => {
      const parsed = navlogSchema.safeParse(navlogResult(run))
      if (!parsed.success) return 0
      const sum = parsed.data.legs.reduce((total, leg) => total + leg.fuelGal, 0)
      return Math.abs(sum - parsed.data.totals.fuelGal) < 0.11 && parsed.data.totals.reserveOk ? 1 : 0
    }, { name: "totals-add-up-and-reserve", threshold: 1 }),
    custom((run) => (/\[poh\/[a-z-]+\.md/.test(run.finalMessage) ? 1 : 0), { name: "cites-poh", threshold: 1 }),
    custom((run, testCase) => {
      const filed = run.toolCalls.some((call) => call.name === "fileFlightPlan")
      const asked = /file the flight plan/i.test(testCase.input)
      if (!asked) return filed ? 0 : 1
      const approved = run.interrupts.some((entry) => entry.kind === "tool")
      return filed && approved ? 1 : 0
    }, { name: "files-only-when-asked-and-approved", threshold: 1 }),
    ...(process.env.OPENAI_API_KEY ? [llmJudge({ criteria: JUDGE_CRITERIA, model: "gpt-5-mini", threshold: 0.7 })] : []),
  ],
  gate: gate.all(gate.passRate(1), gate.perScorer()),
})
```

If `run.toolResults` entries carry the tool name under a different key (check `ObservedToolResult` in `packages/testing/src/run-result.ts`), adjust `navlogResult` to that key; the scorer's intent is "the `computeNavlog` tool's returned value".

- [ ] **Step 2: Record (needs `OPENAI_API_KEY` and network)**

```bash
OPENAI_API_KEY=… pnpm --filter @b4-example/navlog-server exec b4 eval --record src/app/navlog/evals/navlog-quality.eval.ts
```
Expected: three sibling `navlog-quality.<slug>.fixtures.json` files written and the gate passes. The "file after planning" case pauses on the `fileFlightPlan` approval; `b4 eval` resolves tool interrupts in record mode the way the CLI documents (check `packages/cli/src/commands/eval.ts` for the `--approve` or auto-resume behaviour before recording; if it has none, change that case's input to ask for the plan only and drop the approval half of the last scorer, and say so in the PR). If no key is available in the session, STOP and report NEEDS_CONTEXT: the controller records the fixtures.

- [ ] **Step 3: Replay keyless and commit**

```bash
pnpm --filter @b4-example/navlog-server exec b4 eval src/app/navlog/evals/navlog-quality.eval.ts
```
Expected: replay passes without `OPENAI_API_KEY` set (the judge is skipped). Mirror the eval and its fixture files into the template (`.eval.ts.template`; fixture JSON keeps its name) and commit:

```bash
git add examples/navlog/server/src/app/navlog/evals packages/devkit/templates/app-navlog/server/src/app/navlog/evals
git commit -m "feat(navlog): recorded quality evals with shape scorers

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 9: Workbench prompts, scaffold tests, demo scenario

**Files:**
- Modify: `examples/navlog/web/app/components/DemoSuggestions.tsx` and its template twin `packages/devkit/templates/app-navlog/web/app/components/DemoSuggestions.tsx`
- Modify: `packages/create-b4-app/test/create-app.test.ts`, `packages/devkit/test/generated-app.test.ts`, `docs/brand/demo/scenario.mjs`, `docs/brand/demo/demo.test.mjs`
- Modify: READMEs: `examples/navlog/README.md`, `examples/navlog/server/README.md`, `packages/devkit/templates/app-navlog/README.md`, `packages/devkit/templates/app-navlog/server/README.md`

- [ ] **Step 1: The three starter prompts (both copies, identical)**

Replace the `suggestions` array and the explanatory comment in `DemoSuggestions.tsx`:

```ts
// Starter prompts for the empty chat. The planner's most interesting behavior
// is model-driven — it only dispatches subagents, computes a navlog, asks for
// approval, or proposes a memory if the request steers it there — so without a
// nudge a new user is unlikely to discover any of it.
//
// - "Plan a flight" drives recall → plan → the performance subagent → computeNavlog → a saved report
// - "File the plan" drives fileFlightPlan, which the route approves per call, so the approve/deny flow is on screen
// - "Teach it the aircraft" drives remember() → a memory candidate in the rail's memory panel
      suggestions: [
        {
          title: "Plan a flight",
          message: "Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z, and save the navlog.",
        },
        {
          title: "File the plan",
          message: "File the flight plan for KSTP to KRST.",
        },
        {
          title: "Teach it the aircraft",
          message: "My airplane is N738ZU, a Cessna 172N. I cruise at 2400 RPM with 50 gallons usable.",
        },
      ],
```

Run `pnpm --filter @b4-example/navlog-web test` and fix any web test that asserted the old titles or messages (grep `Research a topic`, `Trigger a permission prompt`, `Teach it a preference` under `examples/navlog/web/app` and the template twin; update the strings only).

- [ ] **Step 2: Scaffold assertions**

`packages/create-b4-app/test/create-app.test.ts` (both `assertExists` blocks): replace the research-era list with

```ts
    await assertExists(join(targetDir, "server/src/app/navlog/index.ts"))
    await assertExists(join(targetDir, "server/src/app/navlog/state.ts"))
    await assertExists(join(targetDir, "server/src/app/navlog/plan.md"))
    await assertExists(join(targetDir, "server/src/tools/computeNavlog.ts"))
    await assertExists(join(targetDir, "server/src/tools/readDoc.ts"))
    await assertExists(join(targetDir, "server/src/lib/navlog.ts"))
    await assertExists(join(targetDir, "server/src/app/navlog/subagents/weather/index.ts"))
    await assertExists(join(targetDir, "server/src/app/navlog/subagents/performance/index.ts"))
    await assertExists(join(targetDir, "server/src/app/navlog/skills/poh-lookup/SKILL.md"))
    await assertExists(join(targetDir, "server/src/app/navlog/evals/navlog-quality.eval.ts"))
    await assertExists(join(targetDir, "server/test/navlog.test.ts"))
    await assertExists(join(targetDir, "server/workspace/AGENTS.md"))
    await assertExists(join(targetDir, "server/workspace/poh/cruise-performance.md"))
```

and delete the `@b4run/sandbox` `not.toMatch(/^file:/)` expectation. Update `RESEARCH_SERVER_SCRIPTS` (or whatever the constant is now named) to drop `test:sandbox:docker`.

`packages/devkit/test/generated-app.test.ts`: in the research-template test, read `server/src/tools/computeNavlog.ts` instead of `searchCorpus.ts`, read `server/test/navlog.test.ts` as `navlogTest`, drop the `sandboxTest` read and its two expectations, drop `expect(serverPackageJson).toContain('"@b4run/sandbox": "workspace:*"')`, change `expect(readme).toContain("Docker sandbox")` to `expect(readme).toContain("aviationweather.gov")`, replace the `seedMemory` and `h.resume` expectations with `expect(navlogTest).toContain("computeNavlog")`, and keep the "tools are shared, never route-local" check pointed at `server/src/app/navlog/tools/readDoc.ts`.

`docs/brand/demo/scenario.mjs`:

```js
export const DEMO_PROMPT = "Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z, and save the navlog.";

export const DEMO_FIXTURES = script()
	.user(DEMO_PROMPT)
	.callsTool("computeNavlog", DEMO_NAVLOG_INPUT)
	.replies("KSTP and KRST are VFR. 66 nm, 44 minutes, 7.0 gal burned, reserve 5 hours. [poh/cruise-performance.md, Figure 5-7]")
	.build();
```

with `DEMO_NAVLOG_INPUT` defined above it as the same inline navlog input the harness uses (Task 10, `NAVLOG_INPUT`), copied verbatim. `docs/brand/demo/demo.test.mjs`: `GENERATED_TREE` becomes `server/src/app/navlog/index.ts`, `state.ts`, `plan.md`, `server/src/tools/computeNavlog.ts`, `server/test/navlog.test.ts`; the "scenario exports" test's expected script mirrors the new `DEMO_FIXTURES`; the `normalizeLog` sample path becomes `server/test/navlog.test.ts` and its sample test name `✓ splits the first leg into a climb segment and a cruise segment`.

- [ ] **Step 3: READMEs**

Rewrite the four READMEs' "what this shows" and "tools" sections to describe the flight planner: live aviationweather.gov tools (no key), POH-grounded `computeNavlog`, `weather` and `performance` subagents, `fileFlightPlan` behind approval, `npm test` as keyless unit tests of the math and parsers, `npm run eval` replaying recorded cases. Keep every command and port. Remove the Docker sandbox section and `test:sandbox:docker`. Mention `B4_AWC_BASE_URL`. Do not use any of the banned terms the docs-bundle test lists (`STATE_SNAPSHOT`, `TodosPanel`, `b4.subagent.`, `createAgUiTranslator`, `mapRunInput`, `forwardedProps.command.resume`).

- [ ] **Step 4: Run and commit**

```bash
pnpm --filter create-b4-app test
pnpm --filter @b4run/devkit test
pnpm test:brand-demo
pnpm --filter @b4-example/navlog-web test
git add -A examples/navlog packages/devkit/templates/app-navlog packages/create-b4-app/test packages/devkit/test docs/brand/demo/scenario.mjs docs/brand/demo/demo.test.mjs
git commit -m "feat(navlog): starter prompts, scaffold tests and demo scenario follow the flight planner

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 10: harness journeys (generated activation and Workbench suggestions)

**Files:**
- Modify: `test/generated/run-generated-research-activation.test.ts`
- Modify: `test/harness/workbench-suggestions.ts`, `test/harness/workbench-suggestions.test.ts`

These lanes scaffold the navlog template, boot server and web, drive the Workbench in Chromium, and assert the AG-UI event stream against scripted fixtures. They must stay hermetic (no network). The mapping below is complete; apply it everywhere the old names appear, then run the lane until green.

- [ ] **Step 1: Shared constants**

At the top of `test/generated/run-generated-research-activation.test.ts`, replace the research-era constants with:

```ts
const PLAN_PROMPT = "Plan a VFR flight from KSTP to KRST at 4500 feet, departing 1400Z, and save the navlog."
const FILE_PROMPT = "File the flight plan for KSTP to KRST."
const TEACH_PROMPT = "My airplane is N738ZU, a Cessna 172N. I cruise at 2400 RPM with 50 gallons usable."
const PERF_INPUT = "KSTP and KRST, 4500 ft, 2400 RPM: takeoff, landing, cruise row and climb figures"
const NAVLOG_INPUT = {
  aircraft: { tailNumber: "N738ZU", cruiseRpm: 2400, usableFuelGal: 50 },
  altitudeFt: 4500,
  departureTimeUtc: "2026-10-05T14:00:00Z",
  waypoints: [
    { id: "KSTP", lat: 44.9346, lon: -93.0603, elevationFt: 215, magneticVariationDeg: 0, kind: "airport" },
    { id: "KRST", lat: 43.9083, lon: -92.49, elevationFt: 1317, magneticVariationDeg: 0, kind: "airport" },
  ],
  winds: [{ dirDegTrue: 320, speedKt: 20, tempC: 5 }],
} as const
const FLIGHT_PLAN = {
  item7: "N738ZU", item8: "VG", item9: "C172/L", item10: "SG/C", item13: "KSTP1400",
  item15: "N0110VFR DCT", item16: "KRST0044", item18: "DOF/261005", item19: "E/0640 P/1",
} as const
const PLAN_REPLY = "KSTP and KRST are VFR. 66 nm, 44 minutes, 7.0 gal burned, reserve about 5 hours. [poh/cruise-performance.md, Figure 5-7]"
const PERF_REPLY = "Cruise 2400 RPM at 4500 ft: 64% BHP, 110 KTAS, 7.1 GPH [poh/cruise-performance.md, Figure 5-7]."
const FILE_REPLY = "Recorded the flight plan at flight-plans/261005-KSTP-KRST.txt. It was not transmitted."
const TEACH_REPLY = "Remembered: N738ZU is a 172N, cruise 2400 RPM, 50 gallons usable."
const TEACH_CONTENT = "N738ZU is a Cessna 172N, cruise 2400 RPM, 50 gal usable"
```

- [ ] **Step 2: Fixture builders**

Replace `createSafeResearchFixtures` with:

```ts
function createPlanFixtures() {
  const todos = [
    { content: "Recall the aircraft profile and parse the route, altitude and departure time", status: "completed" },
    { content: "Brief the weather and look up POH performance", status: "in_progress" },
    { content: "Compute the navlog and save it to the workspace", status: "pending" },
    { content: "Brief the pilot and file only on request", status: "pending" },
  ]
  const root = script()
    .user(PLAN_PROMPT)
    .callsTool("recall", { query: "aircraft profile and pilot preferences" })
    .callsTool("writeTodos", { todos })
    .callsTool("task", { subagent: "performance", input: PERF_INPUT })
    .callsTool("computeNavlog", NAVLOG_INPUT)
    .callsTool("writeFile", { path: "reports/KSTP-KRST.md", content: "# KSTP to KRST\n\n| Leg | MH | GS | Dist | ETE | Fuel |\n|---|---|---|---|---|---|\n| KSTP-KRST climb | 165 | 76 | 9 | 7 | 2.5 |\n| KSTP-KRST cruise | 165 | 117 | 57 | 29 | 3.4 |\n" })
    .replies(PLAN_REPLY)
  const child = script()
    .user(PERF_INPUT)
    .callsTool("readDoc", { path: "poh/cruise-performance.md" })
    .replies(PERF_REPLY)
  return [...root.build(), ...child.build()]
}
```

Replace `createGatedAndBuiltFixtures` and `createWebHopFixtures` so every `runBash` gate becomes a `fileFlightPlan` approval:

```ts
function createGatedAndBuiltFixtures() {
  return [
    ...script().user(FILE_PROMPT).callsTool("fileFlightPlan", { flightPlan: FLIGHT_PLAN }).replies(FILE_REPLY).build(),
    ...script().user(BUILT_PROMPT).replies(BUILT_REPLY).build(),
  ]
}
```

(`createWebHopFixtures`: the same substitution for its gated half, with `WEB_GATED_PROMPT` becoming a filing request and the tool `fileFlightPlan` with `FLIGHT_PLAN`.) Replace `createBrowserFixtures` so the W7 journey calls `computeNavlog` with `NAVLOG_INPUT` and replies `PLAN_REPLY`, and the teach fixture calls `remember` with `{ data: { subject: "aircraft", predicate: "profile", value: "N738ZU 172N 2400 RPM 50 gal" }, content: TEACH_CONTENT }` and replies `TEACH_REPLY`.

- [ ] **Step 3: Assertion mapping**

Apply throughout the activation test:

| Old | New |
|---|---|
| `"searchCorpus"`, `"readDoc"` as the child's tool list | `["readDoc"]` (one call) |
| `{ subagent: "researcher", input: SUBQUESTION }` | `{ subagent: "performance", input: PERF_INPUT }` |
| `name: "researcher"` | `name: "performance"` |
| `call_searchCorpus_0_0`, `call_readDoc_0_1` | `call_readDoc_0_0` |
| root call order `recall, writeTodos, task, searchCorpus?, writeFile` | `recall, writeTodos, task, computeNavlog, writeFile` |
| `Asking researcher to ${SUBQUESTION}` / `Heard back from researcher` | `Asking performance to ${PERF_INPUT}` / `Heard back from performance` |
| `runBash` start/args/result expectations (`call_runBash_0_0`, string result) | `fileFlightPlan` (`call_fileFlightPlan_0_0`); its result is the JSON `{ status: "recorded", path, transmitted: false }`, so the "parses straight to a string" assertion becomes a JSON parse of that object |
| interrupt `kind: "command"` with a `command` detail | `kind: "tool"` with detail `{ toolName: "fileFlightPlan" }` |
| `reports/agent-architectures.md` | `reports/KSTP-KRST.md` |
| `"corpus/agent-architectures.md"` anywhere | `"poh/cruise-performance.md"` |
| step labels for `searchCorpus`/`readDoc` (`Searching the corpus…`) | `Reading poh/cruise-performance.md` / `Read poh/cruise-performance.md`; `computeNavlog`'s running label `Computing the navlog for 1 leg` and done label `Computed the navlog: 66.3 nm, 36 min, 5.9 gal, reserve 372 min` (take the exact numbers from a local run: the display function formats `log.totals`) |
| the comment "the template's own tools export no display" | delete; the tools now export `display`, so the step labels above are asserted |

`test/harness/workbench-suggestions.ts`: `researchJourney` becomes `planJourney` started by "Plan a flight"; it waits for `Plan · 1/4 complete`, the subagent card `performance · completed · 1 tool`, the `readDoc` tool inside it, one `computeNavlog` card and one `writeFile` card at the root, and the exact `PLAN_REPLY`. `gateJourney` starts "File the plan", waits for the approval alert that names `fileFlightPlan`, clicks Approve (same control as today), and waits for `FILE_REPLY`; rename the option `fetchCommand` to `approvalToolName` (`"fileFlightPlan"`). `teachJourney` starts "Teach it the aircraft" and uses `TEACH_CONTENT` (it is 55 characters, under the 60 limit). Update `SuggestionJourneyOptions`, the `JOURNEYS` table titles, and `workbench-suggestions.test.ts`'s `baseOptions` and recorded step lists (`click page > button=/^Plan a flight/`, `hasText="performance · completed"`, etc.) to match.

- [ ] **Step 4: Run the lanes**

```bash
pnpm verify:harness:self-test
pnpm verify:harness:framework
```
Expected: both pass. The framework lane takes about five minutes and must run alone. Iterate on the mapping until the transcript in `artifacts/testing/harness-*/framework/` shows no failed assertion; the preserved temporary root named in a failure holds the AG-UI transcript (`transcripts/ag-ui.json`) with the real event sequence to compare against.

- [ ] **Step 5: Commit**

```bash
git add test/generated/run-generated-research-activation.test.ts test/harness/workbench-suggestions.ts test/harness/workbench-suggestions.test.ts
git commit -m "test(harness): journeys drive the flight planner (plan, file with approval, teach)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Task 11: docs touch-ups that would otherwise be false, changeset, gate, PR

**Files:**
- Modify: `apps/web/content/docs/recipes/research-assistant.mdx` and `research-web-ui.mdx` (minimal: the prompt excerpt and tool names they quote; PR 6 rewrites them), `apps/web/content/docs/testing-agents.mdx` and `evals.mdx` where they quote `searchCorpus`, `apps/web/app/llms.txt/route.ts`, `apps/web/content/prompts/index.ts`, `apps/web/content/templates/AGENTS.md` (the lines naming `searchCorpus`/`readDoc` as the scaffold's shared tools, and the `/navlog` run body example's content string)
- Modify: `docs/superpowers/specs/2026-10-04-navlog-example-design.md` (fold in the three plan-level refinements from the header)
- Create: `.changeset/navlog-server-retheme.md`
- Regenerate: `apps/web/app/seo/lastmod.generated.json`

- [ ] **Step 1: Docs that name the scaffold's tools**

```bash
grep -rn "searchCorpus\|fetch-source\|researcher" apps/web/content apps/web/app/llms.txt --include=*.mdx --include=*.ts --include=*.md | grep -v node_modules
```
For each hit that describes what the scaffold ships (not a generic example): `searchCorpus`/`readDoc` → `computeNavlog`/`readDoc`; "What are common agent architectures?" run bodies → the `PLAN_PROMPT` text; `researcher` → `performance`. Leave generic prose for PR 6. Run `node scripts/check-docs.mjs`; if a pinned phrase on the recipe pages breaks, restore that exact phrase (the recipe pages' pins are listed in `scripts/check-docs.mjs` near `recipes/research-assistant.mdx`).

- [ ] **Step 2: Spec**

In section 9 PR 3 bullet add: "Also the Workbench starter prompts, the harness journeys and the brand demo scenario, which script the server's tools by name." In section 7 add after the recorded-evals bullet: "The harness journeys stay hermetic: `computeNavlog` with inline waypoints and winds, and the `performance` subagent reading the POH; the network tools are covered by unit tests with a stubbed `fetch` and by the recorded evals."

- [ ] **Step 3: Changeset**

```md
---
"@b4run/devkit": patch
"create-b4-app": patch
---

The `navlog` scaffold is now a Cessna 172N VFR flight planner: live aviationweather.gov tools (no key), a POH-grounded `computeNavlog` tool, `weather` and `performance` subagents, and `fileFlightPlan` behind per-call approval. The research corpus, `searchCorpus`, the `researcher` subagent, `runBash` and the Docker sandbox seam are gone from the scaffold. `npm test` runs keyless unit tests of the math and parsers; `npm run eval` replays recorded cases.
```

- [ ] **Step 4: Gate**

```bash
pnpm lint && pnpm check:build-cache && pnpm build && pnpm typecheck && pnpm test && pnpm check:release-inventory && node scripts/check-docs.mjs && node scripts/check-changesets.mjs
pnpm test:brand-demo && pnpm verify:harness:self-test && pnpm verify:harness:framework
pnpm exec vitest --run --config test/security-dependencies/vitest.config.ts test/security-dependencies/copilotkit-v2-runtime.test.ts
```
Expected: green, apart from the known load flakes (`packages/sandbox` bounded-filesystem timeouts, `test/k8s-compat` docker smoke under load) which pass when re-run alone. Commit docs content first, then `pnpm --dir apps/web seo:lastmod` and commit the manifest.

- [ ] **Step 5: PR**

```bash
git fetch origin main && git merge --no-edit origin/main
git push -u origin HEAD
gh pr create --title "feat(navlog): the scaffold becomes a C172N VFR flight planner" --body "$(cat <<'EOF'
## Summary
PR 3 of the navlog series (`docs/superpowers/specs/2026-10-04-navlog-example-design.md`, sections 4 and 7). The server and its devkit template become a Cessna 172N VFR flight planner:
- `workspace/poh/*` and `regs/*`: our own transcriptions of the 1978 172N POH figures 2-1, 5-4, 5-5, 5-6, 5-7, 5-10 and the weight/fuel limits; a test keeps them equal to the tables in code.
- `src/lib`: great-circle and wind-triangle math, POH interpolation, the navlog core, the ICAO flight plan, an aviationweather.gov client with a 5-minute cache, the FB winds-aloft parser. All keyless unit tests.
- Tools: `lookupAirport`, `getMetar`, `getTaf`, `getWindsAloft`, `getAdvisories`, `computeNavlog`, `fileFlightPlan` (approved per call), `readDoc` over the POH; `searchCorpus`, `runBash` and the Docker sandbox seam are gone. Every tool exports `display`.
- Subagents `weather` and `performance` with disjoint tool scopes; skills `brief-weather` and `poh-lookup`.
- Recorded evals with shape scorers (no weather-dependent numbers); the judge runs only with a key.
- Workbench starter prompts, scaffold tests, the brand demo scenario and both harness journeys retargeted; the journeys stay hermetic.

Left for PR 4: the map-dominant layout. PR 6: recipe pages and prose.

## Test plan
- [x] `pnpm --filter @b4-example/navlog-server test` (unit), `b4 check`, `b4 eval` replay without a key
- [x] `pnpm --filter @b4run/devkit test` (parity), `pnpm --filter create-b4-app test`, `pnpm test:brand-demo`
- [x] `pnpm verify:harness:framework`
- [x] Local `pnpm ci:validate` sequence

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review against the spec

- Section 4.1 route: Task 7. Section 4.2 tools: Task 6 (`renderRouteMap` was dropped in spec section 5; `renderChart` unchanged). Section 4.3 `computeNavlog`: Task 4, with the climb/cruise split, variation, wind triangle, Figure 5-6 and 5-7 lookups, reserve and FPL fields. Section 4.4 subagents: Task 7. Section 4.5 corpus: Task 1 (Figure 5-8/5-9 range and endurance are charts, not tables; the reserve note from them is in `cruise-performance.md`). Section 4.6 memory and config: Task 7. Section 7 tests: Tasks 2 to 6 (unit), Task 8 (recorded evals), Task 10 (harness). Section 8 scaffold: Task 9 and the changeset in Task 11.
- Placeholders: Task 8 Step 2 names a decision that depends on how `b4 eval --record` handles a tool approval; it says exactly what to do in each case. Task 10 Step 3's `computeNavlog` done-label numbers are taken from a local run by design, since they are the tool's own formatting of `NAVLOG_INPUT`.
- Type consistency: `NavlogInput`/`Navlog` (Task 4) are what `computeNavlog.ts` (Task 6), the eval schema (Task 8) and `NAVLOG_INPUT` (Tasks 9 and 10) use; `FlightPlan` (Task 4) is what `fileFlightPlan` (Task 6) and `FLIGHT_PLAN` (Task 10) use; `WindAtLevel` (Task 5) is what `getWindsAloft` returns.

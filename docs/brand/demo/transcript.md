# B4.run navlog demo transcript

The navlog demo is silent. Its headlines are repeated here, beat by beat, so
the same walkthrough is available without motion. The footage begins inside an
existing generated navlog workspace; it does not show the scaffold command
running. Every file shown is the generated file, unedited, and every Workbench
moment is the real Workbench running against the B4.run server.

Two parts of the run are made deterministic so the video can be rebuilt
offline and without a provider key. aimock scripts every model turn, so the
agent's tool calls and replies are fixed in advance
(`docs/brand/demo/scenario.mjs`). A loopback stub of the aviationweather.gov
API answers the weather tools with fixed data: KSTP and KRST VFR, clear, 10
statute miles, wind 320 at 8, winds aloft 320 at 20, and no AIRMET or SIGMET.
Every tool runs for real against those inputs; the navlog numbers and the
forecast (each leg's winds, each airport's flight category and the verdict
floor) are what the generated `computeNavlog` returns.

## Navlog demo

### 0. navlog

A title card on paper: “navlog” and “A VFR flight planner, built with B4.run”.

### 1. One file is the agent.

The headline docks above a square-cornered code frame showing the route,
`server/src/app/navlog/index.ts`, from `export default agent({`. The camera
eases to the line marked with a Relay bar:
`tools: { deny: ["runBash"], approve: [{ tool: "fileFlightPlan", allowAlways: false }] },`.

### 2. Ask for a flight.

The frame crossfades to the generated Workbench. The prompt is already in the
composer when the beat begins; the capture filled it before recording. The
capture clicks Send, and the Workbench sends “Plan a VFR flight KSTP to KRST at
4500 ft, 1400Z. N738ZU has long-range tanks.” to the navlog agent. The turn
runs and settles: it checks memory, resolves the 1400Z departure, makes a
four-item plan, looks up both airports, hands the performance to the
performance subagent, computes the navlog and its forecast (the step reads
“Computed the navlog and forecast: 66 nm, 33 min, 5.5 gal, reserve 380 min, GO
floor”), suggests a memory, saves the navlog to
`reports/KSTP-KRST.md`, and answers with a structured brief: a GO bottom line,
the route, the key numbers, its assumptions and sources, and an offer to file
the plan. The scripted run finishes in well under a second, and a settled turn
folds its activity, so the capture opens the turn and its plan step and scrolls
the checklist into view; the camera then eases to the plan's to-dos.

### 3. Code computes the weather.

Two code panes side by side. Left, the tool
`server/src/tools/computeNavlog.ts`, marked at
`const choice = chooseProduct(products, midMs, now)`, where each leg takes the
winds-aloft forecast for the time it is flown. Right, the verdict rules,
`server/src/lib/forecast/verdict.ts`, marked at the floor's NO-GO rule for an
airport that is IFR or LIFR when the flight is there.

### 4. Weather, computed and judged.

Back in the Workbench, the camera eases to the top right: the route bar
(KSTP, KRST, 4500 ft, departing 1400Z, 66 nm), the map with a “VFR” chip on
each airport, and below it the navlog sheet, whose verdict summary reads “GO”
and “KSTP and KRST are VFR now and at the 1433Z ETA, with no advisory during
the flight.” Its Legs tab shows the 320/20 forecast wind on each leg.
`computeNavlog` fetched the METARs, TAFs, winds aloft and advisories from the
loopback stub described above, so the weather on screen is the stub's fixed
data, not a live observation.

### 5. Tools do the math.

Two code panes: `server/src/tools/computeNavlog.ts`, marked at
`let navlog = navlogOf({ ...base, winds: first }, clock)`, where the legs are
timed again on the forecast winds, beside `server/src/lib/navlog.ts`, marked at
`const tri = solveWindTriangle({`.

### 6. A real navlog.

The camera eases to the map: the KSTP→KRST route with both airport markers and
the leg's “MH 161°” label. It holds, then moves to the navlog sheet: 66 nm,
an ETE of 0:33 and 5.5 gal burned, with the climb and cruise rows of the one
leg.

### 7. Filing needs a yes.

The route file again, `server/src/app/navlog/index.ts`, now marked at
`approve: [{ tool: "fileFlightPlan", allowAlways: false }]`.

### 8. Approve once.

The camera holds the bottom of the chat dock. The capture fills the composer
with “File the flight plan.” in one step (it is not typed out) and sends it. The agent calls
`fileFlightPlan`, and the runtime parks the call for approval: the card offers
Allow once and Deny, and no Always allow. After a short hold the capture clicks
Allow once; the card closes, the call runs, and the reply reads that the flight
plan for N738ZU KSTP→KRST, departing 1400Z, was recorded in the workspace and
not transmitted to Flight Service.

### 9. It remembers you.

The memory declaration, `server/src/app/navlog/memory.ts`, marked at
`scope: ["workspace", "route"],`.

### 10. Reload. Still there.

The capture opens memory mode from the sidebar's Memory toggle, and the
camera eases to the top of the Workbench, where the memory column
(“Memory · 1”) lists the memory the planner suggested during the first turn,
“N738ZU has long-range tanks: 50 gal usable.”, waiting for the pilot to approve
or delete it; the run does not store it on its own. The camera pulls
back and the browser frame reloads: the capture navigates the Workbench's frame
to its own URL, as a browser reload would. It opens the thread list and selects
the same thread, and both turns come back from the server checkpoint: the two
prompts, each turn's tool steps, the planning answer and the filing reply. The
camera ends on the navlog sheet, which shows 66 nm again. This shows
browser-reload restoration with the B4.run server still running, not
restoration after a server restart.

### 11. Ridiculous speed. Readable code.

A hairline carrying the Relay dot sweeps across to the closing card: the
b4.run wordmark, “Ridiculous speed. Readable code.”, and
`npm create b4-app@latest my-agent`. The command is an activation next step;
scaffolding is not part of the footage.

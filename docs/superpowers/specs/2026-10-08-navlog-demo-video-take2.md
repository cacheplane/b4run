# Navlog demo video, take 2: design and plan

Date: 2026-10-08. Status: approved direction (Brian: "take 2. go."). It builds on
the take-1 pipeline in `docs/brand/demo/`, which has a director page, a
same-origin iframe Workbench, `frameSurface`, and an encoder that only trims.

## 1. Goal

Make a real demo of the navlog application that answers two questions: "what
does this do, and how did they build it?" The video alternates the **code**
behind each feature with the **feature itself** running in the real Workbench,
and the two are stitched together with smooth transitions. It is about 60
seconds long at full 1440×810 resolution and 30 fps. It should be polished,
modern, and snappy.

## 2. Decisions

| Topic | Decision |
|---|---|
| Length | 45 to 75 s, a target of about 60 s. |
| Resolution | 1440×810 at 30 fps for both MP4 (H.264) and WebM (VP9). |
| README | Links the full MP4 on the Vercel Blob media store, through a clickable poster (`apps/web/public/demo/product-loop-poster.webp`, served from the repo's raw URL as the README already does for images). There is no README animation, so the animated WebP and its contract go. |
| Budgets | MP4 at most 12,000,000 bytes and WebM at most 12,000,000 bytes. The blob hosts them, so the 2 MB limit no longer applies. |
| Determinism | Offline and keyless, as before: aimock scripts every model turn, and a loopback AWC stub serves the weather tools. Every tool runs for real. |
| Brand | Paper Relay tokens and the take-1 director look: docked headline, square frame, Relay focal bar, blur crossfades, and the dot sweep into the close. |
| Honesty | Real code files from the scaffold and real product behaviour; nothing is synthesized. Holds are real waits. Pre-filling the composer is disclosed in the transcript. |

## 3. Storyboard

Each **code** beat shows one or two real files from the generated workspace,
with the focal line marked and the camera eased to it. Each **app** beat shows
the real Workbench through the frame, with the camera at rest or on a focal
preset. A headline (two to five words) docks above the frame and rolls on every
beat.

| # | Kind | Headline | What is on screen | About |
|---|---|---|---|---|
| 0 | title | "navlog" with "A VFR flight planner, built with B4.run" | The wordmark-sized title card on paper | 2.5 s |
| 1 | code | "One file is the agent." | `server/src/app/navlog/index.ts`: `agent({` … focus on the `tools:` line (deny and approve) | 4 s |
| 2 | app | "Ask for a flight." | The Workbench sends the prompt; the plan's to-dos appear in the activity | 5 s |
| 3 | code | "Subagents brief the weather." | `server/src/app/navlog/subagents/weather/index.ts` (focus `allow:`) beside `server/src/tools/getMetar.ts` | 4 s |
| 4 | app | "Weather, briefed and judged." | The weather strip and verdict card on the map | 5 s |
| 5 | code | "Tools do the math." | `server/src/tools/computeNavlog.ts` beside `server/src/lib/navlog.ts` (focus on the wind-triangle or cruise-table line) | 4 s |
| 6 | app | "A real navlog." | The route on the map, then the navlog sheet's numbers | 6 s |
| 7 | code | "Filing needs a yes." | Back to the route's `approve: [{ tool: "fileFlightPlan", allowAlways: false }]` line | 3 s |
| 8 | app | "Approve once." | The Workbench sends "File the flight plan."; the approval card shows Allow once / Deny; the capture clicks **Allow once**; the filed confirmation appears | 7 s |
| 9 | code | "It remembers you." | `server/src/app/navlog/memory.ts` (focus on the schema or scope line) | 3 s |
| 10 | app | "Reload. Still there." | The memory panel shows the suggested memory; the frame reloads; the same thread is restored with the navlog | 6 s |
| 11 | close | "Ridiculous speed. Readable code." | The take-1 close: wordmark, tagline and `npm create b4-app@latest my-agent` | 3 s |

The total is about 52 to 60 s. Beat lengths are targets and are tuned in
`DIRECTOR_TIMING` and the storyboard table.

## 4. Scenario (deterministic)

- **Prompts.** `DEMO_PROMPT` stays at 80 characters or fewer (the thread title
  limit). The follow-up is `DEMO_FILE_PROMPT = "File the flight plan."`.
- **`DEMO_FIXTURES`** (`docs/brand/demo/scenario.mjs`) is modelled on the
  scaffold eval's `planFixtures`, updated for the current route. One aimock
  `script()` covers both turns and both subagents:
  - **The parent, turn 1:**
    1. `recall`
    2. `resolveDeparture({ departure: "1400Z" })`
    3. `writeTodos` (the eval's `PLAN_TODOS`)
    4. `lookupAirport` for KSTP and KRST
    5. `task` weather
    6. `task` performance
    7. `computeNavlog` (the eval's input, with `departureTimeUtc` from `resolveDeparture`'s output shape)
    8. `remember({ data, content })` for the aircraft fact, which produces a memory candidate
    9. `writeFile` of `reports/KSTP-KRST.md`
    10. the brief (the eval's five-line brief)
  - **The weather child:** `getMetar` and `getTaf`, then the eval's brief text in the section format the web's weather selectors parse. It must agree with the stub's data: VFR, wind 320 at 8, no advisory during the flight.
  - **The performance child:** `readDoc`, then the eval's cruise line.
  - **The parent, turn 2:** `fileFlightPlan({ flightPlan })` with the flight plan the code produced. The capture reads it from the computeNavlog result. If the fixture needs it up front, it computes the same input deterministically. Then the 2-to-4-line filed reply.
- **The AWC stub** (`docs/brand/demo/awc-stub.mjs`) is a loopback HTTP server
  started by the capture. The capture passes `B4_AWC_BASE_URL` to the B4.run
  server. It serves deterministic JSON or text for `airport`, `metar`, `taf`,
  `windtemp`, `airsigmet` and `gairmet`, in the shapes the tools parse (see
  the navlog server tests for samples). The data is consistent with the
  scripted brief: KSTP and KRST VFR, clear skies, 10 SM, 320 at 8, and FB
  winds 320/20 at 4500 ft (the 3000/6000 levels). Unknown paths return 404.
  The capture asserts that the stub served each endpoint at least once.

## 5. Units and changes

1. **`scenario.mjs`:** the prompts, the full two-turn fixtures, and the stub data, or the stub data in `awc-stub.mjs`.
2. **`awc-stub.mjs` (new):** `startAwcStub({ getPort })` returns `{ baseUrl, close(), hits }`. It is unit-tested with real HTTP on loopback.
3. **`director.mjs`:** it renders from a **storyboard** (exported `STORYBOARD`, the table above as data):
   - title, code, app and close layers;
   - code layers are built from `{ path, source, focal: RegExp }` panes (one or two per beat, side by side when two);
   - app beats reuse the iframe layer with `RUN_FOCUS`-style presets (`rest`, `todos`, `weather`, `map`, `sheet`, `approval`, `memory`);
   - `play(beatIndex)` advances: roll the headline, crossfade the layer, and ease the camera to the beat's focal point or preset;
   - the first code beat docks the headline exactly as take 1 does;
   - the take-1 runtime fixes (sweep visibility, zoom-out origin, focal bar z-index, roll height, `overflow: clip`) carry over.
4. **`capture.mjs`:**
   - It starts the AWC stub before the server.
   - It reads every file the storyboard needs from the generated app and passes them to `renderDirector`.
   - It drives the beats in order. App beats perform the real interactions through `frameSurface`, each with evidence assertions:
     - **Ask for a flight:** send; the plan's to-dos are visible.
     - **Weather:** the weather strip region and the verdict card are visible.
     - **Navlog:** the sheet shows "66 nm"; this is the computeNavlog number, so read it rather than hard-coding it if it differs.
     - **Filing:** send `DEMO_FILE_PROMPT`; the approval card shows "Allow once" and "Deny", and no "Always allow"; click Allow once; the filed reply is visible.
     - **Memory:** the memory panel lists the suggested candidate.
     - **Reload:** the restored thread shows both turns and the navlog.
   - Scenes are recorded per beat (`beat-00` … `beat-11`). The encoder trims from the first beat's start to the last beat's end.
5. **`encode.mjs`:** the README animation path is removed. It encodes the MP4, WebM and poster (the poster at the end of beat 6, the navlog sheet) and keeps constrained-quality VP9 with a ceiling suited to the 12 MB budget.
6. **`check-media.mjs` and `upload.mjs`:**
   - the contract becomes 45 to 75 s, with MP4 and WebM each at most 12 MB;
   - the animation validation and `docs/brand/product-loop.webp` are removed;
   - the catalog stays at one entry;
   - the caption is updated to the navlog demo story.
7. **README and contracts:**
   - The README's media block becomes `<a href="<blob mp4 url>"><img src="apps/web/public/demo/product-loop-poster.webp" alt="…" width="900"></a>`, with a one-line "Watch the 60-second demo" link.
   - The three package READMEs use the raw-URL poster and the same link.
   - The readme-contracts pins are updated.
   - `docs/brand/product-loop.gif` stays until the next release, as recorded earlier.
8. **Copy:** the transcript (one section per beat, literal), the recording guide, `docs/brand/README.md`, and this spec's section 7 deviations.

## 6. Testing

- Unit tests in `demo.test.mjs`:
  - the storyboard data (beats, kinds, focal patterns that match the real scaffold files; the test reads the template files from `packages/devkit/templates/app-navlog`);
  - the director HTML for a storyboard;
  - the AWC stub over real loopback HTTP;
  - the fixtures (both turns, both children, and the `fileFlightPlan` call);
  - the capture orchestration order with fakes, including the approval click and the evidence assertions;
  - the encoder trim over beat scenes;
  - the checker's new budgets.
- A headless Chromium smoke test of the director runtime, the way the take-1 review did it, run by the implementer and the reviewer; it is not committed.
- The real capture plus `pnpm media:readme:check -- --local`, reviewed by Brian before the media is committed or uploaded.

## 7. Deviations recorded during the build

Unit 4 (`capture.mjs`), checked against a real Workbench run:

- **"Ask for a flight" starts at rest.** At the `todos` framing the composer's
  Send button is outside the viewport and Playwright refuses the click, so the
  beat's preset is `rest`; the capture moves to `todos` once the plan is up.
- **The plan is reopened.** The scripted run settles in well under a second,
  and a settled turn folds its activity, so the ask beat waits for turn 1 to
  settle, opens the turn and the plan step (real clicks), and scrolls the
  checklist to the middle of the transcript before it holds. The thread id is
  read there, after turn 1.
- **Filing does not move the camera to click.** The `approval` framing holds
  the composer, its Send button and the approval card, so the beat sends,
  holds on the card and clicks Allow once without the `rest` round trips.
- **Restored tool steps are the activity kit's root tool steps.** `writeTodos`
  is the plan step, `task` a subagent step, and the two back-to-back
  `lookupAirport` calls fold into one group step, so turn 1 restores with five
  root tool steps and turn 2 with one (`expectedRootToolSteps`).
- **Beat scenes are `beat-NN-id`** (`beat-06-navlog`); a failure names its beat
  (`Beat 8 (file): …`) with the original error as its cause.

Units 5–8 (media contract, README and copy):

- **The watch link sits inside the poster's paragraph.** It is a
  `<br><a href="…mp4">▶ Watch the 50-second navlog demo</a>` line under the
  linked poster rather than a paragraph of its own, because
  `scripts/check-docs.mjs` keeps `packages/create-b4-app/README.md` at 50 lines
  or fewer. The root README contract pins that line (with the rounded duration)
  and leaves both video links out of the hero's four-text-link count.
- **The transcript heading is "Navlog demo"** (`#navlog-demo`). `upload.mjs`'s
  transcript anchor and aria label and the checked-in `demo-media.json` follow
  it, and a test holds the checked-in catalog equal to what the uploader would
  write. The README's transcript link reads "Read the navlog demo transcript".
- **The weather is the stub's, and the copy says so.** The beat 4 headline
  became "Weather, briefed and judged." (it was "Live weather, judged."), and
  the transcript states that the footage's weather comes from the loopback AWC
  stub.
- **The evidence matrix is unchanged.** No root README claim changed: the
  README only swaps its animation for the linked poster.
- **Codecs:** H.264 `-preset slow -crf 23 -maxrate 2500k -bufsize 5000k`; VP9
  `-b:v 1800k -crf 32 -maxrate 2200k -bufsize 4400k`. The quality ceiling is the
  Playwright recording itself (VP8 at 25 fps, about 0.9 Mbit/s), so a lower CRF
  adds bytes without sharper text.

Take-2 polish round:

- **The Workbench root never scrolls.** `scrollIntoView` (centring the plan)
  and Playwright's actionability scrolling also scrolled the Workbench's
  `overflow: hidden` root, which pushed the weather strip and the dock header
  out of the top of the page and cut the memory candidate. The capture now
  centres an element only within its nearest scrolling ancestor
  (`centerInScroller`) and resets the document and `.wb-root` scroll
  (`settleWorkbenchViewport`) after each interaction that can scroll them.
- **Framings.** `weather` holds the top-right corner (scale 1.4) so the strip
  and the sheet's GO card are in one frame; `memory` holds the dock's middle,
  where the capture centres the candidate.
- **Two-pane code.** The panes use 14px JetBrains Mono; each column is
  `minmax(<focal line>ch + 40px, <longest visible line, at most 100>fr)`, so a
  focal line is always whole, and a line longer than its column fades out over
  the pane's last 24px (a CSS mask) rather than being cut hard.
- **Headline roll.** Each headline line is exactly the 1.12em window tall and
  the outgoing line fades as it rolls, so nothing of it lingers above the new
  one.

# B4.run compliance demo transcript

The compliance demo (the RAG take) is silent. Its headlines are repeated here,
beat by beat, so the same walkthrough is available without motion.

The app is an emergency-plan compliance assistant. It is not a
`create-b4-app` template: the capture scaffolds the navlog template, whose web
client is the Workbench, and overlays `docs/brand/demo-rag/app/` on it
(`overlay.mjs` lists every file it removes, adds or edits). Every file shown is
the overlaid file, unedited, and every Workbench moment is the real Workbench
running against the B4.run server.

Only the model is scripted. aimock answers every model call with the tool
calls and replies in `docs/brand/demo-rag/scenario.mjs`, so the run is
offline and keyless. Every tool call runs for real: `searchPlans` and
`readSection` read the workspace's files, and the citation chips are what
they return.

The workspace holds short excerpts adapted from FEMA's Comprehensive
Preparedness Guide (CPG) 101, version 3.1, a US government work, each labelled
"Excerpt adapted from FEMA CPG 101 v3.1", and two short sample county plans
written for the demo, each titled "Sample". No real county's plan is used.

## Compliance demo

### 0. compliance

A title card on paper: “compliance” and “Grounded answers, built with B4.run”.

### 1. One file is the agent.

The headline docks above a code frame showing the route,
`server/src/app/compliance/index.ts`, marked at
`tools: { deny: ["runBash", "writeFile", "editFile"] },`.

### 2. Ask the question.

The frame crossfades to the Workbench: the sidebar, the chat and the source
reader, which lists the four sources. The prompt is already in the composer;
the capture clicks Send, and the Workbench sends “Are we in compliance with
FEMA CPG 101?”. The turn runs and settles in well under a second. The capture
opens the turn and its plan, and the camera eases to the four to-dos, all
done, with the first steps and their chips below.

### 3. Search is a plain function.

The tool `server/src/tools/searchPlans.ts`, marked at
`sources: (hits) => hits.map(citation),`, under the `citation` helper that
gives each chip its title and its link.

### 4. Every claim has a source.

Back in the Workbench, on the turn's steps: “Found 5 sections for “CPG 101
basic plan elements””, a read of the guide's basic plan elements, and “Found 5
sections for “Lakeview communications warning backup””, each with its source
chips (three shown, the rest as “+2”). The transcript scrolls down past the
checker's step to the answer's verdict: Sample Lakeview County's plan meets
four of the seven CPG 101 basic plan elements.

### 5. A checker does the review.

The checker subagent, `server/src/app/compliance/subagents/checker/index.ts`,
marked at `allow: ["searchPlans", "readSection"],`.

### 6. Met, partial, missing.

The camera holds the answer's checklist: one row per element, four Met,
communications and plan maintenance Partial, and administration, finance and
logistics Missing, each with the plan's section and a one-line reason. The
capture then opens the checker's step: its five steps, each with the sections
it read as chips. It clicks the chip “Sample Lakeview County EOP · 5.
Communications”, and the source reader opens the sample plan at that section,
highlighted: the plan does not say how warnings reach residents who are deaf
or hard of hearing or who read other languages, and it names no backup if the
radio system fails.

### 7. Answers you can check.

A hairline carrying the Relay dot sweeps across to the closing card: the
b4.run wordmark, “Answers you can check.”, and
`npm create b4-app@latest my-agent`.

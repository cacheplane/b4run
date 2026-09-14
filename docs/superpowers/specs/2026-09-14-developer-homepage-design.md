# Developer homepage — code, proof, control

Date: 2026-09-14
Status: visual direction approved; independent specification review passed

## Decision

Replace the current homepage composition with the approved code-led Paper Relay
study. The primary takeaway is **this clean, organized, readable code runs this
agent**. The user approved showing the result immediately, keeping source beside
the recorded steps, and leading capability explanations with real TypeScript.
Voice: developer-forward, confident, concise. Technical detail earns its place
by helping the visitor inspect or run the example.

The reviewed study is `artifacts/visuals/developer-code-study.html`. It is local
review material, not a production dependency. This specification is the durable
contract. The [brand guidelines](../../brand/guidelines.md) govern identity and
tokens; the [blueprint design](2026-09-13-code-fixer-blueprint-design.md) and
[live report](../runbooks/2026-09-13-code-fixer-live-evaluations.md) govern claims.

## Scope and existing application

Implement one homepage in the existing Next.js application, `apps/web`. Retain
the SEO registration and structured-data path in `app/page.tsx`. Replace its old
landing-section composition; do not append a second homepage below it. Keep
existing unreferenced landing components unless removing one is necessary for
this change. No framework, release, or example behavior changes.

Keep documentation layout, navigation, content, and routing intact. Reuse the
existing header and footer instead of duplicating the mockup masthead inside
`main`. A pathname-scoped homepage header treatment may use Paper Relay and
replace its scaffold command with the blueprint link. Preserve Docs, Blog,
GitHub, mobile navigation, and the existing header height contract. Other routes
retain their current header behavior. The existing shared footer remains.

Homepage metadata and the root social card should reflect the new identity and
headline. Preserve canonical URLs, robots, sitemap, structured-data types, and
article-specific metadata. Do not carry the prototype's host controls into the
product. This phase introduces no hosted agent execution, video service,
analytics system, accounts, or new marketing surfaces.

## Page sequence and copy

1. **Hero.** Eyebrow: “The TypeScript framework for agents.” Headline:
   “Ridiculous speed. Readable code.” Supporting copy: “Write the agent. Give it
   tools. Set the limits. Ship code you can actually read.” Speed is development
   positioning, not a measured productivity or inference-speed claim.
2. **Recorded walkthrough.** “This code runs this agent.” Start on the verified
   result with the agent source visible. Steps: Reproduce, Repair, Verify + review.
   Provide “Get the code” linking to the example README.
3. **Capabilities.** “Give it tools. Keep the controls.” One short sentence per
   selection and a substantial source excerpt. Workspaces, Sandboxes, Evals,
   Approval; default Sandboxes. No decorative architecture diagram replaces code.
4. **Project structure.** “Small files. Clear responsibilities.” A compact mapping
   of agent, plan, skill, tool, and config files to their responsibilities.
5. **Run it.** “Read it. Run it. Make it yours.” Show the exact monorepo invocation,
   setup prerequisites, README link, and a link to the complete evaluation report.

Use Inter for reading and display, JetBrains Mono for code. Paper `#F5F4F0`, ink
`#111111`, dark code `#17181B`, Relay `#B4CE37`. Use the supplied D2.2 logo through
the existing brand component. Square panels, generous alignment, restrained
rules, one optional static editorial dot. Green emphasizes selection and verified
results; labels convey meaning independently of color. No looping animation.

Code is 13–14px desktop and at least 12px on narrow layouts. Body text is 16px
where space permits; short panel explanations may be 13–14px. Preserve useful
reading measure and actual code rather than compressing text to fit the study.

## Evidence contract

Use the final CLI recording `90532f93-a8b9-43ff-9d94-b664a37af813` from batch
`batch-9377dec7-1792-40f7-a721-645d4caa9959`. Its agent commit is
`cbe93c9b53ac6981436b20814b544aa4ce38f4b5`.
The blueprint merged as `91619fa68522079087f09e9ead792b30a09bd6de` in PR #640.
The recording's own provenance stays unchanged after the squash merge.

The selected run took 113,145ms total, including verification and cleanup;
runMs is 109,826 and verificationMs is 2,845. Label “Recorded run · 1m 53s” and
“Edited highlights”. These are selectable recorded states, not a live terminal
or a timeline reconstructed from fabricated event timestamps.

Visible suite: one named check passed. Independent suite: three named checks
passed. Source scope, reproduction, verification, and actual approval gate all
passed. State is **approval pending**. No patch export or human approval is
shown. Preserve the fact that this is a historical defect recreated in a
controlled fixture, not a newly discovered live repository bug.

Commit a bounded, curated public evidence document: run/commit/image/fixture
identities, measured durations, six verdicts, named suite receipts, selected
command/error/result excerpts, original and repaired `src/cli.ts`, agent/config/
plan source snapshots, and the source locations for capability excerpts. Include
the original recording SHA-256 from the report. Do not publish raw conversations,
environment values, host paths, or full harness state. Build and rendering must
work from the committed evidence without ignored local recordings or Docker.

Derive the visual diff from the recorded original and repaired source. Do not
substitute the historical reference patch. The agent-produced repair links to
its curated evidence; it is not presented as a repository file at the merge commit.
The source panel displays actual
recorded code; explicit folding and clearly labeled contiguous excerpts are
allowed. A folded string is an editor presentation, not runnable copied code.
Copy controls copy the complete underlying source or explicitly selected exact
excerpt, never synthesized ellipses. Preserve line numbers when citing snippets.

The main source selector offers `index.ts`, `b4.config.ts`, and `plan.md`.
The default agent view folds only the long instructions and exposes a labeled
expand button. Display the tested model override `gpt-5` near the recording;
preserve `gpt-5-mini` in the actual source fallback. Do not alter code to make
the two appear identical.

Capability code comes from the recorded commit: workspace initialization in
`seeded-provider.ts`, policy in `verifier.ts`, `evaluateRun` in `evaluate.ts`,
and the agent's approval declaration. Match excerpts against pinned source,
retain exact contents, and label blueprint-specific logic as such. Independent
patch verification is owned by this example; do not imply every B4 app receives
this verifier automatically.

## Interaction and rendering

Render the hero, initial source, successful test receipt, and approval-pending
state in server HTML. No model call, request to GitHub, or media download is
required for first paint. Use a small client island for local selections.

Step buttons update the result, actual command/diff/check excerpts, and a
corresponding source highlight. The selected source file stays selected across
step changes. Capability selections update their code and one-sentence
explanation. Neither interaction auto-scrolls, starts playback, invokes a tool,
or resets the other section. Source folding is local to the source panel.

Use native buttons with `aria-pressed`, an accessible group label, and polite
status announcements for selected outcomes. Keep all controls keyboard reachable.
Use ordinary anchors for source, report, and README links; no fake approve button.
Maintain visible focus, reduced-motion support, and touch targets of at least
44px. Missing clipboard permission produces a visible failure and leaves code
selectable.

Desktop pairs code and proof, and pairs capability selection with code. At narrow
widths, show the result before its source and stack the capability code below its
selector. Keep DOM reading order compatible with that order; CSS can place the
source on the left on desktop. No fixed viewport heights or nested vertical
scroll regions. Long code may scroll horizontally inside its own panel, with
all page chrome and prose fitting at 320px and 200% zoom. Do not truncate code
with hidden overflow. Pin panel labels while avoiding layout jumps where useful.

## Implementation boundaries

Separate curated evidence, server-side highlighting, reusable code presentation,
walkthrough state, capability state, and page composition. Use existing Shiki
support at build/server time; do not ship a syntax highlighter to the client.
Escape source and treat recorded text strictly as data. Only trusted highlighter
output may enter an HTML rendering path. Do not interpolate recorded output as
markup. Scope styles to homepage components and the explicit homepage header
variant; leave global semantic tokens and docs styles unchanged.

No new live runs are required to implement this presentation. The final batch
was CLI 3/3, nullable 1/3; retain the report link and avoid a general reliability
claim. Nullable is available through the blueprint and report, not a second
interactive homepage demo in this increment.

## Acceptance and delivery

- Initial HTML contains real source, the 1+3 passed checks, and approval pending.
- All step/file/capability selections and instruction folding work by keyboard.
- Source links resolve to pinned code; setup and report links use existing paths.
- Evidence tests reject mismatched source/diff/provenance and rewritten outcomes.
- No secret, local path, fake streaming, or invented completion is published.
- Verify 320, 390, 768, and 1280px; 200% zoom; reduced motion; and no-JavaScript
  initial content. Compare the docs landing page before/after for regressions.
- Web lint/tests/typecheck/build and built SEO audit pass; required repository
  validation passes before merge. Review the rendered homepage, not just markup.
- Deliver a preview and a PR on `blove/developer-homepage`. Merge only with user
  authorization for that PR. The review-credit waiver for #640 does not claim a
  hosted review occurred for this future change.

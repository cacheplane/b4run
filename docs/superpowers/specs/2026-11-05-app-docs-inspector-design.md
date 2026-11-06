# App documentation and interactive turn inspector

Date: 2026-11-05
Status: Design for owner review. No website or capture implementation yet.

## Purpose and agreed direction

Help people already using Codex or Claude Code get useful work done in the production b4app release, with a clear path for B4 developers. The website provides App and Framework entrances with separate sidebars. Existing framework URLs remain unchanged. App guides live under `/docs/app/`.

Use the maintained Navlog example for a consistent inspectable conversation. The owner selected it after learning that the research example in the older checkout had become Navlog on main. The example supplies the scenario; the inspector is a teaching surface for the actual turns and their observable activity, not a project the reader builds.

Teach through a short video, topic introduction, general explanation, an example demonstration and interactive inspection, then a guided walkthrough of that recording. Preserve independent setup paths for Codex and Claude Code. Viewing a recording requires no account, model key, installed application, or live run.

Implement the inspector inside b4.run, with Replay and optional Source. Use the same component for inline lessons and a full-page view. No separately hosted iframe service, hosted Live mode, arbitrary code execution, shared cross-product package, or SwiftUI clone in the first version.

## Evidence and repository baseline

The initial `/Users/blove/repos/b4run` checkout is on `blove/ag-ui-orchestration-projection` at `f7d89dbc6`, with unrelated local work. It contains obsolete branding and `examples/research`. Earlier recommendations based on that checkout must not become production instructions.

This design is based on locally available `origin/main` at `c1e179655`, checked out separately on `blove/app-docs-design`. No remote freshness claim is made; refresh and reconcile main before implementation. The newer tree has `examples/navlog`, B4 package names, Paper Relay tokens, and `/app` marketing/download pages. `/app` and `/docs/app/` serve different purposes and link to each other.

References consulted:

- LLA: `/Users/blove/repos/liveloveapp/docs/design-rules.md`, `docs/brand/guidelines.md`, and `src/app/globals.css`.
- B4, at the design baseline: `docs/brand/guidelines.md`, `docs/brand/website-design-system.md`, and `apps/web/app/styles/tokens.css`.
- Hashbrown: `docs/superpowers/specs/2026-10-29-concept-first-docs-design.md`, `docs/learning-journeys-audit.md`, `www/examples/quickstart/runtime/workbench-capture.ts`, `workbench-player.ts`, and `www/src/components/workbench/`.
- Voice: `/Users/blove/repos/brianflove/src/content/posts/2024-01-09-year-in-review.md`, `2024-01-11-success-in-the-ordinary.md`, `2018-03-04-rxjs-the-basics.md`, and `2020-06-05-angular-transfer-state.md`.
- App data shapes: `Sources/WorkspaceProtocol/Domain.swift`, `Events.swift`, and `Sources/WorkspaceUI/TranscriptView.swift` in b4app. These establish available concepts, not proof that a lossless recording/export facility already exists.

## Documentation structure

`/docs` becomes a two-entrance landing page. Its App / Framework switcher is visible throughout documentation; route membership selects the active section. The switcher links to each section's introduction rather than guessing an equivalent page. Desktop and mobile navigation share one section registry. Prev/next navigation stays within its section.

Search defaults to the active section and offers an explicit all-docs scope; results carry App or Framework labels. Breadcrumbs, canonical URLs, sitemap, markdown exports, and machine-readable documentation inventories must include app pages without changing framework URL identities. Audit the baseline's redirects and explicit route wrappers before adding routes.

| Section | App page | Proposed path | Reader outcome |
| --- | --- | --- | --- |
| Get started | What is b4app? | `/docs/app/` | Understand the app, runtimes, Mac, and phone |
| Get started | Install and sign in | `/docs/app/install` | Open production b4app with the correct account |
| Get started | Connect Codex | `/docs/app/codex` | Verify their existing agent is ready |
| Get started | Connect Claude Code | `/docs/app/claude-code` | Verify their existing agent is ready |
| Use the app | Your first conversation | `/docs/app/first-conversation` | Send, follow activity, respond when needed, and continue |
| Use the app | Manage your work | `/docs/app/manage-work` | Organize projects and conversations |
| iPhone | Use b4app on your iPhone | `/docs/app/iphone` | Understand remote actions and disconnected behavior |
| Accounts and help | Accounts, privacy, and sync | `/docs/app/accounts-and-data` | Distinguish app/provider accounts and data boundaries |
| Accounts and help | Troubleshooting | `/docs/app/troubleshooting` | Recognize a state and take a concrete recovery action |
| B4 agents | Use a B4 agent | `/docs/app/b4-agents` | Connect or run the maintained example and find framework teaching |

Inspector routes are utilities, not extra authored chapters: `/docs/app/inspect/<capture-id>`. Each has a lesson backlink and recording metadata. The normal page remains readable if interactive assets fail. No full app CLI reference or self-hosting guide in this release.

## Learning and editorial contract

For conceptual lessons:

1. A short real recording shows the outcome before explanation.
2. Introduce the practical problem and why the topic helps.
3. Teach the concept broadly using familiar agent workflows. Explain necessary terms at first use.
4. Introduce the relevant Navlog interaction and its inspection panel.
5. Walk through selected moments, explaining action, observation, and consequence.
6. Offer one relevant continuation or application to the reader's own work.

Setup, privacy, and troubleshooting adapt that order to their purpose. Do not force a video or workbench exercise into every page. A complete text explanation accompanies every essential video lesson; captions and a transcript make recordings usable without sound.

Use Brian's conversational teaching voice: first person where it expresses a real authorial choice, inclusive "we" for walkthroughs, direct "you" for actions, short paragraphs, concrete nouns, and explanations that connect one step to the next. Introduce the problem before machinery; start with a familiar idea before adding detail. Use "Let's" naturally, without repeating it at every heading. Do not invent personal experiences or claim Brian performed a verification he did not perform. Avoid sales language, em-dashes, contrastive slogans, generic next-step boilerplate, and unexplained protocol jargon.

Example teaching copy, subject to the recorded evidence:

> Let's follow one turn. We ask Navlog to prepare a flight plan. Before it can answer, it needs information about the route and the weather.
>
> A tool gives the agent a way to ask for that information. Select a weather lookup in the recording. The input tells us what the agent requested. The result shows what came back. We can now follow how that result contributes to the response.

The lesson must use the names and actions in its real capture, not make an unrecorded tool sequence look observed. General explanations may compare runtimes, but B4 footage is labeled as B4 and does not qualify Codex or Claude Code behavior.

## Visual identity

Owner instruction governs: LLA layout and typography, with B4 colors and palette. The existing site's Inter, uppercase eyebrows, and other incompatible rules do not override this instruction for the new docs experience.

- Hanken Grotesk for documentation and inspector UI; JetBrains Mono for code and structured values. Scope the shared documentation layout typography to App and Framework for a coherent switcher; do not restyle unrelated marketing pages.
- Paper backgrounds, restrained surface changes, hairline separators, readable spacing, sentence-case labels, and functional icons only. No eyebrow labels, numbered decorative labels, gradients, glows, shadows, decorative icon tiles, or repeated card grids.
- Reuse B4's authoritative color roles: page `#f5f4f0`, surface `#eeeee7`, ink `#111111`, muted `#595b53`, rule `#d6d6cc`, control boundary `#75796a`, relay `#b4ce37`, relay tint `#e7edd1`, relay ink `#424d18`, olive `#627410`, focus `#667811`.
- Relay is a fill, never small text on paper. Use olive for accent text and focus tokens for focus indicators. Selected items have a label/marker in addition to tint. Status colors retain B4's semantic roles, alongside status text.
- Consume the existing central token source. Any necessary additional role is defined there, with contrast verification; no scattered color literals or second global theme.
- Inspector and Source stay on light surfaces, following the Hashbrown adaptation. Source syntax colors must be suitable for that surface. Existing article code blocks can retain their current code theme.
- Use real app video and screenshots. A browser inspector is labeled as an inspector; it is not presented as an exact replica of the native app.
- Avoid competing motion: starting replay pauses the page's demo video and vice versa. Honor reduced motion with a complete static, manually stepped view. Nothing starts automatically.

Existing design-system tests will need deliberate, scoped updates for the requested docs typography and treatment. Keep color-token parity and contrast checks intact; do not disable the design guard globally.

## Inspector behavior

Desktop: a conversation pane beside an activity-detail pane, with a shared turn selector and timeline. Conversation rows expose messages, tool activity, and recorded approvals. Selecting activity shows human-readable input, result, status, and observed relationships; structured data is a secondary disclosure. The reader can play, pause, step between meaningful activities, or seek a milestone.

Small panels: retain the same playback state but switch conversation and details through accessible tabs. Keep playback and turn selection reachable. Source uses a collapsed file picker. Use available container width rather than assuming desktop viewport means a wide article. Validate at 320, 375, 768, 1024, and 1440 pixels, including zoom.

A lesson action such as "Inspect the weather result" scrolls to the inspector, pauses playback, selects Replay, seeks the manifest's stable moment, selects the relevant activity, and announces the selection. Keyboard focus moves predictably to the inspector heading/control; no forced focus changes during playback. URL state identifies capture and moment for direct links, without creating a history entry for every playback tick.

Recorded approvals show the request and the historical decision. They are not actionable Approve/Deny controls. Replay makes no agent calls, writes no application files, and never transmits a recorded flight plan. Agent text and tool output are rendered as inert content. Sanitize Markdown links; do not inject capture HTML or fetch arbitrary capture/source URLs from query strings.

Use progressive disclosure: basic lessons default to conversation and readable tool details; optional Source appears only when the lesson has useful source references. Do not expose empty tabs. Initial replay is paused at the first meaningful moment, with the final outcome available as a named jump.

## Capture and replay contract

A capture represents a real app-observed conversation recorded through b4app against Navlog. The capture boundary is the coordinator/client protocol, not direct database reads or private UI file access. Before modifying b4app architecture, read its roadmap and decision log and determine whether the existing client subscription can preserve all needed changes. If a new recorder/export command is needed, design that change under the app's ownership rules. Normal app usage does not gain automatic recording.

The public artifact contains:

- Schema version, immutable capture ID, example/runtime/app revisions and versions, recorded date, provenance, and explicit live/stubbed dependency disclosures.
- Initial state, followed by ordered app-observed changes with relative timestamps and stable public IDs for turns, items, calls, requests, and any observed parent relationships.
- Milestones with stable IDs, event positions, labels, and optional selected activity references.
- Optional source manifest: repository, revision, file path, content hash, and resolved ranges. Browser source content is bundled from that exact revision.

Define and validate event payloads as a discriminated union at the capture boundary. Keep the normalized teaching model small, preserving the observed event ordering and identifiers. Do not reconstruct missing tool arguments, parentage, token timing, or raw model requests from prose. Mark unavailable fields explicitly. Snapshot provenance remains distinct from live events.

Replay is a deterministic pure reduction of initial state plus the event prefix. Seeking backward recomputes that prefix so future results, completions, decisions, and source-linked moments do not leak into earlier state. Sequence resolves ties; relative time drives playback pacing. Stable call IDs distinguish repeated tools. State records pending, resolved, expired, error, cancellation, and unknown outcomes without treating them all as success. Cross-turn replay retains earlier context. Preserve observed delivery timing and do not claim it is provider token timing.

Public capture production is explicit: record in an isolated demo account/workspace, normalize IDs and local paths consistently, remove secrets/private data from events and source material, validate, manually review, then publish immutable artifacts. A manifest ties video and capture to the same run. Videos may be edited for readability with disclosure; replay preserves semantic event order. Test fixtures are allowed in tests but are never labeled as real public runs.

Unknown schema versions, invalid IDs, bad event ordering, excessive artifact size, malformed payloads, or broken source bindings fail validation. Set finite size/count limits during contract implementation based on representative recordings. Missing/incompatible captures show a concise explanation and the video/transcript fallback, not an indefinite spinner.

## Navlog scenarios and boundaries

First release records a bounded planning request and a follow-up from the same conversation. Choose exact prompt, route, and departure time during capture qualification, recording these inputs and weather timestamp. Teach the turn and tool activity, not aviation decision-making. Date-sensitive weather is labeled as recorded information.

Later in the same first-release content effort, record an approval lesson only after the basic capture pipeline is verified. Source inspection confirms `fileFlightPlan` writes a local record and returns `transmitted: false`; teach that actual effect. Do not say the example files a plan with an aviation authority. The app inspector should show only what the app actually exposes, including any limits in subagent or planning visibility. The web example's map and custom cards are not assumed to appear in b4app.

Starting the example requires the B4-agent guide; Codex and Claude Code onboarding does not. A reader may inspect the static Navlog conversation first and run it later. Public instructions and source links use maintained B4 names and pinned qualified versions.

## Reuse from Hashbrown

Port bounded logic and design patterns into b4run, retaining required notices and attribution. Do not import the complete workbench runtime or its Hashbrown SDK dependency into docs.

- Adapt capture versioning, ordered events, milestone validation, playback controls, lazy loading, failure states, and snippet-to-moment links.
- Adapt the source file picker and commit-pinned source presentation.
- Replace Hashbrown-specific lesson registries, React/Angular dimensions, component-prop views, and application-state assumptions with app turns and activity.
- Do not port iframe messaging or Live-mode controls because the integrated component does not need them.
- Inspect the existing B4 activity-view reducers/renderers for useful presentation pieces during planning, but only adopt them if their semantics match app-observed data without manufacturing AG-UI events.

## Delivery boundaries and verification

This design describes the overall experience; implement it in bounded workstreams, each with its own plan:

1. Documentation navigation and editorial foundation: App/Framework routing, ten-page inventory, shared docs styling and first-conversation prose draft. Existing URLs and search/export behavior stay covered.
2. Capture contract and one real Navlog recording: recorder seam, sanitization, validation, provenance, and a golden capture. Any b4app code changes are a separate app-repository change.
3. Replay and Source inspector: consume the agreed capture format, add lesson links, responsive controls, accessible fallback, and source validation. It can develop against explicitly synthetic test fixtures while recording is qualified.
4. Production content and media: verify the released app's behavior, write the ten pages, record real footage, connect moments, and verify the full onboarding journey.

Dependencies: workstream 3 depends on the capture contract, not on every public recording. Workstream 4 depends on actual release facts and qualified media. Neither a new app command nor an example feature is silently added by the docs implementation.

Acceptance checks:

- Every existing framework URL remains valid; App/Framework navigation, search scopes, breadcrumbs, previous/next, markdown exports, and sitemap include the intended section correctly.
- Replay tests cover forward/backward seeking, multiple turns, repeated tools, deltas, pending and resolved approvals, cancellation/error/unknown outcomes, and malformed captures. Seeking must match the expected prefix state.
- No model or mutating request occurs during replay; recorded actions stay inert. Validate untrusted capture strings and links.
- Lesson moments resolve to actual events and source bindings resolve at the recorded revision. Artifact mismatches fail the publication check.
- Browser verification covers keyboard use, focus, touch, reduced motion, responsive layout, no competing playback, failed asset loading, and large tool results.
- Verify tokens, text/control contrast, light source readability, and LLA typography on representative App and Framework pages.
- Walk through production installation and each provider connection with the released app; distinguish live verification from fixtures. Verify account, sync, offline, and data claims against implementation and release behavior.
- Run repository-required gates for the actual change scope. Design-only work needs document/whitespace validation and review, not model inference or an application build. App changes require its own Swift checks and applicable gate records.

## Review state

The owner approved the audience, ten-page scope, production target, switcher and URL strategy, integrated Replay/Source inspector, LLA/B4 visual direction, voice references, and maintained Navlog example. This written design consolidates those decisions and adds implementation boundaries for review. No production docs, capture, deployed inspector, or live integration is claimed complete.

# Developer homepage refresh

Status: user approved homepage-first direction on September 15, 2026.

## Outcome

Keep the approved Paper Relay composition and “Ridiculous speed. Readable code.”
headline. Ground the next marketing phase in the runnable code-fixer app:
show the result, let developers inspect real code, explain what B4 owns, and
offer the qualified installation guide. Short explanations, confident voice.

## Source and evidence

The existing recorded walkthrough remains immutable historical evidence. Keep
its original source, model, 1m 53s duration, named checks, approval-pending state,
and links. Label its code as the recorded implementation. Do not imply the
recorded result or duration was obtained with the revised app.

Capability panels instead use exact source from the qualified installation:
commit `0003db2802b718ed167c8266b09a2d00ae01a522`, B4 0.8.32. Commit a bounded
source snapshot with hashes and contiguous excerpt ranges; render from local
data without build-time GitHub requests. Source links pin that revision and
line numbers. Preserve the existing evidence JSON and exporter unchanged.

Workspaces show the source descriptor and describe B4-owned capture, creation,
reconnection, and cleanup. Sandboxes show actual Docker configuration/policy.
Evals show the app's scorers and gate, identifying independent verification as
example-owned. Approval shows the ordinary agent declaration and explains that
the runtime pauses before export; the app verifies the candidate. Keep actual
copyable code and clear excerpt labels, with existing keyboard interactions.

## Installation and composition

Keep current section order and hero. Add clear provenance near the historical
walkthrough and qualified capability section. Update the project map for the
current app, including `prepareReview.ts`. Replace the retired `run:agent`
invocation with `b4 add code-fixer`, explicitly a command that prints a guide for
a coding agent to apply, not an automatic installer or agent run. Link to the
published guide and docs explaining the CLI prerequisite. Mention Node 24,
Docker, and an API key for live runs; offline replay needs no model call.
Keep the current walkthrough and full historical evaluation report accessible.

No new live evaluation, performance claim, social posting, article, dependency,
global styling, docs layout, package API, or fixture changes in this PR.

## Validation

Regression tests must distinguish qualified capability source from recorded
source, verify pinned links/excerpts, preserve historical evidence, and reject
the retired homepage run command. Check the rendered page at desktop and narrow
widths and verify capability/file/step selection, clipboard, readable code,
no-JavaScript initial content, and unchanged docs layout. Run web tests, scoped
lint, build, typecheck, docs checks, and required hosted CI before merge.

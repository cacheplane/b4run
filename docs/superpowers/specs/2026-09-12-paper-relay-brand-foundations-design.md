# Paper Relay brand foundations

Date: 2026-09-12
Status: visual direction and written guidelines approved by the user; independent spec review passed
Related work: [PR #631](https://github.com/cacheplane/b4run/pull/631)

## Decision

Adopt D2.2 logo geometry with Paper Relay: paper surfaces, ink typography,
yellow-green emphasis, dark code panels, Inter, and JetBrains Mono.
The user selected Paper Relay over a dark-first marketing treatment and approved
formalizing the subsequent typography, docs styling, and public template study.

The normative visual specification is
[the brand guidelines](../../brand/guidelines.md). Keep values and detailed rules
there rather than duplicating them in an implementation plan.

## Scope of this change

Write durable guidelines and add a discoverable link from the brand README.
Document logo assets and clear space, semantic color roles, contrast constraints,
type hierarchy, spacing, shape, dot graphics, and surface-specific application.
Differentiate the approved direction from the original kit's exploratory snapshot.

This is a documentation change on the existing PR branch. It leaves public SVGs,
the asset manifest, ZIP, live website styling, and product behavior unchanged.
The temporary browser studies remain exploratory artifacts; the guidelines are
the durable source for planning and do not depend on a local preview server.

## Explicit boundary

The user is not committed to the current homepage structure or design. The
homepage will be rebuilt around a new brand narrative in a later phase. This
spec approves no homepage section order, headline, conversion flow, positioning,
or marketing claim. Docs mockup navigation and abbreviated guide content are
also illustrative, not instructions to replace the existing information model.

## Acceptance criteria

- The guidelines identify Paper Relay as the default and Tight Shift as an
  archived alternative, while retaining D2.2 master geometry.
- All logo references resolve to existing files or directories on PR #631.
- Color and type roles are concrete enough to guide later component work.
- Contrast values are reproducible and distinguish decorative colors from text
  and essential UI indicators. They do not claim an end-to-end accessibility audit.
- Logo and type scale guidance distinguishes review mockups from production sizes.
- Homepage narrative and architecture remain explicitly deferred.
- The original public kit is identified as a prior snapshot; no text implies
  its ZIP or live styling has been updated by this documentation change.
- The brand README links to the normative guidelines and clarifies precedence.

## Validation and next step

Check document links, whitespace, and repository documentation conventions;
independently review the spec and guidelines for contradictions or scope drift.
No runtime or package behavior changes, so this increment needs no changeset or
runtime test additions. Do not represent earlier PR build/test results as checks
of this increment.

After written guideline review, create a separate implementation plan for public
kit synchronization. Shared UI styling, the homepage rebuild, and marketing
rollout each need their own bounded plan and validation.

Validation of this documentation increment:

- Independent spec review approved with no required changes.
- All 13 local Markdown links resolve; named logo masters exist.
- Logo geometry agrees with the D2.2 source and usage notes.
- All seven documented contrast ratios were independently recalculated.
- Repository forbidden-content rules pass for the three changed documents.
- `git diff --check` passes.
- `node scripts/check-docs.mjs` could not start because this checkout lacks `tsx`.
  The focused checks above are not a substitute for that full repository check.

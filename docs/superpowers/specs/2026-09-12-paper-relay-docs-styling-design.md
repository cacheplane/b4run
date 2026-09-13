# Paper Relay Docs Styling

Status: design sections and written spec approved by the user; independent spec
review approved. Implemented, independently reviewed, and locally validated;
see the [execution record](../plans/2026-09-12-paper-relay-docs-styling.md).

## Outcome

Apply the approved [Paper Relay brand guidelines](../../brand/guidelines.md) to
the documentation reading experience. Preserve the current layout, information
architecture, content, and behavior. This is the next bounded phase after the
public identity kit in PR #631.

The user selected docs only, dark code panels on paper pages, and more expressive
brand accents. They approved the component treatments and verification boundary
below. The exploratory section-led layout was rejected; its mockup is not a
requirement or implementation reference.

## Scope

Style all rendered documentation routes under `/docs`: sidebar,
page outline, breadcrumbs, article prose, code, tables, callouts, existing tabs
and steps, related cards, previous/next links, and page actions. Existing search
controls and results receive the same docs treatment without changing search.
The `/docs` entrypoint remains its existing redirect to `/docs/getting-started`;
do not introduce a standalone docs landing page.

Preserve the current three-column desktop grid, sidebar widths, article width,
responsive breakpoints, sticky offsets, and current mobile navigation behavior.
Spacing within components may change for the approved typography, but this phase
does not move controls or reorganize navigation groups.

Exclude the shared header and footer, homepage, blog, brand kit, social assets,
metadata, technical content, route names, and runtime packages. Do not remove the
existing Fraunces font or change global defaults used outside docs. Do not add a
dark-mode switch or a new theme system.

## Visual treatments

- **Surfaces:** paper `#F5F4F0`, primary ink `#111111`, dark code `#17181B`,
  Relay `#B4CE37`, and Relay tint `#E7EDD1`. Use quiet neutral borders and muted
  text with verified contrast. Avoid shadows and rounded panel treatments.
- **Type:** Inter for headings and prose, JetBrains Mono for code and technical
  labels, using the existing loaded font variables and appropriate fallbacks.
  Headings use semibold weight. Retain a readable article measure and familiar
  scale; do not import the exploratory mockup's oversized heading treatment.
- **Navigation:** active entries use Relay tint and an ink marker, supported by
  the existing current-page semantics. The outline uses similarly clear active
  treatment. Keep current grouping, links, disclosure and scroll behavior.
- **Sections:** use thin rules and small decorative Relay markers at major
  article sections (h2). Keep lower-level headings quieter; markers must not
  change heading text, IDs, outline labels, or the accessibility tree.
- **Code:** square dark panels, a restrained filename/language bar, readable
  syntax highlighting, and visible copy controls including their feedback
  states. Preserve existing grouping, tab selection, copy payloads, and language
  metadata. Inline code uses a subtle neutral light background. Do not put light
  syntax colors on a light background or flatten syntax colors indiscriminately.
- **Callouts:** info and tip panels use Relay tint with ink labels and icons.
  Preserve their distinct type labels. Warn and danger retain distinct semantic
  colors and explicit type labels, including when no custom title is supplied.
  Preserve custom titles and body content. These supporting labels must be
  scoped to the docs treatment so shared callouts outside docs do not change.
- **Links and controls:** underline prose links; use ink text and square controls.
  Use an ink focus outline on light surfaces and a contrasting light outline on
  dark panels. Do not use Relay-colored small text on paper or rely on color alone.
- **Tables and related components:** thin dividers, lightly tinted headers,
  square boundaries, and restrained Relay accents for selected tabs or step
  markers. Table semantics and existing behavior remain intact.

The strongest brand expression belongs in navigation, callouts, and section
markers. Long prose stays visually quiet. Decorative dots follow the brand
guidelines and never substitute for functional status indicators.

## Implementation boundaries for planning

`apps/web/app/docs/layout.tsx` currently composes `ReadingLayout`, `DocsSidebar`,
and `DocsTOC`. Introduce an explicit docs styling scope around this content rather
than changing root color or font tokens. Preserve the existing grid and sticky
behavior when adding the scope. Shared MDX mappings in `apps/web/mdx-components.tsx`
and components under `app/components/mdx/` also serve non-docs pages; their default
appearance must remain unchanged. Use scoped selectors or an explicit docs
variant/context where markup needs a docs-specific semantic label. Prefer stable
component hooks over matching literal utility-class strings.

Docs search or action popovers rendered outside the wrapper must receive an
explicit docs scope/variant at their actual rendered container; do not rely on
CSS inheritance across a portal. Verify existing rendering before selecting the
smallest necessary mechanism. This does not justify a general theme framework.

`MobileDocsNav` is mounted inside the shared `MobileMenu`, outside the docs layout.
Because the header is excluded, retain its current appearance and behavior in
this phase, including the mobile docs menu. This intentionally leaves shared
navigation chrome for the later shared-shell rollout. Mobile article styling and
controls inside the docs content remain in scope.

No content-loading or data-flow changes are required. Existing search indexing,
MDX rendering, route discovery, heading generation, and page-action data remain
authoritative. Preserve loading, empty, error, copied, expanded, and selected
states wherever these already exist. No new product behavior is introduced.

## Acceptance and verification

1. Inspect representative real pages covering prose, code with filenames and
   tabs, all callout types, tables, steps, related cards, and generated API
   reference content. Select the exact routes during implementation planning
   from actual content rather than inventing a synthetic showcase page.
2. At desktop, tablet, and 390 px mobile widths, verify the existing layout and
   reading flow. Prose, inline code, and callouts fit the viewport. Long code and
   tables scroll inside their containers without causing page-level overflow.
3. Exercise docs search, page actions, anchor links, code copying, tabs, sidebar
   and outline navigation, and the unchanged mobile menu. Confirm focus remains
   visible and sticky chrome does not obscure anchor targets.
4. Check loaded and fallback fonts, readable syntax and muted labels, text
   contrast (4.5:1 normal, 3:1 large), and meaningful control/focus contrast
   (3:1). Warn/danger types must be understandable without color.
5. Compare the homepage, a blog article, shared header/footer, and mobile menu
   against the baseline to catch shared-style leakage. Preserve docs technical
   content, heading IDs, nav entries, metadata, and all existing asset geometry.
6. Run relevant existing website tests plus focused regression coverage for
   meaningful new scoping or semantic behavior. Do not add tests that merely
   mirror CSS declarations. Run lint, build, typecheck, docs and changeset checks,
   and repository validation required by `AGENTS.md`; report exact failures,
   skipped checks, or environmental limitations without overstating completion.

## Delivery

This document authorizes no implementation until the written spec is reviewed by
the user. After independent spec review and user approval, create a bounded
implementation plan with the exact files, representative routes, baseline
captures, and verification commands. Keep the implementation separate from the
completed public-kit changes and follow the repository's branch-per-PR rule.
No merge or production publication is part of this design approval.

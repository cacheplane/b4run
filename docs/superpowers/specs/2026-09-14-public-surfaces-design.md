# Public surfaces and developer narrative

Approved scope: user requested follow-ups 1–3, PR, and merge on green. Apply the
existing Paper Relay design and approved code-first narrative; no new visual
identity or docs layout decision is needed. Continue inline in the existing
worktree, on `blove/public-surfaces` from merged `4afb5c93`.

## Design

1. Verify production homepage at b4.run: actual source/proof, interactions,
   metadata, links and root social image at desktop/mobile sizes.
2. Carry paper #F5F4F0, ink #111111, Relay #B4CE37, Inter and JetBrains Mono
   through blog index, tag pages, article headings/cards and article social
   images. Use square panels, simple rules, readable prose and static accents.
   Scope tokens under the blog layout; do not alter docs layout or global tokens.
   Keep article content, visibility, URLs, metadata and reading rails intact.
   Update shared footer language and add a developer walkthrough link.
3. Refresh the root README introduction using the approved headline, keep its
   canonical no-key quickstart and technical boundaries, retain historical media
   with an accurate destination. Supply repository social-preview PNG/SVG assets
   using the existing wordmark; document their use without changing repository
   settings through an undocumented API.
4. Add `examples/code-fixer/server/WALKTHROUGH.md`: actual source excerpts with
   links, seed/reacquisition lifecycle, sandbox policy, independent verification,
   evaluation criteria, approval and local export. Distinguish framework features
   from example-owned verification. Link it from homepage, footer, README and
   existing recipes overview. Correct stale example README evidence to final 4/6,
   CLI3/3 and nullable1/3, retaining all24 attempts. No new model calls.

## Alternatives considered

A global token migration would alter docs and increase regression scope. A new
marketing landing page would duplicate the recently merged homepage. Use scoped
blog styling and the example-owned walkthrough instead.

## Validation and delivery

Review source claims independently, preserve exact sample code and evidence,
check blog visibility/social-image tests and README contracts, and inspect
production/local desktop/mobile routes and images. Run web checks, docs,
changesets, full repository validation and independent final review. Open one
PR and merge its verified head on green; the established hosted-review credit
exception remains authorized. Preserve the worktree and recordings.

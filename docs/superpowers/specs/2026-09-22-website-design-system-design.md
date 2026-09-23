# Website design system

**Date:** 2026-09-22
**Status:** Approved
**Scope:** `apps/web` (Next.js 16 + Tailwind 4), the b4.run website only.

## Problem

The site's brand is the homepage: paper `#f5f4f0`, ink `#111`, muted `#595b53`,
rule `#d6d6cc`, relay `#b4ce37` fills, olive text, dark `#17181b` code panels,
Inter + JetBrains Mono, square corners, no shadows. Those values exist only inside
three page scopes (`[data-docs-brand]` in `app/docs/docs-brand.css`, `.blog` in
`blog.module.css`, `.home` in `homepage.module.css`). The Tailwind `@theme` in
`app/globals.css` still declares the retired amber palette (white page, `#fafaf7`
surface, `#14110d` ink, `#b45309` on `#fef3c7`), so everything outside a scope
renders the old brand: the header `CopyCommand`, the mobile menu, blog inline
code (4.0:1, fails AA), the light blog code blocks, the white body behind the
404. A 2026-09-22 computed-style audit at 390–1920px also found four muted greys,
three dims, three rules, five eyebrow styles, four link-underline styles, three
focus rings, radii of 4/6/8px and `rounded-full` on square components, dead tokens
(`accent-blue`, `accent-purple`, `text-display-*`, `--b4-font-sans`), Tailwind
classes that match no token (`text-bg-primary`, `hover:border-text-muted`,
`placeholder-text-muted`), `↗` on internal links, 85–90 characters per prose line
at ≥1280px, and inline code in tables splitting mid-token at 390px.

## Goal

One token source, one set of primitives, every surface migrated, the old palette
and its workarounds deleted, AA contrast everywhere, and a test that fails if any
of it comes back. Dark mode is out of scope, but the token structure must support
it later without renaming anything.

## Non-goals

- Dark mode, a theme switcher, or `prefers-color-scheme` handling.
- Changing layout, copy, navigation, or the homepage's page-specific
  composition (`homepage.module.css` keeps its layout rules).
- A published token package. Tokens live in `apps/web`.
- Replacing CSS modules with attribute-scoped stylesheets (the
  angular-agent-framework approach). The two remaining modules are layout, not
  tokens, and stay.

## Prior art

Adopted from `~/repos/angular-agent-framework` (its current `libs/design-tokens`
+ `apps/website/src/styles/*.css`, not the superseded April/May plans):
Tailwind 4 `@theme` as the token surface with composite `--text-*` tokens;
contrast ratios recorded next to each colour; `data-ui` attributes on primitives
with the rules in unlayered stylesheet files so utilities cannot out-specify
them; a TS mirror pinned by a parity test; a guard test that greps the app for
forbidden tokens and classes; `↗` produced only by `a[href^="http"]::after`;
spec and plan under `docs/superpowers/`.

Adopted from `~/repos/pretable` (`apps/website/app/globals.css`,
`packages/ui/src/__tests__/contract.test.ts`, the theming docs): a declared
`@layer` order at the top of `globals.css`; a contract test that every token
resolves; a no-legacy-namespace guard; role-based names with no raw primitives
leaking into components; "restate every colour, alias nothing" as the rule for a
future dark block; the token-reference document shape (one table per group).

Deliberately not adopted: TS-as-source with a generated CSS file (no
non-Tailwind consumer here; the only TS consumer is Satori OG images); the
`--ds-*` / `--pt-*` second namespaces and the `@theme inline` bridge (Tailwind 4
utilities already emit `var(--color-*)`, so a future `[data-theme="dark"]` block
can restate the `--color-*` names directly, which is what `docs-brand.css` does
today); the ESLint inline-style ban (this app lints with Biome); the
style-contract registry (folded into one token test); a 6–20px radius scale.

## Design

### 1. Tokens: `apps/web/app/styles/tokens.css`

One `@theme` block, imported first by `globals.css`. Names are roles. Every
colour comment records its contrast ratio against the surface it is used on.

| Group | Token (`--color-*` unless noted) | Value | Contrast / note |
| --- | --- | --- | --- |
| Surface | `page` | `#f5f4f0` | paper |
| | `surface` | `#eeeee7` | cards, table heads, strips on paper |
| | `surface-sunk` | `#e8e8df` | inline code on paper |
| | `rule` | `#d6d6cc` | decorative rules only |
| | `rule-strong` | `#75796a` | input/control boundaries (3.6:1 on paper) |
| Ink | `ink` | `#111111` | 17.2:1 on paper |
| | `ink-muted` | `#595b53` | 6.3:1 on paper; the only secondary text colour |
| Accent | `relay` | `#b4ce37` | fills only, 1.6:1 — never text |
| | `relay-tint` | `#e7edd1` | selection, active nav, callout body |
| | `relay-ink` | `#424d18` | text on relay-tint, 7.6:1 |
| | `olive` | `#627410` | accent text and underlines on paper, 4.7:1 |
| | `focus` | `#667811` | focus ring on paper, 4.5:1 (non-text ≥3:1) |
| Panel | `panel` | `#17181b` | dark code panel |
| | `panel-strip` | `#202226` | panel header/footer strip |
| | `panel-ink` | `#f5f4f0` | 16.1:1 on panel |
| | `panel-muted` | `#c4c8bc` | 10.5:1 on panel; labels, captions |
| | `panel-dim` | `#a3aa99` | 7.4:1 on panel; line numbers, comments, inactive tabs |
| | `panel-rule` | `#4d5148` | rules inside the panel |
| | `panel-accent` | `#b4ce37` | 9.6:1 on panel; active tab marker, highlighted line, copied state (text is allowed on the panel, never on paper) |
| Status | `ok` / `ok-tint` | `#1f6f3f` / `#e3efe4` | tip callouts, diff add (5.9:1 on tint) |
| | `warn` / `warn-tint` | `#8a5100` / `#fff1ce` | 6.0:1 |
| | `danger` / `danger-tint` | `#a12f25` / `#fbe8e5` | 6.2:1 |
| Type | `--font-sans` / `--font-mono` | unchanged | next/font variables |
| | `--text-eyebrow` | 12px / 1.6 / 500 / 0.07em, uppercase, mono | the homepage eyebrow; the one eyebrow |
| | `--text-body` / `--text-body-lg` | 16px/1.65 / 19px/1.65 | |
| | `--text-code` | 13px / 1.55 | block and inline code |
| | `--text-h1` | clamp(36px, 4.5vw, 44px) / 1.1 / 600 / −0.03em | docs & blog titles |
| | `--text-h2` | 28px / 1.2 / 600 / −0.03em | prose h2 |
| | `--text-h3` | 20px / 1.3 / 600 / −0.02em | |
| | `--text-display` | clamp(44px, 6.5vw, 88px) / 1.03 / 600 / −0.055em | homepage hero, 404 |
| Shape | `--radius-*` | `initial` | removes Tailwind's defaults; `rounded-*` emits nothing |
| | `--shadow-*` | `initial` | same |
| | `--ring-width` (`:root`) | 3px | focus ring |
| Layout | `--prose-max` (`:root`) | 68ch | prose paragraph cap |
| | `--column-max` (`:root`) | 1280px | header/footer/404 column |
| | `--header-h` (`:root`) | 4.5rem | unchanged |

Removed: `accent-green/blue/purple`, `accent-saas*`, `ink-dim`, `divider*`,
`text-display-xl/l`, `--b4-font-sans`, `--docs-relay`, `--docs-tint`, and the
`.home` locals (`--paper --ink --relay --quiet --rule --dark`).

`ink-dim` (three values) merges into `ink-muted`; the three muteds merge into
`#595b53`. Consumers that used `ink-dim` for small print get slightly darker
text; that is intended.

`app/lib/design-tokens.ts` exports the colour roles as a `const` object for
`app/opengraph-image.tsx` and `app/blog/[slug]/opengraph-image.tsx` (Satori
cannot read CSS variables). A test parses `tokens.css` and asserts the mirror
equals it, so neither can drift.

### 2. Global rules replace the scopes

`globals.css` becomes: `@layer` order, `@import "tailwindcss"`, then
`styles/tokens.css`, `styles/base.css`, `styles/prose.css`, `styles/ui.css`.

`base.css`: `html { color-scheme: light; scroll-padding-top }`; `body` on
`page`/`ink`/`font-sans`; `::selection` relay-tint on ink; one global
`:focus-visible { outline: var(--ring-width) solid var(--color-focus);
outline-offset: 3px }` (`main#content:focus` stays `outline: none`);
`h1–h3 { text-wrap: balance }`, `p, li { text-wrap: pretty }`; the skip link on
tokens; `@media print` hides header, footer, sidebars, copy buttons, and prints
`pre` with a border instead of the dark panel.

`prose.css`: every rule currently in `docs-brand.css` and `.prose-b4 a`,
unscoped and on tokens: headings (`h1` line-height 1.1, `h2` 600 with the
top rule and relay dot, `text-wrap: balance`); links (`ink` text, `olive`
underline 1px, 2px on hover); inline code (`surface-sunk`, `ink`, square, no
border-radius, wraps at every width); the Shiki `pre` rules (one theme, see §4);
highlighted / diff lines; tables (`relay-tint` head as docs have today, `rule` borders, inline code
inside a table gets `overflow-wrap: normal` and `white-space: nowrap` and the
wrapper scrolls horizontally, so `AGENTS.md` stays one token); callouts; steps;
tabs; related cards; pagination. Prose blocks get `max-width: var(--prose-max)`
except `pre`, `figure`, `[data-code-frame]`, `[data-prose-table]`,
`[data-prose-tabs]`, `[data-related-cards]`, which stay full width. The
`.mdx-inline-code` class is kept (the `pre .mdx-inline-code` reset depends on
it).

`ui.css`: `data-ui` rules for `eyebrow`, `button` (`primary` = relay fill with
ink text and a 1px ink border, `secondary` = ink border on paper, `ghost`),
`copy-command` (`light` and `dark`: square, mono 13px, olive `$` on light /
relay `$` on dark, no border-radius), `card`, `callout`, `code-frame` (+
`code-header`, `code-tab`, `code-active-marker`), `table`, `chip`, `icon`
(16px and 20px boxes, stroke 1.5), `nav-item`; and
`a[href^="http"]:not([data-no-arrow])::after { content: " ↗" }` so the arrow
can only appear on off-site links. Internal links that currently carry a literal
`↗` (homepage chapter links, mobile menu, `CodePanel`, `BlogCta`) lose it.

Deleted: `docs-brand.css` and the `[data-docs-brand]` attribute (`docs/layout.tsx`,
`DocsSearch.tsx`); the token blocks and `:focus-visible` rules in
`blog.module.css` and `homepage.module.css` (their remaining hex values become
`var(--color-*)`); `header.module.css`'s hex; the footer's inline `style`; the hex in
`not-found.tsx`. `site.webmanifest` `theme_color`/`background_color` become
`#f5f4f0` and `app/layout.tsx` exports `viewport = { themeColor: "#f5f4f0" }`.

Kept: `body:has([data-docs-layout]) [data-site-footer] { display: none }`. It
is not a palette workaround — the footer is a sibling of the page tree, the
docs layout renders the marker on the server, and the client-side alternative
caused a hydration error (#789). It moves to `base.css` unchanged and the
site-chrome test keeps pinning its shape.

The `[data-code-frame]` re-scoping of ink/rule for the dark panel is kept as the
one place tokens are restated (`--color-ink: var(--color-panel-ink)` etc.), and
it is the template a future dark block would follow.

### 3. Primitives: `apps/web/app/components/ui/`

- `Eyebrow` — `<p data-ui="eyebrow" data-tone="muted|olive">`. Replaces the
  five eyebrow styles (homepage `.eyebrow`, `DocsSidebar`/`MobileMenu`/
  `MobileDocsNav` mono 10px, `DocsTOC`/`MobileDocsTOC`/`PostMeta` tracking-widest,
  `Eyebrow.tsx` Inter 600, footer headings, blog olive).
- `Button` — `<button|a data-ui="button" data-variant="primary|secondary|ghost">`;
  renders `<a>` when `href` is set. Used by `CopyPromptButton`, the homepage
  step buttons stay in the module (they are a segmented control, not buttons).
- `SiteLink` — decides `next/link` vs `<a target="_blank" rel="noopener
  noreferrer">` from the href (`http(s)://` or `mailto:`); never writes `↗`
  itself. Used by the header, footer, mobile menu, homepage text links, blog CTA.
- `CopyCommand` — moves to `ui/`, gains `variant="light"|"dark"` (`dark` for
  the blog CTA on the panel), square, `Icon` for the glyphs.
- `Card` — `<Link|div data-ui="card">`; used by `RelatedCards`, `DocsPrevNext`,
  blog `PostCard`/`FeaturedPostCard` keep their module layout but take
  `data-ui="card"` for colour/border.
- `Icon` — `size="sm"|"md"` (16/20), stroke 1.5, wraps the inline SVGs used by
  copy/check/search/close/menu/arrow so sizes stop drifting 13–20px.
- `Callout`, `CodeBlock`, `CodeGroup`, `Steps`, `Tabs`, tables in
  `mdx-components.tsx` stay where they are and drop Tailwind colour, radius,
  and shadow classes for `data-ui` + tokens. `DocsBrandProvider` stays
  (callout labels are still docs-only behaviour).

### 4. Code highlighting: one theme

`lib/shiki-theme.ts` exports the `paper-relay` theme now in
`homepage/highlight.ts`, extended with the scopes docs code uses (`entity.name.function`, `entity.name.type`, `support.type`, `variable`, `constant.numeric`, `punctuation`, `keyword.operator`, `markup.heading`, `markup.bold`) with every foreground ≥4.5:1 on `#17181b` (asserted by the token test). `rehype-pretty-code` uses it as the single `theme`, so output has one `--shiki-*`-free colour per token; the dual `--shiki-light/dark` rules and the `#6A737D` comment patch are deleted. `homepage/highlight.ts` imports the same theme. Blog code becomes dark and square like docs and homepage code.

### 5. Tests

`app/styles/design-system.test.ts`:
1. Token values: the table in §1, parsed from `tokens.css`.
2. Mirror parity: `design-tokens.ts` equals the parsed colours.
3. Contrast: WCAG relative-luminance math for every declared text/background
   pair (ink, ink-muted, olive, relay-ink, panel-ink, panel-muted, the three
   status inks, every Shiki foreground) ≥ 4.5:1; focus and rule-strong ≥ 3:1.
4. Guard, over `app/**/*.{ts,tsx,css}`, `mdx-components.tsx`, `lib/**`,
   `public/site.webmanifest` (excluding tests and the two OG routes for hex):
   no `#b45309 #fef3c7 #fafaf7 #14110d #5a554c #6b6657 #e6e3da #cfcabd #ffffff`
   (webmanifest); no `accent-saas|accent-green|accent-blue|accent-purple|ink-dim|
   divider|text-display`; no `rounded-` / `shadow-` utility classes; no
   `text-bg-primary|border-text-muted|placeholder-text-muted`; no
   `data-docs-brand`; no `border-radius:` other than `0` or `50%` in CSS; no
   literal `↗` in TSX; no `--shiki-light`; no hex literal in `.tsx` outside
   `opengraph-image.tsx`.
5. `tokens.css` declares every `--color-*` that any file references (the
   pretable contract check).

Existing tests are updated, not deleted: `site-chrome.test.tsx` (footer rule
location, docs layout attribute, homepage contrast case becomes a tokens case),
`docs-syntax-theme.test.ts` (single theme, asserts a coloured span and no
`--shiki-light`), `inline-code-responsive.test.ts` (reads `prose.css`),
`mobile-docs-nav.test.ts` (no longer asserts `focus-visible:ring-2`),
`docs-brand.test.tsx` (portal no longer needs the attribute; keeps the callout
label assertions).

### 6. Verification

Before/after with the audit scripts (`bp.mjs` for 390/768/1024/1440 of `/`,
`/blog`, `/blog/why-we-built-b4`, `/docs/getting-started`, `/docs/memory`,
`/docs/configuration`, a 404 URL; plus the open mobile menu at 390 on `/` and
`/docs/getting-started`), a pixel diff per pair using `sharp`, and axe-core
(`~/repos/ag-ui/node_modules/.pnpm/axe-core@4.11.0`) injected via
`playwright-core` on every page at 390 and 1440 with zero `color-contrast`
violations. The homepage and docs views are expected to diff only where the
audit listed a fix (eyebrows, focus ring, strip colour, link arrows, prose
width); the blog, header chip, mobile menu and 404 change on purpose.
Screenshots and the diff summary go in the PR.

Gates: from `apps/web` — `pnpm exec vitest --run`, `pnpm exec tsc --noEmit`,
`pnpm lint`; from the root — `node scripts/check-docs.mjs`, root Biome over
`package.json scripts test`, and `pnpm --dir apps/web seo:lastmod` before commit.

### 7. Documentation

`docs/brand/website-design-system.md`, next to `guidelines.md`: the token
tables (one per group with counts, values, contrast), the primitives with their
`data-ui`/`data-variant` contracts, the rules (square, no shadows, relay is a
fill, `↗` is off-site only, one eyebrow, one focus ring, prose at 68ch), how to
add a token (`tokens.css` → mirror → test table → doc), and the dark-mode path
(restate every `--color-*` under `[data-theme="dark"]`; alias nothing).
`docs/brand/guidelines.md` gets a one-line pointer.

## Files

New: `app/styles/{tokens,base,prose,ui}.css`, `app/styles/design-system.test.ts`,
`app/lib/design-tokens.ts`, `app/components/ui/{Button,SiteLink,Card,Icon}.tsx`,
`lib/shiki-theme.ts`, `docs/brand/website-design-system.md`.
Moved: `app/components/CopyCommand.tsx` → `app/components/ui/CopyCommand.tsx`.
Deleted: `app/docs/docs-brand.css`.
Edited: `globals.css`, `layout.tsx`, `not-found.tsx`, `docs/layout.tsx`,
`docs/not-found.tsx`, `mdx-components.tsx`, `lib/mdx-plugins.ts`,
`homepage/{highlight.ts,homepage.module.css,header.module.css,CodePanel.tsx,
DeveloperHome.tsx,Narrative.tsx}`, `blog/{blog.module.css,BlogCta,PostMeta,
PostHeader,PostCard,FeaturedPostCard,TagChips}.tsx`, `Footer.tsx`,
`HeaderInner.tsx`, `MobileMenu.tsx`, `CopyPromptButton.tsx`,
`docs/{DocsSidebar,DocsTOC,MobileDocsNav,MobileDocsTOC,DocsSearch,PageActions,
RelatedCards,DocsPrevNext}.tsx`, `mdx/{Callout,CodeBlock,CodeGroup,Steps,Tabs}.tsx`,
`ui/Eyebrow.tsx`, `opengraph-image.tsx` (both), `public/site.webmanifest`, the
five tests named in §5.

## Risks

- Removing `--radius-*`/`--shadow-*` defaults silently no-ops any `rounded-*`
  left behind; the guard test is what makes that loud.
- The single Shiki theme has fewer scopes than GitHub Dark; the plan extends it
  and the contrast test covers each added colour. If a language renders flat,
  add a scope, not a second theme.
- The 68ch cap changes line breaks on every docs page at ≥1280px; that is the
  intended fix, but it is the largest visual diff and the screenshots must show
  it is only a width change.
- `:has()` stays for the footer rule; it is supported by every browser the site
  targets and the alternative is a client-side path check that caused a
  hydration error before.

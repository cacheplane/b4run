# Website design system

How b4.run (`apps/web`) is styled: one token file, four rule files, a handful of
`data-ui` primitives, and a test that keeps it that way. The brand itself
(logo, palette rationale, typography) is in [`guidelines.md`](./guidelines.md);
this page is the implementation contract.

## Where things live

| File | Holds |
| --- | --- |
| `apps/web/app/styles/tokens.css` | The one `@theme` block: every colour, type, radius and shadow token. The only stylesheet that may contain a colour value, with two exceptions the guard test names: the two Shiki-mirror diff colours in `ui.css` (`#c5d985`, `#f0ae95`) and `print.css`'s `black`. Outside CSS, hex also lives in the Shiki theme, `lib/design-tokens.ts`, the OG image route and `public/site.webmanifest`. |
| `apps/web/app/styles/base.css` | `html`/`body`, `::selection`, the global `:focus-visible` ring, `text-wrap`, the skip link. |
| `apps/web/app/styles/prose.css` | MDX prose: headings, the reading measure, links, inline code. Lives in `@layer components`, so a Tailwind utility on the same element wins. |
| `apps/web/app/styles/ui.css` | `[data-ui="…"]` primitives, the dark code frame, callouts, tables/tabs/steps, docs-chrome one-offs (the search dialog keyed off `data-docs-search-dialog`, page-actions menu, sidebar marker), and the off-site link arrow. Lives in `@layer components`. |
| `apps/web/app/styles/print.css` | Print only: chrome and controls hidden, code prints as a bordered block, off-site links show their URL inline. Imported last and unlayered, so its `:root :is(...)` rules outrank the `@layer components` files. |
| `apps/web/lib/design-tokens.ts` | TS mirror of the colour roles (`COLOR`) for Satori OG images and `viewport.themeColor`, plus the Shiki foreground list. |
| `apps/web/lib/shiki-theme.ts` | The single `paper-relay` syntax theme. |
| `apps/web/lib/design-system-checks.ts` | The `themeTokens` (parses the `@theme` block) and `contrast` (WCAG luminance ratio) helpers the test imports. |
| `apps/web/app/components/ui/` | `Eyebrow`, `Button`, `SiteLink`, `Card`, `Icon`, `CopyCommand`. |
| `apps/web/app/styles/design-system.test.ts` | Pins token values, TS-mirror parity, contrast ratios; forbids the old palette and classes, hex and named/functional colours outside the files above, and a second `@theme`. |

CSS modules (`homepage.module.css`, `blog.module.css`, `header.module.css`)
hold page layout only and consume tokens through `var(--color-*)`.

## Tokens

Names are roles. Tailwind exposes each `--color-x` as `bg-x`, `text-x`,
`border-x`, `decoration-x`; each composite `--text-x` as `text-x`.

### Surfaces (5)

| Token | Value | Use |
| --- | --- | --- |
| `page` | `#f5f4f0` | Paper. The body background and every card. |
| `surface` | `#eeeee7` | Strips, table heads, the copy-command chip. |
| `surface-sunk` | `#e8e8df` | Inline code. |
| `rule` | `#d6d6cc` | Decorative rules. Never the only boundary of a control. |
| `rule-strong` | `#75796a` | Control boundaries (4.1:1 on page). |

### Ink (2)

| Token | Value | Contrast on page |
| --- | --- | --- |
| `ink` | `#111111` | 17.2:1 |
| `ink-muted` | `#595b53` | 6.3:1 — the only secondary text colour |

### Accent (5)

| Token | Value | Use |
| --- | --- | --- |
| `relay` | `#b4ce37` | Fills only (1.6:1 on page). Never text on paper. |
| `relay-tint` | `#e7edd1` | Selection, active nav, callout body, hover on cards. |
| `relay-ink` | `#424d18` | Text on relay-tint (7.6:1). |
| `olive` | `#627410` | Accent text and link underlines on page (4.7:1). |
| `focus` | `#667811` | The focus ring on page (4.48:1; non-text, 3:1 required). |

### Dark code panel (7)

| Token | Value | Use |
| --- | --- | --- |
| `panel` | `#17181b` | Code blocks, homepage panels, blog CTA. |
| `panel-strip` | `#202226` | Header/footer strip inside a panel. |
| `panel-ink` | `#f5f4f0` | Text (16.1:1). |
| `panel-muted` | `#c4c8bc` | Labels, captions (10.4:1). |
| `panel-dim` | `#a3aa99` | Line numbers, comments, inactive tabs (7.4:1). |
| `panel-rule` | `#4d5148` | Rules inside the panel. |
| `panel-accent` | `#b4ce37` | Active marker, highlighted line, copied state. Relay may be text here (10.0:1). |

### Status (6)

`ok #1f6f3f` (5.2:1 on `ok-tint #e3efe4`), `warn #8a5100` (5.8:1 on
`warn-tint #fff1ce`), `danger #a12f25` (6.0:1 on `danger-tint #fbe8e5`).

### Type

`--font-sans` (Inter) and `--font-mono` (JetBrains Mono) from `next/font`.
Composite tokens: `text-eyebrow` (12px/1.6, 500, 0.07em, mono, uppercase),
`text-body` 16/1.65, `text-body-lg` 19/1.65, `text-code` 13/1.55,
`text-h1` clamp(36–44)/1.1/600/−0.03em, `text-h2` 28/1.2/600, `text-h3`
20/1.3/600, `text-display` clamp(44–88)/1.03/600/−0.055em.

### Shape and layout

`--radius-*` and `--shadow-*` are reset to `initial`: corners are square and
nothing casts a shadow. The only curves are the relay dots (`border-radius: 50%`).
`:root` holds `--header-h 4.5rem`, `--ring-width 3px`, `--prose-max 56ch`,
`--column-max 1280px`.

## Primitives

| Component | Markup | Variants |
| --- | --- | --- |
| `Eyebrow` | `<p\|span data-ui="eyebrow" data-tone>` | tone `muted` (default), `olive`, `tint` (on relay-tint), `panel`; `as="p"` (default) or `"span"` where a `<p>` is invalid |
| `Button` | `<button\|a data-ui="button" data-variant data-size>` | `primary` (relay fill, ink border), `secondary` (ink border), `ghost` (rule-strong border, muted text; ink on hover — the header and sidebar search triggers and the page-actions controls); `size="sm"` mono 2rem, `size="icon"` 44px square for an icon-only control. Forwards the rest of the anchor or button attributes, including `ref`. |
| `SiteLink` | `next/link` or a plain `<a>` | `http(s)://` hrefs get `target="_blank" rel="noopener noreferrer"`; `mailto:`, `download`, or a caller-supplied `target` render a plain `<a>` with no injected target. Never writes ↗. |
| `Card` | `<a\|div data-ui="card">` | Link cards get the relay-tint hover. |
| `Icon` | `<svg data-ui="icon" data-size>` | names: `copy`, `check`, `search`, `menu`, `close`, `arrowRight`; `sm` 16px (default), `md` 20px, stroke 1.5 |
| `CopyCommand` | `<span data-ui="copy-command" data-variant>` wrapping one `<button>` (the whole chip is the copy target) and a `role="status"` beneath it for the copy result | `light`, `dark` |
| `data-ui="nav-item"` | docs sidebar and mobile nav links (`aria-current="page"`), desktop and mobile TOC links (`aria-current="location"`) | active = tint + ink left border + 600 |
| `data-ui="icon-button"` | 44px icon controls | |
| `data-ui="chip"` | blog tag filters | active (`aria-current="page"`) = relay fill + ink border |
| `data-ui="kbd"` | ⌘K / ESC chips | |

## Rules

- Square corners, no shadows. The guard test fails on any `rounded-*` or `shadow-*` class.
- Relay is a fill. Text on paper is ink, ink-muted or olive; on the panel it may be panel-accent.
- ↗ means off-site. It is drawn by `a[href^="http"]::after` in `ui.css` (and, in print, spelled out as the URL by `print.css`); markup never contains the glyph. Icon-only links add `data-no-arrow`.
- One eyebrow (`Eyebrow`), one focus ring (`:focus-visible` in base.css; the dark code frame restates `--color-focus` to `panel-accent`), one link style in prose (ink text, olive underline, 2px on hover).
- Every small uppercase label is an `Eyebrow` (section headings, the homepage proof label, search result sections), with two deliberate exceptions that are different roles, not eyebrows: the callout label (`[data-callout-label]`, 600 weight, sans) and table `th`.
- Prose text (and a blog post's `<header>`) stops at `--prose-max` (56ch ≈ 565px ≈ 70 average characters; `ch` is the "0" width, so 68 characters of prose is well under 68ch); code, tables, tabs and card grids keep the column.
- Inline code inside a table never wraps; the table scrolls.
- No hex outside `tokens.css`, `shiki-theme.ts`, `design-tokens.ts`, the OG route and `site.webmanifest`, except the two Shiki-mirror diff colours in `ui.css`. No named (`white`, `black`, …) or functional (`rgb()`, `hsl()`, `oklch()`) colour in any stylesheet but `tokens.css` and `print.css`.

## Adding a token

1. Add it to the `@theme` block in `tokens.css` with a comment giving its contrast pair.
2. Add it to `COLOR` in `lib/design-tokens.ts` (colours only).
3. Add the value to the pinned list in `design-system.test.ts` and, if it is text, its pair to the contrast list (`contrast`/`themeTokens` live in `lib/design-system-checks.ts`).
4. Add a row above.

## Dark mode (not shipped)

When it comes: add `[data-theme="dark"] { … }` to `tokens.css` and restate
**every** `--color-*` with a dark value — alias nothing, so a paper-white
`surface` cannot survive into dark by omission. Components already read roles
only, and `[data-code-frame]` in `ui.css` shows the pattern (it restates
`--color-ink`, `--color-ink-muted`, `--color-rule`, `--color-rule-strong` and
`--color-focus` for the panel). Add `color-scheme: dark` in the same block and
a second contrast table to the test.

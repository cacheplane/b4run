# Homepage scaffold hero

Date: 2026-09-24 · Scope: `apps/web` homepage hero and its hand-off to the first
section. Everything below "An agent is a folder." is unchanged.

## Problem

A UI/UX audit of b4.run's homepage (desktop 1440, mobile 375) found:

- The hero shows no product. Its only visual is a decorative lime dot; the
  first code appears below the fold.
- Nothing connects the call to action (`npm create b4-app@latest my-agent`) to
  what it produces.
- The LangGraph line decided in the September 16 narrative brainstorm ("Runs on
  LangGraph.js. You keep the graph.") never shipped.

The homepage goal is unchanged: the visitor runs the scaffold command.

## Design

### Layout

Desktop (≥ 960px): a two-column hero, copy about 55% and terminal about 45%,
top-aligned with the H1.

- **Left:** the eyebrow, H1, lede and actions, as they are today, plus one new
  line directly under the lede, **"Runs on LangGraph.js. You keep the graph."**,
  in `--color-olive` (4.7:1 on page). The H1 drops from
  `clamp(44px, 6.5vw, 88px)` to about `clamp(44px, 5.2vw, 72px)`, because at
  88px "Ridiculous speed." is about 750px wide and would wrap in a half column.
  The copy command and "Get started →" are unchanged.
- **Right:** a new `ScaffoldTerminal`, drawn with the existing dark-panel tokens
  (`--color-panel`, `--color-panel-strip`, `--color-panel-ink`,
  `--color-panel-dim`, `--color-panel-accent`):

  ```
  terminal
  $ npm create b4-app@latest my-agent
  ✔ Created my-agent (basic template)

  my-agent/
  ├─ AGENTS.md              guide for your coding agent
  ├─ b4.config.ts           runtime
  ├─ src/app/hello/         the agent ↓
  │  ├─ index.ts            model + prompt
  │  ├─ tools/greet.ts      a typed tool
  │  └─ evals/smoke.eval.ts behavior check
  └─ test/agent.test.ts     passes, no API key
  ─────────────────────────────────────────────
  cd my-agent && npm install && npm test
  ```

  The `✔ Created` line is `create-b4-app`'s real output format
  (`packages/create-b4-app/src/index.ts`, `printNextSteps`). The footer strip
  condenses the first three `basicSteps` (`cd`, `npm install`, `npm test`), and
  the scaffold's `npm test` runs on scripted fixtures, so "no key" is true.

- **Removed:** the `.dot` element and its CSS.

Below 960px the hero stacks, with the terminal after the actions. Below 480px
each note moves under its file name instead of sitting in a right-hand column,
so the tree never scrolls sideways at 375px.

### The Relay dot, given a job

The brand guidelines (`docs/brand/guidelines.md`) make the oversized dot the
signature graphic and allow a separate circle as a focal point, diagram node or
section marker, which may crop at an outer edge but must not cover text. The
hero uses it twice:

1. **Eclipse:** an `aria-hidden` Relay circle, about 440px (desktop) or 240px
   (mobile), positioned behind the terminal's top-right corner and cropped by
   the page edge. It is anchored to the terminal column, never behind text.
   The hero section (not all of `.home`) gets `overflow-x: clip`, so the crop
   cannot create sideways scrolling and no other panel on the page can be
   clipped by it.
2. **Agent marker:** the `src/app/hello/` row carries a Relay `●`, a Relay-tinted
   background with a 2px Relay left rule, and the note "the agent ↓". The row is
   a link to `#first-agent`. The "Your first agent" eyebrow in the next section
   gets the same dot, with a 1.5px ink outline because Relay on paper is 1.6:1,
   so the reader connects the two.

### Motion

CSS only; no client component. The server renders every line in its final
position, and only `opacity` and `translateY(4px → 0)` animate, so nothing on
the page shifts (CLS 0).

The sequence plays once: the command, the `✔ Created` line, the tree rows
staggered 60ms apart (`animation-delay: calc(var(--i) * 60ms + 120ms)`), each
line fading in over 300ms with an ease-out curve, then the marker dot scales in
on the `hello/` row as its highlight fades up. The whole reveal is about 1s.
The terminal is the only animated element on the first screen. All of the
animation sits inside `@media (prefers-reduced-motion: no-preference)`, so
visitors with reduced motion get the finished state immediately. The eclipse
is static.

### Accessibility

- The terminal is a `<figure>` whose `<figcaption>` reads "What
  `npm create b4-app` scaffolds" and is visually hidden; the visible strip
  label stays "terminal".
- The tree is a nested `<ul>`. Box-drawing glyphs are `aria-hidden`; each note
  is a text span, so a screen reader hears "src/app/hello/, the agent".
- Notes use `--color-panel-dim` (7.4:1 on panel). The `hello/` link has the
  global `:focus-visible` ring and an underline on hover and focus. The link is
  not marked by colour alone: it also has the `●` marker and the "↓" note.
- Both circles are `aria-hidden` and carry no information by themselves.

### UI/UX Pro Max guidance applied

Searches run against the skill's database (`ux`, `landing`, `gsap`, and the
`nextjs` stack) shaped these choices:

- Reduced motion (high severity): the finished state renders by default, and
  motion is opt-in through `prefers-reduced-motion: no-preference`.
- Excessive motion (high severity): at most one or two animated elements per
  view. The terminal reveal is the only motion on the first screen, and the
  eclipse is static.
- Stagger lists: 250–350ms per item, with the delay between items well under
  100ms (the reason the first draft's 110ms stagger came down to 60ms).
- Overflow hidden (medium severity): blanket overflow clipping can hide content,
  so the clip is scoped to the hero.
- Next.js, keep client components as leaves: the terminal is a server component
  and needs no `"use client"`.

The skill's `--design-system` output proposed a navy and gold palette with
Poppins and Open Sans. That was rejected because the Paper Relay brand and the
merged website design system (#799) already set the palette and type.

## Components and data

- `apps/web/app/components/homepage/scaffold-tree.json`: the command, the
  created line, the rows (`path`, `depth`, `note`, optional `href`), and the
  footer command.
- `apps/web/app/components/homepage/scaffold-tree.ts`: typed accessor
  (`server-only`, matching `first-agent-source.ts`).
- `apps/web/app/components/homepage/ScaffoldTerminal.tsx`: a server component
  that renders the figure from that data.
- `DeveloperHome.tsx`: the hero becomes a two-column grid; it gains the
  LangGraph line and `ScaffoldTerminal`, and loses the dot.
- `FirstAgent.tsx`: the eyebrow gains the marker dot.
- `homepage.module.css`: hero grid, eclipse, terminal, reveal keyframes, marker
  styles, and `.dot` removed. All colours come from `var(--color-*)` tokens
  already declared in `tokens.css`; no new tokens.

## Tests

- New `scaffold-tree.test.ts`:
  - Every row path exists under `packages/devkit/templates/app-basic`, either as
    written or with a `.template` suffix.
  - The created line matches the `✔ Created ${appName} (${options.template}
    template)` string in `packages/create-b4-app/src/index.ts`, with
    `my-agent`/`basic` substituted.
  - Each command in the footer appears in that file's `basicSteps`.
- `homepage.test.tsx` additions: the hero contains the LangGraph line; every
  tree row is rendered; the `hello/` row links to `#first-agent`; no `.dot`
  element remains.
- The existing design-system guard test must still pass (no raw hex values, no
  `rounded-*` or `shadow-*` utilities, no undeclared `var(--color-*)`).

## Verification

Before calling it done:

- `pnpm --dir apps/web test` and typecheck pass.
- Visual check at 375, 768, 1024 and 1440px (the skill's pre-delivery
  breakpoints), both with and without reduced motion.
- The page has no horizontal scroll at 375px.
- axe reports no new violations.
- `pnpm --dir apps/web seo:lastmod` is regenerated after the content commit.

No changeset: `@b4run/web` is not published.

## Out of scope

The walkthrough, the six chapters, page length, and in-page navigation. The
audit flagged these; each is its own follow-up.

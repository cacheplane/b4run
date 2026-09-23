# Newcomer onboarding: basic template, Getting Started, homepage

Approved by Brian on 2026-09-22.

## Audience

A TypeScript developer who wants to learn how to build agents. The first
thing they run is the basic template, and the first page they read is
Getting Started.

## Constraints

- The homepage hero copy does not change.
- Copy follows Brian's 2018–2024 posts. Use short declarative sentences and
  "we", "let's" and "you". Introduce code with a colon. Don't use em dashes,
  hype words or "not X but Y".
- The homepage stays succinct and accurate. Visible copy carries no SHAs,
  versions or commit hashes.
- There is one Getting Started guide, with no separate Quickstart. The
  research assistant becomes a recipe.

## PR 1: simplify the basic template

The template becomes `src/app/hello/` with `index.ts`, `tools/greet.ts` and
`evals/smoke.eval.ts`. The route has no route group, no dynamic segment and
no `state.ts`. `b4.config.ts` uses `config({})` from `@b4run/cli`.
`test/agent.test.ts` targets `/hello#agent` and stays offline.
`auth.ts.example` and `thread-access.ts.example` stay.

```ts
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  systemPrompt: "You are a friendly assistant. Use greet to greet people by name.",
})
```

```ts
/** Greet someone by name. */
export default async (input: { readonly name: string }) => {
  return { message: `Hello, ${input.name}!` }
}
```

Update every test, fixture and harness that assumes the scaffold produces
`/hello/[tenant]`. Tests and fixtures that exercise dynamic segments or
route groups for their own sake keep their own apps. The PR adds a patch
changeset.

## PR 2: Getting Started, the recipe and the homepage

This PR is held as a draft until a release ships PR 1, because
`npm create b4-app@latest` has to produce the template the guide describes.

**Getting Started** (`/docs/getting-started`, same URL). It builds on the
basic template, takes about five minutes and has the reader write code:

- Create the app: `npm create b4-app@latest my-agent -- --template basic`.
- Look at the agent. The folder is the route and `tools/` holds its tools.
- Add a tool, `tools/getLocalTime.ts`. It takes `{ timeZone: string }` and
  uses `Intl`, so it needs no network.
- Check the app with `npx b4 check`.
- Run the agent with `b4 run` and a real key. One prompt calls both tools.
  The page states exactly how the key is loaded.
- Test offline with `npm test`.
- Next steps link to the research recipe, Tools, Routes and Deployment.

**Recipe: Build a Research Assistant** (`/docs/recipes/research-assistant`).
It takes the current Getting Started content with these fixes:

- The config sample uses `config()`.
- The run step works without `jq`.
- The file tree follows the first concept, and it is shorter.

Register the new page in nav, a page wrapper, the SEO registry, the nav test
fixture, `check-docs` and the lastmod manifest.

**Homepage** (`app/components/homepage`):

- The hero copy stays. A `CopyCommand` for the basic template and a
  "Get started →" link go under it.
- A first-agent section shows the template's `index.ts` and `tools/greet.ts`
  with one sentence and a Tools → link. A test keeps the panels equal to the
  template files.
- The recorded repair moves above the code-fixer chapters and is open by
  default, with one link to the example. The runbook link goes.
- The code-fixer chapters read from one pinned source commit.
- The Get started section links to Getting Started and `b4 add code-fixer`.
- Internal links use →. Off-site links use ↗ and open in a new tab.
- The footer Examples link points to `examples/` on GitHub.
- The hero eyebrow no longer shifts layout when the font loads (CLS 0).
  Headings use `text-wrap: balance`.

Verify with vitest, tsc, lint, check-docs, the k8s docs-policy test,
Playwright screenshots at 390, 768 and 1440 px, CLS with delayed fonts and
axe.

## PR 3: code-fixer blueprint at 0.10.0

Requalify the example against published 0.10.0 with the procedure in
`docs/superpowers/runbooks/2026-09-15-code-fixer-standalone-qualification.md`:

- Run the archive install, `check`, `build`, `typecheck` and `npm test`.
- Run `eval:replay` and `test:sandbox` in Docker.
- Run the publication-path scaffold from `create-b4-app@0.10.0`.

Update the blueprint's source commit and release, the blueprint tests and
the runbook. The guide still removes the `(public)/hello/` route, because the
pinned 0.10.0 scaffold generates it.

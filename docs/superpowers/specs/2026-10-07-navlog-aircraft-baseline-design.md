# navlog aircraft baseline in `workspace/` — design

This is the independent first step of navlog's move to per-visitor memory. See the principal resolver
spec, `2026-10-07-app-principal-resolver-design.md` §7.1 (cacheplane/b4run#970). Decided with Brian
on 2026-10-07.

## 1. Decisions

- **The baseline moves into a workspace file.** It becomes `workspace/aircraft/c172n.md`, a
  read-only reference document in the same form as `poh/` and `regs/`. Memory then holds only what
  a pilot said, which is what per-visitor memory needs.
- **One demo aircraft, tail N734ST.** It has long-range tanks (50 gal usable) and cruises at 2400
  RPM.
  - N738ZU stays what it is today, the tail a pilot *teaches* in the memory scenario ("My airplane
    is N738ZU…").
  - 50 gal keeps every scripted eval, docs and brand number unchanged (for example 44.5 gal at
    landing).
- **The agent reads it with `readDoc`**, alongside `recall`. It isn't injected into the prompt and
  isn't a code default.
- **The reference corpus becomes read-only.** That covers `AGENTS.md`, `aircraft/`, `poh/` and
  `regs/`. The workspace is one host directory shared by every visitor, and permission path gates
  cover only paths *outside* `workspace/`. Today any visitor can get the agent to overwrite the POH
  tables or `AGENTS.md` for everyone, and a new baseline file would inherit that hole.
- **Memory scope doesn't change here.** Per-visitor scope and `writes: "auto"` wait for the
  resolver (PR 2 of #970).

## 2. The baseline file

`examples/navlog/server/workspace/aircraft/c172n.md`, mirrored in
`packages/devkit/templates/app-navlog/server/workspace/aircraft/c172n.md`.

```markdown
# Demo aircraft: N734ST

The aircraft this planner assumes when the pilot has not said otherwise. What the pilot says in
the request wins; then what this pilot asked the planner to remember; then this file.

| Item | Value | Source |
|---|---|---|
| Tail number | N734ST | Demo aircraft |
| Type | Cessna 172N (1978) | Demo aircraft |
| Tanks | Long range | Demo aircraft |
| Usable fuel | 50 US gal | [poh/weights-and-fuel.md] (standard tanks: 40 US gal) |
| Cruise power | 2400 RPM | Demo aircraft |
| Start, taxi and takeoff | 1.1 US gal | [poh/time-fuel-distance-to-climb.md, Figure 5-6] |
| Reserve | 45 min at planned cruise burn | [regs/vfr-fuel-reserves.md] |

"Full tanks" means all usable fuel. A pilot who says "standard tanks" has 40 US gal usable.
```

The exact wording is settled in the plan. The numbers in this table are fixed.

## 3. How the agent uses it

- **`readDoc`** (`src/tools/readDoc.ts`, both copies): `ROOTS` gains `"aircraft/"`. The doc comment
  and error message list it.
- **System prompt** (`src/app/navlog/index.ts`, both copies). Step 1 becomes:

  > Start by calling `readDoc({ path: "aircraft/c172n.md" })` and
  > `recall({ query: "pilot aircraft overrides and preferences" })` together. The baseline file is
  > the demo aircraft. A recalled fact overrides it, and what the pilot says in the request
  > overrides both. Don't stop to ask for anything the three leave open: use the baseline and list
  > each baseline value you relied on under Assumptions. When the pilot states aircraft facts or
  > preferences, `remember` them.

  The inline "POH defaults (usable fuel 40 gal … cruise 2400 RPM)" sentence leaves the prompt. The
  Assumptions bullet changes from "any POH default you used for usable fuel or cruise RPM" to "any
  baseline value you used (tail, usable fuel, cruise RPM)". Everything else in the prompt is
  unchanged.
- **`memory.md`** (both copies): the aircraft profile no longer "lives in long-term memory". The
  baseline lives in `aircraft/c172n.md`, and memory holds what this pilot stated (`subject:
  aircraft`, the same predicates) and their preferences.
- **`plan.md`** (both copies): the first todo becomes "Read the aircraft baseline, recall the
  pilot's overrides, and parse the route, altitude and departure time".
- **`workspace/AGENTS.md`** (both copies): the header changes from "the agent updates it with
  `writeFile`" to a read-only house-style note. The house-style bullets don't change.

## 4. Read-only reference corpus

A filesystem middleware, `readOnlyPaths`, is defined in navlog's own source as
`src/lib/read-only-paths.ts`. It isn't a framework export, because it's an app policy.

```ts
import type { FilesystemBackend, FilesystemMiddleware } from "@b4run/workspace"

/** Workspace-relative paths the agent may read but never change. A trailing "/" protects a tree. */
export function readOnlyPaths(protectedPaths: readonly string[]): FilesystemMiddleware
```

- **Matching.** Backend methods receive an already-resolved absolute path inside
  `ctx.workspaceRoot`; the capability has done the jail. The middleware matches on
  `relative(ctx.workspaceRoot, path)`, with POSIX separators. A `"dir/"` entry protects `dir`
  itself and everything under it. Any other entry protects that exact file. So `poh2/x.md` and
  `reports/AGENTS.md` are not protected.
- **Refused:** `writeFile`, `removeFile`, `touchFile` and `mkdir` on a protected path. The error
  reads: `"<rel> is read-only reference material in this app; write reports under reports/"`.
  `editFile` reaches the backend as a `readFile` plus a `writeFile`, so it's refused at the write.
- **Forwarded unchanged:** every other method, both required (`readFile`, `listDir`, `realPath`) and
  optional (`lstat`, `readBinaryFile`, `readBinaryFiles`, `statFile`, `walkTree`). Optional methods
  are forwarded only when `next` has them (conditional spread, as `workspace.mdx` requires). An
  optional mutator the base lacks stays absent rather than becoming a stub.
- **Wiring** (`b4.config.ts`, both copies):

  ```ts
  backends: {
    filesystem: compose(readOnlyPaths(["AGENTS.md", "aircraft/", "poh/", "regs/"]))(localFilesystem()),
  },
  ```

  This is the first app in the repo to set `backends.filesystem`. navlog builds only the `node`
  target, so the edge-target refusal (`edge-capabilities.ts:131`) doesn't apply. The plan's first
  task verifies that `b4 dev`, `b4 start`, the `.b4/build` server and `main.mjs` all honor it,
  the way they already honor the live `memory.store` object. If `main.mjs` doesn't pass config
  backends through `serve()`, that's fixed in the same PR.
- **Dependency.** The example and the template gain `@b4run/workspace` (`workspace:*` in the
  example; the template's `package.json.template` pin follows the other `@b4run/*` entries). This
  re-keys `pnpm-lock.yaml`. Rebase on fresh main right before merge.
- **Known mismatch (resolved).** The built-in agents-md capability told the model it may
  `writeFile({ path: "AGENTS.md" })`, a call this guard refuses. #978 added
  `agentsMd: { writable: false }`, and navlog sets it, so the injected header no longer invites
  the write.

## 5. Every place it lands

| Area | Change |
|---|---|
| `examples/navlog/server` | workspace file, `readDoc`, prompt, `memory.md`, `plan.md`, `AGENTS.md`, `b4.config.ts`, `src/lib/read-only-paths.ts`, `package.json` |
| `packages/devkit/templates/app-navlog/server` | The same, as template files (`.template` suffix where the existing file has one) |
| `navlog-quality.eval.ts` (+ `.template`) | `PROFILE` becomes the new recall query, a `readDoc({ path: "aircraft/c172n.md" })` step is added before `recall` in the parent script, the first todo text changes, and every existing case names N738ZU in its input and keeps it. A new case, *plan on the baseline aircraft*, names no aircraft and asserts `computeNavlog` ran on N734ST |
| `test/generated/run-generated-navlog-activation.test.ts` | The pinned recall query, first todo and step label; no `readDoc` step, because a new root call would shift its positional call ids |
| `examples/navlog/web` tests (+ templates) quoting the recall text (`VerdictCard.test.tsx`, `assistant-text.test.ts`) | Unchanged: they feed the old recall text to a sanitizer as arbitrary echoed text |
| `apps/web/content/docs/recipes/flight-planner.mdx` | Baseline file, read-only corpus, and the recall query |
| `apps/web/content/docs/workspace.mdx` | The navlog tree gains `aircraft/`; a note that this app guards the corpus with a filesystem middleware, linked from the Middleware section |
| `apps/web/app/seo/lastmod.generated.json` | Regenerated after the content commit |
| `.changeset/` | A patch changeset for `@b4run/devkit` (the scaffold changed) |

N738ZU references in the docs, brand demo and `apps/web/content/templates/AGENTS.md` are the
teach scenario or generic `computeNavlog` examples, and they stay. The plan checks each one.

## 6. Testing

- **`test/read-only-paths.test.ts`** (new):
  - Each refused method is refused for each protected entry.
  - `reports/x.md`, `tool-outputs/x`, `poh2/x.md` and `reports/AGENTS.md` pass through.
  - Exact-file vs. tree matching.
  - Reads of protected paths pass.
  - Optional methods are forwarded when present and absent when the base lacks them.
  - An error message names the path.
- **`test/corpus-sync.test.ts`:** asserts the baseline's usable fuel (50 long range, 40 standard)
  matches `poh/weights-and-fuel.md`, and the 1.1 gal matches `time-fuel-distance-to-climb.md`.
- **`test/read-doc.test.ts`:** `aircraft/c172n.md` is readable, and `aircraft/../poh` is refused.
- **An integration test through the real workspace capability:** a `writeFile` tool call to
  `poh/cruise-performance.md` returns the read-only error, and the file is unchanged.
- **Eval replay** (`navlog-quality`) green, keyless.
- **The generated navlog activation lane**, for the template.
- Then `pnpm ci:validate`'s lanes, as usual.

## 7. Out of scope

- Per-visitor memory scope, `writes: "auto"`, and removing the owner review flow. These follow #970
  PR 2.
- A semantic-memory TTL and per-namespace write caps. Both are prerequisites for auto writes on the
  live demo (#970 §7.1).
- A framework-level read-only workspace option.

# Activity kit for Angular, and the CopilotKit Angular connector — design

Sub-project 3 of the activity-components arc (`2026-10-03-b4-activity-components-design.md`,
§1 decisions 3, 6 and 7, §6, §8, §9 item 3). Sub-projects 1, 2a, 2b-restore and 2b-adopt are
merged. Decided on 2026-10-07 from the arc's standing decisions and the research recorded
below; the arc spec governs anything not restated here.

## 1. Decisions

- **Package:** `@b4run/ag-ui-angular`, a new workspace package at `packages/ag-ui-angular`.
  Entries: `.` (the components), `./copilotkit` (the CopilotKit Angular connector) and
  `./styles.css` (re-exports the shared sheet). It depends on `@b4run/ag-ui` (view core and
  the stylesheet); Angular, `@angular/cdk`, `@copilotkit/angular` and `rxjs` are peers.
- **Angular 22** (current stable 22.2). Built with **ng-packagr 22** in partial-compilation
  mode, so apps on Angular 22 and later link it.
- **TypeScript 6.0.x in this package only.** Angular's compiler (`@angular/compiler-cli`,
  `ng-packagr`) supports `typescript >=6.0 <6.1`; the repo is on TypeScript 7. The package
  pins its own `typescript` devDependency, the way `packages/core` pins TypeScript 6 for its
  API use. Turbo runs each package's own scripts, so nothing else changes.
- **Same DOM, same sheet.** Every Angular component renders the DOM contract of the arc spec
  §5.6 exactly as the React component does. There is one stylesheet,
  `@b4run/ag-ui/react/styles.css`, under `@layer b4-activity`; `./styles.css` re-exports it.
- **Parity is a test, not a promise.** Shared fixtures (`TurnView`s and `ApprovalView`s)
  render through both kits; a contract serializer keeps the §5.6 classes and the `data-*`
  and `aria-*` attributes and the visible text; the serialized React and Angular output must
  be equal for every fixture.
- **Signals and standalone components.** Inputs are `input()` signals; outputs are
  `output()`; no NgModules. Open/closed state follows the same rules as the React kit
  (`useDisclosure(autoOpen, live, resetKey)`), as a small injectable-free helper.
- **CopilotKit Angular connector** (`./copilotkit`), on `@copilotkit/angular` 0.5.x:
  - `B4ActivityStore` — an injectable created per chat (`provideB4Activity({ agentId?, labels?, hiddenTools?, renderStep? })`) that subscribes to the agent from `injectAgentStore(agentId)` with `agent.subscribe({ onEvent })` and folds `reduceTurns` into a `turns` signal; it uses each event's `timestamp` when present, as the React connector does. `markResuming()` and `clearResuming()` as in React.
  - `<b4-activity-assistant-message>` — a component given to `CopilotChat` as the assistant message component: it renders the message's markdown through CopilotKit's own assistant message and, for the turn that message closes, one `<b4-turn-activity>`. Tool-only assistant messages render nothing (Angular has no `transformMessages`; the per-turn grouping lives here, using the same turn lookup as React's `mergeTurnMessages`).
  - Approvals: `injectInterrupt` drives one `<b4-approval-card>` per parked interrupt, with `markResuming()` before `resolve`/`cancel` and `clearResuming()` on failure; grants `"off"` only, like React.
  - `renderStep` takes a map of tool name → Angular component type, rendered with `NgComponentOutlet` and given the step as input.
- **Version alignment first.** `@copilotkit/angular` 0.5.3 is built on `@ag-ui/*` 1.0.2 and `@copilotkit/core` 1.77.1. B4 moves its pins to `@ag-ui/*` 1.0.2 and CopilotKit 1.77.1 (react-core, runtime) in its own PR before the connector lands, so one `@ag-ui/core` is in the tree.
- **Private until npm is ready.** The package ships `"private": true` and joins the release train in a follow-up, after Brian creates the npm name under the `@b4run` org and adds its trusted publisher (`cacheplane/b4run`, `release.yml`). The release controller's preflight runs `npm trust list` for every canonical package, so adding it earlier would block releases. Everything else (build, typecheck, lint, tests, docs page) lands now.
- **No new example app.** The connector is proven with component tests against a fake agent (the React connector's approach) and one Playwright host test that renders the connector in a minimal Angular test page built from fixtures. An Angular navlog example is out of scope; sub-project 4 dogfoods the navlog backend in threadplane's chat instead.

## 2. Components

The Angular kit mirrors `@b4run/ag-ui/react` one to one: `b4-turn-activity` (`TurnActivity`),
`b4-step`, `b4-step-group`, `b4-step-detail`, `b4-plan-step`, `b4-reasoning-step`,
`b4-subagent-step`, `b4-approval-card`, `b4-source-chips`, `b4-disclosure`, `b4-step-icon`,
plus the pure helpers re-used from the view core (`stepLabel`, `groupSteps`,
`summaryLine` and duration formatting move to `@b4run/ag-ui/view` if they live in `./react`
today, so both kits import one implementation). Component selectors are elements; the host
element uses `display: contents` so the contract DOM is what the sheet styles.

## 3. Testing

- **Component tests:** vitest with `@analogjs/vitest-angular` and jsdom, one spec per
  component, ported from the React tests.
- **Parity:** `packages/ag-ui/test/fixtures/activity-fixtures.ts` (shared fixtures) and a
  contract serializer; a React test and an Angular test each serialize every fixture and
  compare to one committed snapshot file, so a divergence fails the side that moved.
- **Stylesheet coverage:** the styles test that checks every class the React kit emits has a
  rule, and the sheet has no class the kit does not emit, also reads the Angular templates.
- **Accessibility:** axe (`axe-core`) on every fixture in the Angular component tests, zero
  serious or critical violations; keyboard toggles covered by component tests.
- **Connector:** a fake `AbstractAgent` drives live, replayed (timestamped) and parked
  streams; tests assert the turns signal, the per-turn rendering on the assistant message,
  the approval card, and resolve/cancel with resuming.
- **Host:** one Playwright test against a minimal Angular page (built with Angular's
  application builder in the package's test setup) rendering `CopilotChat` with the
  connector and a replayed run, asserting the contract DOM.

## 4. Rollout

1. **Pins:** `@ag-ui/*` 1.0.2 and CopilotKit 1.77.1 across the repo (packages, examples,
   templates, generated-app pins, harness), changeset.
2. **Angular kit:** the package (private), components, shared fixtures and parity, styles
   coverage, axe, docs page `/docs/api/ag-ui-angular` and registry entries that do not
   require publishing, the AGENTS.md workspace map, changeset for any `@b4run/ag-ui` moves.
3. **CopilotKit Angular connector:** `./copilotkit`, its tests and the host test, docs.
4. **Follow-up (needs Brian):** npm name and trusted publisher, then the release-train PR
   (fixed group, release manifest order, content pins, pack and published-artifact checks).

## 5. Out of scope

- threadplane (sub-project 4).
- An Angular navlog example.
- Angular versions before 22.

## Amendment, 2026-10-08: one package

Decided by Brian: there is one `@b4run/ag-ui` package with a folder per framework, not a
separate Angular package. This replaces the "Package" and "Private until npm is ready"
decisions above and the arc spec's decision 6.

| Subpath | Contents |
|---|---|
| `@b4run/ag-ui/react` | React kit |
| `@b4run/ag-ui/react/copilotkit` | React CopilotKit connector (was `./copilotkit`) |
| `@b4run/ag-ui/angular` | Angular kit |
| `@b4run/ag-ui/angular/events` | Angular host-agnostic connector |
| `@b4run/ag-ui/angular/copilotkit` | Angular CopilotKit connector |
| `@b4run/ag-ui/styles.css` | The one stylesheet (was `./react/styles.css`) |
| `.`, `./sse`, `./client`, `./view`, `./copilotkit-runtime` | Unchanged |

- The Angular sources live in `packages/ag-ui/src/angular/**` and are compiled by Angular's
  compiler in partial mode during the package build, under TypeScript 6.0.x (Angular's
  compiler requires it); the rest of the package keeps its current compiler.
- Angular packages and `@copilotkit/angular` are optional peers of `@b4run/ag-ui`, as React
  and `@copilotkit/react-core` are.
- `packages/ag-ui-angular` is removed. The `@b4run/ag-ui-angular@0.0.0` name reservation on
  npm is deprecated with a pointer to `@b4run/ag-ui/angular`; it never joins the release
  train.
- The renames are breaking (0.x patch on the fixed group, upgrading entry).

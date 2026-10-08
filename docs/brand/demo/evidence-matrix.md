# Root README claim-evidence matrix

This is the source-of-truth review for material claims planned for the root
README. `keep` means the claim can be stated within the recorded boundary;
`qualify` means that boundary must accompany it; `remove` means it should not
appear without new evidence. The matrix intentionally contains no benchmark,
popularity, adoption, or quantitative code-reduction claims.

### Drift-control legend

- **A — automated merge gate:** the `validate` job in
  `.github/workflows/ci.yml`, principally `pnpm test`,
  `pnpm verify:harness:framework`, and `node scripts/check-docs.mjs`. Each row
  names the owning file/test and, where useful, a reproducible targeted command;
  those package tests also run through `validate`'s `pnpm test`.
- **G — gated CI lane:** a separately named `.github/workflows/ci.yml` job that
  needs Docker, credentials, or dedicated infrastructure. The row gives the
  job and its exact test command.
- **M — manual pre-publication observation:** the README/release owner reruns
  the exact command in this file whenever root README copy will describe
  `npm create ...@latest` or when a new npm `latest` is published. The owner
  replaces the dated receipt under [Clean-room activation
  observation](#clean-room-activation-observation); the retained output is
  this checked-in section, reviewed in the same change.

## Claims

| Claim | Code/test/doc evidence | Conditionality | Drift control | Disposition |
| --- | --- | --- | --- | --- |
| B4.run is a TypeScript meta-framework for LangGraph.js. | `apps/web/content/docs/mental-model.mdx` defines the boundary; `packages/langchain/src/agent-adapter.ts` materializes `agent()` descriptors with `@langchain/langgraph/prebuilt`; `packages/langgraph/src/langgraph-adapter.ts` executes raw graph/workflow entries; `packages/langchain/package.json` carries the LangGraph runtime dependency. | Category description, not a claim that B4.run replaces LangGraph.js or supports its Python runtime. | A: `pnpm --filter @b4run/langchain test`, `pnpm --filter @b4run/langgraph test`, and `node scripts/check-docs.mjs`. | keep |
| “Build LangGraph agents like Next.js apps” describes B4.run's file-system convention. | `apps/web/content/docs/routes.mdx` documents App-Router-style groups and dynamic segments; `packages/core/test/discover-routes.test.ts` tests “strips route groups from pathnames” and “preserves dynamic segments in pathnames.” | An analogy about project and route conventions. B4.run is not a Next.js plugin, and the B4.run server does not require Next.js. | A: `pnpm --filter @b4run/core test` (`discover-routes.test.ts`) and `node scripts/check-docs.mjs`. | qualify |
| Folders under `src/app/` become file-system routes. | `packages/core/test/discover-routes.test.ts` tests workflow, graph, and agent discovery from `index.ts`; `apps/web/content/docs/routes.mdx` documents pathname rules. | An `index.ts` must export exactly one supported entry shape; route groups are omitted, dynamic segments remain parameterized, and private segments are skipped. | A: `pnpm --filter @b4run/core test` (`discover-routes.test.ts`) and `node scripts/check-docs.mjs`. | keep |
| The navlog starter's agent identity is `/navlog#agent`. | `packages/devkit/templates/app-navlog/server/src/app/navlog/index.ts` default-exports `agent()`; `packages/devkit/templates/app-navlog/web/app/api/copilotkit/[...path]/route.ts` addresses the AG-UI route as `/navlog#agent`; `test/generated/run-generated-navlog-activation.test.ts` tests “activates the navlog scaffold (--template navlog) through the complete npm lifecycle.” | `#agent` selects the entry kind. The pathname alone is `/navlog`. | A: `pnpm verify:harness:framework` (`run-generated-navlog-activation.test.ts`) and `pnpm --filter create-b4-app test`. | keep |
| B4.run supports shared tools in `src/tools/`. | `packages/core/src/compiler/analyze-route-tools.ts` reads the configured shared tools directory; `packages/core/test/extract-tool-types.test.ts` tests “merges shared and route-local tools”; the navlog starter contains `server/src/tools/computeNavlog.ts`. | Shared authored tools remain subject to tool policy and runtime constraints. | A: `pnpm --filter @b4run/core test` (`extract-tool-types.test.ts`) and `pnpm --filter create-b4-app test` (“scaffolds external mode…”). | keep |
| B4.run supports route-local tools in a route's `tools/` directory. | `packages/core/src/compiler/analyze-route-tools.ts` reads `<routeDir>/tools`; `packages/core/test/extract-tool-types.test.ts` tests merging and “route-local tools shadow shared tools of the same name”; `packages/cli/test/test-command.test.ts` tests a route-local mock alongside a real shared tool. | The default research starter demonstrates shared tools, not route-local tools. Do not depict `server/src/app/research/tools/*` as generated starter content. | A: `pnpm --filter @b4run/core test` (`extract-tool-types.test.ts`) and `pnpm --filter @b4run/cli test test-command`. | qualify |
| B4.run generates TypeScript route, route-parameter, state, and tool types. | `packages/core/test/render-route-types.test.ts` tests exact `b4:routes` exports, route params, tools, and optional state exports; `packages/cli/test/run-typegen.test.ts` tests “writes types and schemas from one combined route analysis”; `packages/cli/test/typegen-command.test.ts` tests writing generated route types. | State exports exist only when discoverable state supplies valid defaults; declarations are compile-time artifacts regenerated by typegen/build. | A: `pnpm --filter @b4run/core test` and `pnpm --filter @b4run/cli test run-typegen typegen-command`. | keep |
| The starter's normal test path is deterministic and fixture-backed. | `packages/devkit/templates/app-navlog/server/test/navlog.test.ts.template` runs `computeNavlog` (from `src/lib/navlog.ts`) under vitest with inline inputs and no model call (the navlog server tests do not use `createAgentHarness()`); `packages/testing/test/fixture-file-e2e.test.ts` tests committed-fixture replay; `apps/web/content/docs/testing-agents/fixtures.mdx` states unmatched replay fails instead of falling through to a provider. | Applies to replay/fixture paths. `--live`, recording modes, and explicitly injected provider calls are not offline claims. | A: `pnpm --filter @b4run/testing test` (`fixture-file-e2e.test.ts`) and `pnpm verify:harness:framework` (generated starter `npm test`). | keep |
| `npm test` in the basic starter runs its fixture-backed test offline, with no API key and no model calls. | `packages/devkit/templates/app-basic/package.json.template` defines `"test": "vitest run"`; `packages/devkit/templates/app-basic/test/agent.test.ts.template` drives `/hello#agent` through `createAgentHarness()` with a scripted `script().user(...).replies(...)` fixture, so the model turn is replayed; `packages/testing/test/fixture-file-e2e.test.ts` tests that replay fails on an unmatched interaction instead of calling a provider; `packages/create-b4-app/test/create-app.test.ts` asserts the basic scaffold's `test` script, its `test/agent.test.ts`, and the printed `npm test  # offline tests — no API key needed` step. | Applies to the scaffolded starter as generated. A test a user adds that calls a live provider is not covered. The dated clean-room observation below predates the basic template and is historical; the root README no longer cites it. | A: `pnpm --filter create-b4-app test`, `pnpm --filter @b4run/devkit test` (`generated-app.test.ts`), and `pnpm --filter @b4run/testing test` (`fixture-file-e2e.test.ts`). | keep |
| The Workbench can restore a checkpoint-backed conversation after a browser reload while the server stays running. | `packages/devkit/templates/app-navlog/web/app/api/copilotkit/[...path]/route.test.ts.template` tests “connect replays the thread with the visitor id from the cookie, and the token when deployed” and “connecting to a thread the server does not know is an empty stream, not an error”; `packages/ag-ui/test/copilotkit-runtime` tests the `createB4AgentRunner` replay of `GET /threads/:id/events`; `apps/web/content/docs/ag-ui.mdx` documents restoring a conversation after a reload. | Browser storage retains the rail entry; the runtime route's runner (`createB4AgentRunner`) replays the server checkpoint as AG-UI events (messages, turns, tool results with media, a parked approval). Notices for parts the model never saw are stream-only and do not return. The server must remain available. | A: `pnpm verify:harness:framework`; its generated starter `npm test` executes the route test, and `pnpm --filter @b4run/ag-ui test` runs the runner tests. | qualify |
| Default SQLite-backed state can survive a `b4 dev` process restart. | `packages/testing/test/restart-persistence.test.ts` tests “persists thread state across a real b4 dev process restart (Layer C)” with two processes against one app root; `packages/sqlite-storage/test/threads.test.ts` tests metadata surviving a fresh store instance. | Requires the same persistent app root and SQLite files. It does not imply survival of filesystem loss, container/Pod replacement, or multi-replica coordination; `apps/web/content/docs/deployment/kubernetes.mdx` says chart-local `.b4` data is ephemeral across Pod replacement. | A: `pnpm --filter @b4run/testing test restart-persistence`, `pnpm --filter @b4run/sqlite-storage test`, and `node scripts/check-docs.mjs`. | qualify |
| The default build emits a runnable Node server, Dockerfile, and LangSmith graph artifacts. | `packages/cli/test/build-targets.test.ts` tests “default targets emit both the node bundle and the langsmith config,” asserting `.b4/build/server.mjs`, a hardened `Dockerfile`, and `.b4/build/langgraph.json`; `test/generated/run-generated-research-activation.test.ts` then runs generated `npm start`, waits for health, completes an AG-UI turn, and verifies the report output. | Node is B4.run's Agent Protocol/AG-UI HTTP runtime. LangSmith receives generated graph entries and uses its platform envelope; it is not the B4.run HTTP server. | A: `pnpm --filter @b4run/cli test build-targets` plus `pnpm verify:harness:framework` (`run-generated-research-activation.test.ts`). | keep |
| Hono is an opt-in edge build target. | `apps/web/content/docs/deployment.mdx` lists artifacts and the capability gate; `packages/cli/test/build-targets.test.ts` covers target selection; `packages/cli/test/hono-node-roundtrip.test.ts` is the validate job's Docker-backed, Node-hosted emitted-app/Postgres round trip; `packages/cli/test/workerd-lane.test.ts` is the separate real-workerd proof. | Filesystem, shell, workspace, skills, long-term memory, and sandbox surfaces are gated. Node-hosted and local workerd evidence is not a claim about a live provider deployment. | A: `B4_REQUIRE_DOCKER=1 pnpm test` in `validate`. G: `edge-workerd` runs `B4_TEST_WORKERD=1 pnpm --filter @b4run/cli test workerd-lane --reporter=default --reporter=json` and asserts zero skips. | qualify |
| Vercel is an opt-in build/deployment target. | `packages/cli/test/build-targets.test.ts` tests “vercel target is opt-in and leaves the default targets unchanged” and combination with Node/LangSmith; `.github/workflows/ci.yml` contains the credentialed native Vercel deployment and cleanup job. | Not a default target. Production confidence depends on the credentialed lane; local artifact tests alone do not prove a live deployment. | A: `pnpm --filter @b4run/cli test build-targets`. G: `vercel-native` runs `pnpm --filter @b4run/cli test vercel-native-lane.test.ts --reporter=json`, then cleanup and `--assert-receipt`. | qualify |
| Kubernetes deployment uses the generated Node image plus B4.run's Helm chart. | `apps/web/content/docs/deployment/kubernetes.mdx` says to build the Node image first; `charts/b4-app/README.md` says the chart runs, but does not build, that image; `.github/workflows/ci.yml` defines chart validation and kind smoke lanes. | The chart does not provision secrets, make SQLite durable, or translate `b4.config.ts`. Sandbox infrastructure is a separate chart and gated lane. | G: `chart-validate` runs strict Helm lint, chart render scripts, and kubeconform; `chart-apply-smoke` installs `charts/b4-app` into kind and curls the Service. | qualify |
| The current research starter (`--template research`) is a two-package npm workspace with a B4.run server and Workbench web app. | `packages/create-b4-app/src/index.ts` initializes `template = "basic"`, so current source selects research only with `--template research`; `packages/devkit/templates/app-research/package.json.template` declares `server` and `web`; `packages/create-b4-app/test/create-app.test.ts` “scaffolds external mode…” asserts root/server/web manifests plus the research route, state, plan, tools, subagent, skills, eval, test, and corpus. | Current checked-in 0.8.22 source. Published `latest` resolved to 0.8.21 and generated the earlier single-package research shape. Do not attribute the two-workspace tree to `@latest` until published and reverified. | A: `pnpm --filter create-b4-app test` and `pnpm verify:harness:framework`. M: after publishing, rerun the sanitized clean room below before calling this the `@latest` shape. | qualify |
| The current research starter uses server port 3002 and Workbench port 3010. | `packages/devkit/templates/app-research/server/package.json.template` has `b4 dev --port 3002`; `packages/devkit/templates/app-research/web/package.json.template` has `next dev -p 3010`; `packages/create-b4-app/src/index.ts` prints both; `packages/create-b4-app/test/create-app.test.ts` asserts both lines. | Current checked-in source only until published. Verified 0.8.21 `@latest` printed and used a single server on port 3000. | A: `pnpm --filter create-b4-app test` (stdout assertions). M: after publishing, rerun the sanitized clean room and update the version/ports receipt below. | qualify |
| The research starter example uses `gpt-5-mini`. | `packages/devkit/templates/app-research/server/src/app/research/index.ts` and its researcher subagent specify `gpt-5-mini`; `packages/devkit/templates/app-research/server/test/research.test.ts.template` covers the fixture-backed route independently of a live model. | A live run requires provider credentials; the offline fixture test does not call that model. | A: `node scripts/check-docs.mjs` rejects provider-prefixed example ids. M: README author runs `rg -n 'model: "gpt-5-mini"' packages/devkit/templates/app-research/server/src/app/research` and reviews the output in the README change. | keep |
| The canonical activation is `npm create b4-app@latest my-agent`, then `npm install`, then `npm test`. | `packages/create-b4-app/src/index.ts` initializes `template = "basic"` and prints `npm install` then `npm test` as the basic next steps; `packages/create-b4-app/test/create-app.test.ts` asserts that output; `scripts/lib/readme-contracts.mjs` pins the root README's Quickstart block (`CANONICAL_QUICKSTART_BLOCK`). | Network- and registry-dependent: `@latest` resolves whatever npm's dist-tag selects. The root README states no version. | A: `pnpm --filter create-b4-app test` and `node --test scripts/readme-contracts.test.mjs`. | keep |
| In the clean generated 0.8.21 scaffold inspected on 2026-09-01, `npm run build` invoked the TypeScript compiler and the manifest defined no `npm start` script. | The generated scaffold's `package.json` defined `"build": "tsc -p tsconfig.json"` and `"dev": "b4 dev --port 3000"`; inspection of its `scripts` object found no `start`, `dev:server`, or `dev:web` property. | Version- and date-specific manual package inspection. It supports the published 0.8.21 instructions only; `@latest` can move, and current checked-in 0.8.22 source has a different workspace shape and script set. | M: before describing the published scaffold's lifecycle, resolve npm `@latest`, generate it in a clean temporary directory, and inspect its `package.json` scripts. | qualify |
| Node.js 24+ is required; npm 11 is the documented package-manager baseline. | `packages/create-b4-app/src/index.ts` sets `NODE_FLOOR_MAJOR = 24` and documents that Node 24 bundles npm 11, whose resolver the scaffold's dependency graph needs; `packages/create-b4-app/test/node-floor.test.ts` tests rejection below 24 and acceptance at/above it; the basic and navlog manifests declare Node `>=24.0.0`; `apps/web/content/docs/getting-started.mdx`, `apps/web/content/docs/recipes/flight-planner.mdx` and `packages/devkit/templates/app-navlog/README.md` say "Node.js 24 or later and npm 11". | Node 24+ is enforced at scaffold time and by `b4 verify`. npm 11 is documented, not enforced by a version check; the README states it as a requirement because Node 24 ships it. | A: `pnpm --filter create-b4-app test` (`node-floor.test.ts`) and `node --test scripts/readme-contracts.test.mjs` (Quickstart block). | qualify |
| B4.run is pre-1.0, its API surface is moving, and users should pin versions and read release notes. | Public manifests are currently `0.8.22`; `apps/web/content/docs/upgrading.mdx` states the pre-1.0 posture and fixed-group releases; `SECURITY.md` defines support as fixes on the default branch through the normal release process. | “Supported” means documented public surfaces on the current release line, not a 1.0 stability guarantee or long-term-support promise. | A: `pnpm check:release-inventory` and `node scripts/check-docs.mjs`. M: README author compares maturity copy with `apps/web/content/docs/upgrading.mdx` and `SECURITY.md` in the same review. | keep |
| How B4.run fits: LangGraph.js remains the graph runtime; B4.run supplies application conventions around it. | `packages/langgraph/src/langgraph-adapter.ts`, `packages/langchain/src/agent-adapter.ts`, `apps/web/content/docs/mental-model.mdx`, and `apps/web/content/docs/migrating-from-langgraph.mdx` preserve this boundary. | B4.run requires LangGraph.js; it is not a replacement runtime. Raw graphs may need explicit checkpointer invocation adaptation at a target boundary. | A: `pnpm --filter @b4run/langgraph test`, `pnpm --filter @b4run/langchain test`, and `node scripts/check-docs.mjs`. | keep |
| How B4.run fits: LangChain remains usable, and B4.run's built-in `agent()` path uses LangChain integrations. | `packages/langchain/src/agent-adapter.ts` converts tools, creates a chat model, and calls `createReactAgent`; `packages/langchain/package.json` lists provider peers; `apps/web/content/docs/migrating-from-langgraph.mdx` says raw graph/chain routes retain imported packages. | Do not imply every LangChain package/provider is tested by B4.run. Raw routes own their imports and behavior. | A: `pnpm --filter @b4run/langchain test` (`agent-adapter.test.ts`, `chat-model-factory.test.ts`, `model-provider-resolver.test.ts`) and `node scripts/check-docs.mjs`. | qualify |
| How B4.run fits: LangSmith is a separate deployment and observability platform that consumes B4.run's generated artifacts. | `packages/cli/test/build-targets.test.ts` asserts generated `langgraph.json`; `apps/web/content/docs/deployment.mdx` and `apps/web/content/docs/mental-model.mdx` distinguish LangSmith entries from B4.run's HTTP runtime. | B4.run does not provision or host LangSmith; local Node protocol behavior is not evidence of the LangSmith envelope. | A: `pnpm --filter @b4run/cli test build-targets` and `node scripts/check-docs.mjs`. | qualify |
| How B4.run fits: model providers remain external and selectable. | `packages/langchain/src/model-provider-resolver.ts`, `packages/langchain/src/chat-model-factory.ts`, and `packages/langchain/package.json` define the implemented seam; `apps/web/content/docs/migrating-from-langgraph.mdx` distinguishes built-in agents from raw graph/chain ownership. | Built-in aliases depend on mappings and installed peers; raw graph/chain routes can instantiate LangChain-compatible providers. Credentials/provider availability remain the user's responsibility. | A: `pnpm --filter @b4run/langchain test` (`model-provider-resolver.test.ts`, `chat-model-factory.test.ts`) and `node scripts/check-docs.mjs`. | qualify |
| A local Ollama-backed agent route requires no provider API key. | `packages/langchain/src/chat-model-factory.ts` omits an API-key environment variable for `ollama`; `packages/cli/src/lib/verify/check-dependencies.ts` maps `ollama` to `null`; `packages/cli/test/check-dependencies.test.ts` tests “requires no key for an ollama-only app”; `apps/web/content/docs/cli.mdx` documents the same provider-aware preflight behavior. | Keyless means no provider credential is required. The local Ollama service, selected model, and optional `@langchain/ollama` integration must still be installed, reachable, and validated by the application. | A: `pnpm --filter @b4run/cli test check-dependencies` and `pnpm --filter @b4run/langchain test chat-model-factory`. | keep |
| How B4.run fits: CopilotKit composes with B4.run through AG-UI; B4.run remains backend-first. | `examples/chat/web/app/api/copilotkit/[...path]/route.ts` wires a `B4HttpAgent` (an AG-UI `HttpAgent` from `@b4run/ag-ui/client`) to B4.run's AG-UI route; `test/security-dependencies/copilotkit-v2-runtime.test.ts` tests “streams a real B4HttpAgent run across the encoded B4.run AG-UI boundary”; `packages/ag-ui/test/conformance.test.ts` verifies an `HttpAgent` parses the stream. | Evidenced integration, not a claim that B4.run is a general frontend framework or every CopilotKit version is compatible. | A: `pnpm test` covers AG-UI conformance/dependency tests. G: `copilotkit-examples-e2e` runs both `pnpm --filter @b4-example/chat-web test:e2e` and `pnpm --filter @b4-example/research-web test:e2e`. | keep |
| How B4.run fits: Vercel AI SDK can be used inside a B4.run route. | The only checked-in comparison is prose in `apps/web/content/docs/faq.mdx`; there is no dedicated Vercel AI SDK integration fixture or compatibility test. | Generic TypeScript compatibility is not enough evidence for a root README product comparison, and the external surface can drift. | Remove from root README. Reconsider only after adding a maintained fixture/test and current primary-source review in the same change. | remove |
| How B4.run fits: Mastra is broader with its own runtime, while B4.run is narrower around LangGraph.js. | The only checked-in evidence is prose in `apps/web/content/docs/faq.mdx`; no code or compatibility test establishes the competitor characterization. | External-product scope can change, and the repository does not test it. | Remove from root README. Reconsider only after current primary-source review and maintained evidence are added in the same change. | remove |
| When B4.run fits: a TypeScript team wants LangGraph.js plus file-system routes, generated types, a local dev/test loop, persistence primitives, and build targets. | Evidence is distributed across `packages/core/test/discover-routes.test.ts`, `packages/core/test/render-route-types.test.ts`, `packages/cli/test/test-command.test.ts`, `packages/testing/test/restart-persistence.test.ts`, and `packages/cli/test/build-targets.test.ts`. | A fit description, not a guarantee every application needs or can use every capability on every target. | A: `pnpm test`, `pnpm verify:harness:framework`, and `node scripts/check-docs.mjs`; README review must preserve the qualifications from the component rows above. | qualify |
| When B4.run does not fit: projects that do not want LangGraph.js or require Python. | `apps/web/content/docs/faq.mdx` says LangGraph is required and Python is unsupported; packages/starters are TypeScript/Node, and typegen reads TypeScript signatures. | States B4.run's current boundary; it is not a judgment about LangGraph Python. | A: `pnpm check:release-inventory`, `pnpm typecheck`, and `node scripts/check-docs.mjs`. | keep |
| When B4.run fits: existing raw LangGraph.js graphs can migrate incrementally and remain raw `graph` routes. | `packages/core/test/discover-routes.test.ts` tests graph discovery; `packages/langgraph/src/langgraph-adapter.ts` executes invokable graph entries; `apps/web/content/docs/migrating-from-langgraph.mdx` gives the re-export shape and checkpointer caveat. | Existing nodes, edges, and imports can remain, but deployment/invocation/checkpointer behavior must be validated per target. | A: `pnpm --filter @b4run/core test`, `pnpm --filter @b4run/langgraph test`, and `node scripts/check-docs.mjs`. | qualify |
| When B4.run does not fit: teams seeking a hosted AI platform or infrastructure provisioning. | `apps/web/content/docs/deployment.mdx` says B4.run emits artifacts but does not provision infrastructure, host apps, or manage secrets; `charts/b4-app/README.md` says the chart runs a user-built image and does not build it. | Users operate or contract with deployment platforms separately. | A: `node scripts/check-docs.mjs`. G: `chart-validate` verifies the chart artifact without changing the non-provisioning boundary. | keep |
| When B4.run fits in production: teams accept pre-1.0 change management and validate their runtime, storage, auth, and provider boundary. | `apps/web/content/docs/faq.mdx` recommends pinning; `apps/web/content/docs/deployment.mdx` says a green build is not a substitute for deployed-boundary testing; `apps/web/content/docs/upgrading.mdx` documents upgrades. | Do not use an unqualified “production-ready” label. Readiness is application- and target-specific. | A: `pnpm ci:validate`. G: the selected target's named job (`edge-workerd`, `vercel-native`, `chart-validate`, or `chart-apply-smoke`) must pass before making that target-specific claim. | qualify |

## Clean-room activation observation

Historical. This 2026-09-01 receipt describes the 0.8.21 research starter that
`@latest` resolved then; the root README no longer cites it, and the claims
above rest on the automated checks they name.

Run on 2026-09-01 from the repository root with the required runtime prepended
to `PATH`. The wrapper removed 14 common provider variables and failed if any
remained before executing the public command sequence:

```text
provider credentials present after sanitization: 0/14
node: v24.19.0
npm: 10.9.2
npm latest: 0.8.21

✔ Created my-agent (research template)

added 195 packages, and audited 196 packages in 25s
found 0 vulnerabilities

Test Files  1 passed | 1 skipped (2)
Tests  7 passed | 1 skipped (8)
Duration  2.95s
```

The exact sanitized command was:

```bash
provider_vars=(
  OPENAI_API_KEY OPENAI_BASE_URL AZURE_OPENAI_API_KEY AZURE_OPENAI_ENDPOINT
  ANTHROPIC_API_KEY GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY
  MISTRAL_API_KEY GROQ_API_KEY XAI_API_KEY OPENROUTER_API_KEY
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
)
for key in "${provider_vars[@]}"; do unset "$key"; done
for key in "${provider_vars[@]}"; do
  if printenv "$key" >/dev/null; then
    printf "provider credential still present: %s\n" "$key" >&2
    exit 1
  fi
done
printf "provider credentials present after sanitization: 0/%s\n" "${#provider_vars[@]}"
node --version
npm --version
npm view create-b4-app@latest version

activation_root="$(mktemp -d)"
(
  cd "$activation_root"
  npm create b4-app@latest my-agent
  cd my-agent
  npm install
  npm test
)
```

This date/version-specific observation supports only the 0.8.21 package npm
resolved at that moment. It demonstrates the canonical activation and default
fixture suite with the listed provider variables absent; it does not prove that
all possible credential variables were absent or that arbitrary user changes
cannot enable a live path. It also does not prove the published package already
contains the current repository's two-workspace Workbench shape or its
3002/3010 ports: 0.8.21 generated the earlier single-package starter and printed
port 3000.

## Current-source verification observation

The required repository checks ran with Node v24.19.0 and pnpm 10.33.0:

```text
pnpm build
  Tasks: 25 successful, 25 total

pnpm --filter create-b4-app test
  Test Files 2 passed (2)
  Tests 11 passed (11)

source scan
  NODE_FLOOR_MAJOR = 24
  let template = "research"
  server dev port = 3002
  Workbench dev/start port = 3010

internal research scaffold
  server: Test Files 1 passed | 1 skipped (2)
  server: Tests 7 passed | 1 skipped (8)
  Workbench: Test Files 15 passed (15)
  Workbench: Tests 209 passed (209)
```

The internal scaffold receipt was generated on 2026-09-01 from the built
`packages/create-b4-app/dist/bin.js` with `--mode internal`, installed with
pnpm 10.33.0, and tested through the generated root workspace. It validates
the current two-workspace source shape independently of the published
`@latest` observation above.

Later source changed the default template to `basic` (`let template = "basic"`),
so the source scan below no longer matches and the internal research scaffold
now needs `--template research`. The receipt above records the 2026-09-01
source only.

The source scan command was:

```bash
rg -n 'NODE_FLOOR_MAJOR|let template = "research"|3002|3010' \
  packages/create-b4-app/src/index.ts \
  packages/create-b4-app/test/create-app.test.ts \
  packages/devkit/templates/app-research
```

The current research template's root and server manifests declare Node
`>=24.0.0`; its README documents npm 11. Because the published clean-room run
succeeded with npm 10.9.2, root README wording must distinguish the enforced
Node floor from the current-template npm baseline instead of presenting npm 11
as a demonstrated hard minimum.

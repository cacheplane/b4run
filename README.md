<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/b4-logo-horizontal-white-on-black.png">
    <img src="docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="360">
  </picture>
</p>

<p align="center"><strong>TypeScript meta-framework for LangGraph.js</strong></p>

# Build LangGraph agents like Next.js apps.

B4.run adds file-system routes, shared and route-local tools, generated types,
deterministic tests, durable threads, and build targets around LangGraph.js.
Keep the runtime. Drop the boilerplate.

<p align="center">
  <a href="https://www.npmjs.com/package/create-b4-app"><img src="https://img.shields.io/npm/v/create-b4-app?label=create-b4-app" alt="create-b4-app npm version"></a>
  <a href="https://github.com/cacheplane/b4run/actions/workflows/ci.yml"><img src="https://github.com/cacheplane/b4run/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-111827.svg" alt="MIT license"></a>
  <a href="https://github.com/cacheplane/b4run/stargazers"><img src="https://img.shields.io/github/stars/cacheplane/b4run" alt="GitHub stars"></a>
  <a href="https://github.com/cacheplane/b4run/actions/workflows/scorecard.yml"><img src="https://github.com/cacheplane/b4run/actions/workflows/scorecard.yml/badge.svg" alt="OpenSSF Scorecard"></a>
</p>

<p align="center">
  <a href="https://b4.run/docs/getting-started">Get started</a> ·
  <a href="https://b4.run/docs/migrating-from-langgraph">Migrate from LangGraph.js</a> ·
  <a href="https://b4.run/docs">Documentation</a> ·
  <a href="https://github.com/cacheplane/b4run/discussions">Discussions</a>
</p>

```bash
npm create b4-app@latest my-agent
```

<p align="center">
  <a href="https://b4.run/#product-loop">
    <img src="docs/brand/product-loop.gif" alt="Animation showing an existing generated research workspace, a deterministic test, and the B4.run Workbench" width="900">
  </a>
</p>

[Read the product-loop transcript](docs/brand/demo/transcript.md).

## Quickstart

The first activation is the no-key path:

Requires Node.js 24 or later.

```bash
npm create b4-app@latest my-agent
cd my-agent
npm install
npm test
```

In a credential-sanitized clean-room run on August 31, 2026, npm resolved
`create-b4-app` 0.8.21; the generated starter installed and its default
fixture suite passed, with one opt-in test file skipped. The observation is
version- and date-specific; `@latest` can move. See the
[activation receipt](docs/brand/demo/evidence-matrix.md#clean-room-activation-observation).

## Why B4.run

- **Author the application shape, not route wiring.** Put one supported entry in
  a route's `src/app/**/index.ts`; B4.run discovers the route. Shared tools live in
  `src/tools/`, while route-local tools can live beside the route and remain
  subject to its runtime policy.
- **Let generated types follow the route.** B4.run generates TypeScript route,
  parameter, state, and tool declarations during typegen and build. State types
  are emitted when the discovered state schema supplies valid defaults.
- **Make the normal test loop deterministic.** Fixture-backed tests replay
  committed responses and fail on an unmatched interaction instead of silently
  calling a provider. Live and recording modes remain explicit opt-ins.
- **Carry one project from local state to build artifacts.** Default
  SQLite-backed state can survive a `b4 dev` restart when the app root and its
  SQLite files persist. The default build emits a runnable Node server,
  Dockerfile, and LangSmith graph artifacts; validate the runtime, storage, auth,
  and provider boundary for the deployment target you choose.

## How B4.run fits

| Layer | Role |
| --- | --- |
| **LangChain** | Remains available. B4.run's built-in `agent()` path uses LangChain integrations; raw graph and chain routes own their imports and provider behavior, and B4.run does not claim coverage for every LangChain package or provider. |
| **LangGraph.js** | Remains the graph runtime and is required by B4.run. B4.run adds application conventions around it rather than replacing it. |
| **B4.run** | Supplies file-system routing, generated types, local test and development conventions, persistence primitives, and build targets around LangGraph.js. |
| **Deployment and observability choices** | Model providers and LangSmith remain external. B4.run emits a Node runtime and LangSmith artifacts by default, with target-specific options documented separately; it does not provision infrastructure, host the app, or manage secrets. |

## What B4.run writes for you

| You author | B4.run discovers or emits |
| --- | --- |
| One `agent`, `workflow`, `graph`, or `chain` entry in a route's `index.ts` | The route identity and runtime entry |
| Shared tools in `src/tools/` and optional route-local tools in the route's `tools/` directory | The tool set available at that route, subject to tool policy and runtime constraints |
| Optional state schemas and typed tool signatures | Regenerated route, route-parameter, state, and tool declarations; state exports require discoverable defaults |
| Fixture-backed tests and application configuration | A deterministic replay path for those fixtures; live and recording paths stay explicit |
| Application source | A runnable Node server, Dockerfile, and LangSmith graph artifacts from the default build |

Already have a graph? Keep its nodes, edges, and imports, expose it as a raw
`graph` route, and validate invocation and checkpointer behavior for each target.
The [full migration guide](https://b4.run/docs/migrating-from-langgraph)
covers that incremental path.

## What are you building?

- [Research assistant](./examples/research/README.md)
- [Chat and workspace assistant](./examples/chat/README.md)
- [Memory-backed agent](./examples/memory/README.md)
- [Routes and workflows guide](https://b4.run/docs/routes)

## When B4.run fits

- **A good fit:** a TypeScript team wants LangGraph.js with file-system routes,
  generated types, a local test and development loop, persistence primitives,
  and build targets. Capability support varies by target, so validate the subset
  your application uses.
- **Stay with raw LangGraph.js:** if you do not want B4.run's application
  conventions, or if your project requires Python. B4.run requires LangGraph.js
  and targets TypeScript and Node.js.
- **Bring the ecosystem with you:** existing raw LangGraph.js graphs can migrate
  incrementally as `graph` routes. LangChain remains usable, and CopilotKit
  composes with B4.run through the tested AG-UI boundary; validate versions and
  target-specific invocation, provider, and checkpointer behavior in your app.

B4.run is not a hosted AI platform or an infrastructure provisioner. You operate
the emitted application or deploy it through a separate platform.

## Build with a coding agent

Give your coding agent the framework sources before it writes a route.

<details>
<summary>Copy this prompt</summary>

```text
Scaffold a new B4.run app and help me build an agent. B4.run is the TypeScript meta-framework for LangGraph — agents and workflows are file-system routes with route-local tools, generated types, and durable threads. Run `npm create b4-app@latest my-agent` to scaffold, then read https://b4.run/AGENTS.md and https://b4.run/llms-full.txt for the full framework reference before writing any routes.
```

</details>

## Run it live

Credentials are provider-specific: the published research starter's OpenAI live
path requires `OPENAI_API_KEY`, while a local Ollama route requires no provider
key.

### Published `@latest` (0.8.21)

The clean-room activation recorded above resolved npm `@latest` to 0.8.21. That
published scaffold is a single package. Set its OpenAI key and start its B4.run
server on port 3000:

```bash
export OPENAI_API_KEY=sk-...
npm run dev
```

Drive the backend through the
[Agent Protocol](https://b4.run/docs/dev-server/agent-protocol), or follow
the [Workbench guide](https://b4.run/docs/recipes/research-web-ui) to add a
browser client; the 0.8.21 scaffold does not include the Workbench package.

In a clean 0.8.21 scaffold inspected on September 1, 2026, `npm run build`
compiles the TypeScript project. That scaffold does not define `npm start`; use
`npm run dev` for its working server path.

### Current source (unreleased 0.8.22)

The current checked-in research template is a two-package workspace with a
server and the B4.run Workbench. These commands apply to a scaffold generated
from current repository source, not the published `@latest` package:

```bash
npm install
export OPENAI_API_KEY=sk-...
npm run dev:server
```

In a second terminal:

```bash
npm run dev:web
```

That source template serves the B4.run server on port 3002 and the Workbench on
port 3010. Its root workspace defines the production build and start scripts:

```bash
npm run build
npm start
```

Choose and validate the deployment boundary that matches your application:
[Node](https://b4.run/docs/deployment/node),
[LangSmith](https://b4.run/docs/deployment/langsmith),
[edge targets](https://b4.run/docs/deployment/edge), or
[Kubernetes](https://b4.run/docs/deployment/kubernetes). B4.run emits the
artifacts; it does not provision infrastructure, host the application, or
manage its secrets.

## Maturity and support

B4.run is pre-1.0 and its API surface is moving. Pin versions and read the
[release notes](https://github.com/cacheplane/b4run/releases) and
[upgrade guide](https://b4.run/docs/upgrading). Supported means documented
public surfaces on the current release line, not a 1.0 stability or long-term
support guarantee.

- Follow [SUPPORT.md](./SUPPORT.md) for support routes, and ask usage questions
  in [GitHub Discussions](https://github.com/cacheplane/b4run/discussions).
- Report security issues through the process in [SECURITY.md](./SECURITY.md).
- See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CONTRIBUTORS.md](./CONTRIBUTORS.md) before contributing.
- Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

Ready to start?

```bash
npm create b4-app@latest my-agent
```

## License

MIT. See [LICENSE](./LICENSE).

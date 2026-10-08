<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/b4-logo-horizontal-white-on-black.png">
    <img src="docs/brand/b4-logo-horizontal-black-on-white.png" alt="B4.run" width="360">
  </picture>
</p>

<p align="center"><strong>An agent framework, the way I'd build it.</strong></p>

# Ridiculous speed. Readable code.

Write the agent. Give it tools. Set the limits. Ship code you can actually read.
B4.run adds file-system routes, generated types, workspaces, sandbox execution,
and approval around LangGraph.js. Keep your application code in TypeScript.

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

https://github.com/user-attachments/assets/5ef7304d-e5f7-44a2-bb19-28b7af6e8347

The 50-second demo shows one agent file, weather and performance subagents, a
computed navlog, approval-gated filing, memory, and a conversation restored
after a reload. Model turns are scripted and the weather API is stubbed, so the
video rebuilds offline. Build the same app with
`npm create b4-app@latest my-navlog -- --template navlog`.

[Read the navlog demo transcript](docs/brand/demo/transcript.md).

## Quickstart

Requires Node.js 24 or later and npm 11. No API key needed:

```bash
npm create b4-app@latest my-agent
cd my-agent
npm install
npm test
```

`npm test` runs the starter's fixture-backed test offline — no API key, no
model calls.

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
- **Set the limits in the route.** `tools.deny` removes a tool from a route,
  and `tools.approve` pauses a call until a person answers, with each answer
  spending a single-use [approval grant](https://b4.run/docs/approval-grants).
  [Permissions](https://b4.run/docs/permissions) gate shell commands and file
  paths outside the workspace, an opt-in [sandbox](https://b4.run/docs/sandbox)
  isolates the workspace tools, and the
  [security architecture](https://b4.run/docs/security-architecture) covers the
  authentication you put in front of the runtime.

The navlog template's whole agent is one route file:

```ts
// server/src/app/navlog/index.ts (description and system prompt abbreviated)
import { agent } from "@b4run/sdk"

export default agent({
  model: "gpt-5-mini",
  recursionLimit: 100,
  description: "A VFR flight planner for a Cessna 172N…",
  tools: { deny: ["runBash"], approve: [{ tool: "fileFlightPlan", allowAlways: false }] },
  systemPrompt: "You are a VFR flight-planning assistant for a Cessna 172N…",
})
```

## How B4.run fits

| Layer | Role |
| --- | --- |
| **LangChain** | Remains available. B4.run's built-in `agent()` uses LangChain integrations; raw graph and chain routes keep their own imports and providers. |
| **LangGraph.js** | The graph runtime, required by B4.run. B4.run adds application conventions around it rather than replacing it. |
| **B4.run** | Supplies file-system routing, generated types, local test and development conventions, persistence primitives, and build targets around LangGraph.js. |
| **Deployment and observability choices** | Model providers and LangSmith stay external. B4.run emits a Node server and LangSmith artifacts by default, with other targets opt-in; it does not provision infrastructure, host the app, or manage secrets. |

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

Start with the [flight planner](https://b4.run/docs/recipes/flight-planner), a
VFR flight planner for a Cessna 172N: live weather tools, a navlog computed in
code from the POH, weather and performance subagents, memory, planning, and
flight-plan filing behind approval. Scaffold it with
`npm create b4-app@latest my-navlog -- --template navlog`.

- [Developer agent](./examples/code-fixer/server/README.md): reproduces a
  historical defect, repairs it in an isolated workspace, verifies the patch
  independently, and asks before exporting it
  ([code walkthrough](./examples/code-fixer/server/WALKTHROUGH.md))
- [Flight planner example source](./examples/navlog/README.md)
- [Chat and workspace assistant](./examples/chat/README.md)
- [Memory-backed agent](./examples/memory/README.md)
- [Routes and workflows guide](https://b4.run/docs/routes)

## When B4.run fits

- **A good fit:** a TypeScript team wants LangGraph.js with file-system routes,
  generated types, a local test and development loop, persistence primitives,
  and build targets. Some capabilities vary by build target.
- **Stay with raw LangGraph.js:** if you do not want B4.run's application
  conventions, or if your project requires Python. B4.run requires LangGraph.js
  and targets TypeScript and Node.js.
- **Bring the ecosystem with you:** existing raw LangGraph.js graphs can migrate
  incrementally as `graph` routes. LangChain remains usable, and CopilotKit
  composes with B4.run through AG-UI. Check a migrated graph's checkpointer
  behavior on each deployment target.

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

Credentials are provider-specific: the navlog starter's OpenAI live
path requires `OPENAI_API_KEY`, while a local Ollama route requires no provider
key.

Scaffold the navlog flight planner, a two-package npm workspace with a B4.run
server and the B4.run Workbench, then add your key and check the app:

```bash
npm create b4-app@latest my-navlog -- --template navlog
cd my-navlog
npm install
cp server/.env.example server/.env   # then set OPENAI_API_KEY in server/.env
npm run verify
```

Start the server:

```bash
npm run dev:server
```

In a second terminal, start the Workbench:

```bash
npm run dev:web
```

The server listens on port 3002 and the Workbench on port 3010. The basic
starter runs live with `npm run dev` on port 3000 once `OPENAI_API_KEY` is set
in your shell.

The navlog root workspace defines the production build and start scripts:

```bash
npm run build
npm start
```

Choose and validate the deployment boundary that matches your application:
[Node](https://b4.run/docs/deployment/node),
[LangSmith](https://b4.run/docs/deployment/langsmith),
[edge targets](https://b4.run/docs/deployment/edge),
[Vercel](https://b4.run/docs/deployment/vercel), or
[Kubernetes](https://b4.run/docs/deployment/kubernetes). B4.run emits the
artifacts; it does not provision infrastructure, host the application, or
manage its secrets.

## Maturity and support

B4.run is pre-1.0 and its API surface is moving. Pin versions and read the
[release notes](https://github.com/cacheplane/b4run/releases) and
[upgrade guide](https://b4.run/docs/upgrading). Supported means documented
public surfaces on the current release line, not a 1.0 stability or long-term
support guarantee.

- Follow [SUPPORT.md](./SUPPORT.md) for support routes. Ask usage questions in
  [GitHub Discussions](https://github.com/cacheplane/b4run/discussions) and
  report defects in [GitHub Issues](https://github.com/cacheplane/b4run/issues).
- Report security issues through the process in [SECURITY.md](./SECURITY.md).
- See [CONTRIBUTING.md](./CONTRIBUTING.md) and [CONTRIBUTORS.md](./CONTRIBUTORS.md) before contributing.
- Follow the [Code of Conduct](./CODE_OF_CONDUCT.md).

Ready to start?

```bash
npm create b4-app@latest my-agent
```

## License

MIT. See [LICENSE](./LICENSE).

---
"@b4run/ag-ui": patch
---

`@b4run/ag-ui`'s optional `@copilotkit/react-core` peer range is now `>=1.76.0`. 1.76.0 is the first `@copilotkit/react-core` whose bundled AG-UI client speaks 1.0, the protocol B4.run serves since 0.13.1; earlier releases resolve a pre-1.0 `@ag-ui/*` (0.0.59 on 1.70–1.75) and cannot talk to the endpoint. The `/react` renderers are unchanged. pnpm warns about the unmet optional peer and installs; npm 7+ rejects it with `ERESOLVE`, so an app pinned below 1.76.0 upgrades CopilotKit together with `@b4run/ag-ui` (or installs with `--legacy-peer-deps`).

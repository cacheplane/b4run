---
"@b4run/ag-ui": patch
---

`@b4run/ag-ui`'s optional `@copilotkit/react-core` peer range is now `>=1.76.0`. 1.76.0 is the first CopilotKit whose runtime speaks AG-UI 1.0, the protocol B4.run serves since 0.13.0; every earlier release resolves `@ag-ui/*` 0.0.59 and cannot talk to the endpoint. The `/react` renderers are unchanged. pnpm and npm warn, rather than fail, on an unmet optional peer, so an existing app on 1.70 still installs and is told why its host should move.

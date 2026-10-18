---
"@b4run/ag-ui": patch
"@b4run/devkit": patch
"create-b4-app": patch
---

The `@b4run/ag-ui` README now documents `B4HttpAgent`'s `responseSchema`, `forwardIdentity`, `B4Activity`'s `renderInChat` and its one-slot caveats (one interrupt slot, no `useDefaultRenderTool()`, `approvals.grants: "off"` only), `useB4ActivityContext`, and `mergeTurnMessages`. The navlog template's CopilotKit notes are verified against `@copilotkit/react-core` 1.77.1, whose `CopilotKit` wrapper no longer defaults `useSingleEndpoint` to `true`.

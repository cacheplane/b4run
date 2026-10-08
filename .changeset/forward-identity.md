---
"@b4run/ag-ui": patch
"@b4run/devkit": patch
---

`forwardIdentity({ headers, resolve })`, from `@b4run/ag-ui/client` and `@b4run/ag-ui/copilotkit-runtime`, returns a `fetch` for a server-side route that talks to B4.run on a browser's behalf, such as a CopilotKit runtime route. On every upstream call it strips the declared identity headers from whatever the call carried, so a browser can't forge them, then sets the current caller's values. Pass it to both `B4HttpAgent` and `createB4AgentRunner`, and read the headers back in the app's `src/auth.ts`. The navlog template's runtime route now uses it instead of a hand-written wrapper.

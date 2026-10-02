---
"@b4run/cli": patch
"@b4run/ag-ui": patch
---

Advertise a route's AG-UI capabilities. `GET /agui/:routeId` returns an AG-UI `AgentCapabilities` document — client-provided tools, structured output, interrupts and approvals — computed by the same checks `POST` enforces, behind the same route middleware. `@b4run/ag-ui/client` adds `B4HttpAgent`, an `HttpAgent` whose `getCapabilities()` reads it, so CopilotKit's `/info` reports them; `@ag-ui/client` is an optional peer dependency for that subpath.

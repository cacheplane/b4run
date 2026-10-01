---
"@b4run/cli": patch
---

An AG-UI approval resume is now answered only on the route that parked it. `/agui/:routeId` takes its route from the URL, so a caller admitted by middleware to one route could send a `resume` for a permission prompt parked by another route, and every `createAgent` route resolves another's park because they share node names: the decision was applied under the wrong route's graph, prompt and tools, and, where the routes shared a tool, the gated tool ran for a caller the parking route would refuse. Such a resume now gets `409` `resume_route_mismatch` after the thread-access gate and before any approval grant is checked or consumed; the parking route is not echoed. The owner is the thread's `parked_route`, or its `metadata.route` before the park is recorded, the same chain the Agent Protocol endpoints use. A thread with no route recorded at all keeps the previous behaviour, as `/threads/:id/resume` falls back to the caller's `route`.

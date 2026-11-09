# Agent Protocol Bindings and Consumers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the approved standard resources/transports and preserve native AG-UI, workspace and first-party consumers.

**Architecture:** Small protocol route modules call the shared runtime services. Node upgrade handling is separate from Fetch response handling; transport filters/auth do not own execution. Native bindings project the same committed facts without changing native input/lifecycle rules.

**Tech Stack:** TypeScript, Fetch/Node HTTP, SSE/WebSocket, AG-UI SSE/protobuf, Hono/generated targets, Vitest and consumer browser tests.

---

**Specs:** approved wire/runtime/coordinated designs in `../specs/`.
**Dependencies:** C1–C5; R4/R6/R7 for mutation bindings, R9 for replay, R10/R11 for state/deletion. Store HTTP plugs in from the Store plan. A test harness may instantiate services before their dependency lands, but no public fake implementation may stand in for them.

## Route boundaries

Create `packages/cli/src/lib/dev/protocol/routes-{agents,threads,runs,stream,commands}.ts`,
`rest-run-stream.ts`, `sse.ts`, `subscriptions.ts`, `node-upgrade.ts` and
`routes.ts`. Keep runtime-fetch-core composition/bootstrap and established
application route ordering; remove old dialect handlers rather than alias them.
Test actual HTTP/upgrades in addition to shared handler calls.

### B1: Standard Agent and Thread routes

**Files:** Create routes-agents.ts, routes-threads.ts, routes.ts; modify `runtime-fetch-core.ts`, `runtime-fetch-handler.ts`; create `packages/cli/test/protocol-resources.test.ts`.

- [ ] Test exact paths/statuses/shapes, all-kind catalog, caller filtering before paging, UUID creation, raise/do_nothing collision, protected metadata and coherent GET/history. Test state PATCH/copy/deletion dispatch counts against real services.
- [ ] Run `pnpm --filter @b4run/cli test protocol-resources`; expect missing standard route behaviors.
- [ ] Implement route modules with common validation/authority and service calls. Preserve no-body copy, metadata-only checkpoint ignoring, standard array/search forms and explicit busy/resource errors.
- [ ] Remove superseded state/turns/events/pending handlers and GET agui capability handler from composition. Add negative HTTP assertions and SPA no-HTML checks; keep internal projection functions only where still used.
- [ ] Rebuild/run focused resource, thread-access and runtime-fetch parity tests. Assert model/tool invocation counts remain zero for discovery/read/PATCH/copy.
- [ ] Commit `feat: serve standard agents and thread resources`.

### B2: Run create/wait/search/join/cancel routes

**Files:** Create routes-runs.ts, rest-run-stream.ts; modify `runtime-fetch-core.ts`; create `packages/cli/test/protocol-run-routes.test.ts`.

- [ ] Add every approved default/override, top-level errors, accepted/settled responses, stateless/result retention, operation-token lookup, future-only join, exact cancel/rollback and creation-stream disconnect tests.
- [ ] Run `pnpm --filter @b4run/cli test protocol-run-routes`; verify no new Run is admitted by a replay/read/failed request.
- [ ] Implement the seven background and two creation/wait routes over shared admission/executor/result services. Map owning-stream abort separately from passive join; explicit continue/background uses a lifetime-capable executor or rejects before acceptance.
- [ ] Implement documented REST Run SSE modes/metadata/end/error framing, distinct from ASP. Remove thread-scoped Run/cancel/resume dialect handlers. Generic token-less requests stay legal with their reduced retry guarantee.
- [ ] Rebuild/run focused tests plus actual Node HTTP creation/join/disconnect cases. Assert complete input/config/webhook is validated before admission and no unsupported field is silently ignored.
- [ ] Commit `feat: serve standard run lifecycle bindings`.

### B3: HTTP commands and durable SSE observation

**Files:** Create routes-commands.ts, routes-stream.ts, sse.ts; create `packages/cli/test/protocol-commands.test.ts`, `protocol-sse.test.ts`.

- [ ] Test every pinned command shape/result and ErrorCode, complete input.respond batches, injection token carrier, fork top-level B4 carrier, filters/depth, exact since boundary, generation mismatch and slow consumers.
- [ ] Run `pnpm --filter @b4run/cli test protocol-commands protocol-sse`; expect framing/dispatch failures and confirm CDDL fixtures are independent of the encoder.
- [ ] Dispatch commands to shared services; keep closed run.start/state.fork/state.get results unchanged and put B4 receipt diagnostics in legal extensible carriers. Resolve actual namespaces and privilege for system injection.
- [ ] Serve `event: message` CDDL frames, id=eventId and numeric since, derived values hydration at H, replay >H and atomic live tail. Abort closes only the observer; no run cancellation or fabricated terminal event. Limit per-observer memory explicitly.
- [ ] Rebuild/run focused HTTP tests using deliberately split SSE byte chunks, Unicode, repeated IDs and snapshot/live races. Verify sequence gaps from filters are not treated as loss.
- [ ] Commit `feat: bind protocol commands and resumable thread SSE`.

Example assertion to preserve closed data:

```ts
expect(Object.keys(startResponse.result)).toEqual(["runId"])
expect(startResponse.meta.b4.receipt.runId).toBe(startResponse.result.runId)
expect(lifecycle.params.data).not.toHaveProperty("runId")
expect(lifecycle.b4.runId).toBe(startResponse.result.runId)
```

### B4: Node WebSocket upgrade and subscription recovery

**Files:** Create node-upgrade.ts, subscriptions.ts; modify `packages/cli/src/lib/dev/runtime-server.ts`, `node-web-adapter.ts`, `packages/cli/package.json`; create `packages/cli/test/protocol-websocket.test.ts`.

- [ ] Test auth before real 101 upgrade, commands after auth changes, subscribe/unsubscribe, descriptor replay after new connection, removed subscriptions, invalid generation, expired events and no sticky-session dependency.
- [ ] Run `pnpm --filter @b4run/cli test protocol-websocket`; use a real listener/client, never a fabricated Response(101).
- [ ] Wire an actual upgrade adapter and frame parser. Reuse command validation, bounded sends and journal tail; no second state machine. Add direct pinned transport dependencies only if needed, with reviewed lockfile/security effects.
- [ ] Implement authenticated principal/deployment/generation/filter subscription descriptors, durable shared verification key/window and reconnect behavior. Reauthorize every restored filter/command; key rotation retains verification for the advertised replay window.
- [ ] Rebuild/run single-instance and two-instance Postgres socket tests. Closing observers only unsubscribes; reconnect false/diagnostics never pretends missed history was restored.
- [ ] Commit `feat: add authenticated Agent Protocol WebSocket transport`.

### B5: Native AG-UI over shared admission/runtime

**Files:** Modify `packages/cli/src/lib/dev/agui-handler.ts`, `agui-capabilities.ts`, `packages/ag-ui/src/client.ts`, `copilotkit-runtime/createB4AgentRunner.ts`, `view/resume.ts`; create `packages/cli/test/protocol-agui-bridge.test.ts`; update `packages/ag-ui/test/client.test.ts` and existing AG-UI endpoint suites.

- [ ] Add arbitrary native string ID/UUID alias cases, normal SSE/protobuf requests across four kinds, permissions/resume/new segment, duplicate native POST correlation, disconnect and no-second-terminal tests.
- [ ] Run `pnpm --filter @b4run/cli test protocol-agui-bridge agui-endpoint` and `pnpm --filter @b4run/ag-ui test client`; demonstrate failures against old capability GET/identity paths.
- [ ] Make native POST call common admission/permission/executor services while preserving original native IDs, tools/context/state/forwardedProps/media/response gates. Duplicate accepted runId returns approved 409 correlation without a new execution.
- [ ] Move B4HttpAgent capability discovery to standard Agent resources and translate full native declarations. Reconstruct B4-aware history through coherent Thread/history and valid native snapshots; ordinary native HttpAgent remains a one-POST client with no invented cursor protocol.
- [ ] Rebuild/run native suite, current required CopilotKit runtime browser integration and protobuf decoding. Verify real supported AG-UI/CopilotKit package versions; do not label earlier isolated 1.x probes as current end-to-end coverage.
- [ ] Commit `refactor: share protocol execution with native AG-UI`.

### B6: Workspace, readiness and generated host wiring

**Files:** Modify `thread-workspace-http.ts`, `packages/cli/src/lib/runtime/workspace-protocol.ts`, `managed-workspace-manager.ts`, `packages/cli/src/lib/build/targets/web-runtime.ts`, `vercel-config.ts`, `packages/cli/src/lib/runtime/edge-capability-report.ts`, `charts/b4-app/templates/deployment.yaml`, `charts/b4-app/values.yaml`; create `packages/cli/test/protocol-host-profile.test.ts` and update workspace/readiness/target tests.

- [ ] Test separate inspection lease/abort/deadline, staged uploader/digest/quota, do_nothing attachment invariance, required-store readiness and reduced-host pre-admission errors. Preserve all current workspace security assertions.
- [ ] Run `pnpm --filter @b4run/cli test protocol-host-profile thread-workspace-endpoint staged-workspace-endpoint`; expect old slot/error/profile assumptions to fail.
- [ ] Keep retained extension payloads/caps; standardize errors without making inspection a Run. Wire fresh coordinated backend bundles and actual host execution/upgrade adapters; absent capabilities are honest false/unknown, never inferred from Fetch or a DB WebSocket driver.
- [ ] Separate healthz from readyz and correct Helm probes/shutdown. Preserve edge static imports/request-store disposal. Full Node gets all features; Vercel/Workers new upgrade/lifetime claims require real supported host adapters and deployed tests, otherwise use the approved reduced profile.
- [ ] Rebuild/run focused workspace/host/target tests, chart lint/render/kubeconform and affected apply/shutdown smoke. Run the existing real Vercel lane and its cleanup receipt; it is not replaced by a local mock.
- [ ] Commit `feat: wire protocol host profiles and retained workspace operations`.

### B7: CLI and first-party application consumers

**Files:** Modify `test/code-fixer/scripts/consumer-probe.ts`, `test/code-fixer/scripts/consumer.ts`, `test/runtime/run-agent-protocol.test.ts`, `packages/cli/src/commands/run.ts`, `threads.ts`, `packages/cli/src/lib/threads/attach-state.ts`, `sse-frames.ts`, `tail-stream.ts`, `tail-render.ts`, `examples/software-factory/controller/src/lib/worker/{client,wire,sse,workspace-reader}.ts`, `examples/navlog/web/app/api/b4/[...path]/route.ts`, `examples/chat/web/app/api/copilotkit/[...path]/route.ts`, Navlog's matching CopilotKit route and matching `packages/devkit/templates/app-navlog` routes.

- [ ] Port existing CLI/worker/native consumer tests to standard resources while retaining tool/plan/reasoning/nested/permission/outcome assertions. Add no-legacy-request spies and cancelled/unknown recovery cases.
- [ ] Run `pnpm --filter @b4run/cli test threads-tail-stream threads-tail-command` and `pnpm --filter @b4-example/software-factory-controller test worker-client`; the audited controller package name is @b4-example/software-factory-controller and any execution-baseline drift is recorded at P0.
- [ ] Replace literal old route/body/event callers with the shared schema/decoder and standard Thread/Run/ASP flow. Preserve remote CLI scalar/message input, project ownership, worker source digests and read abort behavior. No runtime dialect fallback.
- [ ] Update chat/native connectors and owner-only Navlog proxy. Store method/address review allowlists come from the Store plan; do not expose unrestricted generic Store operations. Apply identical scaffold edits and exact-release template pins at release preparation.
- [ ] Rebuild and run CLI tail/worker tests, framework/runtime/smoke harnesses and current required CopilotKit example browser lane. Port code-fixer's consumer probe from retired Run-stream/pending/resume endpoints and run `pnpm code-fixer:consumer` against the configured scratch artifact; use actual generated packed consumer installs in the release plan.
- [ ] Commit `refactor: move CLI examples and scaffolds to standard protocol resources`.

## Exit checkpoint

All 27 operations plus six extensions have real route tests and absent old-path
assertions. Full Node transport/native consumers work against the shared runtime;
reduced hosts reject unsupported work before acceptance. The release plan adds
current documentation and packed/published/live-target evidence; neither mocked
HTTP nor successful local compilation closes those gates.

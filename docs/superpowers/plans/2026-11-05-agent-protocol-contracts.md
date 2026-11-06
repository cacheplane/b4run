# Agent Protocol Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the pinned standard/B4 contracts and shared fixtures consumed by runtime, transports and Swift.

**Architecture:** The original upstream inputs remain immutable; an explicit overlay corrects only the reproduced RunStream defect. SDK subpaths expose public DTO/schema/corpus assets without loading Node or optional model dependencies. Runtime catalog/schema/authorization derives from real adapters rather than configured claims.

**Tech Stack:** TypeScript NodeNext, JSON Schema, pinned CDDL, Vitest, pnpm, existing SDK schema/build and pack checks.

---

**Approved specifications:** [Wire](../specs/2026-11-05-agent-protocol-wire-design.md), [coordination](../specs/2026-11-05-agent-protocol-coordinated-design.md).
**Dependency:** coordination task P0. Execute from the implementation worktree root; never the dirty original checkout. Names below designate new files where marked Create; refresh existing paths against the selected implementation SHA at P0.

## File responsibilities

| Files | Responsibility |
| --- | --- |
| `test/agent-protocol/fixtures/upstream/openapi.json`, `protocol.cddl`, `manifest.json` | Original pinned input bytes, hashes, license/source provenance |
| `test/agent-protocol/fixtures/corrections.json`, `wire-cases.json` | Exact overlay and independent positive/negative corpus |
| `packages/sdk/src/agent-protocol/{index,types,metadata,errors}.ts` | Public DTOs, reserved vocabulary and standard/B4 discriminants |
| `packages/sdk/src/agent-protocol/schema.ts` | B4 v1 schema definitions and source references |
| `packages/sdk/scripts/write-agent-protocol-schema.mjs` | Deterministic schema/corpus build assets |
| `packages/cli/src/lib/dev/protocol/{validate,catalog,metadata,errors}.ts` | Request decoding, real Agent descriptions and protected metadata handling |

The new SDK exports are `./agent-protocol`, `./agent-protocol.schema.json` and
`./agent-protocol.fixtures.json`. The JSON assets carry fixtures and a source/hash
manifest; clients do not need a live schema endpoint. Keep generated output in
dist and source fixtures/version pins in Git. No production handler changes in
this component; each commit leaves existing public behavior intact until the
integration branch's binding replacement.

### C1: Freeze source inputs and reproduce the correction

**Files:** Create the five fixture files above; create `packages/sdk/test/agent-protocol-inputs.test.ts`, `packages/sdk/scripts/agent-protocol-inputs.mjs` and its `.d.mts` declaration for the shared guarded overlay reader; modify `packages/sdk/package.json` and lockfile to pin the schema validator as a test-only dependency.

- [ ] Copy exact OpenAPI/CDDL bytes from the audited upstream commit; record SHA256/source URL/license in manifest. Verify against an independent fetch/read of that immutable commit, never moving main.
- [ ] Write tests counting exactly 27 method/path operations, five original RunStream request-required failures, corrected empty RunStream validity and still-required Run response fields. Assert unmodified ordinary text-array Message validates; add no speculative Message overlay.
- [ ] Run `pnpm --filter @b4run/sdk test agent-protocol-inputs`; verify actual collection count, not a no-tests success.
- [ ] Implement the shared overlay reader as an exact JSON-pointer removal guarded by original hash and expected array equality. A changed upstream file or unexpectedly shaped target must fail before generation.
- [ ] Run the chosen contract command; expect all cases collected and passing. Record source hashes and correction diff in the test output artifact.
- [ ] Commit only fixture/test/config files: `git commit -m "test: pin Agent Protocol inputs and correction fixtures"` after explicit `git add` of the listed files.

The correction assertion is equivalent to:

```ts
expect(originalErrors.map((e) => e.params.missingProperty).sort()).toEqual([
  "created_at", "metadata", "run_id", "status", "updated_at",
])
expect(validateCorrectedRunStream({})).toBe(true)
expect(validateCorrectedRun({})).toBe(false)
expect(validateOriginalMessage({ role: "user", content: [{ type: "text", text: "ok" }] })).toBe(true)
```

Use a real schema validator in the test lane; do not substitute checks against
the same runtime DTO guards being tested. Pin any added test dependency/lockfile
and preserve edge-safe production imports.

### C2: Publish the DTO, schema and fixture assets

**Files:** Create SDK files in the responsibility map; create `packages/sdk/test/agent-protocol.test.ts`; modify `packages/sdk/package.json`, `packages/sdk/scripts/write-schema.mjs`, `scripts/lib/pack-check.mjs`, `scripts/lib/published-export-kinds.mjs` and its `.d.mts` only where their existing export inventories require additions.

- [ ] Add compile/runtime fixtures for closed run.start/state.fork results, extensible Event/ResponseMeta, canonical IDs, native string tokens, metadata collisions, response enums and all B4 v1 envelopes. Include accepted/expired/target-gone/ambiguous lookup and filtered replay cases.
- [ ] Run `pnpm --filter @b4run/sdk test agent-protocol`; expect missing definitions/assets failures, not an unrelated dependency/build failure.
- [ ] Define DTOs and B4 schemas from wire sections 3–13. Use optional-property conditional spreads and source `.js` imports. Keep arbitrary application payload/unknown optional block content intact. Include all Recovery/Activity/Receipt definitions, effectsUncertain, history fragments and query selectors.
- [ ] Reuse the C1 guarded source reader and emit deterministic schema and fixture JSON in SDK build; export the three subpaths above. Assert identical builds produce identical bytes and no Node/model imports enter the pure contract subpath.
- [ ] Run `pnpm build`, `pnpm --filter @b4run/sdk test agent-protocol`, `pnpm --filter @b4run/sdk typecheck`, then scoped pack-export tests. Expected: valid consumers load schema/fixtures/types from built paths, malformed/closed-map fixtures reject.
- [ ] Add a fixed-group patch changeset and commit the listed files with `feat: publish pinned Agent Protocol contract assets`. If an inventory helper is release-reachable, update its reviewed content pin/snapshot through the existing integrity procedure in the same commit; never bypass pins.

### C3: Normalize public messages and input without dialect leakage

**Files:** Create `packages/cli/src/lib/dev/protocol/messages.ts`, `input.ts`; modify `packages/cli/src/lib/runtime/execute-route-core.ts`, `normalize-server-result.ts`; create `packages/cli/test/protocol-messages.test.ts`, `protocol-input.test.ts`.

- [ ] Add fixtures for public Message roles/blocks/IDs, scalar input/output, input.messages plus top-level messages (top-level before input.messages as specified), conflicting duplicate IDs, media/reasoning/provider annotations and LangChain internal envelopes. Assert scalar output is `{output: value}`, never dropped.
- [ ] Run `pnpm --filter @b4run/cli test protocol-messages protocol-input`; verify the new normalization expectations fail.
- [ ] Implement the boundary conversions; combine supported message arrays in the approved order, preserve opaque blocks, reject conflicting IDs/unsupported combinations. Keep graph business input opaque and route-schema checked; never read old route/resume request keys as aliases.
- [ ] Wire conversions through existing execution adapters without exposing lc/id/kwargs on standard resources. Strip duplicate values.messages only when returning top-level messages.
- [ ] Rebuild and run the focused tests plus `agui-model-framing.test.ts`/`agui-handler-parts.test.ts` to prove native inputs and rich outputs survive.
- [ ] Commit `feat: normalize public protocol messages and route inputs` with the exact file set.

### C4: Build truthful Agent catalog and default selection

**Files:** Create `protocol/catalog.ts`; modify `packages/cli/src/lib/runtime/route-identity.ts`, `descriptor-route-index.ts`, `packages/core/src/config.ts`, `packages/cli/src/lib/verify/check-runtime.ts`, `packages/cli/src/lib/dev/agui-capabilities.ts`; create `packages/cli/test/protocol-catalog.test.ts`.

- [ ] Test all four public runnable kinds, route import failure, private route visibility, full native capability omission semantics, input/output/state/config schemas, denied default and sole versus multiple route defaults.
- [ ] Run `pnpm --filter @b4run/cli test protocol-catalog`; expect catalog/default behavior failures.
- [ ] Implement server.agentProtocol.defaultAgentId validation at check/build/boot and exact canonical Agent IDs. Explicit-ID calls remain usable when multiple routes have no default; omission returns agent_required.
- [ ] Derive run.b4 capabilities and Agent.metadata.b4 schema/limits from resolved adapters/stores/host/policy. A configured flag alone must not produce true. Reuse native capability derivation and preserve unknown omissions.
- [ ] Rebuild; run `protocol-catalog`, `agui-capabilities` and config checks. Assert discovery runs no model/tool and discloses no protected route before authorization.
- [ ] Commit `feat: describe runnable agents through standard resources`.

### C5: Share request validation, authority and error mapping

**Files:** Create `protocol/validate.ts`, `metadata.ts`, `errors.ts`; modify `packages/cli/src/lib/dev/server-errors.ts`, `thread-access.ts`, `thread-gate.ts`, `packages/sdk/src/thread-access.ts`; create `packages/cli/test/protocol-validation.test.ts`, `protocol-authority.test.ts`.

- [ ] Add table cases for each wire error/status, literal metadata filters versus reserved receipt selectors, forged b4 metadata/config, bad UUID, wrong scalar/array defaults, anonymous/authenticated scope, unauthorized/missing resource equivalence and unsupported controls.
- [ ] Run `pnpm --filter @b4run/cli test protocol-validation protocol-authority`; prove the new contract assertions fail.
- [ ] Implement parse/authorize/normalize helpers. Preserve standard extensibility where allowed; reject retired forms/protected collisions explicitly. Return top-level REST code/message/metadata and legal ASP ErrorCode plus meta.b4 diagnostics. No runtime stacktrace or secret diagnostic values.
- [ ] Extend thread access operation types for standard resources/controls and provenance context, including destructive rollback/deletion and privileged system injection. Reauthorize receipt disclosure and source/destination copies separately.
- [ ] Rebuild and run the focused tests plus existing thread-access pure/coverage tests. Test unauthorized requests cannot distinguish absence, active state or receipt existence.
- [ ] Commit `feat: validate protocol requests and shared authorization`.

## Exit checkpoint

Contract fixtures/schema/types/guards/catalog are stable, built and packable.
Record their exact source/corpus hashes for all downstream plans and Swift copies.
Run focused checks once after the last related change, then the component's
required repository validation; do not claim runtime conformance from DTO tests.
Keep these changes on the integration branch until the full coordinated release
is ready. Any public wire change goes through the approved spec, not a transport-
specific workaround.

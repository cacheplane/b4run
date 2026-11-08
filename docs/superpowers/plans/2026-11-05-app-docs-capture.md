# App Docs Capture Contract and Recorder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, or superpowers:subagent-driven-development when delegation is selected. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a sanitized, versioned recording of a real Navlog conversation that faithfully preserves app-observed streaming and decisions.

**Architecture:** A bounded opt-in CLI recorder consumes the existing WorkspaceClient event and desync streams. The website owns the public normalized capture contract and deterministic reducer; Swift exports a private intermediate recording with narrowly selected protocol fields. Publication validates, sanitizes and normalizes that recording into an immutable static artifact.

**Tech Stack:** Swift/Foundation/ArgumentParser, WorkspaceClient, TypeScript, Vitest, JSON/NDJSON.

---

## Ownership and prerequisites

Website paths below are in b4run; Swift paths are in b4app. Read the entire app technical spec and decision layout before implementation, plus D-001, D-031, D-088, D-183, D-185 and newer relevant decisions. This plan proposes a CLI capability, not a new coordinator method, database reader, UI file access, or sync feature.

Current evidence: `EventPrinter` omits `message.delta` from JSON output. `EventsSnapshot` has a global epoch/cursor and active turns, not a full transcript. `ThreadRead` has no atomic cursor. `WorkspaceClient.events()` deduplicates contiguous global events; `desync()` reports gaps/epoch changes. `EventLog` replay is bounded. Never filter thread events before validating the global cursor.

For v1, use a fresh empty thread created through the existing CLI before recording; `ThreadCreate` is still supported even though the native new-thread composer normally uses `ThreadStart`. Open that thread in the app and submit only after recorder readiness. This avoids claiming arbitrary mid-turn snapshots can reconstruct already-missed deltas. Record multiple turns until explicit finish. Do not add a general history-export feature.

### Task 1: Define public capture types and semantic validation

Website create:
- `apps/web/lib/turn-inspector/capture-types.ts`, `capture-schema.ts`, `replay.ts`: types, bounded parser, pure reducer.
- `apps/web/app/components/turn-inspector/capture-contract.test.ts`, `replay.test.ts`, `__fixtures__/synthetic-capture.json`: tests discovered by current Vitest.
- `docs/contracts/app-turn-capture-v1.md`: language-neutral wire contract and input mapping table.

- [ ] Write the failing parser/reducer tests. Use a two-turn synthetic fixture explicitly marked `provenance: "synthetic"`, with repeated tool names but distinct IDs, deltas, a request, decision, completion, cancellation and unknown outcome variants. Test reversed seeking against expected prefix states.
- [ ] Run `pnpm --filter @b4run/web test -- app/components/turn-inspector/capture-contract.test.ts app/components/turn-inspector/replay.test.ts`; expect missing module failures.
- [ ] Implement this public shape with fully validated nested fields; use existing validation dependency only if it is already a runtime dependency, otherwise a small manual parser:

```ts
type ObservedValue = { available: true; value: JsonValue } | { available: false }
type Change =
  | { kind: "turn"; turn: PublicTurn }
  | { kind: "item"; item: PublicItem }
  | { kind: "delta"; itemId: string; text: string }
  | { kind: "request"; request: PublicRequest }
  | { kind: "notice"; code: string; text: string }
interface CaptureEvent {
  sequence: number // normalized contiguous index, not coordinator sequence
  elapsedMs: number
  sourceSequence: number // coordinator sequence, may skip unrelated threads
  changes: readonly Change[]
}
interface Capture {
  version: 1
  id: string
  provenance: "live" | "synthetic"
  recordedAt: string
  revisions: { app: string; runtime: string; example: string }
  initial: ReplayState
  events: readonly CaptureEvent[]
  moments: readonly { id: string; eventIndex: number; label: string; itemId?: string }[]
}
```

Define `PublicTurn` with explicit status/submission/outcome, `PublicItem` with stable ID/turn/role/type/observed content and provenance, and `PublicRequest` with stable ID/turn/kind/state/observed decision. Preserve missing versus empty values. Carry observed tool call/parent IDs only when present; native IDs become stable public aliases. Store artifact source/video metadata in the lesson manifest, not arbitrary fetch URLs in the capture.
- [ ] Enforce version, slug syntax, valid timestamps/revisions, finite nondecreasing elapsed time, strictly increasing source sequence, contiguous normalized sequence, duplicate IDs/moment checks, valid referents and allowed state transitions. Initial limits: 20 MiB UTF-8 capture, 50,000 events, 1 MiB per string, nesting depth 32; fail with an actionable diagnostic rather than silently truncating. Revisit limits using measured real capture size, with tests when changed.
- [ ] `stateAt(capture, index)` starts from initial and applies exactly events `0..index`; `-1` is initial. Deltas append to current content; completed item snapshots replace accumulated content instead of duplicating it. Request resolution never implies an unobserved approve choice. Completion may be failed, cancelled or unknown. No wall-clock reads or mutation of the capture.
- [ ] Rerun parser/replay tests; expected PASS. Document exact event-to-change rules and commit `feat(docs): define versioned turn capture contract`.

### Task 2: Build a bounded client-side recorder core

App create `Sources/WorkspaceClient/RecordingSession.swift`, `Tests/WorkspaceClientTests/RecordingSessionTests.swift`; use `WorkspaceClient.swift`, `EventCursor.swift`, `WorkspaceProtocol/Commands.swift`, `Events.swift`, `Envelopes.swift` as references. No filesystem imports beyond Foundation's value types in the recorder core; caller owns output.

- [ ] Add fake-transport tests: fresh empty thread start; selected-thread delta retained; unrelated events advance cursor without being exported; duplicate events; activity during setup; initial nonempty thread; gap/epoch change; account change; thread deletion; normal two-turn recording; timeout with no incoming events; output limit reached.
- [ ] Run `swift test --filter RecordingSessionTests`; expect tests to fail before the implementation exists.
- [ ] Implement a session state machine `preparing -> ready -> recording -> finished|invalid`. Register events and desync streams before any awaited reads. Validate a B4 thread with no turns/items/requests. Obtain snapshot epoch/cursor, reset cursor as appropriate, perform `ThreadRead`, request `EventsReplay` after that cursor and merge with queued events by epoch/sequence. If the target thread changed during setup, reject and require a fresh thread rather than accepting a raced initial state. Keep unrelated events out of the recording.
- [ ] Emit readiness only after setup and queued-event validation. Keep observing all events before thread filtering. Gap, epoch change, account change, selected-thread deletion, lost connection or overflow invalidates the recording; no attempt to repair a missed interval with a final snapshot. Enforce deadline using a clock task, not only checking time inside an event loop. Finish only on an explicit command and after active turns/requests settle; a cancelled/failed terminal turn is a valid observed outcome.
- [ ] Record sequence, monotonic relative receipt time and selected observed fields in memory. Adapt app-normalized `displayItem`, `turn`, `runtimeRequest`, and delta/native-item mappings; retain all selected event kinds required to reconstruct state. Reject unsupported selected semantic events instead of dropping them. No raw connection, authentication, account or secret-reference payload in output. Unrelated account change can abort without exporting its contents.
- [ ] Rerun focused tests; expected PASS, including global cursor validation across unrelated traffic. Commit `feat(client): add bounded explicit conversation recording`.

### Task 3: Add the opt-in CLI command and private output boundary

App create `Sources/AgentWorkspaceCLI/RecordingCommands.swift`, `Sources/AgentWorkspaceCLI/RecordingOutput.swift`; modify `Sources/AgentWorkspaceCLI/Main.swift`. Add command integration tests in `Tests/CoordinatorTests/RecordingCommandTests.swift` following existing executable-test conventions, or a dedicated CLI test target in Package.swift if executable imports are unsuitable.

- [ ] Add tests for argument validation, exclusive file creation, secret/path masking, no transcript on stdout/stderr, invalid session yielding no publishable file, and a fake B4 run retaining message deltas. Use fake runtimes only.
- [ ] Implement `agent-workspace docs-record --thread-id <id> --output <private-path> --max-seconds 900`. Resolve current runtime through existing launcher. Require a selected empty B4 thread. Print only readiness/status/error codes; never transcript payloads. `finish` on stdin ends recording, EOF aborts, deadline aborts. Include usage in help; no public consumer tutorial depends on this authoring command.
- [ ] Write a bounded, filtered intermediate file atomically with owner-only permissions, rejecting existing output paths. Reuse existing redaction utilities where applicable; explicitly exclude credentials/connection URLs/account identity/native scope. Redact secret-shaped text and local account paths before persistence; ensure masking operates on assembled streamed strings so split deltas cannot evade it. If safe redaction cannot preserve event boundaries, reject the run for publication rather than leak or manufacture timing. Do not persist an unfiltered raw event dump.
- [ ] Verify output includes format version, complete/incomplete marker, app version, epoch alias and observed sequence metadata. Only complete output is accepted by the publisher. Cancellation removes temporary files. Tests check command help and that normal conversation commands are unaffected.
- [ ] Run `swift build`, focused recording tests, then `swift test`; lint with the repository's strict formatter. Add a decision at PR time and gate record with actual evidence. Commit `feat(cli): add explicit docs recording command`.

### Task 4: Normalize, review and publish immutable captures

Website create `scripts/docs-captures/normalize.ts`, `sanitize.ts`, `validate.ts`, `publish.ts`, and `apps/web/app/components/turn-inspector/capture-pipeline.test.ts`; create `docs/verification/app-docs-capture-matrix.md` for qualification evidence. Proposed commands run with existing `tsx`: `pnpm exec tsx scripts/docs-captures/validate.ts <file>` and `publish.ts --manifest <path> --dry-run`.

- [ ] Tests cover each intermediate event mapping, stable ID substitution, repeated tools, complete item replacing deltas, absent arguments/results, secrets split across deltas, invalid completeness, unsafe source paths, source hash mismatch, synthetic provenance and attempted overwrite.
- [ ] Normalize only the selected semantic fields. Resolve delta native IDs through the observed display-item mapping. Preserve tool IDs/turn attribution when present. An explicit mapping error prevents publication; do not infer behavior from display text. Final `ThreadRead` may audit the end state, never fill earlier missing events.
- [ ] Add defense-in-depth scans and a manual review report for every public transcript, tool result, source snippet and video frame. A string scanner alone is not evidence of privacy. Keep intermediate files outside public directories and source control.
- [ ] Require a reviewed manifest with app/runtime/example revisions, date, dependency provenance, capture digest, video/caption/transcript paths, source hashes and moment IDs. Publication accepts only live, complete captures, uses content-addressed filenames and refuses replacing existing bytes. Dry-run validates without writing; publish copies only the manifest's allowlisted assets to `apps/web/public/docs-recordings/`.
- [ ] Run focused pipeline tests and contract tests; expected PASS. Keep fixture-only testing separate from actual recording qualification. Commit `feat(docs): validate reviewed recording artifacts`.

### Task 5: Qualify the first real Navlog conversation

- [ ] Refresh app and B4 compatibility against the versions to be documented. Follow Navlog README's setup/typegen/check steps; use an isolated demo account/workspace and existing authorized provider credentials. Do not inspect secret values.
- [ ] Create the empty B4 thread through the existing CLI, open it in b4app, start docs-record, wait for readiness, then submit the chosen bounded Navlog planning request in the native app. Record a follow-up in the same thread and finish. Exact route/departure time and any weather fixture usage belong in the provenance report. Real model output with stubbed weather must be disclosed as such.
- [ ] Compare the recorded prefix at each named moment with observed app UI and the end state. Record what the adapter exposes about tools, planning and subagents; do not promise missing custom map/card renderers. Verify capture semantics before filming polished media.
- [ ] Sanitize, manually review, run the validator and publisher dry-run; record revisions, capture size, event count and results. Public manifest entry is added only after all checks pass. If unavailable runtime data prevents a lesson, narrow the lesson or fix the integration separately, never synthesize evidence.

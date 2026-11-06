# App turn capture v1

A capture records what the app observed. It does not run an agent. The recorder is opt-in, starts with an empty B4 thread, and finishes only when turns and requests have settled.

## Two file boundaries

`agent-workspace docs-record --thread-id <id> --output <absolute-private-path>` writes `b4app-docs-private-v1`. It retains selected event fields, source sequence numbers, and monotonic receipt times. Account details, connection URLs, native scope, and approval grants are excluded. The CLI masks whole-field secrets and home paths. A secret that crosses streamed chunks rejects the recording because masking it would change the observed chunk boundaries.

The website normalizer replaces native IDs with stable aliases. The public version is `1`, with an ID, provenance (`live` or `synthetic`), recording timestamp, exact 40-character recorder/runtime/example source revisions (`revisions.app` names the recorder source), initial state, events, and named moments. Synthetic captures belong in tests, never the public lesson manifest.

The lesson manifest separately identifies the app build by flavour, version and executable SHA-256. Its source revision is nullable: an installed beta bundle that does not embed a revision is described as unavailable. Never substitute the current checkout revision for that installed binary.

## Observed values

An observed value is either `{ "available": false }` or `{ "available": true, "value": ... }`. Empty strings, null, empty arrays, and empty objects remain available values. Missing tool arguments and results are not inferred from text.

Turn status, submission state, and outcome are separate. A terminal turn can have a completed, cancelled, failed, or unknown (`null`) outcome. A resolved request does not imply approval: the current app event does not expose the decision, so that field remains unavailable.

## Event mapping

| App event | Public change |
| --- | --- |
| `turn.acknowledged`, `turn.state_changed`, `turn.finished` | Replace the turn's observed status, submission, and outcome. |
| `message.started`, `tool.started` | Upsert the observed item with streaming state; preserve item identity across updates. |
| `message.completed`, `tool.completed` | Replace the item with its completed snapshot. Do not append final text to streamed text. |
| `message.delta` | Append text to the item mapped by the observed native item ID within its turn. Missing mappings reject normalization. |
| `runtime_request.opened`, `.resolved`, `.expired` | Upsert the request state and selected prompt fields, without its approval grant. |
| Thread metadata updates | Check deletion, then omit organization and title metadata. |
| Unrelated events | Advance and validate the global cursor, then omit. |
| Account change, selected connection loss, thread deletion, gap, epoch change, unsupported selected semantic event | Invalidate the recording. |

The app can publish a user message immediately before its turn-state event. Turn references must resolve within the complete capture, but replay never inserts a later turn state into an earlier prefix. Item delta references and moment item references must already exist at their event.

Normalized `sequence` starts at zero and is contiguous. `sourceSequence` strictly increases but can skip unrelated events. `elapsedMs` is finite and nondecreasing; it describes receipt timing, not model execution timing.

`stateAt(capture, -1)` returns initial state. Index `n` applies exactly events zero through `n`. Seeking pauses playback; selecting an item does not move the clock. Terminal state cannot return to running, completed items cannot return to streaming, and resolved or expired requests cannot become pending again.

Custom capability items retain their observed event name and JSON data. These are app-visible activity values; they are not promoted to ordinary tool calls.

## Bounds and review

Limits are 20 MiB of UTF-8 JSON, 50,000 events, 1 MiB per string (including assembled streamed text), and nesting depth 32. Unsupported versions, ambiguous IDs, invalid references, and invalid state transitions fail validation. The browser verifies a SHA-256 digest and bounds response bytes before parsing.

A scanner is only one check. A person must review transcript text, tool output, source snippets, and media before publication. Record exact revisions, provider and weather provenance, asset digests, and the review result. Publish only reviewed, complete live captures under immutable content-addressed filenames.

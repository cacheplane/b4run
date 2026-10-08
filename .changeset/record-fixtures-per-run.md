---
"@b4run/testing": patch
---

`b4 eval --record` and `getRecordedFixtures()` record a route that dispatches subagents in parallel so that it replays deterministically. Record mode now sends every call upstream instead of answering a call with an earlier recording from the same run. It also waits for the last call of a run to be recorded before returning, so a recording no longer loses its final turn. Each recorded response is paired with the request that produced it, whatever order the calls completed in. Each fixture is keyed on its own request: `turnIndex` is its position within its own agent run, and `userMessage` is the request's latest user message. A fixture that would also match another call's request gets a `toolName` or `toolCallId` key, and a recording that cannot be told apart is refused.

---
"@b4run/testing": patch
---

`@b4run/testing` now depends on `@copilotkit/aimock` `^1.43.0` (was `^1.37.4`, resolving to 1.38.0). Recording over the OpenAI Responses API now keeps tool calls. Before, a turn that only called a tool was recorded as an empty assistant message with the call dropped. Recorded fixtures now also carry the upstream's token `usage`, so a replay reports the recorded counts instead of a length-based estimate. Re-recording an existing tape therefore adds a `usage` field to each response.

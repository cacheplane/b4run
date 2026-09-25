---
"@b4run/testing": patch
"@b4run/cli": patch
---

Recording now fails at record time when replay would reject the recording. Previously `getRecordedFixtures()` returned whatever aimock captured, while replay loads fixtures through aimock's validator. A turn whose assistant message came back empty therefore produced a tape that the next replay refused with `content is empty string`. `getRecordedFixtures()` now applies the same validation and throws an error naming each rejected turn and its user message, with the likely causes. `b4 eval --record` reports it as `Refused to record <eval> › <case>` with exit code 2 and does not write that case's fixture file. If the run's answer is a tool call, `returnDirect` on that tool ends the run on its result, so no empty closing turn is recorded.

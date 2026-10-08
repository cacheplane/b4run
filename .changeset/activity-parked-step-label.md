---
"@b4run/core": patch
"@b4run/langchain": patch
"@b4run/cli": patch
"@b4run/ag-ui": patch
---

A parked call keeps its running label after a reload. When a permission gate (tool, command, path or memory) parks a call whose tool has a `display`, the interrupt envelope now carries `step: { icon, label }`, the `display.running` label and icon the runtime streamed as the call's `running` `b4.step`. The envelope is checkpointed with the interrupt, so `GET /threads/:id/turns`, `/events` and `/pending_interrupts` return it, and AG-UI clients find it at `metadata.step`. `eventsFromState` replays it as the parked call's `running` step, so a restored awaiting step shows the same label and icon as the live run, and the approval card reads "The agent wants to file N738ZU KSTP to KRST" instead of "wants to use fileFlightPlan". The field is additive; an interrupt parked before this release restores as before. Tool run contexts carry the display as `step`, and `@b4run/core` exports its `GateStepDisplay` type.
